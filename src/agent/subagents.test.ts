import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createSteps, definePipeline } from "../core/pipeline.js";
import { createPipelineTestRuntime } from "../testing/testing.js";
import { decodeStoredTraceEvent } from "../run-store/run-store-event-decoder.js";
import { projectPipelineRunStore, type StoredPipelineEvent } from "../run-store/run-store.js";
import {
  defineAgentLoop,
  defineTool,
  pipelineTool,
  ToolError,
  type AgentLimits,
  type AgentTool,
} from "./agent.js";
import { emptyInput, numberSchema, schema } from "./agent.test-support.js";

const input = schema<{ value: number }>((value) => ({ value: value as { value: number } }));
function coordinator(
  id: string,
  tool: AgentTool<unknown, unknown>,
  limits: AgentLimits = {},
  calls: readonly unknown[] = [{}]
) {
  const decide = (state: number, context: { turn: number }) =>
    context.turn === 1
      ? {
          kind: "continue",
          calls: calls.map((input, index) => ({ id: String(index), tool: "work", input })),
        }
      : { kind: "finish", result: state };
  return defineAgentLoop({
    id,
    inputSchema: emptyInput,
    resultSchema: numberSchema,
    tools: { work: tool },
    limits,
    initialState: () => 0,
    decide,
    dryRun: decide,
    reduce: (_state, outcomes) =>
      outcomes.reduce((sum, outcome) => sum + (outcome.ok ? Number(outcome.value) : -1), 0),
  });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("agent subtrees", () => {
  it("runs two children with private state and registries, recording their actual ancestry", async () => {
    const states: number[] = [];
    const child = defineAgentLoop({
      id: "child",
      inputSchema: input,
      resultSchema: numberSchema,
      tools: {
        double: defineTool({
          description: "Double",
          inputSchema: numberSchema,
          outputSchema: numberSchema,
          run: (n) => n * 2,
        }),
      },
      initialState: ({ value }) => {
        states.push(value);
        return value;
      },
      decide: (state, context) => {
        expect(context.capabilities.map(({ name }) => name)).toEqual([
          "bash",
          "double",
          "edit",
          "list",
          "read",
          "search",
          "write",
        ]);
        return context.turn === 1
          ? { kind: "continue", calls: [{ id: "double", tool: "double", input: state }] }
          : { kind: "finish", result: state };
      },
      reduce: (_state, outcomes) =>
        outcomes[0]?.ok && outcomes[0].tool === "double" ? outcomes[0].value : 0,
    });
    const parent = coordinator(
      "parent",
      pipelineTool(child, { description: "Delegate" }),
      { maxConcurrency: 2 },
      [{ value: 2 }, { value: 7 }]
    );
    const events: StoredPipelineEvent[] = [];
    const runtime = createPipelineTestRuntime();
    const result = await parent.run(
      {},
      {},
      {
        ...runtime.context,
        tracing: {
          exporter: {
            export: (event) => {
              events.push({
                ...decodeStoredTraceEvent(JSON.parse(JSON.stringify(event))),
                id: events.length + 1,
              });
            },
          },
        },
      }
    );
    expect(result.value).toBe(18);
    expect(states).toEqual([2, 7]);
    expect(runtime.logs.filter(({ level }) => level === "warn")).toEqual([]);
    const runs = projectPipelineRunStore(events).runs;
    const children = runs.filter(({ pipelineId }) => pipelineId === "child");
    expect(children).toHaveLength(2);
    expect(new Set(children.map(({ runId }) => runId)).size).toBe(2);
    for (const run of children) {
      const parentTurn = runs.find(({ runId }) => runId === run.parentRunId)!;
      expect(parentTurn.pipelineId).toBe("parent/turn");
      expect(parentTurn.parentRunId).toBe(result.runId);
      expect(run.iteration).toBeUndefined();
    }
  });

  it("runs nested work with concurrency one through ordinary single/fan-out/iteration wrappers", async () => {
    const leaf = coordinator(
      "leaf-agent",
      defineTool({
        description: "One",
        inputSchema: emptyInput,
        outputSchema: numberSchema,
        run: () => 1,
      })
    );
    const { fromPipeline, forEachPipeline, iteratePipeline } = createSteps(emptyInput);
    const single = fromPipeline("single", { pipeline: leaf });
    const singlePipeline = definePipeline({ id: "single", steps: [single], finalize: single });
    const fanout = forEachPipeline("fanout", {
      pipeline: singlePipeline,
      items: () => [0, 1],
      key: String,
      mapOptions: () => ({}),
      concurrency: 2,
    });
    const fanoutPipeline = definePipeline({
      id: "fanout",
      steps: [fanout],
      finalize: ({ fanout }) => fanout!.reduce((a, b) => a + b, 0),
    });
    const repeat = iteratePipeline("repeat", {
      pipeline: fanoutPipeline,
      maxIterations: 1,
      initialState: () => 0,
      mapOptions: () => ({}),
      transition: (result) => ({ kind: "finish", result }),
    });
    const wrapper = definePipeline({ id: "wrapped", steps: [repeat], finalize: repeat });
    expect(
      await coordinator("root", pipelineTool(wrapper, { description: "Nested" }), {
        maxConcurrency: 1,
      }).runOrThrow({})
    ).toBe(2);
  });

  it.each(["maxCalls", "maxDecisions"] as const)(
    "preserves shared %s through ordinary wrappers",
    async (kind) => {
      const work = vi.fn(() => 1);
      const leaf = coordinator(
        "leaf",
        defineTool({
          description: "One",
          inputSchema: emptyInput,
          outputSchema: numberSchema,
          run: work,
        })
      );
      const { fromPipeline } = createSteps(emptyInput);
      const nested = fromPipeline("nested", { pipeline: leaf });
      const wrapper = definePipeline({ id: "wrapper", steps: [nested], finalize: nested });
      const root = coordinator("root", pipelineTool(wrapper, { description: "Delegate" }), {
        [kind]: 1,
      });
      const result = await root.run({});
      expect(result.status).toBe("failed");
      expect(JSON.stringify(result.errors)).toContain(`${kind}=1`);
      expect(work).not.toHaveBeenCalled();
    }
  );

  it("atomically reserves competing sibling batches after asynchronous validation", async () => {
    const validated = deferred();
    let validations = 0;
    const argumentSchema = schema<{}>(async () => {
      if (++validations === 2) validated.resolve();
      await validated.promise;
      return { value: {} };
    });
    const run = vi.fn(() => 1);
    const child = coordinator(
      "child",
      defineTool({
        description: "Leaf",
        inputSchema: argumentSchema,
        outputSchema: numberSchema,
        run,
      }),
      { maxConcurrency: 2 },
      [{}, {}]
    );
    const root = coordinator(
      "root",
      pipelineTool(child, { description: "Child" }),
      { maxCalls: 5, maxConcurrency: 2 },
      [{}, {}]
    );
    const result = await root.run({});
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result.errors)).toContain("maxCalls=5");
    expect(validations).toBe(4);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each(["maxCalls", "maxDecisions"] as const)(
    "children can tighten %s without resetting ancestors",
    async (kind) => {
      const run = vi.fn(() => 1);
      const child = coordinator(
        "child",
        defineTool({
          description: "Leaf",
          inputSchema: emptyInput,
          outputSchema: numberSchema,
          run,
        }),
        { [kind]: kind === "maxCalls" ? 0 : 1 }
      );
      const root = coordinator("root", pipelineTool(child, { description: "Child" }), {
        maxCalls: 10,
        maxDecisions: 10,
      });
      const result = await root.run({});
      expect(result.status).toBe("failed");
      expect(JSON.stringify(result.errors)).toContain(kind);
      expect(run).toHaveBeenCalledTimes(kind === "maxCalls" ? 0 : 1);
    }
  );

  it("isolates shared counters across simultaneous roots", async () => {
    const leaf = coordinator(
      "child",
      defineTool({
        description: "One",
        inputSchema: emptyInput,
        outputSchema: numberSchema,
        run: () => 1,
      })
    );
    const root = coordinator("root", pipelineTool(leaf, { description: "Child" }), {
      maxCalls: 2,
      maxDecisions: 4,
      maxConcurrency: 1,
    });
    expect(await Promise.all([root.runOrThrow({}), root.runOrThrow({})])).toEqual([1, 1]);
  });

  it.each([0, 1, 2])("checks delegation depth %s before dispatch", async (maxDepth) => {
    const run = vi.fn(() => 1);
    const leaf = coordinator(
      "leaf",
      defineTool({ description: "One", inputSchema: emptyInput, outputSchema: numberSchema, run }),
      { maxDepth: 0 }
    );
    const middle = coordinator("middle", pipelineTool(leaf, { description: "Leaf" }));
    const root = coordinator("root", pipelineTool(middle, { description: "Middle" }), { maxDepth });
    const result = await root.run({});
    expect(result.status).toBe(maxDepth === 2 ? "completed" : "failed");
    expect(run).toHaveBeenCalledTimes(maxDepth === 2 ? 1 : 0);
    if (maxDepth < 2) expect(JSON.stringify(result.errors)).toContain(`maxDepth=${maxDepth}`);
  });

  it("applies a child's tighter depth bound", async () => {
    const run = vi.fn(() => 1);
    const { step } = createSteps(emptyInput);
    const work = step("work", { run });
    const leaf = definePipeline({ id: "leaf", steps: [work], finalize: work });
    const child = coordinator("child", pipelineTool(leaf, { description: "Leaf" }), {
      maxDepth: 0,
    });
    const root = coordinator("root", pipelineTool(child, { description: "Child" }), {
      maxDepth: 4,
    });
    const result = await root.run({});
    expect(JSON.stringify(result.errors)).toContain("maxDepth=0");
    expect(run).not.toHaveBeenCalled();
  });

  it("limits ordinary pipeline leaf work across concurrent child agents", async () => {
    let active = 0;
    let peak = 0;
    const firstPair = deferred();
    const release = deferred();
    const { step } = createSteps(emptyInput);
    const work = step("work", {
      run: async () => {
        peak = Math.max(peak, ++active);
        if (active === 2) firstPair.resolve();
        await release.promise;
        active--;
        return 1;
      },
    });
    const pipeline = definePipeline({ id: "ordinary", steps: [work], finalize: work });
    const child = coordinator(
      "child",
      pipelineTool(pipeline, { description: "Ordinary" }),
      { maxConcurrency: 3 },
      [{}, {}, {}]
    );
    const root = coordinator(
      "root",
      pipelineTool(child, { description: "Child" }),
      { maxConcurrency: 2 },
      [{}, {}]
    );
    const pending = root.runOrThrow({});
    await firstPair.promise;
    expect(active).toBe(2);
    release.resolve();
    expect(await pending).toBe(6);
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it("enforces a tighter child concurrency limit even when the root has spare permits", async () => {
    let active = 0;
    let peak = 0;
    const run = async () => {
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
      return 1;
    };
    const child = coordinator(
      "child",
      defineTool({ description: "Leaf", inputSchema: emptyInput, outputSchema: numberSchema, run }),
      { maxConcurrency: 1 },
      [{}, {}, {}]
    );
    expect(
      await coordinator("root", pipelineTool(child, { description: "Child" }), {
        maxConcurrency: 5,
      }).runOrThrow({})
    ).toBe(3);
    expect(peak).toBe(1);
  });

  it("limits decision callbacks across siblings without holding waiting parent permits", async () => {
    let active = 0;
    let peak = 0;
    const child = defineAgentLoop({
      id: "child",
      inputSchema: emptyInput,
      resultSchema: numberSchema,
      initialState: () => 0,
      decide: async () => {
        peak = Math.max(peak, ++active);
        await Promise.resolve();
        active--;
        return { kind: "finish", result: 1 };
      },
    });
    const { forEachPipeline } = createSteps(emptyInput);
    const batch = forEachPipeline("children", {
      pipeline: child,
      items: () => [0, 1],
      key: String,
      mapOptions: () => ({}),
      concurrency: 2,
    });
    const wrapper = definePipeline({
      id: "wrapper",
      steps: [batch],
      finalize: ({ children }) => children!.reduce((a, b) => a + b, 0),
    });
    expect(
      await coordinator("root", pipelineTool(wrapper, { description: "Children" }), {
        maxConcurrency: 1,
      }).runOrThrow({})
    ).toBe(2);
    expect(peak).toBe(1);
  });

  it("cancels queued work, forwards the signal, and drains active descendants", async () => {
    const controller = new AbortController();
    const started = deferred();
    const release = deferred();
    const run = vi.fn(async (_value, context) => {
      if (context.signal) expect(context.signal).toBe(controller.signal);
      started.resolve();
      await release.promise;
      return 1;
    });
    const child = coordinator(
      "child",
      defineTool({ description: "Wait", inputSchema: emptyInput, outputSchema: numberSchema, run }),
      { maxConcurrency: 20 },
      Array.from({ length: 20 }, () => ({}))
    );
    const root = coordinator("root", pipelineTool(child, { description: "Child" }), {
      maxConcurrency: 1,
    });
    let settled = false;
    const pending = root.run({}, {}, { signal: controller.signal }).then((result) => {
      settled = true;
      return result;
    });
    await started.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    expect((await pending).status).toBe("cancelled");
    expect(run).toHaveBeenCalledTimes(1);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(await root.runOrThrow({})).toBe(20);
  });

  it("drains sibling descendants after a fatal child failure", async () => {
    const active = deferred();
    const release = deferred();
    const { step } = createSteps(input);
    const work = step("work", {
      run: async (_inputs, context) => {
        if (context.options.value === 0) {
          await active.promise;
          throw new Error("fatal");
        }
        active.resolve();
        await release.promise;
        return 1;
      },
    });
    const child = definePipeline({ id: "child", steps: [work], finalize: work });
    const root = coordinator(
      "root",
      pipelineTool(child, { description: "Child" }),
      { maxConcurrency: 2 },
      [{ value: 0 }, { value: 1 }]
    );
    let settled = false;
    const pending = root.run({}).then((result) => {
      settled = true;
      return result;
    });
    await active.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    expect((await pending).status).toBe("failed");
  });

  it("keeps subagent model ToolError fatal and dry-run skips live models", async () => {
    const decide = vi.fn(() => {
      throw new ToolError("MODEL", "Failure");
    });
    const child = defineAgentLoop({
      id: "child",
      inputSchema: emptyInput,
      resultSchema: numberSchema,
      initialState: () => 0,
      decide,
    });
    const root = coordinator("root", pipelineTool(child, { description: "Child" }));
    expect((await root.run({})).status).toBe("failed");
    expect((await root.run({}, { dryRun: true })).status).toBe("failed");
    expect(decide).toHaveBeenCalledTimes(1);
  });
});
