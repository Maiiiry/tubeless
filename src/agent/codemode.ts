import { invokeChildPipeline } from "../core/child-execution.js";
import { createSingleChildProgress } from "../core/child-progress.js";
import { createSteps, definePipeline } from "../core/pipeline.js";
import { PipelineExecutionError } from "../core/pipeline-execution-error.js";
import { STEP_ORCHESTRATION } from "../core/pipeline-step-metadata.js";
import type { PipelineStepContext } from "../core/pipeline-types.js";
import {
  wireArray,
  wireBoolean,
  wireCustom,
  wireRefine,
  wireString,
} from "../tracing/wire-schema.js";
import { agentError } from "./agent-state.js";
import { codemodeDeclarations } from "./codemode-declarations.js";
import type { CodemodeReply } from "./codemode-protocol.js";
import { callInvocation, prepareCalls, type PreparedCall } from "./decision.js";
import { MAX_OUTPUT_BYTES } from "./default-tool-limits.js";
import { toolObject } from "./default-tool-schema.js";
import { agentScope } from "./execution-scope.js";
import { expectedToolFailure } from "./tool-failure.js";
import { startToolActivity, type ToolActivity } from "./tool-progress.js";
import {
  ToolError,
  type CompiledHandlerTool,
  type CompiledTool,
  type ToolInvocation,
} from "./tools.js";

/** The single model-facing capability of a code-mode agent. */
export const CODEMODE_TOOL = "codemode";

const MAX_CODE_LENGTH = 65_536;
const MAX_DECLARATION_BYTES = 49_152;
const MAX_LOG_LINES = 200;
const MAX_LOG_BYTES = 4096;
const TIMEOUT_MS = 60_000;

const utf8 = (text: string) => new TextEncoder().encode(text).length;

const usage = `Run a JavaScript async function body that calls tools and returns a JSON value.
Call tools as \`await tools.name(input)\`; quote names that are not identifiers, as in \`tools["server__a-b"](input)\`. Chain dependent calls, loops and filtering in one script, and \`return\` only what you need (at most ${MAX_OUTPUT_BYTES} bytes of JSON). console.log output is returned as logs.
A failed call throws an Error with code and message; catch it to recover inside the script.
Write plain JavaScript: no TypeScript syntax, import, require, timers, fetch or process. Scripts time out after ${TIMEOUT_MS / 1000} seconds.

Available tools:`;

const inputSchema = toolObject({ code: wireString({ maxLength: MAX_CODE_LENGTH }) });
const inputJsonSchema = Object.freeze({
  type: "object",
  properties: Object.freeze({
    code: Object.freeze({
      type: "string",
      minLength: 1,
      maxLength: MAX_CODE_LENGTH,
      description: "JavaScript async function body; use return for the result.",
    }),
  }),
  required: Object.freeze(["code"]),
  additionalProperties: false,
});

const jsonResult = wireCustom<unknown>({}, (value, path) => {
  const text = JSON.stringify(value);
  if (text === undefined || utf8(text) > MAX_OUTPUT_BYTES)
    throw new Error(`${path} must be JSON of at most ${MAX_OUTPUT_BYTES} UTF-8 bytes`);
  return value;
});
const logLines = wireRefine(
  wireArray(wireString({ allowEmpty: true }), { maxItems: MAX_LOG_LINES }),
  (lines, path) => {
    if (utf8(lines.join("\n")) > MAX_LOG_BYTES)
      throw new Error(`${path} must hold at most ${MAX_LOG_BYTES} UTF-8 bytes`);
  }
);
const outputSchema = toolObject({
  result: jsonResult,
  logs: logLines,
  logsTruncated: wireBoolean(),
});

type ScriptResult = { result: unknown; logs: string[]; logsTruncated: boolean };
type ScriptOutcome =
  | { readonly ok: true; readonly value: ScriptResult }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Keep complete lines within the byte budget; report whether any were dropped. */
function boundedLogs(lines: readonly string[]): { logs: string[]; truncated: boolean } {
  const logs: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const size = utf8(line) + (logs.length === 0 ? 0 : 1);
    if (logs.length >= MAX_LOG_LINES || bytes + size > MAX_LOG_BYTES)
      return { logs, truncated: true };
    logs.push(line);
    bytes += size;
  }
  return { logs, truncated: false };
}

const errorText = (message: string, logs: readonly string[]) =>
  (logs.length === 0 ? message : `${message}\nLogs:\n${logs.join("\n")}`).slice(0, 4096);

function lineCount(code: string) {
  const lines = code.split("\n").length;
  return `${lines} ${lines === 1 ? "line" : "lines"}`;
}

function publish(outcome: ScriptOutcome): ScriptResult {
  if (!outcome.ok) throw new ToolError(outcome.code, outcome.message);
  return outcome.value;
}

/**
 * Compile the code-mode capability over an agent's registry. The model sees only this tool;
 * its script reaches every registered tool through the same preparation, admission and child
 * execution as a direct call, so nested calls are budgeted, cancellable and recorded.
 */
