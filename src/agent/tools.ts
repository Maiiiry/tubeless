import { compilePipelineTool } from "./pipeline-tool.js";
import { createSteps, definePipeline } from "../core/pipeline.js";
import type {
  Pipeline,
  PipelineDefinitionSnapshot,
  PipelineStepContext,
  StandardSchemaV1,
} from "../core/pipeline-types.js";
import {
  agentError,
  checkDescription,
  checkSchema,
  jsonDescriptor,
  ownState,
} from "./agent-state.js";
import { agentScope } from "./execution-scope.js";
import { startToolActivity, type ToolActivity, type ToolActivityFormat } from "./tool-progress.js";
import type { AgentTool, AgentToolContext, Awaitable, Input, Output } from "./agent-types.js";

/** A handler may throw this error to return a recoverable observation to its agent. */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ToolError";
    if (!code.trim() || code.length > 256 || message.length > 4096)
      throw new Error(
        "ToolError requires a nonblank code (up to 256 characters) and a message of at most 4096 characters"
      );
  }
}

interface ToolDefinition<Arguments extends StandardSchemaV1, Result extends StandardSchemaV1> {
  readonly description: string;
  readonly inputSchema: Arguments;
  readonly outputSchema: Result;
  readonly inputJsonSchema?: Readonly<Record<string, unknown>>;
  /** May an interrupted handler rerun? Defaults to unsafe. */
  readonly replay?: "safe" | "unsafe";
  run(input: Output<Arguments>, context: AgentToolContext): Awaitable<Input<Result>>;
  readonly dryRun?:
    | "skip"
    | ((input: Output<Arguments>, context: AgentToolContext) => Awaitable<Input<Result>>);
}

const tools = new WeakMap<
  object,
  ToolDefinition<StandardSchemaV1, StandardSchemaV1> & {
    inputJsonSchema: Readonly<Record<string, unknown>>;
    activity?: ToolActivityFormat;
  }
>();

/** Declare a validated handler capability; tools skip live work in dry runs by default. */
export function defineTool<
  const Arguments extends StandardSchemaV1,
  const Result extends StandardSchemaV1,
>(definition: ToolDefinition<Arguments, Result>): AgentTool<Input<Arguments>, Output<Result>> {
  return createTool(definition);
}

/** Internal workspace presentation; keep formatter callbacks out of the public tool API. */
export function defineToolWithActivity<
  const Arguments extends StandardSchemaV1,
  const Result extends StandardSchemaV1,
>(
  definition: ToolDefinition<Arguments, Result> &
    ToolActivityFormat<Output<Arguments>, Output<Result>>
): AgentTool<Input<Arguments>, Output<Result>> {
  return createTool(definition, definition);
}

function createTool<Arguments extends StandardSchemaV1, Result extends StandardSchemaV1>(
  definition: ToolDefinition<Arguments, Result>,
  activity?: ToolActivityFormat<Output<Arguments>, Output<Result>>
): AgentTool<Input<Arguments>, Output<Result>> {
  checkDescription(definition.description);
  checkSchema(definition.outputSchema, "Tool output");
  if (
    typeof definition.run !== "function" ||
    (definition.dryRun !== undefined &&
      definition.dryRun !== "skip" &&
      typeof definition.dryRun !== "function") ||
    (definition.replay !== undefined &&
      definition.replay !== "safe" &&
      definition.replay !== "unsafe")
  )
    throw agentError(
      "TUBELESS_AGENT_INVALID_DEFINITION",
      "Tool requires a handler and a valid dry-run policy"
    );
  const inputJsonSchema = jsonDescriptor(
    definition.inputSchema,
    definition.inputJsonSchema,
    "Tool input"
  );
  // SAFETY: the private WeakMap brands this opaque descriptor and keeps its validators/handlers.
  const tool = Object.freeze({}) as AgentTool<Input<Arguments>, Output<Result>>;
  tools.set(tool, { ...definition, inputJsonSchema, activity });
  return tool;
}

export interface ToolInvocation {
  input: unknown;
  /** The dispatching turn and turn-local call ID, independent of tracing attributes. */
  call: { readonly turn: number; readonly id: string };
  execution: AgentToolContext["execution"];
  attributes: Readonly<Record<string, string | number>>;
  onActivity?(activity: ToolActivity): void;
}

/** A validated handler capability compiled to a private pipeline over one invocation. */
export interface CompiledHandlerTool {
  readonly kind: "handler";
  readonly replay: "safe" | "unsafe";
  readonly name: string;
  readonly description: string;
  readonly inputSchema: StandardSchemaV1;
  readonly inputJsonSchema: Readonly<Record<string, unknown>>;
  /** Best-effort result descriptor for generated code-mode declarations. */
  readonly outputJsonSchema?: Readonly<Record<string, unknown>>;
  readonly pipeline: Pipeline<ToolInvocation, unknown> & {
    readonly definition: PipelineDefinitionSnapshot;
  };
}

/** Read an output descriptor when the schema offers one; declarations fall back to unknown. */
function outputDescriptor(schema: StandardSchemaV1): Readonly<Record<string, unknown>> | undefined {
  const converter: { output?: unknown; input?: unknown } | undefined =
    schema["~standard"].jsonSchema;
  for (const convert of [converter?.output, converter?.input]) {
    if (typeof convert !== "function") continue;
    try {
      const descriptor: unknown = convert({ target: "draft-2020-12" });
      if (descriptor !== null && typeof descriptor === "object" && !Array.isArray(descriptor))
        // SAFETY: the object guard and owned plain-data copy validate the descriptor's representation.
        return ownState(descriptor as Record<string, unknown>);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function compileTool(
  agentId: string,
  name: string,
  tool: AgentTool<unknown, unknown>
): CompiledHandlerTool | NonNullable<ReturnType<typeof compilePipelineTool>> {
  const pipelineTool = compilePipelineTool(name, tool);
  if (pipelineTool) return pipelineTool;
  const definition = tools.get(tool);
  if (!definition)
    throw agentError(
      "TUBELESS_AGENT_INVALID_DEFINITION",
      `Tool ${name} must come from defineTool or pipelineTool`
    );
  const {
    run,
    dryRun,
    inputSchema,
    outputSchema,
    inputJsonSchema,
    description,
    replay = "unsafe",
    activity,
  } = definition;
  const invoke = async (handler: typeof run, context: PipelineStepContext<ToolInvocation>) => {
    context.reportAttempt(1, context.options.attributes);
    const scope = agentScope(context)!;
    const toolContext = {
      ...context,
      options: {},
      environment: scope.environment,
      execution: context.options.execution,
    };
    if (activity)
      context.options.onActivity?.(startToolActivity(activity, context.options.input, toolContext));
    return handler(context.options.input, toolContext);
  };
  const { step } = createSteps<ToolInvocation>();
  const call = step("tool", {
    name,
    description,
    outputSchema,
    run: (_inputs, context) => invoke(run, context),
    dryRun: typeof dryRun === "function" ? (_inputs, context) => invoke(dryRun, context) : "skip",
  });
  return {
    kind: "handler",
    replay,
    name,
    description,
    inputSchema,
    inputJsonSchema,
    outputJsonSchema: outputDescriptor(outputSchema),
    pipeline: definePipeline({ id: `${agentId}/tool/${name}`, steps: [call], finalize: call }),
  };
}

export type CompiledTool = ReturnType<typeof compileTool>;
