import { hostname } from "node:os";
import { expect, it, vi } from "vitest";
import {
  defineAgentLoop,
  defineTool,
  pipelineTool,
  createMemoryAgentCheckpointStore,
  plainAgentCheckpointCodec,
} from "./agent.js";
import type { AgentCheckpointStore } from "./checkpoint-types.js";
import type { Checkpoint, SavedAgent } from "./checkpoint-format.js";
import { checkedCheckpoint } from "./checkpoint-format.js";
import { createNodeAgentEnvironment } from "./node-environment.js";
import { emptyInput, numberSchema, schema } from "./agent.test-support.js";
import { createSteps, definePipeline } from "../core/pipeline.js";

// Only the host-change test stubs the host name; every other call reaches the real implementation.
vi.mock("node:os", { spy: true });

function interruptWrite(
  store: AgentCheckpointStore,
  matches: (snapshot: Checkpoint) => boolean,
  after = false
): AgentCheckpointStore {
  let failed = false;
  return {
    acquire: async (key) => {
      const lease = await store.acquire(key);
      return {
        ...lease,
        write: async (value) => {
          if (!failed && matches(checkedCheckpoint(plainAgentCheckpointCodec.decode(value)))) {
            failed = true;
            if (after) await lease.write(value);
            throw new Error("simulated storage interruption");
          }
          await lease.write(value);
        },
      };
    },
  };
}
function agents(snapshot: Checkpoint): SavedAgent[] {
  return Object.values(snapshot.agents);
}

