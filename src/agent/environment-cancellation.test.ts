import { expect, it, vi } from "vitest";
import { defer } from "../core/child-pipeline.test-support.js";
import { createPipelineTestRuntime } from "../testing/testing.js";
import type { PipelineTraceEvent } from "../tracing/tracing-contracts.js";
import { defineAgent, ToolError, type AgentCall } from "./agent.js";
import type { AgentEnvironmentContext } from "./environment.js";
import { remote, workspaceAgent } from "./environment.test-support.js";

const calls = [
  { id: "read", tool: "read", input: { path: "a" } },
  { id: "write", tool: "write", input: { path: "a", content: "after" } },
  { id: "edit", tool: "edit", input: { path: "a", oldText: "before", newText: "after" } },
  { id: "bash", tool: "bash", input: { command: "verify" } },
  { id: "list", tool: "list", input: {} },
  { id: "search", tool: "search", input: { query: "before" } },
] as const satisfies readonly AgentCall[];
const cases = calls.flatMap((call) =>
  ["read", "list", "search"].includes(call.tool)
    ? [
        { call, dryRun: false },
        { call, dryRun: true },
      ]
    : [{ call, dryRun: false }]
);
function recordedRuntime() {
  const runtime = createPipelineTestRuntime();
  const events: PipelineTraceEvent[] = [];
  runtime.context.tracing = {
    exporter: {
      export(event) {
        events.push(event);
      },
    },
  };
  return { runtime, events };
}
function sdkCancellation() {
  return Object.assign(new Error("remote SDK request cancelled"), {
    name: "RemoteRequestCancelled",
    code: "REMOTE_CANCELLED",
  });
}

it.each(cases)(
  "records SDK cancellation for $call.tool (dryRun=$dryRun) and stops queued calls",
  async ({ call, dryRun }) => {
    for (const reason of [new Error("operator stopped"), "operator stopped"]) {
      const environment = remote();
      const { runtime, events } = recordedRuntime();
      const started = defer();
      const adapter = vi.fn(
        (_input: unknown, context: AgentEnvironmentContext) =>
          new Promise<never>((_resolve, reject) => {
            expect(context.signal).toBe(runtime.context.signal);
            context.signal!.addEventListener("abort", () => reject(sdkCancellation()), {
              once: true,
            });
            started.resolve();
          })
      );
      environment[call.tool] = adapter;
      const { agent, decide, reduce } = workspaceAgent(environment, [
        call,
        { ...call, id: "queued" },
      ]);
      const running = runtime.run(agent, {}, { dryRun });
      await started.promise;
      runtime.abort(reason);
      const result = await running;
      expect(result.status).toBe("cancelled");
      expect(result.errors.every(({ kind }) => kind === "cancellation")).toBe(true);
      expect(events.some(({ name }) => name === "step.failed")).toBe(false);
      expect(events).toContainEqual(
        expect.objectContaining({
          name: "step.cancelled",
          stepId: "tool",
          error: expect.objectContaining({
            kind: "cancellation",
            message: expect.stringContaining("operator stopped"),
          }),
        })
      );
      expect(adapter).toHaveBeenCalledTimes(1);
      expect(decide).toHaveBeenCalledTimes(1);
      expect(reduce).not.toHaveBeenCalled();
    }
  }
);

it("normalizes a synchronous adapter throw after abort", async () => {
  const environment = remote();
  const { runtime, events } = recordedRuntime();
  environment.read = vi.fn(() => {
    runtime.abort(new Error("operator stopped"));
    throw sdkCancellation();
  });
  const { agent, reduce } = workspaceAgent(environment, [calls[0]]);
  expect((await runtime.run(agent, {})).status).toBe("cancelled");
  expect(events.some(({ name }) => name === "step.failed")).toBe(false);
  expect(reduce).not.toHaveBeenCalled();
});

it.each([false, true])(
  "drains late success without validating or reducing it (dryRun=%s)",
  async (dryRun) => {
    const environment = remote();
    const { runtime, events } = recordedRuntime();
    const started = defer();
    const release = defer();
    const content = vi.fn(() => "x".repeat(16_385));
    environment.read = vi.fn(async () => {
      started.resolve();
      await release.promise;
      return {
        path: "a",
        get content() {
          return content();
        },
        startLine: 1,
        endLine: 1,
        totalLines: 1,
        truncated: true,
      };
    });
    const { agent, reduce } = workspaceAgent(environment, [
      calls[0],
      { ...calls[0], id: "queued" },
    ]);
    let settled = false;
    const running = runtime.run(agent, {}, { dryRun }).then((result) => {
      settled = true;
      return result;
    });
    await started.promise;
    runtime.abort("operator stopped");
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    expect((await running).status).toBe("cancelled");
    expect(events.some(({ name }) => name === "step.failed")).toBe(false);
    expect(content).not.toHaveBeenCalled();
    expect(environment.read).toHaveBeenCalledTimes(1);
    expect(reduce).not.toHaveBeenCalled();
  }
);

it.each(["factory", "resolveCwd", "projectInstructions"] as const)(
  "normalizes SDK cancellation during environment %s",
  async (operation) => {
    const environment = remote();
    const { runtime, events } = recordedRuntime();
    const started = defer();
    const cancel = vi.fn(
      (context: AgentEnvironmentContext) =>
        new Promise<never>((_resolve, reject) => {
          context.signal!.addEventListener("abort", () => reject(sdkCancellation()), {
            once: true,
          });
          started.resolve();
        })
    );
    if (operation !== "factory") environment[operation] = cancel;
    const model = vi.fn(() => ({
      conversation: null,
      decision: { kind: "finish", result: { answer: "unused" } },
    }));
    const agent = defineAgent({
      id: "cancel-environment-startup",
      environment: operation === "factory" ? cancel : environment,
      model,
    });
    const running = runtime.run(agent, { task: "Work remotely" });
    await started.promise;
    runtime.abort(new Error("operator stopped"));
    expect((await running).status).toBe("cancelled");
    expect(events.some(({ name }) => name === "step.failed")).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(model).not.toHaveBeenCalled();
  }
);

it("preserves SDK errors as failures when the signal is active", async () => {
  const environment = remote();
  const { runtime, events } = recordedRuntime();
  const error = sdkCancellation();
  environment.read = vi.fn(async () => {
    throw error;
  });
  const { agent, reduce } = workspaceAgent(environment, [calls[0]]);
  expect((await runtime.run(agent, {})).status).toBe("failed");
  expect(events).toContainEqual(
    expect.objectContaining({
      name: "step.failed",
      stepId: "tool",
      error: expect.objectContaining({
        kind: "step",
        sourceCode: error.code,
        message: error.message,
      }),
    })
  );
  expect(runtime.context.signal!.aborted).toBe(false);
  expect(reduce).not.toHaveBeenCalled();
});

it("preserves recoverable adapter ToolErrors without cancellation", async () => {
  const environment = remote();
  environment.read = vi.fn(() => {
    throw new ToolError("NOT_FOUND", "file absent");
  });
  const { agent, decide, reduce } = workspaceAgent(environment, [calls[0]]);
  expect(JSON.parse(await agent.runOrThrow({}))).toEqual([
    { id: "read", tool: "read", ok: false, error: { code: "NOT_FOUND", message: "file absent" } },
  ]);
  expect(decide).toHaveBeenCalledTimes(2);
  expect(reduce).toHaveBeenCalledTimes(1);
});
