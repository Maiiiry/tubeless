import { describe, expect, expectTypeOf, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { openCheckpoint } from "../node/checkpoint.js";
import { definePipelineCommand, type CliContext, type CliParamsSchema } from "./cli.js";
import { type ReporterOutput } from "../reporter/interactive-reporter.js";
import { createSteps, definePipeline } from "../core/pipeline.js";
import { defer } from "../core/child-pipeline.test-support.js";
import { renderPipelinePlan } from "../render/render.js";

interface MiniOptions {
  limit?: number;
}

function testLog(): CliContext["log"] & { lines: { level: string; message: string }[] } {
  const lines: { level: string; message: string }[] = [];
  return {
    lines,
    log: (message) => lines.push({ level: "log", message: String(message) }),
    warn: (message) => lines.push({ level: "warn", message: String(message) }),
    error: (message) => lines.push({ level: "error", message: String(message) }),
  };
}

function makeMiniPipeline(onRun: (options: MiniOptions, dryRun: boolean) => void = () => {}) {
  const { step } = createSteps<MiniOptions>();
  const first = step("first", {
    name: "First Step",
    description: "Run first",
    run: (_inputs, context) => {
      onRun(context.options, context.dryRun);
      return context.options.limit ?? 1;
    },
  });
  const second = step("second", {
    description: "Run second",
    run: (_inputs, context) => {
      onRun(context.options, context.dryRun);
      return 2;
    },
  });
  return definePipeline({
    id: "mini",
    steps: [first, second],
    targets: [first, second],
    finalize: (outputs) => ({ first: outputs.first, second: outputs.second }),
  });
}

describe("definePipelineCommand", () => {
  it("exposes the exact wrapped pipeline", () => {
    const pipeline = makeMiniPipeline();
    const command = definePipelineCommand(pipeline, { reporter: false });

    expect(command.pipeline).toBe(pipeline);
    expectTypeOf(command.pipeline).toEqualTypeOf<typeof pipeline>();
    expectTypeOf(command.pipeline.id).toEqualTypeOf<"mini">();
    expectTypeOf(command.id).toEqualTypeOf<typeof pipeline.id>();
    expectTypeOf(command.stepIds).toEqualTypeOf<typeof pipeline.stepIds>();
    expectTypeOf(command.targetIds).toEqualTypeOf<typeof pipeline.targetIds>();
    expectTypeOf(command.plan).parameter(0).toEqualTypeOf<Parameters<typeof pipeline.plan>[0]>();

    function invalidCallsForTypechecking() {
      // @ts-expect-error Commands preserve literal step ids in planning controls.
      command.plan({ stepIds: ["typo"] });
      // @ts-expect-error Commands preserve literal target ids in planning controls.
      command.plan({ targets: ["typo"] });
    }
    void invalidCallsForTypechecking;
  });

  it("inherits pipeline presentation and lets command presentation override it", () => {
    const { step } = createSteps();
    const work = step("work", { run: () => true });
    const pipeline = definePipeline({
      id: "presented",
      name: "Presented pipeline",
      description: "Pipeline-owned help text.",
      steps: [work],
    });

    expect(definePipelineCommand(pipeline).descriptor).toMatchObject({
      name: "Presented pipeline",
      description: "Pipeline-owned help text.",
    });
    expect(
      definePipelineCommand(pipeline, {
        name: "Command override",
        description: "Command-specific help text.",
      }).descriptor
    ).toMatchObject({
      name: "Command override",
      description: "Command-specific help text.",
    });
  });

  it("falls back when an external pipeline supplies blank presentation", () => {
    const { step } = createSteps();
    const externalPipeline = Object.assign(
      definePipeline({
        id: "external",
        steps: [step("work", { run: () => true })],
      }),
      {
        name: "  ",
        description: "\n\t",
      }
    );

    const descriptor = definePipelineCommand(externalPipeline).descriptor;
    expect(descriptor).toMatchObject({ name: "external" });
    expect(descriptor).not.toHaveProperty("description");
  });

  it("defaults to no domain options without leaking command-only values", async () => {
    const seen: MiniOptions[] = [];
    const command = definePipelineCommand(
      makeMiniPipeline((options) => seen.push(options)),
      {
        reporter: false,
      }
    );

    await command.run(["--dry-run"]);

    expect(seen[0]).toEqual({});
    expect(seen[0]).not.toHaveProperty("continueOnError");
    expect(seen[0]).not.toHaveProperty("maxConcurrency");
    expect(seen[0]).not.toHaveProperty("dryRun");
    expect(seen[0]).not.toHaveProperty("plan");
    expect(seen[0]).not.toHaveProperty("resume");
    expect(seen[0]).not.toHaveProperty("step");
    expect(seen[0]).not.toHaveProperty("stepIds");
    expect(seen[0]).not.toHaveProperty("target");
    expect(seen[0]).not.toHaveProperty("targets");
  });

  it("defaults same-name validated flags into compatible required domain options", async () => {
    interface DirectOptions {
      count?: number;
      label: string;
    }
    let seen: DirectOptions | undefined;
    const { step } = createSteps<DirectOptions>();
    const work = step("work", {
      run: (_inputs, context) => {
        seen = context.options;
        return context.options.label.repeat(context.options.count ?? 1);
      },
    });
    const pipeline = definePipeline({
      id: "direct-options",
      steps: [work],
      targets: [work],
      finalize: (outputs) => outputs.work,
    });
    const command = definePipelineCommand(pipeline, {
      params: {
        count: { type: "number", optional: true },
        label: { type: "string" },
      },
      reporter: false,
    });

    await expect(command.run(["--label", "go", "--count", "2", "--target", "work"])).resolves.toBe(
      "gogo"
    );
    expect(seen).toEqual({ count: 2, label: "go" });
    expect(seen).not.toHaveProperty("target");
  });

  it("adds pipeline flags and step choices to generated help", () => {
    const command = definePipelineCommand(makeMiniPipeline(), { mapOptions: () => ({}) });
    const result = command.parse(["--help"]);

    expect(result.kind).toBe("help");
    if (result.kind !== "help") return;
    expect(result.helpText).toContain("--step <string...>");
    expect(result.helpText).toContain("--target <string...>");
    expect(result.helpText).toContain("one of: first, second");
    expect(result.helpText).toContain("--continue-on-error");
    expect(result.helpText).toContain("--max-concurrency <number>");
    expect(result.helpText).not.toContain("--plan");
    expect(
      command.descriptor.parameters
        .filter((parameter) => parameter.group === "execution")
        .map((parameter) => parameter.key)
    ).toEqual(["dryRun", "cache", "stepIds", "continueOnError", "maxConcurrency", "targets"]);
    expect(
      command.descriptor.parameters
        .filter((parameter) => parameter.exclusive === true)
        .map((parameter) => parameter.key)
    ).toEqual(["stepIds", "targets"]);
  });

  it("exposes resume only for managed checkpoints or explicit application handling", () => {
    const unsupported = definePipelineCommand(makeMiniPipeline(), { reporter: false });
    const applicationOwned = definePipelineCommand(makeMiniPipeline(), {
      reporter: false,
      resume: true,
    });
    const managed = definePipelineCommand(makeMiniPipeline(), {
      checkpoint: { path: "run.checkpoint.json" },
      reporter: false,
    });

    expect(unsupported.descriptor.parameters.some(({ key }) => key === "resume")).toBe(false);
    expect(unsupported.parse(["--resume"])).toMatchObject({
      kind: "error",
      errors: ["Unknown option: --resume"],
    });
    expect(applicationOwned.descriptor.parameters.some(({ key }) => key === "resume")).toBe(true);
    expect(applicationOwned.parse(["--resume"])).toMatchObject({
      kind: "values",
      values: { resume: true },
    });
    expect(managed.descriptor.parameters.some(({ key }) => key === "resume")).toBe(true);
  });

  it.each([undefined, 2, 4])(
    "forwards concurrency %s without leaking domain options",
    async (limit) => {
      const capacity = limit ?? 1;
      const full = defer();
      const release = defer();
      let active = 0;
      let highWater = 0;
      const { step } = createSteps();
      const steps = Array.from({ length: 5 }, (_, index) =>
        step(`work-${index}`, {
          run: async (_inputs, context) => {
            expect(context.options).toEqual({});
            active++;
            highWater = Math.max(highWater, active);
            if (active === capacity) full.resolve();
            await release.promise;
            active--;
            return index;
          },
        })
      );
      const command = definePipelineCommand(definePipeline({ id: "cli-concurrency", steps }), {
        reporter: false,
      });
      const result = command.run(limit === undefined ? [] : ["--max-concurrency", String(limit)]);
      await full.promise;
      expect(active).toBe(capacity);
      release.resolve();
      await result;
      expect(highWater).toBe(capacity);
      expect(active).toBe(0);
    }
  );

  it("validates structured concurrency values for Studio and exposes their constraints", async () => {
    const pipeline = makeMiniPipeline();
    const execute = vi.spyOn(pipeline, "runOrThrow");
    const command = definePipelineCommand(pipeline, { reporter: false });
    expect(command.parseValues({})).toMatchObject({
      kind: "values",
      values: { maxConcurrency: 1 },
    });
    const parsed = command.parseValues({ maxConcurrency: 4 });
    expect(parsed.kind).toBe("values");
    if (parsed.kind !== "values") throw new Error("Expected valid form values");
    await command.execute(parsed.values);
    expect(execute).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ maxConcurrency: 4 }),
      expect.anything()
    );
    expect(command.descriptor.parameters.find(({ key }) => key === "maxConcurrency")).toMatchObject(
      {
        default: 1,
        integer: true,
        min: 1,
        type: "number",
        group: "execution",
      }
    );
  });

  it.each([0, -1, 1.5, NaN, Infinity])(
    "rejects concurrency %s in CLI and form parsing",
    (value) => {
      const command = definePipelineCommand(makeMiniPipeline(), { reporter: false });
      expect(command.parse(["--max-concurrency", String(value)]).kind).toBe("error");
      expect(command.parseValues({ maxConcurrency: value }).kind).toBe("error");
    }
  );

  it.each<CliParamsSchema>([
    { maxConcurrency: { type: "number" as const } },
    { workers: { type: "number" as const, flag: "max-concurrency" } },
  ])("reserves the concurrency key and flag", (params) => {
    expect(() =>
      definePipelineCommand(makeMiniPipeline(), { params, mapOptions: () => ({}) })
    ).toThrow(/reserved/);
  });

  it("does not treat a custom execution-group parameter as exclusive with step or target", () => {
    const command = definePipelineCommand(makeMiniPipeline(), {
      params: {
        tags: { type: "string", multiple: true, group: "execution" },
      },
      mapOptions: () => ({}),
    });

    expect(command.descriptor.parameters.find((parameter) => parameter.key === "tags")?.group).toBe(
      "execution"
    );
    expect(
      command.descriptor.parameters.find((parameter) => parameter.key === "tags")?.exclusive
    ).toBeUndefined();
    expect(
      command.descriptor.parameters.find((parameter) => parameter.key === "stepIds")?.exclusive
    ).toBe(true);
  });

  it("plans from selection controls without requiring domain parameters", () => {
    const command = definePipelineCommand(makeMiniPipeline(), {
      params: { source: { type: "path" } },
      mapOptions: () => ({}),
    });

    const plan = command.plan({ dryRun: true, targets: ["first"] });

    expect(plan).toMatchObject({
      dryRun: true,
      ok: true,
      pipelineId: "mini",
      steps: [
        { id: "first", selected: true },
        { id: "second", selected: false, skipReason: "filtered" },
      ],
    });
  });

  it("forwards PipelineRunControls to pipeline.plan without remapping empty arrays", () => {
    const command = definePipelineCommand(makeMiniPipeline(), { mapOptions: () => ({}) });
    const pipeline = makeMiniPipeline();

    const empty = command.plan({ stepIds: [] });
    expect(empty.ok).toBe(false);
    expect(empty.errors[0]?.code).toBe("TUBELESS_PLANNING_STEP_SELECTION_EMPTY");
    expect(empty.errors[0]?.code).toBe(pipeline.plan({ stepIds: [] }).errors[0]?.code);

    // @ts-expect-error Dynamic callers still receive the planner's selection conflict.
    const conflict = command.plan({ stepIds: ["first"], targets: ["second"] });
    expect(conflict.errors[0]?.code).toBe("TUBELESS_PLANNING_SELECTION_CONFLICT");
  });

  it("exposes the owned pipeline identity and static graph", () => {
    const pipeline = makeMiniPipeline();
    const command = definePipelineCommand(pipeline, { mapOptions: () => ({}) });

    expect(command.id).toBe(pipeline.id);
    expect(command.stepIds).toBe(pipeline.stepIds);
    expect(command.targetIds).toBe(pipeline.targetIds);
    expect(command.toMermaid()).toBe(pipeline.toMermaid());
    expect(command.toMermaid({ direction: "LR", includeDescriptions: true })).toBe(
      pipeline.toMermaid({ direction: "LR", includeDescriptions: true })
    );
  });

  it("omits --target when a pipeline declares no public targets", () => {
    const { step } = createSteps();
    const internal = step("internal", { run: () => true });
    const pipeline = definePipeline({
      id: "no-targets",
      steps: [internal],
      targets: [],
      finalize: (outputs) => outputs.internal,
    });
    const command = definePipelineCommand(pipeline, { mapOptions: () => ({}) });
    const result = command.parse(["--help"]);

    expect(pipeline.targetIds).toEqual([]);
    expect(result.kind === "help" && result.helpText).not.toContain("--target");

    const undeclared = command.plan({ targets: ["internal" as never] });
    expect(undeclared.ok).toBe(false);
    expect(undeclared.errors[0]?.code).toBe("TUBELESS_PLANNING_TARGET_UNDECLARED");
  });

  it("offers the implicit target while retaining every exact step choice", () => {
    const { step } = createSteps();
    const internal = step("internal", { run: () => true });
    const release = step("release", {
      dependsOn: [internal],
      run: () => true,
    });
    const pipeline = definePipeline({
      id: "public-targets",
      steps: [internal, release],
    });
    const command = definePipelineCommand(pipeline, { mapOptions: () => ({}) });

    const help = command.parse(["--help"]);
    expect(help.kind === "help" && help.helpText).toContain(
      "Run exactly this step. [repeatable, one of: internal, release]"
    );
    expect(help.kind === "help" && help.helpText).toContain(
      "Run this declared target and its prerequisites. [repeatable, one of: release]"
    );
    const invalid = command.parse(["--target", "internal"]);
    expect(invalid.kind === "error" && invalid.errors[0]).toContain("one of: release");
  });

  it("forwards repeated step selection and omits stepIds when no step is selected", async () => {
    const seen: MiniOptions[] = [];
    const pipeline = makeMiniPipeline((options) => seen.push(options));
    const command = definePipelineCommand(pipeline, { mapOptions: () => ({}), reporter: false });

    await command.run(["--step", "first", "--step", "second"]);
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toHaveProperty("stepIds");

    seen.length = 0;
    await command.run([]);
    expect(seen).toHaveLength(2);
    expect(Object.prototype.hasOwnProperty.call(seen[0], "stepIds")).toBe(false);
  });

  it("forwards dependency-aware target selection", async () => {
    const seen: MiniOptions[] = [];
    const command = definePipelineCommand(
      makeMiniPipeline((options) => seen.push(options)),
      {
        mapOptions: () => ({}),
        reporter: false,
      }
    );

    await command.run(["--target", "first"]);

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty("targets");
    expect(Object.prototype.hasOwnProperty.call(seen[0], "stepIds")).toBe(false);
  });

  it("rejects combining exact steps with dependency-aware targets", () => {
    const command = definePipelineCommand(makeMiniPipeline(), { mapOptions: () => ({}) });
    const result = command.parse(["--step", "first", "--target", "second"]);
    const formResult = command.parseValues({ stepIds: ["first"], targets: ["second"] });

    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors).toContain(
      "--step and --target cannot be used together."
    );
    expect(formResult.kind).toBe("error");
    expect(formResult.kind === "error" && formResult.errors).toContain(
      "--step and --target cannot be used together."
    );
    expect(command.parseValues({ stepIds: [], targets: [] }).kind).toBe("values");
  });

  it("forwards an explicit CLI signal into pipeline step contexts", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const { step } = createSteps();
    const work = step("work", {
      run: (_inputs, context) => {
        seenSignal = context.signal;
        return "done";
      },
    });
    const pipeline = definePipeline({
      id: "signal-forwarding",
      steps: [work],
      finalize: (outputs) => outputs.work,
    });
    const command = definePipelineCommand(pipeline, { mapOptions: () => ({}), reporter: false });

    await command.run([], { signal: controller.signal });

    expect(seenSignal).toBe(controller.signal);
  });

  it("creates and cleans up a SIGINT signal for main entrypoints", async () => {
    let seenSignal: AbortSignal | undefined;
    const { step } = createSteps();
    const work = step("work", {
      run: (_inputs, context) => {
        seenSignal = context.signal;
        return "done";
      },
    });
    const pipeline = definePipeline({
      id: "main-signal",
      steps: [work],
      finalize: (outputs) => outputs.work,
    });
    const command = definePipelineCommand(pipeline, { mapOptions: () => ({}), reporter: false });
    const log = testLog();
    const onceSpy = vi.spyOn(process, "once");
    const removeListenerSpy = vi.spyOn(process, "removeListener");

    try {
      await command.main([], { log });
    } finally {
      const onceCalls = onceSpy.mock.calls.slice();
      const removeListenerCalls = removeListenerSpy.mock.calls.slice();
      onceSpy.mockRestore();
      removeListenerSpy.mockRestore();

      const sigintRegistration = onceCalls.find(([event]) => event === "SIGINT");
      expect(sigintRegistration).toBeDefined();
      expect(seenSignal).toBeInstanceOf(AbortSignal);
      expect(removeListenerCalls).toContainEqual(["SIGINT", sigintRegistration?.[1]]);
    }
  });

  it("aborts a main pipeline when its SIGINT handler fires", async () => {
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let seenSignal: AbortSignal | undefined;
    let ranAfterCancellation = false;
    const { step } = createSteps();
    const wait = step("wait", {
      run: async (_inputs, context) => {
        if (!context.signal) throw new Error("expected a managed CLI signal");
        seenSignal = context.signal;
        resolveStarted?.();
        await new Promise<void>((resolve) => {
          context.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return "done";
      },
    });
    const after = step("after", {
      dependsOn: [wait],
      run: () => {
        ranAfterCancellation = true;
        return "after";
      },
    });
    const pipeline = definePipeline({
      id: "main-signal-abort",
      steps: [wait, after],
      finalize: (outputs) => outputs.after ?? outputs.wait,
    });
    const command = definePipelineCommand(pipeline, { mapOptions: () => ({}), reporter: false });
    const log = testLog();
    const previousExitCode = process.exitCode;
    const onceSpy = vi.spyOn(process, "once");

    try {
      const runPromise = command.main([], { log });
      await started;
      const registration = onceSpy.mock.calls.find(([event]) => event === "SIGINT");
      expect(registration).toBeDefined();
      (registration![1] as () => void)();
      await runPromise;
    } finally {
      const observedExitCode = process.exitCode;
      process.exitCode = previousExitCode;
      onceSpy.mockRestore();

      expect(observedExitCode).toBe(130);
    }

    expect(seenSignal?.aborted).toBe(true);
    expect(ranAfterCancellation).toBe(false);
    expect(log.lines.some(({ message }) => message.includes("SIGINT received"))).toBe(true);
  });

  it("keeps the SIGINT exit code when pipeline cleanup returns normally", async () => {
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const { step } = createSteps();
    const cleanup = step("cleanup", {
      run: async (_inputs, context) => {
        if (!context.signal) throw new Error("expected a managed CLI signal");
        resolveStarted?.();
        await new Promise<void>((resolve) => {
          context.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return "cleaned up";
      },
    });
    const pipeline = definePipeline({
      id: "normal-sigint-cleanup",
      steps: [cleanup],
      finalize: (outputs) => outputs.cleanup,
    });
    const command = definePipelineCommand(pipeline, { mapOptions: () => ({}), reporter: false });
    const log = testLog();
    const previousExitCode = process.exitCode;
    const onceSpy = vi.spyOn(process, "once");

    try {
      const runPromise = command.main([], { log });
      await started;
      const registration = onceSpy.mock.calls.find(([event]) => event === "SIGINT");
      expect(registration).toBeDefined();
      (registration![1] as () => void)();
      await runPromise;
      expect(process.exitCode).toBe(130);
    } finally {
      process.exitCode = previousExitCode;
      onceSpy.mockRestore();
    }
  });

  it("rejects unknown steps during CLI parsing", () => {
    const command = definePipelineCommand(makeMiniPipeline(), { mapOptions: () => ({}) });
    const result = command.parse(["--step", "missing"]);

    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors[0]).toContain("one of: first, second");
  });

  it("prints a plan without running pipeline steps", () => {
    let ran = false;
    const command = definePipelineCommand(
      makeMiniPipeline(() => {
        ran = true;
      }),
      { mapOptions: () => ({}) }
    );

    const plan = command.plan({ stepIds: ["first"] });
    expect(ran).toBe(false);
    expect(renderPipelinePlan(plan).split("\n")).toEqual([
      "Pipeline mini: plan (ok=true, dryRun=false, steps=2)",
      "  - First Step [first]: run (exact selection) - Run first",
      "  - second: skip: filtered (not selected) - Run second",
    ]);
  });

  it("returns a structured planning failure without running steps", () => {
    let ran = false;
    const command = definePipelineCommand(
      makeMiniPipeline(() => {
        ran = true;
      }),
      { mapOptions: () => ({}), reporter: false }
    );

    const plan = command.plan({ targets: ["first", "first"] });

    expect(plan.ok).toBe(false);
    expect(plan.errors[0]).toMatchObject({
      code: "TUBELESS_PLANNING_TARGET_SELECTION_DUPLICATE",
      kind: "selection",
      phase: "planning",
    });
    expect(renderPipelinePlan(plan)).toContain("plan (ok=false");
    expect(ran).toBe(false);
  });

  it("explains target closure selection in plan output", () => {
    const { step } = createSteps();
    const source = step("source", { run: () => "source" });
    const hint = step("hint", { run: () => "hint" });
    const publish = step("publish", {
      dependsOn: [source],
      optionalDependsOn: [hint],
      run: () => "published",
    });
    const pipeline = definePipeline({
      id: "explained-target",
      steps: [source, hint, publish],
      targets: [publish],
      finalize: (outputs) => outputs.publish,
    });
    const command = definePipelineCommand(pipeline, {
      mapOptions: () => ({}),
      reporter: false,
    });

    const plan = command.plan({ targets: ["publish"] });

    expect(renderPipelinePlan(plan).split("\n")).toEqual([
      "Pipeline explained-target: plan (ok=true, dryRun=false, steps=3)",
      "  - source: run (required by publish for target publish)",
      "  - hint: skip: filtered (optional-only input to publish for target publish)",
      "  - publish: run (target publish)",
    ]);
  });

  it("forwards dry-run, continue-on-error, and mapped user params", async () => {
    const seen: MiniOptions[] = [];
    const dryRuns: boolean[] = [];
    const command = definePipelineCommand(
      makeMiniPipeline((options, dryRun) => {
        seen.push(options);
        dryRuns.push(dryRun);
      }),
      {
        params: {
          limit: { type: "number", optional: true, integer: true, min: 1 },
        },
        mapOptions: (values) => ({ limit: values.limit }),
        reporter: false,
      }
    );

    const result = await command.run(["--dry-run", "--continue-on-error", "--limit", "4"]);
    expect(result).toEqual({ first: 4, second: 2 });
    expect(seen[0]).toEqual({ limit: 4 });
    expect(dryRuns).toEqual([true, true]);
  });

  it("attaches the reporter by default and can disable it", async () => {
    const defaultLog = testLog();
    const defaultCommand = definePipelineCommand(makeMiniPipeline(), { mapOptions: () => ({}) });
    await defaultCommand.run([], { log: defaultLog });
    expect(defaultLog.lines.some((line) => line.message.includes("Pipeline mini: starting"))).toBe(
      true
    );

    const quietLog = testLog();
    const quietCommand = definePipelineCommand(makeMiniPipeline(), {
      mapOptions: () => ({}),
      reporter: false,
    });
    await quietCommand.run([], { log: quietLog });
    expect(quietLog.lines).toEqual([]);
  });

  it("configures reporter styling and resolves user hook factories", async () => {
    const log = testLog();
    const completed: string[] = [];
    const command = definePipelineCommand(makeMiniPipeline(), {
      hooks: ({ context, values }) => [
        {
          onStepComplete: ({ step }) => completed.push(`${context.cwd}:${values.limit}:${step.id}`),
        },
      ],
      mapOptions: (values) => ({ limit: values.limit }),
      params: { limit: { type: "number", optional: true } },
      reporter: { color: "never", symbols: "unicode" },
    });

    await command.run(["--limit", "3"], { cwd: "/workspace", log });

    expect(log.lines.map((line) => line.message)).toEqual(
      expect.arrayContaining([
        "  → First Step - Run first",
        expect.stringMatching(/^  ✓ First Step \(\d+ms\)$/),
      ])
    );
    expect(completed).toEqual(["/workspace:3:first", "/workspace:3:second"]);
  });

  it("routes pipeline and hook logs through the interactive renderer", async () => {
    const chunks: string[] = [];
    const output: ReporterOutput = {
      isTTY: true,
      write: (chunk) => chunks.push(chunk),
    };
    const cliLog = testLog();
    const { step } = createSteps();
    const work = step("work", {
      run: (_inputs, context) => {
        context.reportProgress({ completed: 3, total: 4, message: "items" });
        context.log.log("step detail");
        return "done";
      },
    });
    const pipeline = definePipeline({
      id: "interactive-command",
      steps: [work],
      finalize: (outputs) => outputs.work,
    });
    const command = definePipelineCommand(pipeline, {
      hooks: ({ context }) => {
        context.log.log("hook configured");
        return undefined;
      },
      mapOptions: () => ({}),
      reporter: {
        color: "never",
        mode: "interactive",
        output,
        progressBarWidth: 8,
        refreshIntervalMs: 10_000,
        symbols: "unicode",
        terminal: { color: false, isTTY: true, unicode: true },
      },
      summarize: () => ["summary after renderer"],
    });

    await command.run([], { log: cliLog });

    const rendered = chunks.join("");
    expect(rendered).toContain("hook configured\n");
    expect(rendered).toContain("step detail\n");
    expect(rendered).toContain("[██████░░] 75% 3/4 items");
    expect(rendered).toContain("\u001B[?25h");
    expect(cliLog.lines).toEqual([{ level: "log", message: "summary after renderer" }]);
  });

  it("logs domain summary lines after a successful run", async () => {
    const log = testLog();
    const command = definePipelineCommand(makeMiniPipeline(), {
      mapOptions: () => ({}),
      reporter: false,
      summarize: (result) => [`first=${result.first}`],
    });

    await command.run([], { log });
    expect(log.lines.map((line) => line.message)).toEqual(["first=1"]);
  });

  it("rejects bridge parameter and flag collisions at definition time", () => {
    expect(() =>
      definePipelineCommand(makeMiniPipeline(), {
        params: { stepIds: { type: "string" } as never },
        mapOptions: () => ({}),
      })
    ).toThrow(/"stepIds" is a reserved parameter/);

    expect(() =>
      definePipelineCommand(makeMiniPipeline(), {
        params: { step: { type: "string" } as never },
        mapOptions: () => ({}),
      })
    ).toThrow(/--step is a reserved flag/);

    expect(() =>
      definePipelineCommand(makeMiniPipeline(), {
        params: { stage: { type: "string", flag: "continue-on-error" } },
        mapOptions: () => ({}),
      })
    ).toThrow(/--continue-on-error is a reserved flag/);
  });

  it("does not reserve a ghost plan parameter or --plan flag", () => {
    const command = definePipelineCommand(makeMiniPipeline(), {
      params: { plan: { type: "boolean" } },
      mapOptions: () => ({}),
    });
    const result = command.parse(["--plan"]);

    expect(result.kind).toBe("values");
    expect(result.kind === "values" && result.values.plan).toBe(true);
  });

  it("treats --plan as an unknown pipeline-command flag", () => {
    const command = definePipelineCommand(makeMiniPipeline(), { mapOptions: () => ({}) });
    const result = command.parse(["--plan"]);

    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors).toContain("Unknown option: --plan");
  });

  it("maps command.main validation, planning, execution, and cancellation onto workbench exit codes", async () => {
    const previousExitCode = process.exitCode;
    const log = testLog();

    try {
      const command = definePipelineCommand(makeMiniPipeline(), {
        mapOptions: () => ({}),
        reporter: false,
      });

      process.exitCode = undefined;
      await command.main(["--help"], { log });
      expect(process.exitCode).toBe(0);

      process.exitCode = undefined;
      await command.main(["--bogus"], { log });
      expect(process.exitCode).toBe(4);

      process.exitCode = undefined;
      await command.main(["--step", "first", "--target", "second"], { log });
      expect(process.exitCode).toBe(4);

      process.exitCode = undefined;
      await command.main(["--target", "first", "--target", "first"], { log });
      expect(process.exitCode).toBe(5);

      const { step: failingStep } = createSteps();
      const fail = failingStep("fail", {
        run: () => {
          throw new Error("intentional command failure");
        },
      });
      const failingCommand = definePipelineCommand(
        definePipeline({
          id: "main-failure",
          steps: [fail],
          finalize: (outputs) => outputs.fail,
        }),
        { mapOptions: () => ({}), reporter: false }
      );
      process.exitCode = undefined;
      await failingCommand.main([], { log });
      expect(process.exitCode).toBe(6);

      const { step: cancellingStep } = createSteps();
      const cancel = cancellingStep("cancel", {
        run: () => {
          throw new DOMException("intentional command cancellation", "AbortError");
        },
      });
      const cancellingCommand = definePipelineCommand(
        definePipeline({
          id: "main-cancellation",
          steps: [cancel],
          finalize: (outputs) => outputs.cancel,
        }),
        { mapOptions: () => ({}), reporter: false }
      );
      process.exitCode = undefined;
      await cancellingCommand.main([], { log });
      expect(process.exitCode).toBe(7);

      const throwingCommand = definePipelineCommand(makeMiniPipeline(), {
        mapOptions: () => {
          throw new Error("mapOptions failed");
        },
        reporter: false,
      });
      process.exitCode = undefined;
      await throwingCommand.main([], { log });
      expect(process.exitCode).toBe(6);

      const throwingValidateCommand = definePipelineCommand(makeMiniPipeline(), {
        mapOptions: () => ({}),
        validate: () => {
          throw new Error("validate failed");
        },
        reporter: false,
      });
      process.exitCode = undefined;
      await throwingValidateCommand.main([], { log });
      expect(process.exitCode).toBe(6);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("plans without opening or mutating a managed checkpoint", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-command-plan-"));
    const checkpointPath = path.join(cwd, "checkpoint.json");
    let validationCalls = 0;
    try {
      const checkpoint = openCheckpoint(checkpointPath);
      checkpoint.record("existing");
      checkpoint.flush();

      const command = definePipelineCommand(makeMiniPipeline(), {
        checkpoint: { path: checkpointPath },
        mapOptions: () => ({}),
        validate: () => {
          validationCalls += 1;
        },
      });
      const plan = command.plan();

      expect(plan.ok).toBe(true);
      expect(openCheckpoint(checkpointPath).has("existing")).toBe(true);
      expect(validationCalls).toBe(0);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

it("forwards --cache as a run control without including it in domain options or keys", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cli-cache-"));
  const { step } = createSteps<{ input: string }>();
  const run = vi.fn((_inputs, context) => {
    expect(context.options).toEqual({ input: "same" });
    return 1;
  });
  const work = step("work", { cache: { version: "v1" }, run });
  const command = definePipelineCommand(definePipeline({ id: "cli-cache", steps: [work] }), {
    params: { input: { type: "string", required: true } },
    reporter: false,
  });
  try {
    const context = { cwd: directory, log: testLog() };
    for (const args of [[], [], ["--cache", "recompute"], ["--cache", "bypass"], []]) {
      expect(await command.run(["--input", "same", ...args], context)).toBe(1);
    }
    expect(run).toHaveBeenCalledTimes(3);
    expect(command.parse(["--input", "same", "--cache", "invalid"]).kind).toBe("error");
    expect(command.descriptor.parameters.find((p) => p.key === "cache")?.group).toBe("execution");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
