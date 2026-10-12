import { describe, expect, it } from "vitest";
import { createRunHistoryIndex } from "../run-store/run-history.js";
import { projectPipelineRunStore } from "../run-store/run-store.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import { createFakeDurableStorage } from "./cloudflare-storage.test-support.js";
import { openDurableRunStore } from "./cloudflare-run-store.js";
import { LaunchRegistry } from "./cloudflare-launches.js";

const base = { version: 3 as const, pipelineId: "demo", timestampMs: 1 };
const started = (runId: string, parentRunId?: string, stepCount = 2): PipelineTraceEvent => ({
  ...base,
  runId,
  ...(parentRunId ? { parentRunId } : {}),
  name: "pipeline.started",
  payload: { dryRun: false, planOk: true, stepCount, targetIds: [] },
});
const completed = (runId: string): PipelineTraceEvent => ({
  ...base,
  runId,
  name: "pipeline.completed",
  payload: { dryRun: false, errorCount: 0, finalized: true, status: "completed", stepCount: 2 },
});

function setup() {
  const storage = createFakeDurableStorage();
  const store = openDurableRunStore(storage);
  return { storage, store, registry: new LaunchRegistry(storage, store) };
}

describe("Durable Object run store", () => {
  it("creates the schema once and stays append-only", async () => {
    const { storage, store } = setup();
    openDurableRunStore(storage);
    storage.transactionSync(() => store.append([started("r1")]));
    expect((await store.listEvents()).map((event) => event.id)).toEqual([1]);
    expect(() => storage.sql.exec("DELETE FROM pipeline_run_events")).toThrow(/append-only/);
  });

  it("rejects an unknown schema version", () => {
    const { storage } = setup();
    storage.sql.exec("UPDATE tubeless_meta SET value = '99' WHERE key = 'run_event_store_version'");
    expect(() => openDurableRunStore(storage)).toThrow(/schema version 99/);
  });
});

