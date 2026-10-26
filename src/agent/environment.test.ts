import { expect, it, vi } from "vitest";
import { createSteps, definePipeline } from "../core/pipeline.js";
import { defineAgent, defineTool, pipelineTool } from "./agent.js";
import { toolObject } from "./default-tool-schema.js";
import { compileTool } from "./tools.js";
import { AgentExecutionScope, resolvedLimits } from "./execution-scope.js";
import { setExecutionScope } from "../core/execution-scope.js";
import { remote, workspaceAgent } from "./environment.test-support.js";

it("routes all workspace operations, guidance and custom tools through a remote environment", async () => {
  const environment = remote();
  const factory = vi.fn(() => environment);
  const empty = toolObject({});
  const agent = defineAgent({
    id: "remote-workspace",
    environment: factory,
    tools: {
      custom: defineTool({
        description: "Use workspace authority",
        inputSchema: empty,
        outputSchema: empty,
        run: (_input, context) => {
          expect(context.environment).toBe(environment);
          expect(context.cwd).toBe("/remote/project");
          return {};
        },
      }),
    },
    model: (request, context) => {
      expect(request.instructions).toContain("REMOTE GUIDANCE");
      expect(context.environment).toBe(environment);
      expect(context.cwd).toBe("/remote/project");
      return {
        conversation: null,
        decision:
          context.turn === 1
            ? {
                kind: "continue",
                calls: [
                  { id: "read", tool: "read", input: { path: "a" } },
                  { id: "write", tool: "write", input: { path: "a", content: "after" } },
                  {
                    id: "edit",
                    tool: "edit",
                    input: { path: "a", oldText: "after", newText: "AFTER" },
                  },
                  { id: "bash", tool: "bash", input: { command: "verify" } },
                  { id: "list", tool: "list", input: {} },
                  { id: "search", tool: "search", input: { query: "before" } },
                  { id: "custom", tool: "custom", input: {} },
                ],
              }
            : { kind: "finish", result: { answer: "remote" } },
      };
    },
  });
  expect(
    await agent.runOrThrow({ task: "Work remotely" }, undefined, { cwd: "/does-not-exist-locally" })
  ).toEqual({ answer: "remote" });
  expect(factory).toHaveBeenCalledTimes(1);
  expect(environment.resolveCwd).toHaveBeenCalledTimes(1);
  for (const method of [
    "read",
    "write",
    "edit",
    "bash",
    "list",
    "search",
    "projectInstructions",
  ] as const)
    expect(environment[method]).toHaveBeenCalledTimes(1);
});

it("inherits workspace authority through ordinary pipelines between parent and child agents", async () => {
  const environment = remote();
  const child = defineAgent({
    id: "remote-child",
    model: (request, context) => {
      expect(context.environment).toBe(environment);
      expect(request.instructions).toContain("REMOTE GUIDANCE");
      return { conversation: null, decision: { kind: "finish", result: { answer: context.cwd } } };
    },
  });
  const { fromPipeline } = createSteps(child.optionsSchema);
  const nested = fromPipeline("nested", { pipeline: child });
  const wrapper = definePipeline({ id: "remote-wrapper", steps: [nested], finalize: nested });
  const parent = defineAgent({
    id: "remote-parent",
    environment,
    tools: { child: pipelineTool(wrapper, { description: "Delegate" }) },
    model: (request, context) => ({
      conversation: null,
      decision:
        context.turn === 1
          ? {
              kind: "continue",
              calls: [{ id: "child", tool: "child", input: { task: "Report cwd" } }],
            }
          : { kind: "finish", result: { answer: JSON.stringify(request.outcomes) } },
    }),
  });
  expect(
    (await parent.runOrThrow({ task: "Delegate" }, undefined, { cwd: "/missing-local" })).answer
  ).toContain("/remote/project");
});

it("validates remote results and arguments at the same schema boundary as local tools", async () => {
  const environment = remote();
  environment.read = vi.fn(
    () =>
      ({
        path: "a",
        content: "x",
        startLine: 1,
        endLine: 1,
        totalLines: 1,
        truncated: "invalid",
      }) as never
  );
  const agent = defineAgent({
    id: "invalid-remote-result",
    environment,
    model: () => ({
      conversation: null,
      decision: { kind: "continue", calls: [{ id: "read", tool: "read", input: { path: "a" } }] },
    }),
  });
  expect((await agent.run({ task: "Read" })).status).toBe("failed");
  expect(environment.read).toHaveBeenCalledTimes(1);
  const invalid = defineAgent({
    id: "invalid-remote-args",
    environment,
    model: () => ({
      conversation: null,
      decision: { kind: "continue", calls: [{ id: "read", tool: "read", input: { path: 2 } }] },
    }),
  });
  expect((await invalid.run({ task: "Read" })).status).toBe("failed");
  expect(environment.read).toHaveBeenCalledTimes(1);
});

it("keeps environment factories out of plans and skipped model dry runs", async () => {
  const factory = vi.fn(() => remote());
  const model = vi.fn();
  const agent = defineAgent({ id: "environment-preview", environment: factory, model });
  expect(agent.plan().ok).toBe(true);
  await agent.run({ task: "Preview" }, { dryRun: true }, { cwd: "/missing" });
  expect(factory).not.toHaveBeenCalled();
  expect(model).not.toHaveBeenCalled();
});

