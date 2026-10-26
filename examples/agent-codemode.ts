import type { StandardSchemaV1 } from "tubeless";
import { defineAgentLoop, type AgentDecision, type CodemodeResult } from "tubeless/agent";

const noOptions: StandardSchemaV1<{}> = {
  "~standard": {
    version: 1,
    vendor: "example",
    validate: (value) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? { value: {} }
        : { issues: [{ message: "Expected options" }] },
    jsonSchema: { input: () => ({ type: "object", properties: {} }) },
  },
};
const surveyResult: StandardSchemaV1<CodemodeResult> = {
  "~standard": {
    version: 1,
    vendor: "example",
    validate: (value) =>
      value !== null && typeof value === "object" && "result" in value && "logs" in value
        ? { value: value as CodemodeResult }
        : { issues: [{ message: "Expected a code-mode result" }] },
    jsonSchema: { input: () => ({ type: "object" }) },
  },
};

// One script lists the workspace and reads every top-level text file. Nested calls run as
// ordinary child runs of the codemode call, so traces and Studio show each read.
const survey = `
const { entries } = await tools.list({ path: null });
const files = [];
for (const entry of entries.filter((item) => item.kind === "file")) {
  try {
    const { totalLines } = await tools.read({ path: entry.name, startLine: null, maxLines: 1 });
    files.push({ name: entry.name, lines: totalLines });
  } catch (error) {
    console.log("skipped", entry.name, error.code);
  }
}
return files;`;

type State = { readonly survey?: CodemodeResult };

// The agent may only call `codemode`; the decision type rejects direct tool calls.
function decide(state: State): AgentDecision<{}, CodemodeResult, true> {
  return state.survey
    ? { kind: "finish", result: state.survey }
    : { kind: "continue", calls: [{ id: "survey", tool: "codemode", input: { code: survey } }] };
}

/** An autonomous agent permitted to use code mode: one script instead of a call per file. */
export const CodemodeAgent = defineAgentLoop({
  id: "codemode-agent",
  name: "Code mode agent",
  description: "Survey a workspace with one JavaScript script instead of a call per file.",
  codemode: true,
  defaultTools: ["list", "read"],
  inputSchema: noOptions,
  resultSchema: surveyResult,
  limits: { maxTurns: 2, maxCalls: 50 },
  initialState: (): State => ({}),
  decide,
  // Read-only tools run in previews, so --dry-run executes the same survey.
  dryRun: decide,
  reduce: (_state, [outcome]) => {
    if (!outcome?.ok) throw new Error("Workspace survey failed");
    return { survey: outcome.value };
  },
});
