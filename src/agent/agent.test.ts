import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createSteps,
  definePipeline,
  type PipelineInput,
  type PipelineResult,
} from "../core/pipeline.js";
import { createPipelineTestRuntime } from "../testing/testing.js";
import { definePipelineCommand } from "../cli/cli.js";
import { defineProject } from "../project/project.js";
import { defer } from "../core/child-pipeline.test-support.js";
import {
  defineAgentLoop,
  defineTool,
  ToolError,
  type AgentDecision,
  type AgentOutcome,
} from "./agent.js";
import { emptyInput, numberSchema, schema, textSchema } from "./agent.test-support.js";

const base = {
  id: "test-agent",
  inputSchema: emptyInput,
  resultSchema: numberSchema,
  initialState: () => 0,
};
const call = (id = "one", input: unknown = 2) => ({ id, tool: "double", input });
const finish = { kind: "finish", result: 4 };
const batch = { kind: "continue", calls: [call()] };

describe("single-agent execution", () => {
  it("finishes immediately, preserves schema transforms/types, and composes with pipelines/projects", async () => {
    const inputValidate = vi.fn((value: unknown) => ({
      value: { text: String((value as { text: string }).text), extra: true },
    }));
    const resultValidate = vi.fn((value: unknown) =>
      typeof value === "string"
        ? { value: { answer: value } }
        : { issues: [{ message: "Expected raw text" }] }
    );
    const agent = defineAgentLoop({
      id: "immediate",
      inputSchema: schema<{ text: string }, { text: string; extra: boolean }>(inputValidate, {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      }),
      resultSchema: schema<string, { answer: string }>(resultValidate, { type: "string" }),
      initialState: (options) => ({ text: options.text }),
      decide: (state, context) => {
        expect(context.options.extra).toBe(true);
        expect(context.turn).toBe(1);
        expect(context.stateVersion).toBe(0);
        return { kind: "finish", result: state.text };
      },
    });
    expectTypeOf<PipelineInput<typeof agent>>().toEqualTypeOf<{ text: string }>();
    expectTypeOf<PipelineResult<typeof agent>>().toEqualTypeOf<{ answer: string }>();
    expectTypeOf(agent.id).toEqualTypeOf<"immediate">();
    const command = definePipelineCommand(agent);
    const project = defineProject("agents", [command]);
    expectTypeOf(project.get("immediate")).toEqualTypeOf<typeof agent>();
    const child = createSteps<{ text: string }>().fromPipeline("child", { pipeline: agent });
    const parent = definePipeline({ id: "parent", steps: [child], finalize: child });
    expect(await createPipelineTestRuntime().runOrThrow(parent, { text: "answer" })).toEqual({
      answer: "answer",
    });
    expect(inputValidate).toHaveBeenCalledOnce();
    expect(resultValidate).toHaveBeenCalledOnce();
  });

  it("prevalidates the entire batch once, retains output transforms, and reduces in decision order", async () => {
    const argumentsSeen: number[] = [];
    const resultSeen: number[] = [];
    const tools = {
      double: defineTool({
        description: "Double a number",
        inputSchema: schema<string, number>((value) => {
          argumentsSeen.push(Number(value));
          return { value: Number(value) };
        }),
        outputSchema: schema<number, { doubled: number }>((value) => {
          resultSeen.push(Number(value));
          return { value: { doubled: Number(value) } };
        }),
        run: (input) => {
          expect(argumentsSeen).toEqual([2, 3]);
          return input * 2;
        },
      }),
    };
    const reducer = vi.fn(
      (_state: readonly number[], outcomes: readonly AgentOutcome<typeof tools>[]) =>
        outcomes.map((outcome) => {
          if (!outcome.ok || outcome.tool !== "double") throw new Error("Expected double output");
          return outcome.value.doubled;
        })
    );
    const decide = vi.fn(
      (state: readonly number[], context: { turn: number; stateVersion: number }) => {
        expect(context.stateVersion).toBe(context.turn - 1);
        return context.turn === 1
          ? { kind: "continue", calls: [call("a", "2"), call("b", "3")] }
          : { kind: "finish", result: state.reduce((sum, value) => sum + value, 0) };
      }
    );
    const agent = defineAgentLoop({
      ...base,
      tools,
      initialState: (): number[] => [],
      decide,
      reduce: reducer,
    });
    expect(await createPipelineTestRuntime().runOrThrow(agent, {})).toBe(10);
    expect(resultSeen).toEqual([4, 6]);
    expect(reducer).toHaveBeenCalledOnce();
    expect(decide).toHaveBeenCalledTimes(2);
  });

  it.each([
    null,
    [],
    {},
    { kind: "continue", calls: [] },
    { kind: "finish" },
    { ...finish, calls: [call()] },
    { ...batch, extra: true },
    { kind: "continue", calls: [call(), call()] },
    { kind: "continue", calls: [{ ...call(), tool: "missing" }] },
    { kind: "continue", calls: [{ ...call(), extra: true }] },
    { kind: "continue", calls: [{ ...call(), id: " " }] },
    { kind: "continue", calls: [{ id: "x", tool: "double" }] },
  ])("rejects malformed decisions before any handler starts: %j", async (decision) => {
    const run = vi.fn((value: number) => value);
    const tools = {
      double: defineTool({
        description: "Double",
        inputSchema: numberSchema,
        outputSchema: numberSchema,
        run,
      }),
    };
    const agent = defineAgentLoop({ ...base, tools, decide: () => decision });
    const result = await createPipelineTestRuntime().run(agent, {});
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result.errors)).toContain("TUBELESS_AGENT_INVALID_DECISION");
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a bad later argument before an earlier valid call starts", async () => {
    const run = vi.fn((input: number) => input);
    const tools = {
      double: defineTool({
        description: "Double",
        inputSchema: numberSchema,
        outputSchema: numberSchema,
        run,
      }),
    };
    const agent = defineAgentLoop({
      ...base,
      tools,
      decide: () => ({ kind: "continue", calls: [call("a"), call("b", "bad")] }),
    });
    expect((await createPipelineTestRuntime().run(agent, {})).status).toBe("failed");
    expect(run).not.toHaveBeenCalled();
  });

  it.each([undefined, "bad", null])("rejects invalid finish results: %s", async (result) => {
    expect(
      (
        await createPipelineTestRuntime().run(
          defineAgentLoop({ ...base, decide: () => ({ kind: "finish", result }) }),
          {}
        )
      ).status
    ).toBe("failed");
  });

  it("publishes valid undefined and advances versions without an optional reducer", async () => {
    const tools = {
      double: defineTool({
        description: "Double",
        inputSchema: numberSchema,
        outputSchema: numberSchema,
        run: (input) => input,
      }),
    };
    const agent = defineAgentLoop({
      ...base,
      tools,
      resultSchema: schema<undefined>(() => ({ value: undefined })),
      decide: (state, context) => {
        expect(state).toBe(0);
        expect(context.stateVersion).toBe(context.turn - 1);
        return context.turn === 1 ? batch : { kind: "finish", result: undefined };
      },
    });
    expectTypeOf<PipelineResult<typeof agent>>().toEqualTypeOf<undefined>();
    expect(await createPipelineTestRuntime().run(agent, {})).toMatchObject({
      status: "completed",
      finalized: true,
      value: undefined,
    });
  });

  it("recovers only handler-originated ToolError values", async () => {
    const tools = {
      double: defineTool({
        description: "Expected failure",
        inputSchema: numberSchema,
        outputSchema: numberSchema,
        run: () => {
          throw new ToolError("MISSING", "Not found");
        },
      }),
    };
    const agent = defineAgentLoop({
      ...base,
      tools,
      decide: (_state, context) => (context.turn === 1 ? batch : finish),
      reduce: (state, outcomes) => {
        expect(outcomes).toEqual([
          {
            id: "one",
            tool: "double",
            ok: false,
            error: { code: "MISSING", message: "Not found" },
          },
        ]);
        return state;
      },
    });
    expect(await createPipelineTestRuntime().runOrThrow(agent, {})).toBe(4);
  });

  it.each(["handler", "output", "reducer"] as const)(
    "treats %s implementation/validation failures as fatal",
    async (boundary) => {
      const reduce = vi.fn(() => {
        if (boundary === "reducer") throw new ToolError("NO", "reducer failed");
        return 0;
      });
      const decide = vi.fn(() => batch);
      const tools = {
        double: defineTool({
          description: "Failure",
          inputSchema: numberSchema,
          outputSchema:
            boundary === "output"
              ? schema<number>(() => {
                  throw new ToolError("BAD", "validator failed");
                })
              : numberSchema,
          run: () => {
            if (boundary === "handler") throw Object.assign(new Error("bad"), { code: "MISSING" });
            return 1;
          },
        }),
      };
      const result = await createPipelineTestRuntime().run(
        defineAgentLoop({ ...base, tools, decide, reduce }),
        {}
      );
      expect(result.status).toBe("failed");
      expect(decide).toHaveBeenCalledOnce();
      expect(reduce).toHaveBeenCalledTimes(boundary === "reducer" ? 1 : 0);
    }
  );

  it.each([{ maxTurns: 1 }, { maxCalls: 0 }, { maxCalls: 1 }, { maxDecisions: 1 }])(
    "enforces invocation limits %j",
    async (limits) => {
      const run = vi.fn((input: number) => input);
      const tools = {
        double: defineTool({
          description: "Double",
          inputSchema: numberSchema,
          outputSchema: numberSchema,
          run,
        }),
      };
      const decide = vi.fn(() => ({ kind: "continue", calls: [call("a"), call("b")] }));
      const agent = defineAgentLoop({ ...base, tools, limits, decide });
      const result = await createPipelineTestRuntime().run(agent, {});
      expect(result.status).toBe("failed");
      expect(JSON.stringify(result.errors)).toContain("TUBELESS_AGENT_LIMIT_REACHED");
      expect(run).toHaveBeenCalledTimes("maxDecisions" in limits ? 2 : 0);
      expect(decide).toHaveBeenCalledOnce();
    }
  );

  it("finishes on the last admitted decision with no later call", async () => {
    const decide = vi.fn(() => finish);
    const agent = defineAgentLoop({
      ...base,
      limits: { maxTurns: 1, maxDecisions: 1, maxCalls: 0 },
      decide,
    });
    expect(await createPipelineTestRuntime().runOrThrow(agent, {})).toBe(4);
    expect(decide).toHaveBeenCalledOnce();
  });

  it.each([
    { limits: { maxCalls: 1 }, priorBatches: 0, batchLength: 1_000_000 },
    { limits: { maxCalls: 2 }, priorBatches: 1, batchLength: 2 },
    { limits: { maxTurns: 1 }, priorBatches: 0, batchLength: 1 },
  ])(
    "rejects inadmissible batches before reading entries: %j",
    async ({ limits, priorBatches, batchLength }) => {
      const readCall = vi.fn(() => {
        throw new Error("Rejected calls must not be read");
      });
      const calls: unknown[] = [];
      calls.length = batchLength;
      Object.defineProperty(calls, 0, { get: readCall });
      const validate = vi.fn((input: unknown) => ({ value: Number(input) }));
      const run = vi.fn((input: number) => input);
      const reduce = vi.fn((state: number) => state);
      const agent = defineAgentLoop({
        ...base,
        limits,
        tools: {
          double: defineTool({
            description: "Double",
            inputSchema: schema<number>(validate),
            outputSchema: numberSchema,
            run,
          }),
        },
        decide: (_state, context) =>
          context.turn <= priorBatches ? batch : { kind: "continue", calls },
        reduce,
      });
      const result = await createPipelineTestRuntime().run(agent, {});
      expect(result.status).toBe("failed");
      expect(JSON.stringify(result.errors)).toContain("TUBELESS_AGENT_LIMIT_REACHED");
      expect(readCall).not.toHaveBeenCalled();
      expect(validate).toHaveBeenCalledTimes(priorBatches);
      expect(run).toHaveBeenCalledTimes(priorBatches);
      expect(reduce).toHaveBeenCalledTimes(priorBatches);
    }
  );

  it.each([
    { maxTurns: 0 },
    { maxCalls: -1 },
    { maxDecisions: 1.5 },
    { maxDepth: -1 },
    { maxDepth: 1.5 },
    { maxConcurrency: Infinity },
    { maxTurns: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects invalid definition limits %j", (limits) => {
    expect(() => defineAgentLoop({ ...base, limits, decide: () => finish })).toThrow(
      "safe integer"
    );
  });

  it("owns frozen snapshots and isolates concurrent invocations", async () => {
    const shared = { values: [1], optional: undefined };
    const initialState = vi.fn(() => shared);
    const agent = defineAgentLoop({
      ...base,
      initialState,
      decide: async (state) => {
        expect(Object.isFrozen(state)).toBe(true);
        expect(Object.isFrozen(state.values)).toBe(true);
        expect(state).not.toBe(shared);
        await Promise.resolve();
        return { kind: "finish", result: state.values[0] };
      },
    });
    expect(
      await Promise.all([
        createPipelineTestRuntime().runOrThrow(agent, {}),
        createPipelineTestRuntime().runOrThrow(agent, {}),
      ])
    ).toEqual([1, 1]);
    expect(initialState).toHaveBeenCalledTimes(2);
    expect(Object.isFrozen(shared)).toBe(false);
  });

  it.each([new Date(), new Map(), { value: Infinity }, { run: () => 1 }, { value: Symbol("x") }])(
    "rejects non-plain state %j",
    async (state) => {
      const result = await createPipelineTestRuntime().run(
        defineAgentLoop({ ...base, initialState: () => state, decide: () => finish }),
        {}
      );
      expect(JSON.stringify(result.errors)).toContain("TUBELESS_AGENT_INVALID_STATE");
    }
  );

  it("rejects cyclic initialization and invalid reducer commits", async () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(
      (
        await createPipelineTestRuntime().run(
          defineAgentLoop({ ...base, initialState: () => cycle, decide: () => finish }),
          {}
        )
      ).status
    ).toBe("failed");
    const tools = {
      double: defineTool({
        description: "Double",
        inputSchema: numberSchema,
        outputSchema: numberSchema,
        run: (input) => input,
      }),
    };
    const decide = vi.fn(() => batch);
    const result = await createPipelineTestRuntime().run(
      defineAgentLoop({
        ...base,
        tools,
        initialState: (): { value: unknown } => ({ value: 0 }),
        decide,
        reduce: () => ({ value: new Date() }),
      }),
      {}
    );
    expect(JSON.stringify(result.errors)).toContain("TUBELESS_AGENT_INVALID_STATE");
    expect(decide).toHaveBeenCalledOnce();
  });

  it("does no model/state/tool work during plan, graph, filtered selection, or default dry run", async () => {
    const initialState = vi.fn(() => 0);
    const decide = vi.fn(() => finish);
    const agent = defineAgentLoop({ ...base, initialState, decide });
    expect(agent.plan().steps[0]?.agent?.limits.maxTurns).toBe(20);
    agent.toMermaid();
    const result = await createPipelineTestRuntime().run(agent, {}, { dryRun: true });
    expect(result.status).toBe("failed");
    expect(result.steps[0]?.status).toBe("skipped");
    await createPipelineTestRuntime().run(agent, {}, { stepIds: [] });
    expect(initialState).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "uses explicit previews and never invents skipped tool output (preview=%s)",
    async (preview) => {
      const run = vi.fn((input: number) => input);
      const decide = vi.fn(() => finish);
      const tools = {
        double: defineTool({
          description: "Preview",
          inputSchema: numberSchema,
          outputSchema: numberSchema,
          run,
          dryRun: preview ? () => 3 : undefined,
        }),
      };
      const agent = defineAgentLoop({
        ...base,
        tools,
        decide,
        dryRun: (_state, context) => (context.turn === 1 ? batch : finish),
      });
      expect((await createPipelineTestRuntime().run(agent, {}, { dryRun: true })).status).toBe(
        preview ? "completed" : "failed"
      );
      expect(decide).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    }
  );

  it("drains active calls on cancellation and never dispatches the queued call or reduces", async () => {
    const started = defer();
    const release = defer();
    const runtime = createPipelineTestRuntime();
    const run = vi.fn(async (_input: number, context: { signal?: AbortSignal }) => {
      expect(context.signal).toBe(runtime.context.signal);
      started.resolve();
      await release.promise;
      return 2;
    });
    const tools = {
      double: defineTool({
        description: "Wait",
        inputSchema: numberSchema,
        outputSchema: numberSchema,
        run,
      }),
    };
    const reduce = vi.fn(() => 0);
    const agent = defineAgentLoop({
      ...base,
      tools,
      reduce,
      decide: () => ({ kind: "continue", calls: [call("a"), call("b")] }),
    });
    let settled = false;
    const running = runtime.run(agent, {}).then((value) => {
      settled = true;
      return value;
    });
    await started.promise;
    runtime.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    expect((await running).status).toBe("cancelled");
    expect(run).toHaveBeenCalledOnce();
    expect(reduce).not.toHaveBeenCalled();
  });

  it("honors cancellation before initialization and after an in-flight decision", async () => {
    const runtime = createPipelineTestRuntime();
    const initialState = vi.fn(() => 0);
    const decide = vi.fn(() => finish);
    runtime.abort();
    expect((await runtime.run(defineAgentLoop({ ...base, initialState, decide }), {})).status).toBe(
      "cancelled"
    );
    expect(initialState).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    const second = createPipelineTestRuntime();
    const readCall = vi.fn(() => call());
    const calls = Object.defineProperty([call()], 0, { get: readCall });
    expect(
      (
        await second.run(
          defineAgentLoop({
            ...base,
            decide: () => {
              second.abort();
              return { kind: "continue", calls };
            },
          }),
          {}
        )
      ).status
    ).toBe("cancelled");
    expect(readCall).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "preserves input order and stops queued calls after fatal failures (fatal=%s)",
    async (fatal) => {
      const slow = defer();
      const both = defer();
      const completion: number[] = [];
      let active = 0;
      let maximum = 0;
      const run = vi.fn(async (input: number) => {
        active++;
        maximum = Math.max(maximum, active);
        if (input === 1) await slow.promise;
        else {
          both.resolve();
          if (fatal) {
            active--;
            throw new Error("fatal");
          }
        }
        completion.push(input);
        active--;
        return input;
      });
      const tools = {
        double: defineTool({
          description: "Wait",
          inputSchema: numberSchema,
          outputSchema: numberSchema,
          run,
        }),
      };
      const reduce = vi.fn((_state: number, outcomes: readonly AgentOutcome<typeof tools>[]) => {
        expect(outcomes.map((outcome) => outcome.ok && outcome.value)).toEqual([1, 2, 3]);
        return 0;
      });
      const agent = defineAgentLoop({
        ...base,
        tools,
        limits: { maxConcurrency: 2 },
        reduce,
        decide: (_state, context) =>
          context.turn === 1
            ? { kind: "continue", calls: [call("a", 1), call("b", 2), call("c", 3)] }
            : finish,
      });
      const runtime = createPipelineTestRuntime();
      const running = runtime.run(agent, {});
      await both.promise;
      // Allow the second child lifecycle and scheduler stop to settle while the first remains active.
      if (fatal)
        await vi.waitFor(() =>
          expect(runtime.latestProgress.get("agent")?.message).toContain("failed")
        );
      slow.resolve();
      const result = await running;
      expect(maximum).toBe(2);
      expect(result.status).toBe(fatal ? "failed" : "completed");
      expect(run).toHaveBeenCalledTimes(fatal ? 2 : 3);
      expect(reduce).toHaveBeenCalledTimes(fatal ? 0 : 1);
      if (!fatal) expect(completion[0]).toBe(2);
    }
  );

  it("keeps typed calls and outcomes tied to their registered tool", () => {
    const tools = {
      text: defineTool({
        description: "Text",
        inputSchema: textSchema,
        outputSchema: numberSchema,
        run: (input) => input.length,
      }),
    };
    const valid = {
      kind: "continue",
      calls: [{ id: "one", tool: "text", input: "a" }],
    } satisfies AgentDecision<typeof tools, number>;
    const invalid: AgentDecision<typeof tools, number> = {
      kind: "continue",
      // @ts-expect-error Unknown tools cannot be typed decisions.
      calls: [{ id: "one", tool: "missing", input: 2 }],
    };
    void [valid, invalid];
    const agent = defineAgentLoop({
      ...base,
      tools,
      decide: () => valid,
      reduce: (state, outcomes) => {
        if (outcomes[0]?.ok && outcomes[0].tool === "text")
          expectTypeOf(outcomes[0].value).toEqualTypeOf<number>();
        return state;
      },
    });
    // @ts-expect-error Runtime calls are not selectable static steps.
    const invalidPlan = agent.plan({ stepIds: ["one"] });
    expect(invalidPlan.ok).toBe(false);
  });

  it("accumulates call admissions across turns independently for each root run", async () => {
    const run = vi.fn((input: number) => input);
    const reduce = vi.fn((state: number) => state + 1);
    const tools = {
      double: defineTool({
        description: "Number",
        inputSchema: numberSchema,
        outputSchema: numberSchema,
        run,
      }),
    };
    const agent = defineAgentLoop({
      ...base,
      tools,
      limits: { maxCalls: 1 },
      reduce,
      decide: () => batch,
    });
    const results = await Promise.all([
      createPipelineTestRuntime().run(agent, {}),
      createPipelineTestRuntime().run(agent, {}),
    ]);
    for (const result of results) {
      expect(result.status).toBe("failed");
      expect(JSON.stringify(result.errors)).toContain("consumed=1, requested=1");
    }
    expect(run).toHaveBeenCalledTimes(2);
    expect(reduce).toHaveBeenCalledTimes(2);
  });
});