it("lets a child explicitly replace inherited workspace authority", async () => {
  const parentEnvironment = remote();
  const childEnvironment = {
    ...remote(),
    id: "container:two",
    resolveCwd: vi.fn(() => "/remote/child"),
  };
  const child = defineAgent({
    id: "overridden-child",
    environment: childEnvironment,
    projectContext: false,
    model: (_request, context) => {
      expect(context.environment).toBe(childEnvironment);
      return { conversation: null, decision: { kind: "finish", result: { answer: context.cwd } } };
    },
  });
  const parent = defineAgent({
    id: "overridden-parent",
    environment: parentEnvironment,
    projectContext: false,
    tools: { child: pipelineTool(child, { description: "Delegate to another workspace" }) },
    model: (request, context) => {
      expect(context.environment).toBe(parentEnvironment);
      expect(context.cwd).toBe("/remote/project");
      return {
        conversation: null,
        decision:
          context.turn === 1
            ? {
                kind: "continue",
                calls: [{ id: "child", tool: "child", input: { task: "Report cwd" } }],
              }
            : { kind: "finish", result: { answer: JSON.stringify(request.outcomes) } },
      };
    },
  });
  expect((await parent.runOrThrow({ task: "Delegate" })).answer).toContain("/remote/child");
  expect(parentEnvironment.resolveCwd).toHaveBeenCalledTimes(1);
  expect(childEnvironment.resolveCwd).toHaveBeenCalledTimes(1);
});

it("fails explicit invalid environments and rejected factories without falling back to the host", async () => {
  const model = vi.fn(() => ({
    conversation: null,
    decision: { kind: "finish", result: { answer: "host fallback" } },
  }));
  for (const environment of [
    null as never,
    async () => {
      throw new Error("Remote workspace unavailable");
    },
  ]) {
    const agent = defineAgent({ id: "unavailable-environment", environment, model });
    expect((await agent.run({ task: "Work remotely" })).status).toBe("failed");
  }
  expect(model).not.toHaveBeenCalled();
});

it("resolves asynchronous factories independently for concurrent invocations", async () => {
  const factory = vi.fn(async (context: { cwd: string }) => ({
    ...remote(),
    id: context.cwd,
    resolveCwd: () => context.cwd,
    projectInstructions: () => [],
  }));
  const agent = defineAgent({
    id: "concurrent-environments",
    environment: factory,
    model: (_request, context) => {
      expect(context.environment.id).toBe(context.cwd);
      return {
        conversation: null,
        decision: { kind: "finish", result: { answer: context.environment.id } },
      };
    },
  });
  expect(
    await Promise.all(
      ["/remote/one", "/remote/two"].map((cwd) =>
        agent.runOrThrow({ task: "Report workspace" }, undefined, { cwd })
      )
    )
  ).toEqual([{ answer: "/remote/one" }, { answer: "/remote/two" }]);
  expect(factory).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  "rejects oversized remote search output before committing state (dryRun=%s)",
  async (dryRun) => {
    const cases = [
      { matches: [{ path: "/remote/a", line: 1, text: "x".repeat(1025) }], truncated: false },
      { matches: [{ path: "/remote/a", line: 1, text: "é".repeat(513) }], truncated: true },
      {
        matches: Array.from({ length: 16 }, (_, index) => ({
          path: "/remote/a",
          line: index + 1,
          text: "x".repeat(1024),
        })),
        truncated: false,
      },
      {
        matches: Array.from({ length: 16 }, (_, index) => ({
          path: "é".repeat(256),
          line: index + 1,
          text: "x".repeat(768),
        })),
        truncated: true,
      },
    ];
    for (const result of cases) {
      const environment = remote();
      environment.search = vi.fn(() => ({ ...result, skippedFiles: 0 }));
      const { agent, decide, reduce } = workspaceAgent(environment, [
        { id: "search", tool: "search", input: { query: "needle" } },
      ]);
      expect((await agent.run({}, { dryRun })).status).toBe("failed");
      expect(environment.search).toHaveBeenCalledTimes(1);
      expect(reduce).not.toHaveBeenCalled();
      expect(decide).toHaveBeenCalledTimes(1);
    }
  }
);

it.each([false, true])(
  "preserves remote search output at the UTF-8 byte limits (dryRun=%s)",
  async (dryRun) => {
    const cases = [
      [{ path: "/remote/a", line: 1, text: "🙂".repeat(256) }],
      Array.from({ length: 16 }, (_, index) => ({
        path: "/remote/" + "é".repeat(124),
        line: index + 1,
        text: "🙂".repeat(192),
      })),
      [],
    ];
    for (const matches of cases) {
      const result = { matches, truncated: true, skippedFiles: 3 };
      const environment = remote();
      environment.search = vi.fn(() => result);
      const { agent, decide, reduce } = workspaceAgent(environment, [
        { id: "search", tool: "search", input: { query: "needle" } },
      ]);
      expect(JSON.parse(await agent.runOrThrow({}, { dryRun }))).toEqual([
        { id: "search", tool: "search", ok: true, value: result },
      ]);
      expect(environment.search).toHaveBeenCalledTimes(1);
      expect(reduce).toHaveBeenCalledTimes(1);
      expect(decide).toHaveBeenCalledTimes(2);
    }
  }
);

it("carries execution identity independently of tracing attribute names and values", async () => {
  const environment = remote();
  const execution = { id: "job", agent: "agent-route", turn: 2, call: "work" };
  const empty = toolObject({});
  const tool = compileTool(
    "agent",
    "work",
    defineTool({
      description: "Observe identity",
      inputSchema: empty,
      outputSchema: empty,
      run: (_input, context) => {
        expect(context.execution).toBe(execution);
        return {};
      },
    })
  );
  const runtime = { cwd: "/remote/project" };
  setExecutionScope(
    runtime,
    AgentExecutionScope.enter(runtime, resolvedLimits(), "run", environment, "agent")
  );
  await tool.pipeline.runOrThrow(
    {
      input: {},
      call: { turn: 1, id: "call" },
      execution,
      attributes: { "agent.turn": "changed", "agent.callId": 99 },
    },
    undefined,
    runtime
  );
});