export function compileCodemodeTool(
  agentId: string,
  registry: ReadonlyMap<string, CompiledTool>
): CompiledHandlerTool {
  if (registry.has(CODEMODE_TOOL))
    throw agentError(
      "TUBELESS_AGENT_INVALID_DEFINITION",
      `Code mode reserves the ${CODEMODE_TOOL} tool name`
    );
  const tools = [...registry.values()];
  const declarations = codemodeDeclarations(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputJsonSchema: tool.inputJsonSchema,
      outputJsonSchema: tool.kind === "handler" ? tool.outputJsonSchema : undefined,
    }))
  );
  if (utf8(declarations) > MAX_DECLARATION_BYTES)
    throw agentError(
      "TUBELESS_AGENT_INVALID_DEFINITION",
      `Code mode tool declarations exceed ${MAX_DECLARATION_BYTES} UTF-8 bytes; expose fewer tools, for example with MCP tool allowlists`
    );
  const names = tools.map(({ name }) => name);
  const { step } = createSteps<ToolInvocation>();
  // Dry runs execute the script too; each script call follows its tool's own dry-run policy.
  const runScript = async (
    context: PipelineStepContext<ToolInvocation>
  ): Promise<ScriptOutcome> => {
    const { call, attributes } = context.options;
    // SAFETY: prepareCalls validated this invocation's input against inputSchema.
    const { code } = context.options.input as { code: string };
    context.reportAttempt(1, attributes);
    const scope = agentScope(context)!;
    let calls = 0;
    const activity = startToolActivity(
      {
        action: () => `Run script (${lineCount(code)})`,
        summarize: (result: ScriptResult) =>
          `${calls} tool ${calls === 1 ? "call" : "calls"}, ${result.logs.length} log ${result.logs.length === 1 ? "line" : "lines"}`,
      },
      context.options.input,
      {
        ...context,
        options: {},
        environment: scope.environment,
        execution: context.options.execution,
      }
    );
    context.options.onActivity?.(activity);
    context.log.log(code.length > MAX_OUTPUT_BYTES ? `${code.slice(0, MAX_OUTPUT_BYTES)}…` : code);
    const dispatch = async (
      name: string,
      input: unknown,
      signal: AbortSignal
    ): Promise<CodemodeReply> => {
      const id = `${call.id}.${++calls}`;
      const nested: PipelineStepContext<object> = { ...context, signal };
      let prepared: PreparedCall;
      try {
        [prepared] = (await prepareCalls(
          [{ id, tool: name, input }],
          registry,
          nested,
          call.turn
        )) as [PreparedCall];
      } catch (error) {
        if (signal.aborted || (error as { code?: unknown }).code === "TUBELESS_AGENT_LIMIT_REACHED")
          throw error;
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, code: "CODEMODE_INVALID_CALL", message: message.slice(0, 4096) };
      }
      await scope.admitNestedCall(signal);
      let started: ToolActivity | undefined;
      const invocation = callInvocation(prepared, nested, {
        turn: call.turn,
        attributes: {
          ...attributes,
          "agent.callId": id,
          "agent.tool": name,
          "agent.parentAttemptId": context.attemptId,
        },
        execution: scope.identity(call.turn, id),
        onActivity: (activity) => {
          started = activity;
        },
      });
      const run = await invokeChildPipeline(
        prepared.tool.pipeline,
        invocation.options,
        invocation.context,
        {
          stepId: "script",
          plan: prepared.plan,
          hooks: createSingleChildProgress(prepared.plan, context.reportProgress),
          itemKey: id,
          preparedOptions: invocation.preparedOptions,
        }
      );
      if (run.status === "completed" && run.finalized) {
        const label = started?.complete(run.value);
        if (label !== undefined) context.log.log(label);
        return { ok: true, value: run.value };
      }
      const expected = !signal.aborted && expectedToolFailure(run);
      if (!expected) throw new PipelineExecutionError(run);
      if (started) context.log.warn(`${started.action}: failed`);
      return { ok: false, ...expected };
    };
    const { runCodemodeScript } = await import("./codemode-sandbox.js");
    const outcome = await runCodemodeScript({
      code,
      tools: names,
      timeoutMs: TIMEOUT_MS,
      maxLogLines: MAX_LOG_LINES,
      maxLogCharacters: MAX_LOG_BYTES,
      signal: context.signal,
      call: dispatch,
    });
    if (!outcome.ok)
      return {
        ok: false,
        code: outcome.code,
        message: errorText(outcome.message, outcome.logs),
      };
    const bytes = utf8(outcome.result);
    if (bytes > MAX_OUTPUT_BYTES)
      return {
        ok: false,
        code: "CODEMODE_RESULT_TOO_LARGE",
        message: `Script returned ${bytes} bytes of JSON; return at most ${MAX_OUTPUT_BYTES}. Its ${calls} tool calls already ran.`,
      };
    const { logs, truncated } = boundedLogs(outcome.logs);
    return {
      ok: true,
      value: {
        result: JSON.parse(outcome.result),
        logs,
        logsTruncated: outcome.logsTruncated || truncated,
      },
    };
  };
  const script = step("script", {
    name: "Run script",
    description: "Run the script in a sandbox and dispatch its tool calls as child runs.",
    run: (_inputs, context) => runScript(context),
    dryRun: (_inputs, context) => runScript(context),
  });
  // The script holds no leaf permit while its nested handlers wait for admission.
  Object.defineProperty(script, STEP_ORCHESTRATION, { value: true });
  const result = step("result", {
    name: "Script result",
    description: "Publish the validated script result, or its recoverable failure.",
    dependsOn: [script],
    outputSchema,
    run: ({ script: outcome }) => publish(outcome),
    dryRun: ({ script: outcome }) => publish(outcome),
  });
  return {
    kind: "handler",
    replay: tools.every((tool) => tool.replay === "safe") ? "safe" : "unsafe",
    name: CODEMODE_TOOL,
    description: `${usage}\n${declarations}`,
    inputSchema,
    inputJsonSchema,
    pipeline: definePipeline({
      id: `${agentId}/tool/${CODEMODE_TOOL}`,
      steps: [script, result],
      finalize: result,
    }),
  };
}