it("resumes an acknowledged decision without repeating argument transforms, completed calls or finish transforms", async () => {
  const storage = interruptWrite(createMemoryAgentCheckpointStore(), (snapshot) =>
    agents(snapshot).some((agent) => agent.phase === "calls" && agent.decision.admitted)
  );
  const argument = vi.fn((value) => ({ value: Number(value) }));
  const output = vi.fn((value) => ({ value: Number(value) * 2 }));
  const finish = vi.fn((value) => ({ value: `value=${value}` }));
  const handler = vi.fn((value: number) => value + 1);
  const decide = vi.fn((state, context) =>
    context.turn === 1
      ? { kind: "continue", calls: [{ id: "work", tool: "work", input: "3" }] }
      : { kind: "finish", result: state }
  );
  const agent = defineAgentLoop({
    id: "resumed-validation",
    implementationVersion: "1",
    inputSchema: emptyInput,
    resultSchema: schema<number, string>(finish),
    initialState: () => 0,
    durability: { store: storage, key: "job" },
    tools: {
      work: defineTool({
        description: "Work",
        inputSchema: schema<string, number>(argument),
        outputSchema: schema<number>(output),
        run: handler,
      }),
    },
    decide,
    reduce: (_state, outcomes) => (outcomes[0]!.ok ? Number(outcomes[0]!.value) : -1),
  });
  expect((await agent.run({})).status).toBe("failed");
  expect(handler).not.toHaveBeenCalled();
  expect(await agent.runOrThrow({})).toBe("value=8");
  expect(await agent.runOrThrow({})).toBe("value=8");
  expect(argument).toHaveBeenCalledTimes(1);
  expect(output).toHaveBeenCalledTimes(1);
  expect(finish).toHaveBeenCalledTimes(1);
  expect(handler).toHaveBeenCalledTimes(1);
  expect(decide).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  "reads authoritative storage after an outcome write rejects (committed: %s)",
  async (committed) => {
    const storage = interruptWrite(
      createMemoryAgentCheckpointStore(),
      (snapshot) =>
        agents(snapshot).some((agent) =>
          agent.decision?.calls.some((call) => call.status === "completed")
        ),
      committed
    );
    const handler = vi.fn(() => 7);
    const agent = defineAgentLoop({
      id: "ambiguous-outcome",
      implementationVersion: "1",
      inputSchema: emptyInput,
      resultSchema: numberSchema,
      initialState: () => 0,
      durability: { store: storage, key: "job" },
      tools: {
        work: defineTool({
          description: "Mutation",
          inputSchema: numberSchema,
          outputSchema: numberSchema,
          run: handler,
        }),
      },
      decide: (state, context) =>
        context.turn === 1
          ? { kind: "continue", calls: [{ id: "work", tool: "work", input: 1 }] }
          : { kind: "finish", result: state },
      reduce: (_state, outcomes) => (outcomes[0]!.ok ? Number(outcomes[0]!.value) : -1),
    });
    expect((await agent.run({})).status).toBe("failed");
    expect(await agent.runOrThrow({})).toBe(committed ? 7 : -1);
    expect(handler).toHaveBeenCalledTimes(1);
  }
);

it("replays interrupted safe calls and preserves committed outcomes in decision order", async () => {
  const storage = createMemoryAgentCheckpointStore();
  const abort = new AbortController();
  let stop = true;
  const first = vi.fn(() => 1);
  const second = vi.fn((_input) => {
    if (stop) {
      stop = false;
      abort.abort(new Error("stop"));
    }
    return 2;
  });
  const agent = defineAgentLoop({
    id: "ordered-recovery",
    implementationVersion: "1",
    inputSchema: emptyInput,
    resultSchema: schema<number[]>((value) => ({ value: value as number[] })),
    initialState: (): number[] => [],
    durability: { store: storage, key: "job" },
    tools: {
      first: defineTool({
        description: "First",
        inputSchema: numberSchema,
        outputSchema: numberSchema,
        run: first,
      }),
      second: defineTool({
        description: "Second",
        replay: "safe",
        inputSchema: numberSchema,
        outputSchema: numberSchema,
        run: second,
      }),
    },
    decide: (state, context) =>
      context.turn === 1
        ? {
            kind: "continue",
            calls: [
              { id: "one", tool: "first", input: 1 },
              { id: "two", tool: "second", input: 2 },
            ],
          }
        : { kind: "finish", result: state },
    reduce: (_state, outcomes) =>
      outcomes.map((outcome) => (outcome.ok ? Number(outcome.value) : -1)),
  });
  expect((await agent.run({}, undefined, { signal: abort.signal })).status).toBe("cancelled");
  expect(await agent.runOrThrow({})).toEqual([1, 2]);
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(2);
});

it("does not reset decision budgets after interrupted model work", async () => {
  const store = createMemoryAgentCheckpointStore();
  const abort = new AbortController();
  const decide = vi.fn(() => {
    abort.abort(new Error("stop"));
    return { kind: "finish", result: 1 };
  });
  const agent = defineAgentLoop({
    id: "decision-budget",
    implementationVersion: "1",
    inputSchema: emptyInput,
    resultSchema: numberSchema,
    initialState: () => 0,
    durability: { store, key: "job" },
    limits: { maxDecisions: 1 },
    decide,
  });
  expect((await agent.run({}, undefined, { signal: abort.signal })).status).toBe("cancelled");
  await expect(agent.runOrThrow({})).rejects.toThrow("maxDecisions");
  expect(decide).toHaveBeenCalledTimes(1);
});

it("does not charge an admitted batch twice or reset call budgets on restart", async () => {
  const store = createMemoryAgentCheckpointStore();
  const abort = new AbortController();
  const work = vi.fn(() => {
    abort.abort(new Error("stop"));
    return 1;
  });
  const agent = defineAgentLoop({
    id: "call-budget",
    implementationVersion: "1",
    inputSchema: emptyInput,
    resultSchema: numberSchema,
    initialState: () => 0,
    durability: { store, key: "job" },
    limits: { maxCalls: 1 },
    tools: {
      work: defineTool({
        description: "Work",
        inputSchema: numberSchema,
        outputSchema: numberSchema,
        run: work,
      }),
    },
    decide: (_state, context) => ({
      kind: "continue",
      calls: [{ id: `work-${context.turn}`, tool: "work", input: 1 }],
    }),
  });
  expect((await agent.run({}, undefined, { signal: abort.signal })).status).toBe("cancelled");
  await expect(agent.runOrThrow({})).rejects.toThrow("maxCalls");
  expect(work).toHaveBeenCalledTimes(1);
});

it("resumes child agents through ordinary fan-out pipelines with stable identities and ancestor budgets", async () => {
  const store = createMemoryAgentCheckpointStore();
  const abort = new AbortController();
  let stop = true;
  const work = vi.fn((input: number, context) => {
    expect(context.execution).toMatchObject({ id: "job", turn: 1, call: "work" });
    if (input === 2 && stop) {
      stop = false;
      abort.abort(new Error("stop"));
    }
    return input;
  });
  const input = schema<{ n: number }>((value) => ({ value: value as { n: number } }));
  const child = defineAgentLoop({
    id: "durable-child",
    implementationVersion: "1",
    inputSchema: input,
    resultSchema: numberSchema,
    initialState: () => 0,
    tools: {
      work: defineTool({
        description: "Safe child work",
        replay: "safe",
        inputSchema: numberSchema,
        outputSchema: numberSchema,
        run: work,
      }),
    },
    decide: (state, context) =>
      context.turn === 1
        ? { kind: "continue", calls: [{ id: "work", tool: "work", input: context.options.n }] }
        : { kind: "finish", result: state },
    reduce: (_state, outcomes) => (outcomes[0]!.ok ? Number(outcomes[0]!.value) : -1),
  });
  const { forEachPipeline } = createSteps(emptyInput);
  const items = forEachPipeline("children", {
    pipeline: child,
    items: () => [1, 2],
    key: String,
    mapOptions: (n) => ({ n }),
  });
  const wrapper = definePipeline({ id: "durable-wrapper", steps: [items], finalize: items });
  const parent = defineAgentLoop({
    id: "durable-parent",
    implementationVersion: "1",
    inputSchema: emptyInput,
    resultSchema: schema<number[]>((value) => ({ value: value as number[] })),
    initialState: (): number[] => [],
    durability: { store, key: "job" },
    limits: { maxCalls: 3, maxDecisions: 6, maxConcurrency: 1 },
    tools: { children: pipelineTool(wrapper, { description: "Resume children", replay: "safe" }) },
    decide: (state, context) =>
      context.turn === 1
        ? { kind: "continue", calls: [{ id: "children", tool: "children", input: {} }] }
        : { kind: "finish", result: state },
    reduce: (_state, outcomes) =>
      outcomes[0]!.ok && outcomes[0]!.tool === "children" ? [...outcomes[0]!.value] : [],
  });
  expect((await parent.run({}, undefined, { signal: abort.signal })).status).toBe("cancelled");
  expect(await parent.runOrThrow({})).toEqual([1, 2]);
  expect(work.mock.calls.map(([n]) => n)).toEqual([1, 2, 2]);
  expect(work.mock.calls[0]![1].execution.agent).not.toBe(work.mock.calls[1]![1].execution.agent);
  expect(work.mock.calls[1]![1].execution).toEqual(work.mock.calls[2]![1].execution);
  expect(work.mock.calls[0]![1].execution.agent).toBe(
    JSON.stringify([
      '["agent","durable-parent"]',
      '["call",1,"children"]',
      '["pipeline","durable-wrapper","calls","children"]',
      '["pipeline","durable-child","children","1"]',
      '["agent","durable-child"]',
    ])
  );
});

it("rejects different inputs and semantic versions before replaying stored work", async () => {
  const store = createMemoryAgentCheckpointStore();
  const decide = vi.fn(() => ({ kind: "finish", result: 1 }));
  const agent = (version: string) =>
    defineAgentLoop({
      id: "bound-execution",
      implementationVersion: version,
      inputSchema: schema<{ value: number }>((value) => ({ value: value as { value: number } })),
      resultSchema: numberSchema,
      initialState: () => 0,
      durability: { store, key: "job" },
      decide,
    });
  expect(await agent("1").runOrThrow({ value: 1 })).toBe(1);
  await expect(agent("1").runOrThrow({ value: 2 })).rejects.toThrow("differ");
  await expect(agent("2").runOrThrow({ value: 1 })).rejects.toThrow("differ");
  expect(decide).toHaveBeenCalledTimes(1);
});

it("resumes a durable execution after the host identity changes", async () => {
  const store = createMemoryAgentCheckpointStore();
  const work = vi.fn(() => 7);
  const agent = defineAgentLoop({
    id: "host-independent",
    implementationVersion: "1",
    inputSchema: emptyInput,
    resultSchema: numberSchema,
    initialState: () => 0,
    durability: { store, key: "job" },
    tools: {
      work: defineTool({
        description: "Work",
        inputSchema: numberSchema,
        outputSchema: numberSchema,
        run: work,
      }),
    },
    decide: (_state, context) =>
      context.turn === 1
        ? { kind: "continue", calls: [{ id: "work", tool: "work", input: 1 }] }
        : { kind: "finish", result: 7 },
    reduce: () => 0,
  });
  // A recreated container or pod receives a new host name; the default local
  // workspace authority must not follow it.
  vi.mocked(hostname).mockReturnValue("pod-a");
  expect(await agent.runOrThrow({})).toBe(7);
  vi.mocked(hostname).mockReturnValue("pod-b");
  expect(await agent.runOrThrow({})).toBe(7);
  expect(work).toHaveBeenCalledTimes(1);
  vi.mocked(hostname).mockRestore();
});

it("rejects resuming a durable execution under a different explicit environment id", async () => {
  const store = createMemoryAgentCheckpointStore();
  const decide = vi.fn(() => ({ kind: "finish", result: 1 }));
  const agent = (id: string) =>
    defineAgentLoop({
      id: "scoped-authority",
      implementationVersion: "1",
      inputSchema: emptyInput,
      resultSchema: numberSchema,
      initialState: () => 0,
      durability: { store, key: "job" },
      environment: createNodeAgentEnvironment({ id }),
      decide,
    });
  expect(await agent("worker-1").runOrThrow({})).toBe(1);
  await expect(agent("worker-2").runOrThrow({})).rejects.toThrow("differ");
  expect(decide).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  "rejects unversioned children that inherit recovery (wrapped: %s)",
  async (wrapped) => {
    const store = createMemoryAgentCheckpointStore();
    const initialState = vi.fn(() => 0);
    const decide = vi.fn(() => ({ kind: "finish", result: 1 }));
    const child = defineAgentLoop({
      id: "unversioned-child",
      inputSchema: emptyInput,
      resultSchema: numberSchema,
      initialState,
      decide,
    });
    // Ordinary invocations remain ephemeral and do not require a version.
    expect(await child.runOrThrow({})).toBe(1);
    initialState.mockClear();
    decide.mockClear();
    const { fromPipeline } = createSteps(emptyInput);
    const step = fromPipeline("child", { pipeline: child });
    const wrapper = definePipeline({ id: "unversioned-wrapper", steps: [step], finalize: step });
    const parent = defineAgentLoop({
      id: "versioned-parent",
      implementationVersion: "1",
      inputSchema: emptyInput,
      resultSchema: numberSchema,
      initialState: () => 0,
      durability: { store, key: "job" },
      tools: {
        child: pipelineTool(wrapped ? wrapper : child, {
          description: "Run child",
          replay: "safe",
        }),
      },
      decide: (state, context) =>
        context.turn === 1
          ? { kind: "continue", calls: [{ id: "child", tool: "child", input: {} }] }
          : { kind: "finish", result: state },
      reduce: (_state, outcomes) => {
        const outcome = outcomes[0]!;
        if (!outcome.ok) throw new Error(outcome.error.message);
        return Number(outcome.value);
      },
    });
    await expect(parent.runOrThrow({})).rejects.toThrow("implementationVersion");
    expect(initialState).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    const lease = await store.acquire("job");
    try {
      expect(
        Object.keys(
          checkedCheckpoint(plainAgentCheckpointCodec.decode((await lease.read())!)).agents
        )
      ).toHaveLength(1);
    } finally {
      await lease.close();
    }
  }
);

it("rejects changed child versions before restoring a completed ancestor", async () => {
  const store = createMemoryAgentCheckpointStore();
  const childDecide = vi.fn(() => ({ kind: "finish", result: 1 }));
  const initialState = vi.fn(() => 0);
  const parent = (version: string) => {
    const child = defineAgentLoop({
      id: "versioned-child",
      implementationVersion: version,
      inputSchema: emptyInput,
      resultSchema: numberSchema,
      initialState,
      decide: childDecide,
    });
    const { fromPipeline } = createSteps(emptyInput);
    const step = fromPipeline("child", { pipeline: child });
    const wrapper = definePipeline({ id: "versioned-wrapper", steps: [step], finalize: step });
    return defineAgentLoop({
      id: "bound-parent",
      implementationVersion: "1",
      inputSchema: emptyInput,
      resultSchema: numberSchema,
      initialState,
      durability: { store, key: "job" },
      tools: {
        child: pipelineTool(wrapper, { description: "Run versioned child", replay: "safe" }),
      },
      decide: (state, context) =>
        context.turn === 1
          ? { kind: "continue", calls: [{ id: "child", tool: "child", input: {} }] }
          : { kind: "finish", result: state },
      reduce: (_state, outcomes) => (outcomes[0]!.ok ? Number(outcomes[0]!.value) : -1),
    });
  };
  expect(await parent("1").runOrThrow({})).toBe(1);
  expect(await parent("1").runOrThrow({})).toBe(1);
  await expect(parent("2").runOrThrow({})).rejects.toThrow("differ");
  expect(initialState).toHaveBeenCalledTimes(2);
  expect(childDecide).toHaveBeenCalledTimes(1);
});

it("does not open checkpoint storage during planning or previews", async () => {
  const acquire = vi.fn();
  const decide = () => ({ kind: "finish", result: 1 });
  const agent = defineAgentLoop({
    id: "durable-preview",
    implementationVersion: "1",
    inputSchema: emptyInput,
    resultSchema: numberSchema,
    initialState: () => 0,
    durability: { store: { acquire }, key: "job" },
    decide,
    dryRun: decide,
  });
  expect(agent.plan().ok).toBe(true);
  expect(await agent.runOrThrow({}, { dryRun: true })).toBe(1);
  expect(acquire).not.toHaveBeenCalled();
});

it("keeps an explicitly previewed child out of a live parent's recovery state", async () => {
  const store = createMemoryAgentCheckpointStore();
  const live = vi.fn(() => ({ kind: "finish", result: 1 }));
  const child = defineAgentLoop({
    id: "previewed-child",
    inputSchema: emptyInput,
    resultSchema: numberSchema,
    initialState: () => 0,
    decide: live,
    dryRun: () => ({ kind: "finish", result: 2 }),
  });
  const { fromPipeline } = createSteps(emptyInput);
  const preview = fromPipeline("preview", { pipeline: child, controls: { dryRun: true } });
  const wrapper = definePipeline({ id: "preview-wrapper", steps: [preview], finalize: preview });
  const parent = defineAgentLoop({
    id: "live-parent",
    implementationVersion: "1",
    inputSchema: emptyInput,
    resultSchema: numberSchema,
    initialState: () => 0,
    durability: { store, key: "job" },
    tools: { child: pipelineTool(wrapper, { description: "Preview child", replay: "safe" }) },
    decide: (state, context) =>
      context.turn === 1
        ? { kind: "continue", calls: [{ id: "child", tool: "child", input: {} }] }
        : { kind: "finish", result: state },
    reduce: (_state, outcomes) => (outcomes[0]!.ok ? Number(outcomes[0]!.value) : -1),
  });
  expect(await parent.runOrThrow({})).toBe(2);
  expect(live).not.toHaveBeenCalled();
  const lease = await store.acquire("job");
  try {
    expect(
      Object.keys(checkedCheckpoint(plainAgentCheckpointCodec.decode((await lease.read())!)).agents)
    ).toHaveLength(1);
  } finally {
    await lease.close();
  }
});

it("rehydrates a child agent's prepared options without repeating its schema transform", async () => {
  const storage = interruptWrite(createMemoryAgentCheckpointStore(), (snapshot) =>
    agents(snapshot).some((agent) =>
      agent.decision?.calls.some((call) => call.tool === "child" && call.status === "running")
    )
  );
  const transform = vi.fn((value: unknown) => ({
    value: { value: Number((value as { raw: string }).raw) },
  }));
  const child = defineAgentLoop({
    id: "transformed-child",
    implementationVersion: "1",
    inputSchema: schema<{ raw: string }, { value: number }>(transform),
    resultSchema: numberSchema,
    initialState: () => 0,
    decide: (_state, context) => ({ kind: "finish", result: context.options.value }),
  });
  const parent = defineAgentLoop({
    id: "transformed-parent",
    implementationVersion: "1",
    inputSchema: emptyInput,
    resultSchema: numberSchema,
    initialState: () => 0,
    durability: { store: storage, key: "job" },
    tools: { child: pipelineTool(child, { description: "Durable child" }) },
    decide: (state, context) =>
      context.turn === 1
        ? { kind: "continue", calls: [{ id: "child", tool: "child", input: { raw: "4" } }] }
        : { kind: "finish", result: state },
    reduce: (_state, outcomes) => (outcomes[0]!.ok ? Number(outcomes[0]!.value) : -1),
  });
  expect((await parent.run({})).status).toBe("failed");
  expect(await parent.runOrThrow({})).toBe(4);
  expect(transform).toHaveBeenCalledTimes(1);
});

it("retains parallel outcomes when storage acknowledgements settle in reverse call order", async () => {
  const store = createMemoryAgentCheckpointStore();
  const abort = new AbortController();
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  let stop = true;
  const work = vi.fn(async (n: number) => {
    if (n === 1 && stop) await ready;
    if (n === 2) release();
    return n;
  });
  const reduce = vi.fn((_state, outcomes) => {
    if (stop) {
      stop = false;
      abort.abort(new Error("stop before reduction commit"));
    }
    return outcomes.map((outcome: { ok: boolean; value?: unknown }) => Number(outcome.value));
  });
  const agent = defineAgentLoop({
    id: "parallel-recovery",
    implementationVersion: "1",
    inputSchema: emptyInput,
    resultSchema: schema<number[]>((value) => ({ value: value as number[] })),
    initialState: (): number[] => [],
    durability: { store, key: "job" },
    limits: { maxConcurrency: 2, maxCalls: 2 },
    tools: {
      work: defineTool({
        description: "Parallel work",
        inputSchema: numberSchema,
        outputSchema: numberSchema,
        run: work,
      }),
    },
    decide: (state, context) =>
      context.turn === 1
        ? {
            kind: "continue",
            calls: [1, 2].map((input) => ({ id: String(input), tool: "work", input })),
          }
        : { kind: "finish", result: state },
    reduce,
  });
  expect((await agent.run({}, undefined, { signal: abort.signal })).status).toBe("cancelled");
  expect(await agent.runOrThrow({})).toEqual([1, 2]);
  expect(work).toHaveBeenCalledTimes(2);
  expect(reduce).toHaveBeenCalledTimes(2);
});

it("persists terminal failures rather than rerunning broken callbacks", async () => {
  const decide = vi.fn(() => {
    throw new Error("fatal model failure");
  });
  const agent = defineAgentLoop({
    id: "failed-execution",
    implementationVersion: "1",
    inputSchema: emptyInput,
    resultSchema: numberSchema,
    initialState: () => 0,
    durability: { store: createMemoryAgentCheckpointStore(), key: "job" },
    decide,
  });
  for (let attempt = 0; attempt < 2; attempt++)
    await expect(agent.runOrThrow({})).rejects.toThrow("fatal model failure");
  expect(decide).toHaveBeenCalledTimes(1);
});

it("rejects corrupt receipts before opening an execution or invoking a callback", async () => {
  const store = createMemoryAgentCheckpointStore();
  const lease = await store.acquire("job");
  await lease.write(plainAgentCheckpointCodec.encode({ version: 999, agents: {}, budgets: {} }));
  await lease.close();
  const decide = vi.fn(() => ({ kind: "finish", result: 1 }));
  const agent = defineAgentLoop({
    id: "corrupt-execution",
    implementationVersion: "1",
    inputSchema: emptyInput,
    resultSchema: numberSchema,
    initialState: () => 0,
    durability: { store, key: "job" },
    decide,
  });
  await expect(agent.runOrThrow({})).rejects.toThrow("checkpoint envelope");
  expect(decide).not.toHaveBeenCalled();
});

it("uses a custom lossless codec for validated class arguments, outcomes and final results", async () => {
  type Tree =
    | ["date", number]
    | ["array", Tree[]]
    | ["record", [string, Tree][]]
    | ["value", unknown];
  function pack(value: unknown): Tree {
    if (value instanceof Date) return ["date", value.getTime()];
    if (Array.isArray(value)) return ["array", value.map(pack)];
    if (value !== null && typeof value === "object")
      return [
        "record",
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, value]) => [key, pack(value)]),
      ];
    return ["value", value];
  }
  function unpack(value: Tree): unknown {
    if (value[0] === "date") return new Date(value[1]);
    if (value[0] === "array") return value[1].map(unpack);
    if (value[0] === "record")
      return Object.fromEntries(value[1].map(([key, value]) => [key, unpack(value)]));
    return value[1];
  }
  const input = vi.fn((value: unknown) => ({ value: new Date(String(value)) }));
  const result = vi.fn((value: unknown) => ({ value: new Date(Number(value)) }));
  const handler = vi.fn((value: Date) => new Date(value.getTime() + 1000));
  const agent = defineAgentLoop({
    id: "custom-checkpoint-codec",
    implementationVersion: "1",
    inputSchema: emptyInput,
    resultSchema: schema<number, Date>(result),
    initialState: () => 0,
    durability: {
      store: createMemoryAgentCheckpointStore(),
      key: "job",
      codec: {
        encode: (value) => plainAgentCheckpointCodec.encode(pack(value)),
        decode: (value) => unpack(plainAgentCheckpointCodec.decode(value) as Tree),
      },
    },
    tools: {
      date: defineTool({
        description: "Transform a date",
        inputSchema: schema<string, Date>(input),
        outputSchema: schema<Date>((value) =>
          value instanceof Date ? { value } : { issues: [{ message: "Expected date" }] }
        ),
        run: handler,
      }),
    },
    decide: (state, context) =>
      context.turn === 1
        ? { kind: "continue", calls: [{ id: "date", tool: "date", input: "2026-01-01T00:00:00Z" }] }
        : { kind: "finish", result: state },
    reduce: (_state, outcomes) =>
      outcomes[0]!.ok && outcomes[0]!.tool === "date" ? outcomes[0]!.value.getTime() : -1,
  });
  for (let attempt = 0; attempt < 2; attempt++)
    expect(await agent.runOrThrow({})).toEqual(new Date("2026-01-01T00:00:01Z"));
  expect(input).toHaveBeenCalledTimes(1);
  expect(result).toHaveBeenCalledTimes(1);
  expect(handler).toHaveBeenCalledTimes(1);
});

