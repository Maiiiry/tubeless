import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { defineAgent, type AgentCheckpointStore } from "tubeless/agent";
import { openSqliteAgentCheckpointStore } from "tubeless/agent/node";

/** Open storage only during live execution and close it when the lease drains. */
function sqliteStore(file: string): AgentCheckpointStore {
  return {
    acquire: async (key) => {
      const store = await openSqliteAgentCheckpointStore(file);
      try {
        const lease = await store.acquire(key);
        return {
          ...lease,
          close: async () => {
            try {
              await lease.close();
            } finally {
              store.close();
            }
          },
        };
      } catch (error) {
        store.close();
        throw error;
      }
    },
  };
}

/** Scripted model transport; substitute a real AgentModel without changing persistence. */
export function createDurableWorkspaceAgent(checkpointFile: string) {
  return defineAgent({
    id: "durable-workspace-agent",
    name: "Durable workspace agent",
    description: "Write and verify a file with resumable SQLite state, without model credentials.",
    implementationVersion: "durable-workspace-v1",
    projectContext: false,
    durability: {
      store: sqliteStore(checkpointFile),
      key: ({ task }) => createHash("sha256").update(task).digest("hex"),
    },
    limits: { maxTurns: 3, maxCalls: 2, maxDecisions: 3 },
    model: (request, context) => {
      const path = ".tubeless/durable-message.txt";
      if (context.turn === 1)
        return {
          decision: {
            kind: "continue",
            calls: [{ id: "write", tool: "write", input: { path, content: request.task } }],
          },
          conversation: { target: path },
        };
      // An uncertain write is inspected by a read, rather than repeated.
      if (context.turn === 2)
        return {
          decision: { kind: "continue", calls: [{ id: "verify", tool: "read", input: { path } }] },
          conversation: request.conversation,
        };
      const observation = request.outcomes[0];
      if (
        !observation?.ok ||
        observation.tool !== "read" ||
        typeof observation.value !== "object" ||
        observation.value === null ||
        !("content" in observation.value) ||
        observation.value.content !== request.task
      )
        throw new Error("The requested file contents could not be verified");
      return {
        decision: { kind: "finish", result: { answer: `Verified ${path}` } },
        conversation: request.conversation,
      };
    },
  });
}

// A repeated task resumes or returns its completed result. A new task has a new key.
// Plans and dry runs create no files. Live runs replace the demonstration file.
export const DurableWorkspaceAgent = createDurableWorkspaceAgent(
  resolve(".tubeless/agent-demo.sqlite")
);
