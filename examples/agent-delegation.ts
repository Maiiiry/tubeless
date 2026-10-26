import { createSteps, definePipeline } from "tubeless";
import { defineAgentLoop, pipelineTool, type AgentDecision } from "tubeless/agent";
import { definePipelineCommand } from "tubeless/cli";
import { ScriptedAgent, textAnswer, textOptions } from "./agent.js";

const { step } = createSteps<{ text: string }>();
const summarize = step("summarize", {
  description: "Format the collected child answers.",
  run: (_inputs, context) => `Summary: ${context.options.text}`,
});
const summary = definePipeline({ id: "agent-summary", steps: [summarize], finalize: summarize });

const tools = {
  processWord: pipelineTool(ScriptedAgent, {
    description: "Count and uppercase one word using a child agent with its own state and tools.",
  }),
  summarize: pipelineTool(summary, {
    description: "Format the collected answers after the child agents finish.",
    inputSchema: textOptions,
    mapOptions: ({ question }) => ({ text: question }),
  }),
};
interface State {
  question: string;
  answers: readonly string[];
  summary?: string;
}

function decide(state: Readonly<State>): AgentDecision<typeof tools, string> {
  if (state.summary !== undefined) return { kind: "finish", result: state.summary };
  if (state.answers.length > 0)
    return {
      kind: "continue",
      calls: [{ id: "summary", tool: "summarize", input: { question: state.answers.join(" | ") } }],
    };
  const words = state.question.split(/\s+/).filter(Boolean);
  const [first = "", ...rest] = words;
  return {
    kind: "continue",
    calls: [
      { id: "word-0", tool: "processWord", input: { question: first } },
      ...rest.map((question, index) => ({
        id: `word-${index + 1}`,
        tool: "processWord" as const,
        input: { question },
      })),
    ],
  };
}

export const DelegatingAgent = defineAgentLoop({
  id: "delegating-agent",
  description: "Delegate a dynamic word batch, then call an ordinary summary pipeline.",
  implementationVersion: "delegation-v1",
  inputSchema: textOptions,
  resultSchema: textAnswer,
  tools,
  limits: { maxTurns: 3, maxCalls: 100, maxDecisions: 50, maxDepth: 1, maxConcurrency: 2 },
  initialState: ({ question }): State => ({ question, answers: [] }),
  decide,
  dryRun: decide,
  reduce: (state, outcomes) => {
    const answers = [...state.answers];
    let summary = state.summary;
    for (const outcome of outcomes) {
      if (!outcome.ok) answers.push(`Observed ${outcome.error.code}: ${outcome.error.message}`);
      else if (outcome.tool === "summarize") summary = outcome.value;
      else if (outcome.tool === "processWord") answers.push(outcome.value.answer);
      else answers.push(JSON.stringify(outcome.value));
    }
    return { ...state, answers, summary };
  },
});

export const DelegatingAgentCommand = definePipelineCommand(DelegatingAgent, {
  summarize: (result) => [result.answer],
});
