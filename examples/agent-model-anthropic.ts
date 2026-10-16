import { defineModelAgent } from "tubeless/agent";
import { anthropicModel } from "tubeless/agent/anthropic";

/** The coding agent on the Claude Messages API; live runs make paid API requests. */
export const ClaudeCodingAgent = defineModelAgent({
  id: "claude-coding-agent",
  name: "Workspace coding agent (Claude)",
  description: "Investigate a task, edit the workspace, and verify the result with Claude.",
  implementationVersion: "claude-coding-agent-v1",
  model: anthropicModel({ reasoningEffort: "high" }),
});
