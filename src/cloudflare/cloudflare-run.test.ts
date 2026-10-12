import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSteps, definePipeline, type StandardSchemaV1 } from "../core/pipeline.js";
import { defineProject } from "../project/project.js";
import { hostedProjectCommands } from "../hosting/hosting-commands.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import { createFakeDurableStorage } from "./cloudflare-storage.test-support.js";
import {
  BatchingTraceExporter,
  MAX_RUN_DURATION_MS,
  RunObjectCore,
  runHostedJob,
  type RunJob,
  type StudioIngest,
} from "./cloudflare-run.js";

function schema<T>(validate: (value: unknown) => T | undefined): StandardSchemaV1<T, T> {
  return {
    "~standard": {
      vendor: "test",
      version: 1,
      validate: (value) => {
        const result = validate(value);
        return result === undefined
          ? { issues: [{ message: "Expected at least 3 characters" }] }
          : { value: result };
      },
      jsonSchema: { input: () => ({ type: "object", properties: { name: { type: "string" } } }) },
    } as StandardSchemaV1<T, T>["~standard"],
  };
}
const nameSchema = schema((value) => {
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" && name.length >= 3 ? { name } : undefined;
});
const { step } = createSteps(nameSchema);
const greet = step("greet", { run: (_inputs, context) => `hi ${context.options.name}` });
const Greeting = definePipeline({ id: "greeting", steps: [greet], finalize: greet });
// Blocks until the run is aborted, so tests can exercise cancellation and the deadline.
const hold = step("hold", {
  run: (_inputs, context) =>
    new Promise<never>((_resolve, reject) => {
      const signal = context.signal;
      if (!signal) return reject(new Error("The run has no abort signal."));
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
});
const Waiting = definePipeline({ id: "waiting", steps: [hold], finalize: hold });
const sideEffect = vi.fn();
const effect = step("effect", { run: () => void sideEffect() });
const Effect = definePipeline({ id: "effect", steps: [effect], finalize: effect });
const commands = new Map(
  hostedProjectCommands(defineProject("p", [Greeting, Waiting, Effect])).map((entry) => [
    entry.descriptor.id,
    entry,
  ])
);
const startEvent: PipelineTraceEvent = {
  version: 3,
  name: "pipeline.started",
  runId: "r",
  pipelineId: "p",
  timestampMs: 1,
  payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
};
const logEvent: PipelineTraceEvent = {
  version: 3,
  name: "pipeline.log",
  runId: "r",
  pipelineId: "p",
  timestampMs: 1,
  payload: { level: "log", message: "x" },
};

function ingest(admit: StudioIngest["admit"] = async () => ({ admitted: true })) {
  const batches: { sequence: number; events: PipelineTraceEvent[] }[] = [];
  const failures: string[] = [];
  const studio: StudioIngest = {
    admit,
    appendEvents: async (_launchId, sequence, events) => {
      batches.push({ sequence, events });
      return { accepted: true };
    },
    reportFailure: async (_launchId, message) => void failures.push(message),
  };
  return { studio, batches, failures };
}
const job = (values: Record<string, unknown>): RunJob => ({
  launchId: "l1",
  commandId: "greeting",
  values,
  maxRunDurationMs: 60_000,
});

// The run object forwards pipeline output to the console; keep test output quiet.
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("batching exporter", () => {
  it("flushes the top-level start immediately, numbers batches, and retries", async () => {
    const sent: number[] = [];
    let failOnce = true;
    const exporter = new BatchingTraceExporter(
      async (sequence) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("transient");
        }
        sent.push(sequence);
      },
      { maxEvents: 50, maxDelayMs: 10_000, retries: 2, retryDelayMs: 0, onFailure: () => {} }
    );
    await exporter.export(startEvent);
    expect(sent).toEqual([0]);
    await exporter.export(logEvent);
    await exporter.flush();
    expect(sent).toEqual([0, 1]);
  });

  it("flushes when maxEvents is reached", async () => {
    const sent: number[] = [];
    const exporter = new BatchingTraceExporter(async (sequence) => void sent.push(sequence), {
      maxEvents: 2,
      maxDelayMs: 10_000,
      retries: 0,
      retryDelayMs: 0,
      onFailure: () => {},
    });
    await exporter.export(logEvent);
    expect(sent).toEqual([]);
    await exporter.export(logEvent);
    expect(sent).toEqual([0]);
  });

  it("flushes after maxDelayMs", async () => {
    vi.useFakeTimers();
    try {
      const sent: number[] = [];
      const exporter = new BatchingTraceExporter(async (sequence) => void sent.push(sequence), {
        maxEvents: 50,
        maxDelayMs: 100,
        retries: 0,
        retryDelayMs: 0,
        onFailure: () => {},
      });
      await exporter.export(logEvent);
      await vi.advanceTimersByTimeAsync(99);
      expect(sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toEqual([0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never sends a later sequence after a delivery failed", async () => {
    const send = vi.fn(async (_sequence: number) => {
      throw new Error("down");
    });
    const exporter = new BatchingTraceExporter(send, {
      maxEvents: 1,
      maxDelayMs: 0,
      retries: 0,
      retryDelayMs: 0,
      onFailure: () => {},
    });
    await expect(exporter.export(logEvent)).rejects.toThrow("down");
    await expect(exporter.export(logEvent)).rejects.toThrow("down");
    await expect(exporter.flush()).rejects.toThrow("down");
    expect(send.mock.calls.map(([sequence]) => sequence)).toEqual([0]);
  });

  it("reports exhausted retries once", async () => {
    const onFailure = vi.fn();
    const exporter = new BatchingTraceExporter(
      async () => {
        throw new Error("down");
      },
      { maxEvents: 1, maxDelayMs: 0, retries: 1, retryDelayMs: 0, onFailure }
    );
    await expect(
      exporter.export({
        version: 3,
        name: "pipeline.log",
        runId: "r",
        pipelineId: "p",
        timestampMs: 1,
        payload: { level: "log", message: "x" },
      })
    ).rejects.toThrow("down");
    expect(onFailure).toHaveBeenCalledTimes(1);
  });
});

describe("run object", () => {
  it("executes a job once and clears its storage", async () => {
    const storage = createFakeDurableStorage();
    const { studio, batches, failures } = ingest();
    const core = new RunObjectCore({ storage, commands, ingest: () => studio, now: () => 1_000 });
    await core.start(job({ name: "ada" }));
    expect(storage.alarmAtMs()).toBe(1_000);
    await core.alarm();
    const names = batches.flatMap((batch) => batch.events.map((event) => event.name));
    expect(names[0]).toBe("pipeline.started");
    expect(names).toContain("pipeline.completed");
    expect(batches.map((batch) => batch.sequence)).toEqual([...batches.keys()]);
    expect(failures).toEqual([]);
    expect(await storage.get("job")).toBeUndefined();
    expect(storage.alarmAtMs()).toBeUndefined();
  });

  it("records an options-schema rejection as a failed run rather than a host failure", async () => {
    const storage = createFakeDurableStorage();
    const { studio, batches, failures } = ingest();
    const core = new RunObjectCore({ storage, commands, ingest: () => studio });
    await core.start(job({ name: "ab" }));
    await core.alarm();
    const events = batches.flatMap((batch) => batch.events);
    expect(events[0]?.name).toBe("pipeline.started");
    const completed = events.find((event) => event.name === "pipeline.completed");
    expect(completed?.payload).toMatchObject({ status: "failed" });
    expect(failures).toEqual([]);
    expect(await storage.get("job")).toBeUndefined();
  });

  it("reports a command that is not registered", async () => {
    const storage = createFakeDurableStorage();
    const { studio, batches, failures } = ingest();
    const core = new RunObjectCore({ storage, commands, ingest: () => studio });
    await core.start({ ...job({ name: "ada" }), commandId: "missing" });
    await core.alarm();
    expect(batches).toEqual([]);
    expect(failures).toEqual(["Pipeline command not found."]);
  });

  it("treats an alarm that finds its job running as a crashed attempt", async () => {
    const storage = createFakeDurableStorage();
    const { studio, batches, failures } = ingest();
    await storage.put("job", job({ name: "ada" }));
    await storage.put("state", "running");
    await new RunObjectCore({ storage, commands, ingest: () => studio }).alarm();
    expect(batches).toEqual([]);
    expect(failures).toEqual(["The Cloudflare run host stopped before the run finished."]);
    expect(await storage.get("job")).toBeUndefined();
  });

  it("never executes a job that Studio does not admit", async () => {
    sideEffect.mockClear();
    const storage = createFakeDurableStorage();
    const { studio, batches, failures } = ingest(async () => ({ admitted: false }));
    const core = new RunObjectCore({ storage, commands, ingest: () => studio });
    await core.start({ ...job({ name: "ada" }), commandId: "effect" });
    await core.alarm();
    expect(sideEffect).not.toHaveBeenCalled();
    expect(batches).toEqual([]);
    expect(failures).toEqual([]);
    expect(await storage.get("job")).toBeUndefined();
    expect(storage.alarmAtMs()).toBeUndefined();
  });

  it("never executes a job whose admission could not be confirmed", async () => {
    sideEffect.mockClear();
    const storage = createFakeDurableStorage();
    const { studio, batches, failures } = ingest(async () => {
      throw new Error("admission RPC lost");
    });
    const core = new RunObjectCore({ storage, commands, ingest: () => studio });
    await core.start({ ...job({ name: "ada" }), commandId: "effect" });
    await core.alarm();
    expect(sideEffect).not.toHaveBeenCalled();
    expect(batches).toEqual([]);
    expect(failures).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: "admission RPC lost" })
    );
    expect(await storage.get("job")).toBeUndefined();
  });

  it("executes an admitted job", async () => {
    sideEffect.mockClear();
    const storage = createFakeDurableStorage();
    const { studio, failures } = ingest();
    const core = new RunObjectCore({ storage, commands, ingest: () => studio });
    await core.start({ ...job({ name: "ada" }), commandId: "effect" });
    await core.alarm();
    expect(sideEffect).toHaveBeenCalledTimes(1);
    expect(failures).toEqual([]);
  });

  it("ignores duplicate starts and cancels only a live run", async () => {
    const storage = createFakeDurableStorage();
    const core = new RunObjectCore({ storage, commands, ingest: () => ingest().studio });
    await core.start(job({ name: "ada" }));
    await core.start(job({ name: "other" }));
    expect((await storage.get<RunJob>("job"))?.values).toEqual({ name: "ada" });
    expect(core.cancel()).toBe(false);
  });
});

describe("run lifecycle", () => {
  const completedStatus = (batches: { events: PipelineTraceEvent[] }[]) =>
    batches.flatMap((batch) => batch.events).find((event) => event.name === "pipeline.completed")
      ?.payload;

  it("cancels a live run and ends it cancelled", async () => {
    const storage = createFakeDurableStorage();
    const { studio, batches, failures } = ingest();
    const core = new RunObjectCore({ storage, commands, ingest: () => studio });
    await core.start({ ...job({ name: "ada" }), commandId: "waiting" });
    const alarm = core.alarm();
    await vi.waitFor(() => expect(batches.length).toBeGreaterThan(0));
    expect(core.cancel()).toBe(true);
    expect(core.cancel()).toBe(false);
    await alarm;
    expect(completedStatus(batches)).toMatchObject({ status: "cancelled" });
    expect(failures).toEqual([]);
    expect(await storage.get("job")).toBeUndefined();
    expect(core.cancel()).toBe(false);
  });

  it("aborts a run that exceeds its deadline", async () => {
    const storage = createFakeDurableStorage();
    const { studio, batches, failures } = ingest();
    const core = new RunObjectCore({ storage, commands, ingest: () => studio });
    await core.start({ ...job({ name: "ada" }), commandId: "waiting", maxRunDurationMs: 50 });
    await core.alarm();
    expect(completedStatus(batches)).toMatchObject({ status: "cancelled" });
    expect(failures).toEqual([]);
  });

  it("caps the watchdog alarm at the maximum run duration", async () => {
    const storage = createFakeDurableStorage();
    const { studio, batches } = ingest();
    const core = new RunObjectCore({ storage, commands, ingest: () => studio, now: () => 1_000 });
    await core.start({
      ...job({ name: "ada" }),
      commandId: "waiting",
      maxRunDurationMs: 100 * MAX_RUN_DURATION_MS,
    });
    const alarm = core.alarm();
    await vi.waitFor(() => expect(batches.length).toBeGreaterThan(0));
    expect(storage.alarmAtMs()).toBe(1_000 + MAX_RUN_DURATION_MS + 60_000);
    core.cancel();
    await alarm;
  });

  it("reports a command that exits before recording a run", async () => {
    const storage = createFakeDurableStorage();
    const { studio, batches, failures } = ingest();
    const real = commands.get("greeting")!;
    const throwing = new Map([
      [
        "greeting",
        {
          descriptor: real.descriptor,
          command: {
            ...real.command,
            execute: async () => {
              throw new Error("boom before start");
            },
          },
        },
      ],
    ]);
    const core = new RunObjectCore({ storage, commands: throwing, ingest: () => studio });
    await core.start(job({ name: "ada" }));
    await core.alarm();
    expect(batches).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/before recording a run/);
    expect(failures[0]).toContain("boom before start");
  });

  it("never rethrows from alarm even when cleanup fails", async () => {
    const storage = createFakeDurableStorage();
    const { studio } = ingest();
    const broken = {
      ...storage,
      deleteAll: async () => {
        throw new Error("storage down");
      },
    };
    const core = new RunObjectCore({ storage: broken, commands, ingest: () => studio });
    await core.start(job({ name: "ada" }));
    await expect(core.alarm()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: "storage down" })
    );
  });

  it("never rethrows from alarm when the ingest factory throws", async () => {
    const storage = createFakeDurableStorage();
    const core = new RunObjectCore({
      storage,
      commands,
      ingest: () => {
        throw new Error("no binding");
      },
    });
    await core.start(job({ name: "ada" }));
    await expect(core.alarm()).resolves.toBeUndefined();
  });
});

