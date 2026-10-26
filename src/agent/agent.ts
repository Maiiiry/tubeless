import type { StandardSchemaV1 } from "../core/pipeline-types.js";
import type { AgentDefinition, DefaultAgentToolName, Tools } from "./agent-types.js";
import { agentError } from "./agent-state.js";
import { compileAgent } from "./compile-agent.js";

export { pipelineTool } from "./pipeline-tool.js";
export { defineTool, ToolError } from "./tools.js";
export type { DefaultAgentTools } from "./default-tools.js";
export type {
  AgentCall,
  AgentDecision,
  AgentDecisionContext,
  AgentLimits,
  AgentOutcome,
  AgentState,
  AgentTool,
  AgentToolContext,
  CodemodeResult,
  DefaultAgentToolName,
} from "./agent-types.js";

export type {
  AgentEnvironment,
  AgentEnvironmentContext,
  AgentEnvironmentProvider,
  AgentProjectInstruction,
} from "./environment.js";

export { createMemoryAgentCheckpointStore } from "./memory-checkpoint-store.js";
export { plainAgentCheckpointCodec } from "./checkpoint-codec.js";
export type {
  AgentCheckpointLease,
  AgentCheckpointStore,
  AgentCheckpointCodec,
  AgentDurability,
  AgentExecutionIdentity,
} from "./checkpoint-types.js";

export { defineAgent } from "./model-agent.js";
export { createAgentSession, type AgentSession } from "./agent-session.js";
export type { AgentModel, AgentModelRequest, AgentModelResponse } from "./model-types.js";

/** Build a bounded in-process agent as an ordinary pipeline with one target, agent. */
export function defineAgentLoop<
  const Id extends string,
  const Options extends StandardSchemaV1<object, object>,
  const Result extends StandardSchemaV1,
  State,
  const Registry extends Tools = {},
  const Codemode extends boolean = false,
  const Defaults extends DefaultAgentToolName = DefaultAgentToolName,
>(definition: AgentDefinition<Id, Options, Result, State, Registry, Codemode, Defaults>) {
  const { decide, dryRun } = definition;
  if (typeof decide !== "function" || (dryRun !== undefined && typeof dryRun !== "function"))
    throw agentError(
      "TUBELESS_AGENT_INVALID_DEFINITION",
      "Agent requires callable decide/dryRun callbacks"
    );
  return compileAgent<Id, Options, Result, State, Registry, Codemode, Defaults>({
    ...definition,
    decide: async (state, context) => ({ decision: await decide(state, context), state }),
    dryRun:
      dryRun && (async (state, context) => ({ decision: await dryRun(state, context), state })),
  });
}
