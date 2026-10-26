import { defineAgent } from "tubeless/agent";
import { openaiModel } from "tubeless/agent/openai";

/** Run from the workspace the agent should inspect and edit; live runs make paid API requests. */
export const CodingAgent = defineAgent({
  id: "coding-agent",
  name: "Workspace coding agent",
  description: "Investigate a task, edit the workspace, and verify the result with a model.",
  implementationVersion: "coding-agent-v5",
  model: openaiModel({ reasoningEffort: "high" }),
});
