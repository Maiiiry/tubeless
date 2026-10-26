import { appendFile } from "node:fs/promises";
import { defineAgent, defineTool } from "tubeless/agent";
import { openSqliteAgentCheckpointStore } from "tubeless/agent/node";
import type { StandardSchemaV1 } from "tubeless";

const [mode, file, effects, decisions, cwd] = process.argv.slice(2);
const store = await openSqliteAgentCheckpointStore(file!);
const text: StandardSchemaV1<string> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) =>
      typeof value === "string" ? { value } : { issues: [{ message: "Expected text" }] },
  },
};
const agent = defineAgent({
  id: "process-recovery",
  implementationVersion: "1",
  projectContext: false,
  durability: { store, key: "job" },
  limits: { maxCalls: 3, maxDecisions: 2, maxConcurrency: 1 },
  tools: {
    effect: defineTool({
      description: "Record a nonrepeatable effect",
      inputSchema: text,
      outputSchema: text,
      inputJsonSchema: { type: "string" },
      run: async (input) => {
        await appendFile(effects!, `${input}\n`);
        if (mode === "crash" && input === "uncertain") {
          process.send?.({ ready: true });
          await new Promise<void>(() => {
            setInterval(() => {}, 1000);
          });
        }
        return input;
      },
    }),
  },
  model: async (request, context) => {
    await appendFile(decisions!, `${context.turn}\n`);
    if (context.turn === 1)
      return {
        decision: {
          kind: "continue",
          calls: ["first", "uncertain", "last"].map((input) => ({
            id: input,
            tool: "effect",
            input,
          })),
        },
        conversation: { accepted: "batch" },
      };
    if (JSON.stringify(request.conversation) !== JSON.stringify({ accepted: "batch" }))
      throw new Error("Lost provider conversation");
    return {
      decision: {
        kind: "finish",
        result: {
          answer: request.outcomes
            .map((outcome) => (outcome.ok ? outcome.value : outcome.error.code))
            .join("|"),
        },
      },
      conversation: null,
    };
  },
});
try {
  const result = await agent.runOrThrow({ task: "record effects" }, undefined, { cwd });
  process.send?.({ result });
} finally {
  store.close();
}
