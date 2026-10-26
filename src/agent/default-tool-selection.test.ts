import { describe, expect, expectTypeOf, it } from "vitest";
import {
  defineAgent,
  defineAgentLoop,
  defineTool,
  type AgentCall,
  type AgentDecisionContext,
  type AgentOutcome,
} from "./agent.js";
import { emptyInput, numberSchema, schema, textSchema } from "./agent.test-support.js";
import { remote } from "./environment.test-support.js";

const count = defineTool({
  description: "Count",
  inputSchema: emptyInput,
  outputSchema: numberSchema,
  run: () => 1,
});

function loop<const Defaults extends "read" | "write" | "edit" | "bash" | "list" | "search">(
  defaultTools: readonly Defaults[] | undefined,
  calls: readonly unknown[]
) {
  const seen: string[][] = [];
  const agent = defineAgentLoop({
    id: "selected-tools",
    environment: remote(),
    inputSchema: emptyInput,
    resultSchema: schema<unknown>((value) => ({ value })),
    resultJsonSchema: {},
    tools: { count },
    defaultTools,
    initialState: () => ({ outcomes: [] as unknown[] }),
    decide: (state, context: AgentDecisionContext<{}>) => {
      seen.push(context.capabilities.map(({ name }) => name));
      return state.outcomes.length
        ? { kind: "finish", result: state.outcomes }
        : { kind: "continue", calls };
    },
    reduce: (_state, outcomes) => ({ outcomes: [...outcomes] }),
  });
  return { agent, seen };
}

describe("default tool selection", () => {
  it("advertises and dispatches only the selected defaults plus custom tools", async () => {
    const { agent, seen } = loop(
      ["read", "list"],
      [
        { id: "r", tool: "read", input: { path: "a", startLine: null, maxLines: null } },
        { id: "c", tool: "count", input: {} },
      ]
    );
    const result = (await agent.runOrThrow({})) as AgentOutcome[];
    expect(seen[0]).toEqual(["count", "list", "read"]);
    expect(result.map(({ tool, ok }) => [tool, ok])).toEqual([
      ["read", true],
      ["count", true],
    ]);
    const denied = await loop(
      ["read"],
      [{ id: "b", tool: "bash", input: { command: "true" } }]
    ).agent.run({});
    expect(denied.status).toBe("failed");
    expect(denied.errors[0]!.message).toContain("Unknown agent tool: bash");
  });

  it("grants no defaults for an empty list and keeps all six by default", async () => {
    const none = loop([], [{ id: "c", tool: "count", input: {} }]);
    await none.agent.runOrThrow({});
    expect(none.seen[0]).toEqual(["count"]);
    const all = loop(undefined, [{ id: "c", tool: "count", input: {} }]);
    await all.agent.runOrThrow({});
    expect(all.seen[0]).toEqual(["bash", "count", "edit", "list", "read", "search", "write"]);
  });

  it("narrows call and outcome types to the selection", () => {
    expectTypeOf<AgentCall<{}, false, "read" | "list">["tool"]>().toEqualTypeOf<"read" | "list">();
    expectTypeOf<
      AgentOutcome<{ count: typeof count }, false, never>["tool"]
    >().toEqualTypeOf<"count">();
    // @ts-expect-error bash is not selected
    const call: AgentCall<{}, false, "read"> = { id: "b", tool: "bash", input: { command: "x" } };
    void call;
  });

  it("rejects unknown names and passes the selection through the model-backed factory", async () => {
    expect(() =>
      defineAgentLoop({
        id: "unknown-default",
        inputSchema: emptyInput,
        resultSchema: textSchema,
        // @ts-expect-error rm is not a standard tool
        defaultTools: ["rm"],
        initialState: () => null,
        decide: () => ({ kind: "finish", result: "" }),
      })
    ).toThrow("defaultTools must list standard tools");
    let names: string[] = [];
    const agent = defineAgent({
      id: "model-selected",
      projectContext: false,
      environment: remote(),
      defaultTools: ["search"],
      model: (_request, context) => {
        names = context.capabilities.map(({ name }) => name);
        return { decision: { kind: "finish", result: { answer: "ok" } }, conversation: null };
      },
    });
    await agent.runOrThrow({ task: "go" });
    expect(names).toEqual(["search"]);
  });
});
