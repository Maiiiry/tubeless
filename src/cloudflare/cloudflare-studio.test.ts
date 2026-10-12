import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSteps, definePipeline, type StandardSchemaV1 } from "../core/pipeline.js";
import { defineProject } from "../project/project.js";
import { hostedProjectCommands } from "../hosting/hosting-commands.js";
import { createFakeDurableStorage } from "./cloudflare-storage.test-support.js";
import { openDurableRunStore } from "./cloudflare-run-store.js";
import { RunObjectCore, type RunJob, type StudioIngest } from "./cloudflare-run.js";
import { StudioObjectCore, type RunStubLike } from "./cloudflare-studio.js";

const inputSchema = (minimum: number): StandardSchemaV1<{ name: string }, { name: string }> => ({
  "~standard": {
    vendor: "test",
    version: 1,
    validate: (value) => {
      const name = (value as { name?: unknown }).name;
      return typeof name === "string" && name.length >= minimum
        ? { value: { name } }
        : { issues: [{ message: `Expected at least ${minimum} characters`, path: ["name"] }] };
    },
    jsonSchema: {
      input: () => ({
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      }),
    },
  } as StandardSchemaV1<{ name: string }, { name: string }>["~standard"],
});
const greetSteps = createSteps(inputSchema(3));
const greet = greetSteps.step("greet", { run: (_inputs, context) => `hi ${context.options.name}` });
const Greeting = definePipeline({ id: "greeting", steps: [greet], finalize: greet });
const slowSteps = createSteps(inputSchema(0));
const wait = slowSteps.step("wait", {
  run: (_inputs, context) =>
    new Promise<string>((resolve, reject) => {
      const timer = setTimeout(resolve, 10_000, "done");
      context.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(context.signal?.reason);
        },
        { once: true }
      );
    }),
});
const Slow = definePipeline({ id: "slow", steps: [wait], finalize: wait });
const commands = new Map(
  hostedProjectCommands(defineProject("p", [Greeting, Slow])).map((entry) => [
    entry.descriptor.id,
    entry,
  ])
);

