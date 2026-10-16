import type { AgentModelRequest } from "./model-types.js";
import { boundedToolOutputs } from "./provider-tool-outputs.js";

/** Bound provider-visible results, including outer JSON escaping and item separators. */
export function openaiToolOutputs(outcomes: AgentModelRequest["outcomes"], availableBytes: number) {
  return boundedToolOutputs("OpenAI", outcomes, availableBytes, (outcome, output) => ({
    type: "function_call_output" as const,
    call_id: outcome.id,
    output,
  }));
}
