import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { defineAgent, defineTool, pipelineTool, type AgentModelRequest } from "./agent.js";
import { toolObject } from "./default-tool-schema.js";
import { remote } from "./environment.test-support.js";
import { wireArray, wireNumber, wireString } from "../tracing/wire-schema.js";

const directories: string[] = [];
async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), "tubeless-model-"));
  directories.push(cwd);
  return cwd;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("model agents", () => {
  it("composes model agents through pipeline tools and shares ancestor decision limits", async () => {
    const child = defineAgent({
      id: "child-model",
      projectContext: false,
      model: (request) => ({
        decision: { kind: "finish", result: { answer: request.task } },
        conversation: null,
      }),
    });
    const parent = (maxDecisions: number) =>
      defineAgent({
        id: "parent-model",
        projectContext: false,
        tools: { child: pipelineTool(child, { description: "Ask the child." }) },
        limits: { maxDecisions, maxConcurrency: 1 },
        model: (request, context) =>
          context.turn === 1
            ? {
                decision: {
                  kind: "continue",
                  calls: [{ id: "child", tool: "child", input: { task: request.task } }],
                },
                conversation: null,
              }
            : {
                decision: {
                  kind: "finish",
                  result: request.outcomes[0]!.ok
                    ? request.outcomes[0]!.value
                    : { answer: "failed" },
                },
                conversation: null,
              },
      });
    expect(await parent(3).runOrThrow({ task: "delegated" })).toEqual({ answer: "delegated" });
    const limited = await parent(2).run({ task: "delegated" });
    expect(limited.status).toBe("failed");
    expect(limited.errors[0]!.message).toContain("maxDecisions");
  });

  it("owns conversation, recovers from a tool error and completes an edit without caller schemas or reducers", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "target"), "original");
    const requests: AgentModelRequest[] = [];
    const model = vi.fn(async (request: AgentModelRequest) => {
      requests.push(request);
      const decisions = [
        { kind: "continue", calls: [{ id: "read", tool: "read", input: { path: "missing" } }] },
        { kind: "continue", calls: [{ id: "read", tool: "read", input: { path: "target" } }] },
        {
          kind: "continue",
          calls: [
            {
              id: "edit",
              tool: "edit",
              input: { path: "target", oldText: "original", newText: "updated" },
            },
          ],
        },
        { kind: "finish", result: { answer: "Updated target." } },
      ];
      if (requests.length === 2)
        expect(request.outcomes).toMatchObject([{ ok: false, error: { code: "ENOENT" } }]);
      if (requests.length === 3)
        expect(request.outcomes).toMatchObject([{ ok: true, value: { content: "original" } }]);
      expect(request.conversation).toEqual(
        requests.length === 1 ? null : { turn: requests.length - 1 }
      );
      expect(Object.isFrozen(request.outcomes)).toBe(true);
      return { decision: decisions[requests.length - 1], conversation: { turn: requests.length } };
    });
    const agent = defineAgent({ id: "coding", model, instructions: "Keep the answer short." });
    expectTypeOf(agent.id).toEqualTypeOf<"coding">();
    expectTypeOf(
      await agent.runOrThrow({ task: "Update target" }, undefined, { cwd })
    ).toEqualTypeOf<{ answer: string }>();
    expect(await readFile(join(cwd, "target"), "utf8")).toBe("updated");
    expect(requests[0]!.instructions).toContain("Keep the answer short.");
    expect(requests[0]!.instructions).toContain("Never claim a check passed");
    expect(requests[1]!.instructions).toBe(requests[0]!.instructions);
  });

  it("isolates concurrent runs and snapshots provider-owned state", async () => {
    const cwd = await workspace();
    const seen: string[] = [];
    const agent = defineAgent({
      id: "isolated",
      projectContext: false,
      model: async (request, context) => {
        if (context.turn === 1) {
          expect(request.conversation).toBeNull();
          await Promise.resolve();
          return {
            decision: { kind: "continue", calls: [{ id: "list", tool: "list", input: {} }] },
            conversation: { task: request.task },
          };
        }
        expect(request.conversation).toEqual({ task: request.task });
        expect(Object.isFrozen(request.conversation)).toBe(true);
        seen.push(request.task);
        return {
          decision: { kind: "finish", result: { answer: request.task } },
          conversation: request.conversation,
        };
      },
    });
    expect(
      await Promise.all(
        ["first", "second"].map((task) => agent.runOrThrow({ task }, undefined, { cwd }))
      )
    ).toEqual([{ answer: "first" }, { answer: "second" }]);
    await agent.runOrThrow({ task: "again" }, undefined, { cwd });
    expect(seen.sort()).toEqual(["again", "first", "second"]);
  });

  it("owns pending conversation before tool handlers can mutate provider data", async () => {
    const conversation = { nested: { value: "original" } };
    const empty = toolObject({});
    const agent = defineAgent({
      id: "snapshot-boundary",
      projectContext: false,
      tools: {
        mutate: defineTool({
          description: "Mutate the provider's original object.",
          inputSchema: empty,
          outputSchema: empty,
          run: () => {
            conversation.nested.value = "mutated";
            return {};
          },
        }),
      },
      model: (request, context) => {
        if (context.turn === 1)
          return {
            decision: { kind: "continue", calls: [{ id: "mutate", tool: "mutate", input: {} }] },
            conversation,
          };
        expect(conversation.nested.value).toBe("mutated");
        expect(request.conversation).toEqual({ nested: { value: "original" } });
        expect(Object.isFrozen(request.conversation)).toBe(true);
        return { decision: { kind: "finish", result: { answer: "Owned." } }, conversation: null };
      },
    });
    expect(await agent.runOrThrow({ task: "Test ownership" })).toEqual({ answer: "Owned." });
  });

  it("does no model or project-context I/O during planning and dry runs", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, "AGENTS.md"));
    const model = vi.fn();
    const agent = defineAgent({ id: "preview", model });
    expect(agent.plan().ok).toBe(true);
    for (const directory of [cwd, join(cwd, "missing")]) {
      const result = await agent.run({ task: "Do work" }, { dryRun: true }, { cwd: directory });
      expect(result.steps[0]?.status).toBe("skipped");
      expect(result.finalized).toBe(false);
    }
    expect(model).not.toHaveBeenCalled();
  });

  it("rejects invalid conversation state before a returned mutation starts", async () => {
    const cwd = await workspace();
    const agent = defineAgent({
      id: "invalid-state",
      projectContext: false,
      model: () => ({
        decision: {
          kind: "continue",
          calls: [{ id: "write", tool: "write", input: { path: "target", content: "wrong" } }],
        },
        conversation: new Map(),
      }),
    });
    await expect(agent.runOrThrow({ task: "write" }, undefined, { cwd })).rejects.toThrow();
    await expect(readFile(join(cwd, "target"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates default task and answer boundaries before work or finish", async () => {
    const model = vi.fn(() => ({
      decision: { kind: "finish", result: { answer: 42 } },
      conversation: null,
    }));
    const agent = defineAgent({ id: "validated", projectContext: false, model });
    for (const task of ["", "é".repeat(8193)])
      await expect(agent.runOrThrow({ task })).rejects.toThrow();
    expect(model).not.toHaveBeenCalled();
    await expect(agent.runOrThrow({ task: "valid" })).rejects.toThrow();
    expect(model).toHaveBeenCalledTimes(1);
  });

  it("maps typed options to the task and finishes against a typed result schema", async () => {
    const files = toolObject({
      files: wireArray(wireString({ maxLength: 4096 }), { maxItems: 100 }),
    });
    const report = toolObject({ count: wireNumber({ integer: true, minimum: 0 }) });
    const requests: AgentModelRequest[] = [];
    let resultJsonSchema: unknown;
    const agent = defineAgent({
      id: "typed-model",
      projectContext: false,
      inputSchema: files,
      resultSchema: report,
      task: ({ files }) => `Count ${files.join(", ")}`,
      model: (request, context) => {
        requests.push(request);
        resultJsonSchema = context.resultJsonSchema;
        return { decision: { kind: "finish", result: { count: 2 } }, conversation: null };
      },
    });
    expectTypeOf(agent.runOrThrow).toBeCallableWith({ files: ["a.txt"] });
    // @ts-expect-error typed options replace the default `{ task }` input
    expectTypeOf(agent.runOrThrow).toBeCallableWith({ task: "Count" });
    const counted: { count: number } = await agent.runOrThrow({ files: ["a.txt", "b.txt"] });
    expect(counted).toEqual({ count: 2 });
    expect(requests[0]!.task).toBe("Count a.txt, b.txt");
    expect(resultJsonSchema).toMatchObject({ properties: { count: { type: "integer" } } });

    const wrong = defineAgent({
      id: "typed-model-invalid-result",
      projectContext: false,
      inputSchema: files,
      resultSchema: report,
      task: () => "Count",
      model: () => ({ decision: { kind: "finish", result: { count: -1 } }, conversation: null }),
    });
    expect((await wrong.run({ files: [] })).status).toBe("failed");
  });

  it("requires a task mapper exactly when inputSchema is set and rejects blank task text", async () => {
    const files = toolObject({ files: wireArray(wireString(), {}) });
    const model = () => ({
      decision: { kind: "finish", result: { answer: "done" } },
      conversation: null,
    });
    expect(() =>
      // @ts-expect-error typed input requires a task mapper
      defineAgent({ id: "missing-task", model, inputSchema: files })
    ).toThrow("task mapper exactly when inputSchema is set");
    expect(() =>
      // @ts-expect-error the default `{ task }` input has no mapper
      defineAgent({ id: "extra-task", model, task: () => "x" })
    ).toThrow("task mapper exactly when inputSchema is set");
    const blank = defineAgent({
      id: "blank-task",
      projectContext: false,
      model,
      inputSchema: files,
      task: () => "  ",
    });
    const run = await blank.run({ files: [] });
    expect(run.status).toBe("failed");
    expect(run.errors[0]!.message).toContain("Agent task must be nonblank text");
  });

  it("defaults typed agents to the task prompt and lets them opt into project context", async () => {
    const files = toolObject({ files: wireArray(wireString(), {}) });
    const prompts: string[] = [];
    const define = (projectContext?: boolean) =>
      defineAgent({
        id: "typed-prompt",
        environment: remote(),
        inputSchema: files,
        task: () => "Classify",
        ...(projectContext === undefined ? {} : { projectContext }),
        model: (request) => {
          prompts.push(request.instructions);
          return { decision: { kind: "finish", result: { answer: "ok" } }, conversation: null };
        },
      });
    await define().runOrThrow({ files: [] });
    await define(true).runOrThrow({ files: [] });
    expect(prompts[0]).toContain("autonomous agent completing one task");
    expect(prompts[0]).not.toContain("REMOTE GUIDANCE");
    expect(prompts[1]).toContain("coding, writing, and computer use agent");
    expect(prompts[1]).toContain("REMOTE GUIDANCE");
  });
});
