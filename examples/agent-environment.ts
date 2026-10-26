import { defineAgent, type AgentEnvironmentProvider } from "tubeless/agent";
import { createNodeAgentEnvironment } from "tubeless/agent/node";

/** Replace the environment to run the same agent against a remote workspace. */
export function createEnvironmentWorkspaceAgent(environment: AgentEnvironmentProvider) {
  return defineAgent({
    id: "environment-workspace-agent",
    name: "Environment workspace agent",
    description: "List a workspace through caller-supplied capabilities without model credentials.",
    environment,
    projectContext: false,
    limits: { maxTurns: 2, maxDecisions: 2, maxCalls: 1 },
    model: (request, context) => {
      if (context.turn === 1)
        return {
          conversation: null,
          decision: {
            kind: "continue",
            calls: [{ id: "list", tool: "list", input: { path: null } }],
          },
        };
      const listing = request.outcomes[0];
      if (!listing || !listing.ok) throw new Error("Workspace listing failed");
      return {
        conversation: null,
        decision: { kind: "finish", result: { answer: JSON.stringify(listing.value) } },
      };
    },
  });
}

// Resolve the local adapter only during execution; plans and dry runs perform no workspace I/O.
export const EnvironmentWorkspaceAgent = createEnvironmentWorkspaceAgent(() =>
  createNodeAgentEnvironment()
);