function setup(
  options: {
    startRuns?: boolean;
    now?: () => number;
    storage?: ReturnType<typeof createFakeDurableStorage>;
    start?: (job: RunJob, run: RunObjectCore) => Promise<void>;
    commands?: typeof commands;
    startTimeoutMs?: number;
    ingest?: (studio: StudioObjectCore) => StudioIngest;
  } = {}
) {
  const runs = new Map<string, RunObjectCore>();
  const settled: Promise<void>[] = [];
  let studio!: StudioObjectCore;
  const studioStorage = options.storage ?? createFakeDurableStorage();
  const starts: RunJob[] = [];
  const runStorages = new Map<string, ReturnType<typeof createFakeDurableStorage>>();
  const runStub = (launchId: string): RunStubLike => {
    let core = runs.get(launchId);
    if (!core) {
      const storage = createFakeDurableStorage();
      runStorages.set(launchId, storage);
      core = new RunObjectCore({
        storage,
        commands,
        ingest: () => options.ingest?.(studio) ?? studio,
      });
      runs.set(launchId, core);
    }
    const run = core;
    return {
      async start(job: RunJob) {
        starts.push(job);
        if (options.start) return options.start(job, run);
        await run.start(job);
        if (options.startRuns !== false) settled.push(run.alarm());
      },
      cancel: () => run.cancel(),
    };
  };
  studio = new StudioObjectCore({
    storage: studioStorage,
    commands: options.commands ?? commands,
    clientScript: "",
    maxRunDurationMs: 60_000,
    runStub,
    startTimeoutMs: options.startTimeoutMs ?? 200,
    ...(options.now ? { now: options.now } : {}),
  });
  const api = (path: string, init?: RequestInit) =>
    studio.fetch(new Request(`https://studio.example${path}`, init));
  const launch = (command: string, values: Record<string, unknown>) =>
    api(`/api/commands/${command}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tubeless-studio-launch": "1",
        origin: "https://studio.example",
      },
      body: JSON.stringify({ values }),
    });
  return { studio, storage: studioStorage, api, launch, settled, starts, runStorages };
}

describe("Studio object", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("launches, acknowledges after the start is recorded, and records completion", async () => {
    const { api, launch, settled } = setup();
    const response = await launch("greeting", { name: "ada" });
    expect(response.status).toBe(202);
    const { runId } = (await response.json()) as { runId: string };
    await Promise.all(settled);
    const detail = (await (await api(`/api/runs/${encodeURIComponent(runId)}`)).json()) as {
      run: { status: string };
    };
    expect(detail.run.status).toBe("completed");
    expect(
      ((await (await api("/api/snapshot")).json()) as { liveRunIds: string[] }).liveRunIds
    ).toEqual([]);
  });

  it("rejects unknown commands and invalid values before starting a run", async () => {
    const { launch } = setup();
    expect((await launch("missing", {})).status).toBe(404);
    const rejected = await launch("greeting", {});
    expect(rejected.status).toBe(400);
  });

  it("records an options-schema rejection as a failed run", async () => {
    const { api, launch, settled } = setup();
    const response = await launch("greeting", { name: "ab" });
    await Promise.all(settled);
    expect(response.status).toBe(202);
    const { runId } = (await response.json()) as { runId: string };
    const detail = (await (await api(`/api/runs/${encodeURIComponent(runId)}`)).json()) as {
      run: { status: string };
    };
    expect(detail.run.status).toBe("failed");
  });

  it("cancels a live run through its run object", async () => {
    const { api, launch, settled } = setup();
    const { runId } = (await (await launch("slow", { name: "" })).json()) as { runId: string };
    expect(
      ((await (await api("/api/snapshot")).json()) as { liveRunIds: string[] }).liveRunIds
    ).toEqual([runId]);
    const cancel = await api(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
      headers: { "x-tubeless-studio-cancel": "1", origin: "https://studio.example" },
    });
    expect(cancel.status).toBe(202);
    await Promise.all(settled);
    const detail = (await (await api(`/api/runs/${encodeURIComponent(runId)}`)).json()) as {
      run: { status: string };
    };
    expect(detail.run.status).toBe("cancelled");
  });

  it("reports an unrecorded start as uncertain, then reconciles it", async () => {
    let now = 1_000;
    const { api, launch, studio, storage } = setup({ startRuns: false, now: () => now });
    const response = await launch("greeting", { name: "ada" });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toMatch(/may still start/);
    now += 60_000 + 120_001;
    await studio.alarm();
    // A second reconcile is a no-op once the launch is failed.
    await studio.alarm();
    expect(storage.alarmAtMs()).toBe(181_000);
    expect(
      ((await (await api("/api/snapshot")).json()) as { liveRunIds: string[] }).liveRunIds
    ).toEqual([]);
  });

  it("answers a rejected start as a failed launch that is not live", async () => {
    const { api, launch } = setup({ start: () => Promise.reject(new Error("boom")) });
    const response = await launch("greeting", { name: "ada" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      errors: [
        "The run host could not confirm the run started. It may have started; check history before launching again.",
      ],
    });
    expect(
      ((await (await api("/api/snapshot")).json()) as { liveRunIds: string[] }).liveRunIds
    ).toEqual([]);
  });

  it("stops a run whose start call failed after the run object stored it", async () => {
    const alarms: Promise<void>[] = [];
    const { api, launch, storage, runStorages } = setup({
      start: async (job, run) => {
        await run.start(job);
        alarms.push(run.alarm());
        throw new Error("start RPC lost");
      },
    });
    const response = await launch("slow", { name: "" });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toMatch(/could not confirm the run started/);
    await Promise.all(alarms);
    const runStorage = [...runStorages.values()][0]!;
    expect(await runStorage.get("job")).toBeUndefined();
    expect(runStorage.alarmAtMs()).toBeUndefined();
    const events = await openDurableRunStore(storage).listEvents();
    expect(events).toEqual([]);
    expect(
      ((await (await api("/api/snapshot")).json()) as { liveRunIds: string[] }).liveRunIds
    ).toEqual([]);
  });

  // Hold admission open until the launch request has been answered, so the start failure is
  // handled at a known point relative to admission.
  function gatedAdmission() {
    let admitted!: () => void;
    let release!: () => void;
    const admittedPromise = new Promise<void>((resolve) => (admitted = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const alarms: Promise<void>[] = [];
    return {
      alarms,
      release,
      admittedPromise,
      ingest: (studio: StudioObjectCore): StudioIngest => ({
        appendEvents: (launchId, sequence, events) =>
          studio.appendEvents(launchId, sequence, events),
        reportFailure: (launchId, message) => studio.reportFailure(launchId, message),
        admit: async (launchId) => {
          const result = await studio.admit(launchId);
          admitted();
          await released;
          return result;
        },
      }),
      startAfterAdmission: async (job: RunJob, run: RunObjectCore) => {
        await run.start(job);
        alarms.push(run.alarm());
        await admittedPromise;
        throw new Error("start RPC lost");
      },
      startBeforeAdmission: async (job: RunJob, run: RunObjectCore) => {
        await run.start(job);
        alarms.push(run.alarm());
        throw new Error("start RPC lost");
      },
    };
  }

  it("keeps an admitted run whose start call failed and records its outcome", async () => {
    const gate = gatedAdmission();
    const { api, launch, storage } = setup({
      ingest: gate.ingest,
      start: gate.startAfterAdmission,
    });
    const response = await launch("greeting", { name: "ada" });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toMatch(/could not confirm the run started/);
    gate.release();
    await Promise.all(gate.alarms);
    const events = await openDurableRunStore(storage).listEvents();
    const completions = events.filter((event) => event.name === "pipeline.completed");
    expect(completions).toHaveLength(1);
    expect(completions[0]?.payload).toMatchObject({ status: "completed" });
    const runId = completions[0]!.runId;
    const detail = (await (await api(`/api/runs/${encodeURIComponent(runId)}`)).json()) as {
      run: { status: string };
    };
    expect(detail.run.status).toBe("completed");
    expect(
      ((await (await api("/api/snapshot")).json()) as { liveRunIds: string[] }).liveRunIds
    ).toEqual([]);
  });

  it("fails a launch whose start call failed before the run was admitted", async () => {
    const gate = gatedAdmission();
    const { launch, storage, runStorages } = setup({
      ingest: gate.ingest,
      start: gate.startBeforeAdmission,
    });
    const response = await launch("greeting", { name: "ada" });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toMatch(/could not confirm the run started/);
    await gate.admittedPromise;
    gate.release();
    await Promise.all(gate.alarms);
    expect(await openDurableRunStore(storage).listEvents()).toEqual([]);
    expect(await [...runStorages.values()][0]!.get("job")).toBeUndefined();
  });

  it("logs instead of throwing when recording a failed start fails", async () => {
    const storage = createFakeDurableStorage();
    const { launch } = setup({
      storage,
      start: async () => {
        storage.transactionSync = () => {
          throw new Error("storage down");
        };
        throw new Error("start RPC lost");
      },
    });
    const response = await launch("greeting", { name: "ada" });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toMatch(/could not confirm the run started/);
    expect(console.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: "storage down" })
    );
  });

  it("does not touch the run object when the reconcile alarm cannot be scheduled", async () => {
    const storage = createFakeDurableStorage();
    storage.setAlarm = () => Promise.reject(new Error("alarm unavailable"));
    const { launch, starts } = setup({ storage });
    const response = await launch("greeting", { name: "ada" });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toMatch(/could not start/);
    expect(starts).toEqual([]);
  });

  it("rejects values whose parsing throws before starting a run", async () => {
    const real = commands.get("greeting")!;
    const throwing = new Map([
      [
        "greeting",
        {
          descriptor: real.descriptor,
          command: {
            ...real.command,
            parseValues: () => {
              throw new Error("values could not be parsed");
            },
          },
        },
      ],
    ]);
    const { launch, starts } = setup({ commands: throwing });
    const response = await launch("greeting", { name: "ada" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ errors: ["values could not be parsed"] });
    expect(starts).toEqual([]);
  });

  it("names a one-second start timeout in the singular", async () => {
    const { launch } = setup({ start: () => new Promise<void>(() => {}), startTimeoutMs: 1_000 });
    const response = await launch("greeting", { name: "ada" });
    expect(JSON.stringify(await response.json())).toMatch(/within 1 second\./);
  });

  it("answers a hung start within the start timeout", async () => {
    const { launch } = setup({ start: () => new Promise<void>(() => {}) });
    const response = await launch("greeting", { name: "ada" });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toMatch(/within 200 ms.*may still start/);
  });

  it("keeps the earliest reconcile alarm across launches", async () => {
    let now = 1_000;
    const { launch, storage } = setup({ startRuns: false, now: () => now });
    await launch("greeting", { name: "ada" });
    expect(storage.alarmAtMs()).toBe(181_000);
    now += 30_000;
    await launch("greeting", { name: "ada" });
    expect(storage.alarmAtMs()).toBe(181_000);
  });

  it("reschedules the reconcile alarm while a fresh launch remains active", async () => {
    let now = 1_000;
    const { launch, studio, storage } = setup({ startRuns: false, now: () => now });
    await launch("greeting", { name: "ada" });
    now += 100_000;
    await launch("greeting", { name: "ada" });
    now += 81_001;
    await studio.alarm();
    expect(storage.alarmAtMs()).toBe(now + 60_000 + 120_000);
  });
});