it("resumes a version-one call receipt without rerunning its completed work or initialization", async () => {
  const store = createMemoryAgentCheckpointStore();
  const initialState = vi.fn(() => 0);
  const work = vi.fn(() => 7);
  const agent = defineAgentLoop({
    id: "legacy-receipt",
    implementationVersion: "1",
    inputSchema: emptyInput,
    resultSchema: numberSchema,
    initialState,
    durability: { store, key: "job" },
    tools: {
      work: defineTool({
        description: "Completed work",
        inputSchema: numberSchema,
        outputSchema: numberSchema,
        run: work,
      }),
    },
    decide: (state) => ({ kind: "finish", result: state }),
    reduce: (_state, outcomes) =>
      outcomes[0]!.ok && outcomes[0]!.tool === "work" ? outcomes[0]!.value : -1,
  });
  const key = JSON.stringify(['["agent","legacy-receipt"]']);
  const lease = await store.acquire("job");
  await lease.write(
    plainAgentCheckpointCodec.encode({
      version: 1,
      agents: {
        [key]: {
          metadata: {
            definition: JSON.stringify(agent.definition.identity),
            implementationVersion: "1",
            options: {},
            environment: createNodeAgentEnvironment().id,
            cwd: process.cwd(),
            cache: "use",
          },
          execution: { state: 0, turn: 1, stateVersion: 0, calls: 0 },
          phase: "calls",
          decision: {
            state: 0,
            admitted: true,
            calls: [
              {
                id: "work",
                tool: "work",
                kind: "handler",
                replay: "unsafe",
                input: 3,
                status: "completed",
                outcome: { id: "work", tool: "work", ok: true, value: 7 },
              },
            ],
          },
        },
      },
      budgets: {
        [key]: {
          depth: 0,
          limits: {
            maxTurns: 20,
            maxCalls: 100,
            maxDecisions: 100,
            maxDepth: 4,
            maxConcurrency: 1,
          },
          maxCalls: 1,
          maxDecisions: 1,
        },
      },
    })
  );
  await lease.close();
  expect(await agent.runOrThrow({})).toBe(7);
  expect(initialState).not.toHaveBeenCalled();
  expect(work).not.toHaveBeenCalled();
});

