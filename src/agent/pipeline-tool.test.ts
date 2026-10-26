import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createSteps, definePipeline, type PipelineResult } from "../core/pipeline.js";
import { defineAgentLoop, pipelineTool, ToolError, type AgentTool } from "./agent.js";
import { emptyInput, numberSchema, schema, textSchema } from "./agent.test-support.js";

function caller(tool: AgentTool<unknown, unknown>, inputs: readonly unknown[] = [{}]) {
  const decide = (state: string, context: { turn: number }) =>
    context.turn === 1
      ? {
          kind: "continue",
          calls: inputs.map((input, i) => ({ id: String(i), tool: "child", input })),
        }
      : { kind: "finish", result: state };
  return defineAgentLoop({
    id: "caller",
    inputSchema: emptyInput,
    resultSchema: textSchema,
    tools: { child: tool },
    initialState: () => "",
    decide,
    dryRun: decide,
    reduce: (_state, outcomes) => JSON.stringify(outcomes),
  });
}

describe("pipeline tools", () => {
  it.each([false, true])(
    "validates child options and outputs exactly once (mapped=%s)",
    async (mapped) => {
      const validateInput = vi.fn((value: unknown) => ({
        value: { count: Number((value as { raw: string }).raw) },
      }));
      const inputSchema = schema<{ raw: string }, { count: number }>(validateInput);
      const validateResult = vi.fn((value: unknown) => ({ value: { count: Number(value) } }));
      const { step } = createSteps(inputSchema);
      const work = vi.fn((_inputs, context) => context.options.count + 1);
      const count = step("count", { run: work });
      const child = definePipeline({
        id: "transformed",
        steps: [count],
        finalize: count,
        resultSchema: schema<number, { count: number }>(validateResult),
      });
      const argumentValidation = vi.fn((value: unknown) => ({ value: Number(value) }));
      const mapping = vi.fn((count: number) => ({ raw: String(count) }));
      const tool = mapped
        ? pipelineTool(child, {
            description: "Count",
            inputSchema: schema<string, number>(argumentValidation),
            mapOptions: mapping,
          })
        : pipelineTool(child, { description: "Count" });
      expectTypeOf<PipelineResult<typeof child>>().toEqualTypeOf<{ count: number }>();
      const agent = caller(tool, [mapped ? "4" : { raw: "4" }]);
      agent.plan();
      agent.toMermaid();
      expect(validateInput).not.toHaveBeenCalled();
      expect(mapping).not.toHaveBeenCalled();
      expect(JSON.parse(await agent.runOrThrow({}))).toEqual([
        { id: "0", tool: "child", ok: true, value: { count: 5 } },
      ]);
      expect(validateInput).toHaveBeenCalledTimes(1);
      expect(validateResult).toHaveBeenCalledTimes(1);
      expect(argumentValidation).toHaveBeenCalledTimes(mapped ? 1 : 0);
      expect(mapping).toHaveBeenCalledTimes(mapped ? 1 : 0);
      expect(work).toHaveBeenCalledTimes(1);
    }
  );

  it("preflights every child's mapped options before any child starts", async () => {
    const inputSchema = schema<{ count: number }>((input) => {
      const count = (input as { count: number }).count;
      return count > 0 ? { value: { count } } : { issues: [{ message: "positive only" }] };
    });
    const { step } = createSteps(inputSchema);
    const run = vi.fn(() => 1);
    const work = step("work", { run });
    const child = definePipeline({ id: "preflight", steps: [work], finalize: work });
    const mapOptions = vi.fn((count: number) => ({ count }));
    const result = await caller(
      pipelineTool(child, { description: "Validate", inputSchema: numberSchema, mapOptions }),
      [1, -1]
    ).run({});
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result.errors)).toContain("positive only");
    expect(mapOptions).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
  });

  it("maps schema-less child options and preserves an undefined final result", async () => {
    const { step } = createSteps<{ count: number }>();
    const work = step("work", {
      run: (_inputs, context) => {
        expect(context.options.count).toBe(3);
      },
    });
    const child = definePipeline({ id: "plain", steps: [work], finalize: work });
    const tool = pipelineTool(child, {
      description: "Plain",
      inputSchema: numberSchema,
      mapOptions: (count) => ({ count }),
    });
    const result = JSON.parse(await caller(tool, [3]).runOrThrow({}));
    expect(result).toEqual([{ id: "0", tool: "child", ok: true }]);
  });

  it.each(["schema", "mapper", "shape"])(
    "rejects %s failure before starting any child",
    async (mode) => {
      const run = vi.fn(() => 1);
      const { step } = createSteps<{}>();
      const work = step("work", { run });
      const child = definePipeline({ id: "invalid", steps: [work], finalize: work });
      const tool = pipelineTool(child, {
        description: "Invalid",
        inputSchema: numberSchema,
        mapOptions: (input) => {
          if (input === 2) {
            if (mode === "mapper") throw new ToolError("MAPPING", "mapping failed");
            if (mode === "shape") return null as unknown as {};
          }
          return {};
        },
      });
      const result = await caller(tool, [1, mode === "schema" ? "wrong" : 2]).run({});
      expect(result.status).toBe("failed");
      expect(run).not.toHaveBeenCalled();
    }
  );

  it("inherits dry-run handlers and skips missing previews", async () => {
    const run = vi.fn(() => "live");
    const preview = vi.fn(() => "preview");
    const { step } = createSteps(emptyInput);
    const work = step("work", { run, dryRun: preview });
    const child = definePipeline({ id: "preview", steps: [work], finalize: work });
    expect(
      await caller(pipelineTool(child, { description: "Preview" })).runOrThrow({}, { dryRun: true })
    ).toContain("preview");
    expect(run).not.toHaveBeenCalled();
    expect(preview).toHaveBeenCalledTimes(1);
    const skipped = step("skipped", { run, dryRun: "skip" });
    const noPreview = definePipeline({ id: "skipped", steps: [skipped], finalize: skipped });
    expect(
      (await caller(pipelineTool(noPreview, { description: "Skip" })).run({}, { dryRun: true }))
        .status
    ).toBe("failed");
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["handler", "output", "finalizer", "skip", "unknown", "spoof"])(
    "classifies only handler ToolError (%s)",
    async (source) => {
      const expected = new ToolError("NOT_FOUND", "Unavailable");
      const { step } = createSteps(emptyInput);
      const work = step("work", {
        skip: () => {
          if (source === "skip") throw expected;
          return false;
        },
        outputSchema: schema<string>((value) => {
          if (source === "output") throw expected;
          return { value: String(value) };
        }),
        run: () => {
          if (source === "handler") throw expected;
          if (source === "unknown") throw new Error("bug");
          if (source === "spoof") throw Object.assign(new Error("fake"), { code: "NOT_FOUND" });
          return "done";
        },
      });
      const child = definePipeline({
        id: "failure",
        steps: [work],
        finalize: (outputs) => {
          if (source === "finalizer") throw expected;
          return outputs.work;
        },
      });
      const result = await caller(pipelineTool(child, { description: "Fail" })).run({});
      expect(result.status).toBe(source === "handler" ? "completed" : "failed");
      if (source === "handler")
        expect(JSON.parse(result.value!)[0]).toMatchObject({
          ok: false,
          error: { code: "NOT_FOUND", message: "Unavailable" },
        });
    }
  );

  it("recovers expected errors through ordinary nested pipelines and fan-out", async () => {
    const { step } = createSteps(emptyInput);
    const fail = step("fail", {
      run: () => {
        throw new ToolError("MISSING", "Missing");
      },
    });
    const leaf = definePipeline({ id: "leaf", steps: [fail], finalize: fail });
    const { forEachPipeline, fromPipeline } = createSteps(emptyInput);
    const batch = forEachPipeline("batch", {
      pipeline: leaf,
      items: () => ["a", "b"],
      key: (key) => key,
      mapOptions: () => ({}),
      concurrency: 2,
    });
    const middle = definePipeline({ id: "middle", steps: [batch], finalize: batch });
    const nested = fromPipeline("nested", { pipeline: middle });
    const outer = definePipeline({ id: "outer", steps: [nested], finalize: nested });
    const result = JSON.parse(
      await caller(pipelineTool(outer, { description: "Fail together" })).runOrThrow({})
    );
    expect(result[0]).toMatchObject({
      ok: false,
      error: { code: "TUBELESS_TOOL_ERRORS", message: "MISSING: Missing; MISSING: Missing" },
    });
  });

  it.each(["expected", "handler", "output", "finalizer", "cancelled"])(
    "classifies all fan-out failures beyond the recording cap (last=%s)",
    async (lastFailure) => {
      const { step } = createSteps<{ index: number }>();
      const fail = step("fail", {
        outputSchema: schema<number>((value) => {
          if (lastFailure === "output")
            throw new ToolError("INVALID_OUTPUT", "late validator failure");
          return { value: Number(value) };
        }),
        run: (_inputs, context) => {
          if (context.options.index === 39) {
            if (lastFailure === "handler") throw new Error("late bug");
            if (lastFailure === "output") return 1;
            if (lastFailure === "finalizer") return 1;
            if (lastFailure === "cancelled")
              throw Object.assign(new Error("late cancellation"), { name: "AbortError" });
          }
          throw new ToolError("MISSING", `Missing ${context.options.index}`);
        },
      });
      const leaf = definePipeline({
        id: "many-leaf",
        steps: [fail],
        finalize: () => {
          throw new ToolError("FINALIZER", "late finalizer failure");
        },
      });
      const { forEachPipeline } = createSteps(emptyInput);
      const batch = forEachPipeline("batch", {
        pipeline: leaf,
        items: () => Array.from({ length: 40 }, (_, index) => index),
        key: String,
        mapOptions: (index) => ({ index }),
        concurrency: 4,
      });
      const wrapper = definePipeline({ id: "many", steps: [batch], finalize: batch });
      const result = await caller(pipelineTool(wrapper, { description: "Many failures" })).run({});
      expect(result.status).toBe(lastFailure === "expected" ? "completed" : "failed");
      if (lastFailure === "expected") {
        const outcome = JSON.parse(result.value!)[0];
        expect(outcome.error.code).toBe("TUBELESS_TOOL_ERRORS");
        expect(outcome.error.message).toContain("Missing 31");
        expect(outcome.error.message).not.toContain("Missing 32");
      }
    }
  );

  it("keeps a mixed expected/unexpected child failure fatal", async () => {
    const { step } = createSteps(emptyInput);
    const expected = step("expected", {
      run: () => {
        throw new ToolError("MISSING", "Missing");
      },
    });
    const unexpected = step("unexpected", {
      run: () => {
        throw new Error("bug");
      },
    });
    const leaf = definePipeline({ id: "mixed-leaf", steps: [expected, unexpected] });
    const { fromPipeline } = createSteps(emptyInput);
    const child = fromPipeline("child", {
      pipeline: leaf,
      controls: { continueOnError: true, maxConcurrency: 2 },
    });
    const wrapper = definePipeline({ id: "mixed", steps: [child], finalize: child });
    expect((await caller(pipelineTool(wrapper, { description: "Mixed" })).run({})).status).toBe(
      "failed"
    );
  });

  it("rejects forged pipelines and missing schema or mapping boundaries", () => {
    const { step } = createSteps<{}>();
    const work = step("work", { run: () => 1 });
    const child = definePipeline({ id: "schema-less", steps: [work] });
    expect(() => pipelineTool(child as never, { description: "Missing schema" })).toThrow("Schema");
    expect(() =>
      pipelineTool(
        { ...child },
        { description: "Forged", inputSchema: emptyInput, mapOptions: () => ({}) }
      )
    ).toThrow("compiled");
    expect(() =>
      pipelineTool(child, { description: "Missing mapper", inputSchema: emptyInput } as never)
    ).toThrow("together");
  });
});