describe("hosted job", () => {
  it("keeps the run duration cap below the 15 minute alarm wall time", () => {
    expect(MAX_RUN_DURATION_MS).toBe(840_000);
  });

  it("aborts the run and tells Studio when event delivery is exhausted", async () => {
    const controller = new AbortController();
    const { failures } = ingest();
    const failing: StudioIngest = {
      admit: async () => ({ admitted: true }),
      appendEvents: async () => {
        throw new Error("studio unreachable");
      },
      reportFailure: async (_launchId, message) => void failures.push(message),
    };
    vi.useFakeTimers();
    try {
      const running = runHostedJob({
        job: job({ name: "ada" }),
        commands,
        ingest: failing,
        controller,
      });
      await vi.runAllTimersAsync();
      await running;
    } finally {
      vi.useRealTimers();
    }
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toMatchObject({ message: "studio unreachable" });
    expect(failures).toEqual(["Run events could not be delivered to Studio: studio unreachable"]);
  });

  it("stops the run without retrying when Studio refuses its events", async () => {
    const controller = new AbortController();
    const sequences: number[] = [];
    const failures: string[] = [];
    const refusing: StudioIngest = {
      admit: async () => ({ admitted: true }),
      appendEvents: async (_launchId, sequence) => {
        sequences.push(sequence);
        return { accepted: false };
      },
      reportFailure: async (_launchId, message) => void failures.push(message),
    };
    await runHostedJob({
      job: { ...job({ name: "ada" }), commandId: "waiting" },
      commands,
      ingest: refusing,
      controller,
    });
    expect(controller.signal.reason).toMatchObject({
      message: "Studio closed this launch; stopping the run.",
    });
    expect(sequences[0]).toBe(0);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(failures).toEqual([]);
  });

  it("logs instead of throwing when the delivery failure report also fails", async () => {
    const failing: StudioIngest = {
      admit: async () => ({ admitted: true }),
      appendEvents: async () => {
        throw new Error("studio unreachable");
      },
      reportFailure: async () => {
        throw new Error("report failed");
      },
    };
    vi.useFakeTimers();
    try {
      const running = runHostedJob({
        job: job({ name: "ada" }),
        commands,
        ingest: failing,
        controller: new AbortController(),
      });
      await vi.runAllTimersAsync();
      await expect(running).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    expect(console.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: "report failed" })
    );
  });
});
