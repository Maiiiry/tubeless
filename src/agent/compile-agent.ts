import { createSteps, definePipeline } from "../core/pipeline.js";
import { STEP_AGENT } from "../core/pipeline-step-metadata.js";
import type {
  Pipeline,
  PipelineDefinitionSnapshot,
  StandardSchemaV1,
} from "../core/pipeline-types.js";
import type { AnyStep } from "../core/pipeline-steps.js";
import { agentError, checkSchema, descriptorFingerprint, jsonDescriptor } from "./agent-state.js";
import { compileTool, type CompiledTool } from "./tools.js";
import { CODEMODE_TOOL, compileCodemodeTool } from "./codemode.js";
import { defaultTools } from "./default-tools.js";
import { resolvedLimits, agentScope } from "./execution-scope.js";
import { createAgentTurn, type TurnState } from "./turn.js";
import { initialAgentExecution, runAgentInvocation } from "./invocation.js";
import { markAgent } from "./agent-identity.js";
import type {
  AgentDefinition,
  AgentDecisionContext,
  AgentState,
  Awaitable,
  DefaultAgentToolName,
  Input,
  Output,
  Tools,
} from "./agent-types.js";

/** Accept raw or already-owned pending state; the turn snapshots it before tools run. */
export type RuntimeAgentDefinition<
  Id extends string,
  Options extends StandardSchemaV1<object, object>,
  Result extends StandardSchemaV1,
  State,
  Registry extends Tools,
  Codemode extends boolean = boolean,
  Defaults extends DefaultAgentToolName = DefaultAgentToolName,
> = Omit<
  AgentDefinition<Id, Options, Result, State, Registry, Codemode, Defaults>,
  "decide" | "dryRun"
> & {
  decide(
    state: AgentState<State>,
    context: AgentDecisionContext<Output<Options>>
  ): Awaitable<{
    decision: unknown;
    state: State | AgentState<State>;
  }>;
  dryRun?(
    state: AgentState<State>,
    context: AgentDecisionContext<Output<Options>>
  ): Awaitable<{
    decision: unknown;
    state: State | AgentState<State>;
  }>;
};

export function compileAgent<
  const Id extends string,
  const Options extends StandardSchemaV1<object, object>,
  const Result extends StandardSchemaV1,
  State,
  const Registry extends Tools = {},
  const Codemode extends boolean = false,
  const Defaults extends DefaultAgentToolName = DefaultAgentToolName,
>(
  definition: RuntimeAgentDefinition<Id, Options, Result, State, Registry, Codemode, Defaults>,
  resolveCwd = false
): Pipeline<Input<Options>, Output<Result>, "agent", "agent", Id> & {
  readonly optionsSchema: Options;
  readonly definition: PipelineDefinitionSnapshot;
} {
  const config = { ...definition };
  if (
    config.durability &&
    (typeof config.implementationVersion !== "string" || !config.implementationVersion.trim())
  )
    throw agentError(
      "TUBELESS_AGENT_INVALID_DEFINITION",
      "Durable agents require an explicit implementationVersion"
    );
  checkSchema(config.inputSchema, "Agent input");
  if (
    typeof config.initialState !== "function" ||
    typeof config.decide !== "function" ||
    (config.reduce !== undefined && typeof config.reduce !== "function") ||
    (config.codemode !== undefined && typeof config.codemode !== "boolean") ||
    (config.dryRun !== undefined && typeof config.dryRun !== "function")
  )
    throw agentError(
      "TUBELESS_AGENT_INVALID_DEFINITION",
      "Agent requires initialState and decide callbacks, callable reduce/dryRun and a boolean codemode when supplied"
    );
  const limits = resolvedLimits(config.limits);
  const resultJsonSchema = jsonDescriptor(
    config.resultSchema,
    config.resultJsonSchema,
    "Agent result"
  );
  const selected = config.defaultTools ?? (Object.keys(defaultTools) as DefaultAgentToolName[]);
  if (
    !Array.isArray(selected) ||
    selected.some((name) => typeof name !== "string" || !Object.hasOwn(defaultTools, name))
  )
    throw agentError(
      "TUBELESS_AGENT_INVALID_DEFINITION",
      `defaultTools must list standard tools: ${Object.keys(defaultTools).join(", ")}`
    );
  const standard = Object.fromEntries(selected.map((name) => [name, defaultTools[name]]));
  const entries = Object.entries({ ...standard, ...config.tools }).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  if (entries.length > 4096)
    throw agentError(
      "TUBELESS_AGENT_INVALID_DEFINITION",
      "Agent capability inventory exceeds 4096 tools"
    );
  const tools = new Map(
    entries.map(([name, tool]) => {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(name))
        throw agentError("TUBELESS_AGENT_INVALID_DEFINITION", `Invalid tool name: ${name}`);
      return [name, compileTool(config.id, name, tool)];
    })
  );
  const registry: ReadonlyMap<string, CompiledTool> = config.codemode
    ? new Map([[CODEMODE_TOOL, compileCodemodeTool(config.id, tools)]])
    : tools;
  const capabilities = Object.freeze(
    [...registry.values()].map(({ name, description, inputJsonSchema }) =>
      Object.freeze({ name, description, inputJsonSchema })
    )
  );
  const turn = createAgentTurn(config, registry, limits, { capabilities, resultJsonSchema });
  const { iteratePipeline } = createSteps(config.inputSchema);
  const agent = iteratePipeline("agent", {
    name: "Agent",
    pipeline: turn,
    maxIterations: limits.maxTurns,
    dryRun: config.dryRun ? undefined : "skip",
    initialState: (_inputs, context): TurnState<State> => {
      const scope = agentScope(context)!;
      return initialAgentExecution(
        () => config.initialState(context.options),
        scope.journal?.agent(scope.agentKey)?.execution
      );
    },
    mapOptions: (execution, _inputs, context) => ({
      execution,
      options: context.options,
      agentRunId: context.runId,
    }),
    transition: (result) => result,
  });
  const compiledAgent: AnyStep<Output<Options>> = agent;
  const run = compiledAgent.run;
  compiledAgent.run = (inputs, context) =>
    runAgentInvocation(
      { ...config, limits, resolveCwd, definition: pipeline.definition },
      context,
      (scoped) => run(inputs, scoped)
    );
  Object.defineProperty(agent, STEP_AGENT, {
    value: Object.freeze({
      limits,
      resultSchemaFingerprint: descriptorFingerprint(resultJsonSchema),
      capabilities: Object.freeze(
        [...registry.values()].map((tool) =>
          Object.freeze({
            name: tool.name,
            description: tool.description,
            inputSchemaFingerprint: descriptorFingerprint(tool.inputJsonSchema),
            identity: tool.pipeline.definition.identity,
          })
        )
      ),
    }),
  });
  const pipeline = definePipeline({
    id: config.id,
    name: config.name,
    description: config.description,
    implementationVersion: config.implementationVersion,
    steps: [compiledAgent],
    finalize: compiledAgent,
  });
  markAgent(pipeline);
  // SAFETY: the sole iteration step inherits Options, publishes the once-validated Result,
  // and is the only target. This restores deferred generic inference at the factory boundary.
  return pipeline as unknown as Pipeline<Input<Options>, Output<Result>, "agent", "agent", Id> & {
    readonly optionsSchema: Options;
    readonly definition: PipelineDefinitionSnapshot;
  };
}
