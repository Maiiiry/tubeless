import type { AgentModel } from "./model-types.js";
import { openaiRequest } from "./openai-http.js";
import { MAX_REQUEST_BYTES, providerBaseUrl } from "./provider-http.js";
import { record } from "./provider-schema.js";
import { openaiDecision, outputItems, parameter } from "./openai-protocol.js";
import { openaiToolOutputs } from "./openai-tool-outputs.js";
import { throwIfAborted } from "../utilities/abort.js";

/** Responses transport settings; credentials are resolved only when a decision executes. */
export interface OpenAIModelOptions {
  /** Defaults to OPENAI_MODEL or gpt-5.4-mini. Must support Responses function calling and compaction. */
  readonly model?: string;
  /** Defaults to OPENAI_API_KEY at execution time. */
  readonly apiKey?: string;
  /**
   * Responses API root, including the version path. Defaults to OPENAI_BASE_URL or
   * https://api.openai.com/v1; set it for any server that implements the Responses API.
   */
  readonly baseUrl?: string;
  /** Omitted by default. Set explicitly for models that support reasoning; null also omits it. */
  readonly reasoningEffort?:
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max"
    | null;
  /**
   * Compact above this history size (default 65536 bytes), or when the complete decision
   * exceeds the request limit. null never calls /responses/compact, for servers without it.
   */
  readonly compactAfterBytes?: number | null;
  /** Combined deadline for compaction and decision requests; defaults to 60000 ms. */
  readonly timeoutMs?: number;
}

/** Create a dependency-free OpenAI Responses model with native history and automatic compaction. */
export function openaiModel(options: OpenAIModelOptions = {}): AgentModel {
  const {
    model,
    apiKey,
    baseUrl,
    reasoningEffort = null,
    compactAfterBytes = 65_536,
    timeoutMs = 60_000,
  } = options;
  if (
    (compactAfterBytes !== null &&
      (!Number.isSafeInteger(compactAfterBytes) ||
        compactAfterBytes < 1 ||
        compactAfterBytes >= MAX_REQUEST_BYTES)) ||
    (baseUrl !== undefined && typeof baseUrl !== "string") ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2_147_483_647 ||
    (model !== undefined && (typeof model !== "string" || !model.trim())) ||
    (apiKey !== undefined && (typeof apiKey !== "string" || !apiKey.trim())) ||
    (reasoningEffort !== null &&
      !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(reasoningEffort))
  )
    throw new Error("Invalid OpenAI model configuration");
  if (baseUrl !== undefined) providerBaseUrl("OpenAI", baseUrl);
  return async (request, context) => {
    const selectedModel = (model ?? process.env.OPENAI_MODEL)?.trim() || "gpt-5.4-mini";
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
    throwIfAborted(signal, "OpenAI decision");
    // Validate descriptors before either compaction or a decision can perform I/O.
    const tools = [
      ...context.capabilities.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: parameter("input", tool.inputJsonSchema, `tool ${tool.name}`),
        strict: true,
      })),
      {
        type: "function",
        name: "_finish",
        description: "Finish with the final answer.",
        parameters: parameter("result", context.resultJsonSchema, "tool _finish"),
        strict: true,
      },
    ];
    if (
      request.conversation !== null &&
      (!Array.isArray(request.conversation) || !request.conversation.every(record))
    )
      throw new Error("Invalid OpenAI conversation state");
    const newPrompt = context.turn === 1 && request.outcomes.length === 0;
    let input: unknown[] = request.conversation === null ? [] : [...request.conversation];
    if (request.conversation === null || newPrompt)
      input.push({ role: "user", content: request.task });
    const compactRequest = { model: selectedModel, instructions: request.instructions, input };
    const decisionRequest = {
      model: selectedModel,
      store: false,
      ...(reasoningEffort === null ? {} : { reasoning: { effort: reasoningEffort } }),
      include: ["reasoning.encrypted_content"],
      max_output_tokens: 8192,
      instructions: `${request.instructions}\n\nCall _finish alone with the final answer. Never mix _finish with tool calls.`,
      input,
      tools,
      tool_choice: "required",
      parallel_tool_calls: true,
    };
    const completedInput = [...input, ...openaiToolOutputs(request.outcomes, MAX_REQUEST_BYTES)];
    const shouldCompact =
      compactAfterBytes !== null &&
      (request.outcomes.length > 0 || (newPrompt && request.conversation !== null)) &&
      (Buffer.byteLength(JSON.stringify(completedInput)) > compactAfterBytes ||
        Buffer.byteLength(JSON.stringify({ ...decisionRequest, input: completedInput })) >
          MAX_REQUEST_BYTES);
    // Compaction sends no tool schemas. Budget against the request actually sent,
    // then check the decision with the returned compacted window at the HTTP boundary.
    const nextRequest = shouldCompact ? compactRequest : decisionRequest;
    input =
      Buffer.byteLength(JSON.stringify({ ...nextRequest, input: completedInput })) <=
      MAX_REQUEST_BYTES
        ? completedInput
        : [
            ...input,
            ...openaiToolOutputs(
              request.outcomes,
              MAX_REQUEST_BYTES - Buffer.byteLength(JSON.stringify(nextRequest))
            ),
          ];
    if (shouldCompact) {
      // Keep the new user request verbatim, outside the completed history window.
      if (newPrompt) input = input.slice(0, -1);
      const compacted = await openaiRequest(
        "responses/compact",
        { ...compactRequest, input },
        apiKey,
        signal,
        baseUrl
      );
      if (!record(compacted) || compacted.object !== "response.compaction")
        throw new Error("OpenAI returned invalid compaction");
      input = outputItems(compacted);
      if (input.length === 0) throw new Error("OpenAI returned empty compaction");
      if (newPrompt) input.push({ role: "user", content: request.task });
      context.log.log("Compacted agent conversation");
    }
    const body = await openaiRequest(
      "responses",
      { ...decisionRequest, input },
      apiKey,
      signal,
      baseUrl
    );
    if (!record(body) || body.status !== "completed")
      throw new Error("OpenAI did not return a completed response");
    const output = outputItems(body);
    const decision = openaiDecision(output);
    const conversation = [...input, ...output];
    // A completed user prompt may be continued later. Close the adapter's
    // synthetic tool call before another user message enters native history.
    const finish = output.find((item) => item.type === "function_call" && item.name === "_finish");
    if (finish)
      conversation.push({
        type: "function_call_output",
        call_id: finish.call_id,
        output: JSON.stringify(decision.result),
      });
    return { decision, conversation };
  };
}