it("persists a terminal failure when concurrent child admissions exceed the ancestor budget", async () => {
  const store = createMemoryAgentCheckpointStore();
  const decide = vi.fn(() => ({ kind: "finish", result: 1 }));
  const child = defineAgentLoop({
    id: "budget-child",
    implementationVersion: "1",
    inputSchema: emptyInput,
    resultSchema: numberSchema,
    initialState: () => 0,
    decide,
  });
  const { forEachPipeline } = createSteps(emptyInput);
  const children = forEachPipeline("children", {
    pipeline: child,
    items: () => [1, 2],
    key: String,
    concurrency: 2,
    mapOptions: () => ({}),
  });
  const wrapper = definePipeline({ id: "budget-wrapper", steps: [children], finalize: children });
  const parent = defineAgentLoop({
    id: "budget-parent",
    implementationVersion: "1",
    inputSchema: emptyInput,
    resultSchema: numberSchema,
    initialState: () => 0,
    durability: { store, key: "job" },
    limits: { maxDecisions: 2, maxConcurrency: 2 },
    tools: {
      children: pipelineTool(wrapper, { description: "Concurrent children", replay: "safe" }),
    },
    decide: () => ({ kind: "continue", calls: [{ id: "children", tool: "children", input: {} }] }),
  });
  expect((await parent.run({})).status).toBe("failed");
  const lease = await store.acquire("job");
  const checkpoint = checkedCheckpoint(plainAgentCheckpointCodec.decode((await lease.read())!));
  await lease.close();
  const root = JSON.stringify(['["agent","budget-parent"]']);
  expect(checkpoint.agents[root]!.phase).toBe("failed");
  expect(checkpoint.budgets[root]!.maxDecisions).toBe(2);
  await expect(parent.runOrThrow({})).rejects.toThrow();
  expect(decide).toHaveBeenCalledTimes(1);
});
