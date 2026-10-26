import type { AgentDecisionContext, AgentOutcome, Awaitable, Tools } from "./agent-types.js";

/** Per-run provider context and the latest ordered tool outcomes, never executable handlers. */
export interface AgentModelRequest {
  readonly instructions: string;
  readonly task: string;
  /** Provider-owned plain data; null at the start of a fresh conversation. */
  readonly conversation: unknown;
  readonly outcomes: readonly AgentOutcome<Tools>[];
}

/** An untrusted decision and complete plain-data conversation, including any final answer. */
export interface AgentModelResponse {
  readonly decision: unknown;
  readonly conversation: unknown;
}

/** Pluggable model transport; the harness owns and isolates its returned conversation per run. */
export type AgentModel = (
  request: AgentModelRequest,
  context: AgentDecisionContext<object>
) => Awaitable<AgentModelResponse>;