describe("launch registry", () => {
  it("binds the top-level run, ignores child starts, and tracks liveness", async () => {
    const { registry } = setup();
    registry.create("l1", "demo", 100);
    expect(registry.acceptBatch("l1", 0, [started("r1")])).toEqual({
      duplicate: false,
      dropped: false,
      boundRunId: "r1",
      terminal: false,
    });
    registry.acceptBatch("l1", 1, [started("child", "r1")]);
    expect(registry.get("l1")).toMatchObject({ runId: "r1", state: "running", stepCount: 2 });
    expect(registry.liveRunIds()).toEqual(["r1"]);
    expect(registry.launchIdForRun("r1")).toBe("l1");
    expect(registry.acceptBatch("l1", 2, [completed("r1")])).toEqual({
      duplicate: false,
      dropped: false,
      terminal: true,
    });
    expect(registry.liveRunIds()).toEqual([]);
  });

  it("applies a retried batch at most once", async () => {
    const { registry, store } = setup();
    registry.create("l1", "demo", 100);
    registry.acceptBatch("l1", 0, [started("r1")]);
    expect(registry.acceptBatch("l1", 0, [started("r1")]).duplicate).toBe(true);
    expect(await store.listEvents()).toHaveLength(1);
  });

  it("rolls back a batch that fails validation", async () => {
    const { registry, store } = setup();
    registry.create("l1", "demo", 100);
    const invalid = { ...started("r1"), payload: {} } as unknown as PipelineTraceEvent;
    expect(() => registry.acceptBatch("l1", 0, [started("r1"), invalid])).toThrow();
    expect(await store.listEvents()).toEqual([]);
    expect(registry.get("l1")).toMatchObject({ lastBatch: -1, state: "starting" });
  });

  it("records a host-terminated failure once and drops late events", async () => {
    const { registry, store } = setup();
    registry.create("l1", "demo", 100);
    registry.acceptBatch("l1", 0, [started("r1")]);
    registry.fail("l1", "The Cloudflare run host stopped before the run finished.", 500);
    registry.fail("l1", "again", 600);
    expect(registry.acceptBatch("l1", 1, [completed("r1")])).toEqual({
      duplicate: false,
      dropped: true,
      terminal: true,
    });
    const events = await store.listEvents();
    expect(events.map((event) => event.name)).toEqual(["pipeline.started", "pipeline.completed"]);
    expect(events[1]).toMatchObject({
      payload: { status: "failed", errorCount: 1, stepCount: 2 },
      error: { code: "TUBELESS_RUN_CANCELLED", kind: "cancellation", phase: "execution" },
    });
    expect(registry.get("l1")?.state).toBe("failed");
    expect(registry.get("l1")?.lastBatch).toBe(1);
    expect(registry.acceptBatch("l1", 1, [completed("r1")])).toEqual({
      duplicate: true,
      dropped: false,
      terminal: true,
    });
    expect(await store.listEvents()).toHaveLength(2);
  });

  it("drops the first batch of a launch that failed before it started", async () => {
    const { registry, store } = setup();
    registry.create("l1", "demo", 100);
    registry.fail("l1", "The run host could not confirm the run started.", 200);
    expect(registry.acceptBatch("l1", 0, [started("r1")])).toEqual({
      duplicate: false,
      dropped: true,
      terminal: true,
    });
    expect(registry.acceptBatch("l1", 0, [started("r1")]).dropped).toBe(false);
    expect(await store.listEvents()).toEqual([]);
    expect(registry.launchIdForRun("r1")).toBeUndefined();
  });

  it("requires strictly serial batches", async () => {
    const { registry, store } = setup();
    registry.create("l1", "demo", 100);
    registry.acceptBatch("l1", 0, [started("r1")]);
    expect(() => registry.acceptBatch("l1", 2, [completed("r1")])).toThrow(
      "Launch l1 expected batch 1 but received 2."
    );
    expect(await store.listEvents()).toHaveLength(1);
    expect(registry.get("l1")).toMatchObject({ lastBatch: 0, state: "running" });
    expect(registry.acceptBatch("l1", 1, [completed("r1")]).terminal).toBe(true);
  });

  it("stops resolving a run to its launch once the launch is finished", async () => {
    const { registry } = setup();
    registry.create("l1", "demo", 100);
    registry.acceptBatch("l1", 0, [started("r1")]);
    expect(registry.launchIdForRun("r1")).toBe("l1");
    registry.acceptBatch("l1", 1, [completed("r1")]);
    expect(registry.launchIdForRun("r1")).toBeUndefined();
  });

  it("admits a known, open launch and refuses unknown or closed ones", () => {
    const { registry } = setup();
    expect(registry.admit("missing")).toBe(false);
    registry.create("l1", "demo", 100);
    expect(registry.get("l1")?.admitted).toBe(false);
    expect(registry.admit("l1")).toBe(true);
    expect(registry.get("l1")).toMatchObject({ admitted: true, state: "starting" });
    expect(registry.admit("l1")).toBe(true);
    registry.create("closed", "demo", 100);
    registry.fail("closed", "The run host could not confirm the run started.", 200);
    expect(registry.admit("closed")).toBe(false);
    expect(registry.get("closed")?.admitted).toBe(false);
    registry.create("done", "demo", 100);
    registry.acceptBatch("done", 0, [started("r1"), completed("r1")]);
    expect(registry.admit("done")).toBe(false);
  });

  it("closes every open run in the launch subtree, children before the root", async () => {
    const { registry, store } = setup();
    registry.create("l1", "demo", 100);
    const child: PipelineTraceEvent = {
      ...started("child", "r1", 3),
      pipelineId: "nested",
      correlationId: "corr-1",
      itemKey: "item-1",
    };
    const grandchild: PipelineTraceEvent = {
      ...started("grandchild", "child", 5),
      pipelineId: "leaf",
      iteration: { runId: "child", stepId: "loop", attemptId: "a1", index: 1 },
    };
    const finishedChild: PipelineTraceEvent = {
      ...completed("done-child"),
      parentRunId: "r1",
    };
    registry.acceptBatch("l1", 0, [started("r1")]);
    registry.acceptBatch("l1", 1, [child, grandchild, started("done-child", "r1"), finishedChild]);
    const before = (await store.listEvents()).length;
    registry.fail("l1", "The Cloudflare run host stopped before the run finished.", 900);
    const events = await store.listEvents();
    const appended = events.slice(before);
    expect(appended.map((event) => [event.name, event.runId])).toEqual([
      ["pipeline.completed", "grandchild"],
      ["pipeline.completed", "child"],
      ["pipeline.completed", "r1"],
    ]);
    const cancelled = {
      code: "TUBELESS_RUN_CANCELLED",
      kind: "cancellation",
      message: "The Cloudflare run host stopped before the run finished.",
      phase: "execution",
    };
    expect(appended[0]).toMatchObject({
      pipelineId: "leaf",
      parentRunId: "child",
      iteration: { runId: "child", stepId: "loop", attemptId: "a1", index: 1 },
      timestampMs: 900,
      payload: { status: "failed", errorCount: 1, finalized: false, stepCount: 5, dryRun: false },
      error: cancelled,
    });
    expect(appended[1]).toMatchObject({
      pipelineId: "nested",
      parentRunId: "r1",
      correlationId: "corr-1",
      itemKey: "item-1",
      payload: { status: "failed", stepCount: 3 },
      error: cancelled,
    });
    expect(appended[2]).toMatchObject({
      pipelineId: "demo",
      payload: { status: "failed", stepCount: 2 },
      error: cancelled,
    });
    expect(appended[2]).not.toHaveProperty("parentRunId");
    const { runs } = projectPipelineRunStore(events);
    expect(runs.filter((run) => run.status === "running")).toEqual([]);
    expect(createRunHistoryIndex(runs).subtreeIsRunning("r1")).toBe(false);
  });

  it("fails unbound launches without inventing history and lists stale launches", async () => {
    const { registry, store } = setup();
    registry.create("old", "demo", 100);
    registry.create("edge", "demo", 5_000);
    registry.create("new", "demo", 10_000);
    expect(registry.stale(5_000)).toEqual(["old", "edge"]);
    expect(registry.hasActive()).toBe(true);
    registry.fail("old", "Pipeline command exited (2) before recording a run.", 6_000);
    expect(await store.listEvents()).toEqual([]);
    expect(registry.get("old")?.state).toBe("failed");
  });
});
