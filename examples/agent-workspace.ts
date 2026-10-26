import type { StandardSchemaV1 } from "tubeless";
import { defineAgentLoop, defineTool, type AgentDecision } from "tubeless/agent";
import { definePipelineCommand } from "tubeless/cli";
import { textAnswer } from "./agent.js";

const options: StandardSchemaV1<{ directory?: string }, { directory: string }> = {
  "~standard": {
    version: 1,
    vendor: "example",
    jsonSchema: {
      input: () => ({
        type: "object",
        properties: {
          directory: { type: "string", description: "Directory for the demo's message.txt file." },
        },
      }),
    },
    validate(value) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return { issues: [{ message: "Expected options" }] };
      const directory = "directory" in value ? value.directory : ".tubeless/agent-tools-demo";
      return typeof directory === "string" && directory.trim()
        ? { value: { directory } }
        : { issues: [{ message: "Expected a directory", path: ["directory"] }] };
    },
  },
};

// Custom tools extend the six defaults; no filesystem or process adapter is needed.
const tools = {
  report: defineTool({
    description: "Format the verified workspace result.",
    inputSchema: textAnswer,
    outputSchema: textAnswer,
    run: ({ answer }) => `Verified: ${answer}`,
  }),
};

export const WorkspaceAgent = defineAgentLoop({
  id: "workspace-agent",
  name: "Workspace tools agent",
  description:
    "Write, inspect, edit and check a demo file using the default tools and one custom tool.",
  inputSchema: options,
  resultSchema: textAnswer,
  tools,
  limits: { maxTurns: 6, maxCalls: 8, maxConcurrency: 3 },
  initialState: ({ directory }) => ({ directory, summary: "" }),
  // A deterministic decision source exercises real filesystem and bash operations.
  // A provider callback receives the same default and custom tool descriptors.
  decide(state, context): AgentDecision<typeof tools, string> {
    const path = `${state.directory}/message.txt`;
    const batches = [
      [{ id: "seed", tool: "write", input: { path, content: "hello tubeless\n" } }],
      [
        { id: "inspect", tool: "read", input: { path } },
        { id: "files", tool: "list", input: { path: state.directory } },
        { id: "find", tool: "search", input: { path: state.directory, query: "tubeless" } },
      ],
      [
        {
          id: "change",
          tool: "edit",
          input: { path, oldText: "hello tubeless", newText: "hello agent" },
        },
      ],
      [
        {
          id: "check",
          tool: "bash",
          input: {
            cwd: state.directory,
            command: 'test "$(cat message.txt)" = "hello agent" && printf "check passed\\n"',
          },
        },
      ],
      [{ id: "report", tool: "report", input: "all six default tools and a custom tool" }],
    ] as const;
    const calls = batches[context.turn - 1];
    return calls ? { kind: "continue", calls } : { kind: "finish", result: state.summary };
  },
  reduce(state, outcomes) {
    let summary = state.summary;
    for (const outcome of outcomes) {
      if (!outcome.ok) throw new Error(`${outcome.tool}: ${outcome.error.message}`);
      if (outcome.tool === "bash" && (outcome.value.exitCode !== 0 || outcome.value.timedOut))
        throw new Error("Workspace check failed");
      if (outcome.tool === "report") summary = outcome.value.answer;
    }
    return { ...state, summary };
  },
  // No preview decision source: dry runs skip the agent's filesystem mutations.
});

export const WorkspaceAgentCommand = definePipelineCommand(WorkspaceAgent, {
  summarize: ({ answer }) => [answer],
});
