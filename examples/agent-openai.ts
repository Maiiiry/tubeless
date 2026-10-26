import { defineAgentLoop, type AgentOutcome } from "tubeless/agent";
import { definePipelineCommand } from "tubeless/cli";
import { textAnswer, textOptions, textTools } from "./agent.js";
import { openaiDecision } from "./agent-openai-decision.js";

interface State {
  question: string;
  observations: readonly AgentOutcome<typeof textTools>[];
}

export const OpenAIAgent = defineAgentLoop({
  id: "openai-agent",
  name: "OpenAI text agent",
  description: "Let a model select text tools, observe their results, and finish the task.",
  implementationVersion: "openai-text-v2",
  inputSchema: textOptions,
  resultSchema: textAnswer,
  tools: textTools,
  limits: { maxTurns: 6, maxDecisions: 6, maxCalls: 12, maxConcurrency: 3 },
  initialState: ({ question }): State => {
    if (Buffer.byteLength(question, "utf8") > 4096)
      throw new Error("Question exceeds 4096 UTF-8 bytes");
    return { question, observations: [] };
  },
  decide: openaiDecision,
  reduce: (state, outcomes) => {
    const observations = [...state.observations, ...outcomes];
    if (Buffer.byteLength(JSON.stringify(observations), "utf8") > 16_384)
      throw new Error("Observation history exceeds 16384 UTF-8 bytes");
    return { ...state, observations };
  },
  // No preview model: dry runs skip this agent and produce no final answer.
});

export const OpenAIAgentCommand = definePipelineCommand(OpenAIAgent, {
  summarize: ({ answer }) => [answer],
});
