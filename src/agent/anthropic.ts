import type { AgentModel } from "./model-types.js";
import {
  anthropicDecision,
  anthropicMessage,
  anthropicTool,
  carriesCompaction,
  COMPACTION_BETA,
} from "./anthropic-protocol.js";
import { MAX_REQUEST_BYTES, providerBaseUrl, providerRequest } from "./provider-http.js";
import { record } from "./provider-schema.js";
import { boundedToolOutputs } from "./provider-tool-outputs.js";
import { throwIfAborted } from "../utilities/abort.js";

/** Messages API transport settings; credentials are resolved only when a decision executes. */
export interface AnthropicModelOptions {
  /** Defaults to ANTHROPIC_MODEL or claude-opus-5-5. Must support tool use. */
  readonly model?: string;
  /**
   * Sent as x-api-key. Without an explicit apiKey or authToken, ANTHROPIC_API_KEY is
   * used at execution time, then ANTHROPIC_AUTH_TOKEN.
   */
  readonly apiKey?: string;
  /** Sent as Authorization: Bearer, for compatible servers and gateways that expect it. */
  readonly authToken?: string;
  /**
   * API root without the version path. Defaults to ANTHROPIC_BASE_URL or
   * https://api.anthropic.com; set it for any server that implements the Messages API.
   */
  readonly baseUrl?: string;
  /** Sent as output_config.effort. Omitted by default; null also omits it. */
  readonly reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
  /** Output cap for each request, including thinking; defaults to 32000 tokens. */
  readonly maxTokens?: number;
  /**
   * Send tools with strict: true (default). Unsupported constraints move into descriptions;
   * the harness still validates every argument. Disable for servers without strict tool use.
   */
  readonly strict?: boolean;
  /** Send top-level cache_control (default). Disable for servers that reject it. */
  readonly promptCaching?: boolean;
  /**
   * Compact above this history size (default 65536 bytes), or when the complete decision
   * exceeds the request limit. null never requests on-demand compaction.
   */
  readonly compactAfterBytes?: number | null;
  /** Combined deadline for compaction and decision requests; defaults to 600000 ms. */
  readonly timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const TOOL_RULE =
  "Respond only by calling tools. Call _finish alone with the final answer. Never mix _finish with tool calls.";
const SUMMARY_INSTRUCTIONS =
  "Summarize this agent conversation so the agent can continue the task. Preserve the task, decisions, file paths, commands run, verified results, failures, and remaining work. Do not call tools; respond with the summary text only.";
// `{"role":"user","content":[]}` plus a separator, rounded up.
const RESULT_MESSAGE_BYTES = 64;

/** Create a dependency-free Anthropic Messages model with native history and on-demand compaction. */
export function anthropicModel(options: AnthropicModelOptions = {}): AgentModel {
  const {
    model,
    apiKey,
    authToken,
    baseUrl,
    reasoningEffort = null,
    maxTokens = 32_000,
    strict = true,
    promptCaching = true,
    compactAfterBytes = 65_536,
    timeoutMs = 600_000,
  } = options;
  if (
    (compactAfterBytes !== null &&
      (!Number.isSafeInteger(compactAfterBytes) ||
        compactAfterBytes < 1 ||
        compactAfterBytes >= MAX_REQUEST_BYTES)) ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 1 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2_147_483_647 ||
    typeof strict !== "boolean" ||
    typeof promptCaching !== "boolean" ||
    (apiKey !== undefined && authToken !== undefined) ||
    (authToken !== undefined && (typeof authToken !== "string" || !authToken.trim())) ||
    (model !== undefined && (typeof model !== "string" || !model.trim())) ||
    (apiKey !== undefined && (typeof apiKey !== "string" || !apiKey.trim())) ||
    (baseUrl !== undefined && typeof baseUrl !== "string") ||
    (reasoningEffort !== null && !EFFORTS.includes(reasoningEffort))
  )
    throw new Error("Invalid Anthropic model configuration");
  if (baseUrl !== undefined) providerBaseUrl("Anthropic", baseUrl);
  return async (request, context) => {
    const selectedModel = (model ?? process.env.ANTHROPIC_MODEL)?.trim() || "claude-opus-5-5";
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
    const base = providerBaseUrl(
      "Anthropic",
      baseUrl ?? (process.env.ANTHROPIC_BASE_URL?.trim() || DEFAULT_BASE_URL)
    );
    throwIfAborted(signal, "Anthropic decision");
    // Validate descriptors before either compaction or a decision can perform I/O.
    const tools = [
      ...context.capabilities.map((tool) =>
        anthropicTool(tool.name, tool.description, "input", tool.inputJsonSchema, strict)
      ),
      anthropicTool(
        "_finish",
        "Finish with the final answer.",
        "result",
        context.resultJsonSchema,
        strict
      ),
    ];
    if (
      request.conversation !== null &&
      (!Array.isArray(request.conversation) || !request.conversation.every(record))
    )
      throw new Error("Invalid Anthropic conversation state");
    // A restored session starts a new prompt with no tool outcomes. Close _finish
    // before appending that prompt; the Messages API rejects a second user message.
    const newPrompt = context.turn === 1 && request.outcomes.length === 0;
    let messages: unknown[] =
      request.conversation === null
        ? []
        : newPrompt
          ? closeFinishedTools(request.conversation)
          : [...request.conversation];
    const withPrompt = (history: readonly unknown[]) =>
      newPrompt ? appendUserText(history, request.task) : [...history];
    const send = (endpointLabel: string, payload: { messages: unknown[] }, beta: boolean) =>
      providerRequest(
        "Anthropic",
        endpointLabel,
        `${base}/v1/messages`,
        {
          ...credentials(apiKey, authToken),
          "anthropic-version": "2023-06-01",
          ...(beta || carriesCompaction(payload.messages)
            ? { "anthropic-beta": COMPACTION_BETA }
            : {}),
        },
        payload,
        signal
      );
    const system = `${request.instructions}\n\n${TOOL_RULE}`;
    // Summaries read the same system prompt and tools as the conversation.
    const compactRequest = {
      model: selectedModel,
      max_tokens: maxTokens,
      system,
      tools,
      compaction: { type: "summarize", instructions: SUMMARY_INSTRUCTIONS },
      messages,
    };
    const decisionRequest = {
      model: selectedModel,
      max_tokens: maxTokens,
      ...(reasoningEffort === null ? {} : { output_config: { effort: reasoningEffort } }),
      ...(promptCaching ? { cache_control: { type: "ephemeral" } } : {}),
      system,
      tools,
      // Current models reject forced tool choice; the system rule and retry below steer instead.
      tool_choice: { type: "auto" },
      messages,
    };
    const results = (availableBytes: number) =>
      request.outcomes.length === 0
        ? []
        : [
            {
              role: "user",
              content: boundedToolOutputs(
                "Anthropic",
                request.outcomes,
                availableBytes - RESULT_MESSAGE_BYTES,
                (outcome, output) => ({
                  type: "tool_result",
                  tool_use_id: outcome.id,
                  content: output,
                  ...(outcome.ok ? {} : { is_error: true }),
                })
              ),
            },
          ];
    const history = [...messages, ...results(MAX_REQUEST_BYTES)];
    const completed = withPrompt(history);
    const shouldCompact =
      compactAfterBytes !== null &&
      (request.outcomes.length > 0 || (newPrompt && request.conversation !== null)) &&
      (Buffer.byteLength(JSON.stringify(completed)) > compactAfterBytes ||
        Buffer.byteLength(JSON.stringify({ ...decisionRequest, messages: completed })) >
          MAX_REQUEST_BYTES);
    // Compaction covers completed history only. The new prompt stays verbatim.
    const nextRequest = shouldCompact ? compactRequest : decisionRequest;
    const payload = shouldCompact ? history : completed;
    const fits =
      Buffer.byteLength(JSON.stringify({ ...nextRequest, messages: payload })) <= MAX_REQUEST_BYTES;
    messages = fits
      ? payload
      : [
          ...messages,
          ...results(MAX_REQUEST_BYTES - Buffer.byteLength(JSON.stringify(nextRequest))),
        ];
    if (shouldCompact) {
      const summary = anthropicMessage(
        await send("compaction", { ...compactRequest, messages }, true)
      );
      const [block] = summary.content;
      if (
        summary.stopReason === "compaction" &&
        summary.content.length === 1 &&
        block?.type === "compaction" &&
        typeof block.content === "string" &&
        typeof block.signature === "string"
      ) {
        // The returned assistant message replaces every message it covered, unchanged.
        // The summarized history ended with tool results, so a user turn must follow it.
        messages = [
          { role: "assistant", content: [block] },
          { role: "user", content: "Continue the task from this summary." },
        ];
        context.log.log("Compacted agent conversation");
      } else {
        context.log.log(`Anthropic compaction returned no summary (${summary.stopReason})`);
      }
    }
    if (newPrompt && (shouldCompact || !fits)) messages = withPrompt(messages);
    for (let attempt = 0; ; attempt++) {
      const response = anthropicMessage(
        await send("messages", { ...decisionRequest, messages }, false)
      );
      if (response.stopReason === "max_tokens")
        throw new Error("Anthropic response reached max_tokens; raise maxTokens");
      if (response.stopReason === "refusal") throw new Error("Anthropic refused the request");
      if (response.stopReason !== "tool_use" && response.stopReason !== "end_turn")
        throw new Error(`Anthropic stopped unexpectedly (${response.stopReason})`);
      if (response.content.length === 0) throw new Error("Anthropic returned empty content");
      // Keep every block, including thinking and signatures, exactly as returned.
      messages = [...messages, { role: "assistant", content: response.content }];
      const decision = anthropicDecision(response.content);
      if (decision) return { decision, conversation: messages };
      if (attempt > 0) throw new Error("Anthropic returned no tool calls");
      messages = [...messages, { role: "user", content: TOOL_RULE }];
    }
  };
}

/** Pair each pending `_finish` call with a tool_result so the next user prompt is valid. */
function closeFinishedTools(messages: readonly unknown[]): unknown[] {
  const last = messages.at(-1);
  if (!record(last) || last.role !== "assistant" || !Array.isArray(last.content))
    return [...messages];
  const uses = last.content.filter((block) => record(block) && block.type === "tool_use");
  if (uses.length === 0) return [...messages];
  if (uses.some((block) => block.name !== "_finish"))
    throw new Error("Anthropic conversation has unfinished tool calls");
  return [
    ...messages,
    {
      role: "user",
      content: uses.map((block) => ({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(
          record(block.input) && Object.hasOwn(block.input, "result")
            ? block.input.result
            : block.input
        ),
      })),
    },
  ];
}

/** Add a user prompt, extending a trailing user message so roles keep alternating. */
function appendUserText(messages: readonly unknown[], text: string): unknown[] {
  const last = messages.at(-1);
  if (record(last) && last.role === "user") {
    const content = Array.isArray(last.content)
      ? [...last.content, { type: "text", text }]
      : [
          { type: "text", text: last.content },
          { type: "text", text },
        ];
    return [...messages.slice(0, -1), { role: "user", content }];
  }
  return [...messages, { role: "user", content: text }];
}

function credentials(
  apiKey: string | undefined,
  authToken: string | undefined
): Record<string, string> {
  if (authToken !== undefined) return { Authorization: `Bearer ${authToken.trim()}` };
  const key = (apiKey ?? process.env.ANTHROPIC_API_KEY)?.trim();
  if (key) return { "x-api-key": key };
  const token = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
  if (token) return { Authorization: `Bearer ${token}` };
  throw new Error("ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is required for live model execution");
}
