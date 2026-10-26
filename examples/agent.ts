import type { StandardSchemaV1 } from "tubeless";
import { defineAgentLoop, defineTool, ToolError, type AgentDecision } from "tubeless/agent";

function schema<Input, Output = Input>(
  validate: StandardSchemaV1<Input, Output>["~standard"]["validate"],
  input: Record<string, unknown>
): StandardSchemaV1<Input, Output> {
  return {
    "~standard": { version: 1, vendor: "example", validate, jsonSchema: { input: () => input } },
  };
}

const text = schema<string>(
  (value) => (typeof value === "string" ? { value } : { issues: [{ message: "Expected text" }] }),
  { type: "string" }
);
const count = schema<number>(
  (value) =>
    typeof value === "number" && Number.isFinite(value)
      ? { value }
      : { issues: [{ message: "Expected a finite number" }] },
  { type: "number" }
);
const options = schema<{ question?: string }, { question: string }>(
  (value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return { issues: [{ message: "Expected options" }] };
    const question = "question" in value ? value.question : "hello tubeless";
    return typeof question === "string"
      ? { value: { question } }
      : { issues: [{ message: "Expected question text", path: ["question"] }] };
  },
  {
    type: "object",
    properties: { question: { type: "string", description: "Text or task for the agent." } },
  }
);
const answer = schema<string, { answer: string }>(
  (value) =>
    typeof value === "string"
      ? { value: { answer: value } }
      : { issues: [{ message: "Expected answer text" }] },
  { type: "string" }
);

function uppercase(word: string): string {
  if (word === "missing") throw new ToolError("NOT_FOUND", "Word unavailable");
  return word.toUpperCase();
}

const tools = {
  uppercase: defineTool({
    description: "Uppercase a word; missing reports an expected domain failure.",
    inputSchema: text,
    outputSchema: text,
    run: uppercase,
    dryRun: uppercase,
  }),
  count: defineTool({
    description: "Count characters in text.",
    inputSchema: text,
    outputSchema: count,
    run: (value) => value.length,
    dryRun: (value) => value.length,
  }),
};

// The live-provider recipe uses the same validated tools and boundary schemas.
export { tools as textTools, options as textOptions, answer as textAnswer };

interface State {
  question: string;
  observations: readonly string[];
}

// Replace this application-owned callback with a model adapter. The harness
// validates its return even when the provider SDK claims a structured type.
function scriptedDecision(state: Readonly<State>): AgentDecision<typeof tools, string> {
  if (state.observations.length > 0)
    return { kind: "finish", result: state.observations.join("; ") };
  return {
    kind: "continue",
    calls: [
      { id: "length", tool: "count", input: state.question },
      ...state.question
        .split(/\s+/)
        .filter(Boolean)
        .map((word, index) => ({ id: `word-${index}`, tool: "uppercase" as const, input: word })),
    ],
  };
}

export const ScriptedAgent = defineAgentLoop({
  id: "scripted-agent",
  name: "Scripted agent",
  description: "Run a dynamic tool batch, reduce observations, and finish without credentials.",
  inputSchema: options,
  resultSchema: answer,
  tools,
  limits: { maxTurns: 3, maxCalls: 100, maxDecisions: 3, maxConcurrency: 2 },
  initialState: ({ question }): State => ({ question, observations: [] }),
  decide: scriptedDecision,
  dryRun: scriptedDecision,
  reduce: (state, outcomes) => ({
    ...state,
    observations: outcomes.map((outcome) => {
      if (!outcome.ok) return `Observed ${outcome.error.code}: ${outcome.error.message}`;
      if (outcome.tool === "count") return `${outcome.value} characters`;
      return outcome.tool === "uppercase" ? outcome.value : JSON.stringify(outcome.value);
    }),
  }),
});

export function runAgentExample() {
  return ScriptedAgent.runOrThrow();
}
