import { studioSnapshot as snapshot, studioRunDetail } from "./run-store-ui.test-support.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUN_MODEL_VERSION } from "../core/pipeline.js";
import type { StoredPipelineRun } from "../run-store/run-store.js";
import type {
  StudioApi,
  StudioRunDetail,
  StudioSnapshot,
} from "./run-store-ui-client-transport.js";
import { StudioDataController } from "./run-store-ui-data-controller.js";

function deferred<T>() {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, reject, resolve };
}

function run(runId: string, eventCount = 1): StoredPipelineRun {
  return {
    dryRun: false,
    eventCount,
    logCount: 0,
    logs: [],
    pipelineId: runId,
    runId,
    startedAtMs: 1,
    status: "completed",
    steps: [],
    version: RUN_MODEL_VERSION,
  };
}

function api(overrides: Partial<StudioApi>): StudioApi {
  return {
    cancelRun: vi.fn(async () => {}),
    clearHistory: vi.fn(async () => ({ eventCount: 0 })),
    loadCapabilities: vi.fn(async () => ({ canCancel: false, canClearHistory: false })),
    loadCommands: vi.fn(async () => []),
    loadDefinition: vi.fn(async () => {
      throw new Error("unused");
    }),
    loadDefinitionRuns: vi.fn(async () => {
      throw new Error("unused");
    }),
    loadRunDetail: vi.fn(async () => null),
    loadChildRuns: vi.fn(async () => ({ children: [], page: 0, childCount: 0 })),
    loadSnapshot: vi.fn(async ({ selectedRunId } = {}) =>
      snapshot(selectedRunId ? [run(selectedRunId)] : [], selectedRunId)
    ),
    launch: vi.fn(async () => "run"),
    previewPlan: vi.fn(async () => {
      throw new Error("unused");
    }),
    ...overrides,
  };
}

const controllers: StudioDataController[] = [];
function controller(service: StudioApi, runId: string | null = null) {
  const instance = new StudioDataController(service, { runId, detailRetryMs: 50 });
  controllers.push(instance);
  return instance;
}
async function settle() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}
function detail(instance: StudioDataController) {
  const selection = instance.getState().selection;
  return selection.status === "ready" ? selection.detail : null;
}
afterEach(() => {
  controllers.splice(0).forEach((instance) => instance.dispose());
  vi.useRealTimers();
});

describe("StudioDataController", () => {
  it("owns linked-run loading and confirms absence only from the current snapshot", async () => {
    const requests = [deferred<StudioSnapshot>(), deferred<StudioSnapshot>()];
    const loadSnapshot = vi
      .fn()
      .mockReturnValueOnce(requests[0]!.promise)
      .mockReturnValueOnce(requests[1]!.promise);
    const instance = controller(api({ loadSnapshot }), "linked");
    expect(instance.getState().selection).toEqual({ status: "loading", runId: "linked" });
    instance.refresh();
    instance.selectRun("missing");
    requests[0]!.resolve(snapshot([run("linked")], "linked"));
    await settle();
    expect(instance.getState().selection).toMatchObject({ status: "loading", runId: "missing" });
    expect(loadSnapshot).toHaveBeenLastCalledWith({
      query: "",
      offset: 0,
      selectedRunId: "missing",
    });
    requests[1]!.resolve(snapshot([]));
    await settle();
    expect(instance.getState().selection).toEqual({ status: "unavailable", runId: "missing" });
  });

  it("keeps the pipeline scope while selecting runs and clearing history", async () => {
    const service = api({});
    const instance = new StudioDataController(service, { pipelineId: "import", detailRetryMs: 50 });
    controllers.push(instance);
    instance.refresh();
    await settle();
    expect(service.loadSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ pipelineId: "import", query: "", offset: 0 })
    );
    expect(instance.getState().snapshotPipelineId).toBe("import");
    instance.setHistoryQuery({ pipelineId: "import", query: "child", offset: 0 });
    instance.selectRun("off-page");
    expect(instance.getState().historyQuery).toEqual({
      pipelineId: "import",
      query: "",
      offset: 0,
    });
    instance.invalidate({ resetHistory: true });
    expect(instance.getState().historyQuery.pipelineId).toBe("import");
    instance.setHistoryQuery({});
    expect(instance.getState().snapshotPipelineId).toBe("import");
    await settle();
    expect(service.loadSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ pipelineId: undefined })
    );
    await settle();
    expect(instance.getState().snapshotPipelineId).toBeUndefined();
  });

  it("retires a slow history page when the query changes", async () => {
    const requests = [deferred<StudioSnapshot>(), deferred<StudioSnapshot>()];
    const loadSnapshot = vi
      .fn()
      .mockReturnValueOnce(requests[0]!.promise)
      .mockReturnValueOnce(requests[1]!.promise);
    const instance = controller(api({ loadSnapshot }));
    instance.setHistoryQuery({ offset: 50 });
    instance.setHistoryQuery({ query: "child" });
    requests[0]!.resolve(snapshot([run("old-page")]));
    await settle();
    expect(instance.getState().snapshot).toBeNull();
    expect(loadSnapshot).toHaveBeenLastCalledWith({
      query: "child",
      offset: 0,
      selectedRunId: null,
    });
    requests[1]!.resolve(snapshot([run("new-page")]));
    await settle();
    expect(instance.getState().snapshot?.runs[0]?.runId).toBe("new-page");
  });

  it("loads an off-page run using the selected summary and keeps selection while paging", async () => {
    const recorded = run("off-page");
    const selected = snapshot([recorded], recorded.runId).selectedRun!;
    const loadRunDetail = vi.fn(async () => studioRunDetail(recorded));
    const instance = controller(
      api({
        loadRunDetail,
        loadSnapshot: vi.fn(async () => ({ ...snapshot([run("on-page")]), selectedRun: selected })),
      }),
      recorded.runId
    );
    instance.refresh();
    await settle();
    instance.setHistoryQuery({ offset: 50 });
    await settle();
    expect(instance.getState().selection).toMatchObject({
      status: "ready",
      runId: recorded.runId,
      summary: selected,
    });
    expect(detail(instance)?.run.runId).toBe(recorded.runId);
    expect(loadRunDetail).toHaveBeenCalledTimes(1);
  });

  it("resolves child navigation once and resets a query only when its root is off-page", async () => {
    const root = run("root");
    const child = { ...run("child"), parentRunId: root.runId };
    const summaries = snapshot([root, child], child.runId);
    const instance = controller(
      api({
        loadRunDetail: vi.fn(async (id) => ({
          ...studioRunDetail(id === root.runId ? root : child),
          children: id === root.runId ? [summaries.selectedRun!] : [],
        })),
        loadSnapshot: vi.fn(async ({ selectedRunId } = {}) =>
          snapshot([root, child], selectedRunId)
        ),
      }),
      root.runId
    );
    instance.refresh();
    await settle();
    instance.setHistoryQuery({ query: "root" });
    await settle();
    instance.selectRun(child.runId);
    expect(instance.getState().historyQuery.query).toBe("root");
    await settle();
    expect(detail(instance)?.run.runId).toBe(child.runId);
    instance.selectRun("elsewhere");
    expect(instance.getState().historyQuery).toEqual({ query: "", offset: 0 });
    expect(detail(instance)).toBeNull();
  });

  it("retains detail and coalesces revisions received during a read", async () => {
    let eventCount = 1;
    const requests: ReturnType<typeof deferred<StudioRunDetail | null>>[] = [];
    const loadRunDetail = vi.fn(() => {
      const request = deferred<StudioRunDetail | null>();
      requests.push(request);
      return request.promise;
    });
    const instance = controller(
      api({
        loadRunDetail,
        loadSnapshot: vi.fn(async () => snapshot([run("live", eventCount)], "live")),
      }),
      "live"
    );
    instance.refresh();
    await settle();
    requests[0]!.resolve(studioRunDetail(run("live")));
    await settle();
    for (const count of [2, 3, 4]) {
      eventCount = count;
      instance.refresh();
      await settle();
    }
    expect(detail(instance)?.run.eventCount).toBe(1);
    expect(loadRunDetail).toHaveBeenCalledTimes(2);
    requests[1]!.resolve(studioRunDetail(run("live", 2)));
    await settle();
    expect(loadRunDetail).toHaveBeenCalledTimes(3);
    requests[2]!.resolve(studioRunDetail(run("live", 4)));
    await settle();
    expect(detail(instance)?.run.eventCount).toBe(4);
  });

  it.each(["missing", "failed"] as const)(
    "retains detail and retries after a %s refresh",
    async (outcome) => {
      vi.useFakeTimers();
      let eventCount = 1;
      const requests: ReturnType<typeof deferred<StudioRunDetail | null>>[] = [];
      const loadRunDetail = vi.fn(() => {
        const request = deferred<StudioRunDetail | null>();
        requests.push(request);
        return request.promise;
      });
      const instance = controller(
        api({
          loadRunDetail,
          loadSnapshot: vi.fn(async () => snapshot([run("live", eventCount)], "live")),
        }),
        "live"
      );
      instance.refresh();
      await settle();
      requests[0]!.resolve(studioRunDetail(run("live")));
      await settle();
      eventCount = 2;
      instance.refresh();
      await settle();
      if (outcome === "missing") requests[1]!.resolve(null);
      else requests[1]!.reject(new Error("offline"));
      await settle();
      eventCount = 3;
      instance.refresh();
      await settle();
      expect(detail(instance)?.run.eventCount).toBe(1);
      expect(loadRunDetail).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(50);
      requests[2]!.resolve(studioRunDetail(run("live", 3)));
      await settle();
      expect(detail(instance)?.run.eventCount).toBe(3);
    }
  );

  it("rejects delayed details when switching away and back", async () => {
    const requests: ReturnType<typeof deferred<StudioRunDetail | null>>[] = [];
    const instance = controller(
      api({
        loadRunDetail: vi.fn(() => {
          const request = deferred<StudioRunDetail | null>();
          requests.push(request);
          return request.promise;
        }),
      })
    );
    for (const id of ["first", "second", "first"]) {
      instance.selectRun(id);
      await settle();
    }
    requests[2]!.resolve(studioRunDetail(run("first", 2)));
    await settle();
    requests[0]!.resolve(studioRunDetail(run("first")));
    requests[1]!.resolve(studioRunDetail(run("second")));
    await settle();
    expect(detail(instance)?.run).toMatchObject({ runId: "first", eventCount: 2 });
  });

  it("rejects a detail whose run does not match the selection", async () => {
    vi.useFakeTimers();
    const instance = controller(
      api({ loadRunDetail: vi.fn(async () => studioRunDetail(run("wrong"))) }),
      "selected"
    );
    instance.refresh();
    await settle();
    expect(instance.getState().selection).toMatchObject({ status: "loading", runId: "selected" });
    expect(detail(instance)).toBeNull();
  });

  it("queues a manual refresh without duplicating polling reads", async () => {
    const requests = [deferred<StudioSnapshot>(), deferred<StudioSnapshot>()];
    const loadSnapshot = vi
      .fn()
      .mockReturnValueOnce(requests[0]!.promise)
      .mockReturnValueOnce(requests[1]!.promise);
    const instance = controller(api({ loadSnapshot }));
    instance.refresh();
    instance.refresh(true);
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
    requests[0]!.resolve(snapshot([run("first")]));
    await settle();
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
    instance.refresh();
    requests[1]!.resolve(snapshot([run("second")]));
    await settle();
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
    expect(instance.getState().manualRefreshing).toBe(false);
  });

  it("clears selection and retires pending snapshot and detail reads atomically", async () => {
    const pendingSnapshot = deferred<StudioSnapshot>();
    const pendingDetail = deferred<StudioRunDetail | null>();
    const loadSnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshot([run("recorded")], "recorded"))
      .mockReturnValueOnce(pendingSnapshot.promise)
      .mockResolvedValue(snapshot([]));
    const instance = controller(
      api({ loadSnapshot, loadRunDetail: vi.fn(() => pendingDetail.promise) }),
      "recorded"
    );
    instance.refresh();
    await settle();
    instance.refresh();
    instance.invalidate({ resetHistory: true });
    expect(instance.getState().selection).toEqual({ status: "unavailable", runId: "recorded" });
    expect(instance.getState().snapshot?.runs).toEqual([]);
    pendingSnapshot.resolve(snapshot([run("stale")]));
    pendingDetail.resolve(studioRunDetail(run("recorded")));
    await settle();
    expect(instance.getState().selection.status).toBe("unavailable");
    expect(instance.getState().snapshot?.runs).toEqual([]);
  });

  it("invalidates detail requests and reloads after the requested delay", async () => {
    vi.useFakeTimers();
    const requests: ReturnType<typeof deferred<StudioRunDetail | null>>[] = [];
    const loadRunDetail = vi.fn(() => {
      const request = deferred<StudioRunDetail | null>();
      requests.push(request);
      return request.promise;
    });
    const instance = controller(api({ loadRunDetail }), "selected");
    instance.refresh();
    await settle();
    instance.invalidate({ delayMs: 20 });
    requests[0]!.resolve(studioRunDetail(run("selected")));
    await settle();
    expect(detail(instance)).toBeNull();
    await vi.advanceTimersByTimeAsync(19);
    expect(loadRunDetail).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(loadRunDetail).toHaveBeenCalledTimes(2);
    requests[1]!.resolve(studioRunDetail(run("selected", 2)));
    await settle();
    expect(detail(instance)?.run.eventCount).toBe(2);
  });

  it.each([401, 403] as const)("retires reads and clears selection after %s", async (status) => {
    vi.useFakeTimers();
    let deny!: (status: 401 | 403) => void;
    const pending = deferred<StudioSnapshot>();
    const lateDetail = deferred<StudioRunDetail | null>();
    const unsubscribe = vi.fn();
    const service = api({
      subscribeAccessDenied: (listener) => {
        deny = listener;
        return unsubscribe;
      },
      loadSnapshot: vi
        .fn()
        .mockResolvedValueOnce(snapshot([run("secret")], "secret"))
        .mockReturnValueOnce(pending.promise),
      loadRunDetail: vi
        .fn()
        .mockResolvedValueOnce(studioRunDetail(run("secret")))
        .mockReturnValueOnce(lateDetail.promise),
    });
    const instance = controller(service, "secret");
    instance.refresh();
    await settle();
    expect(detail(instance)?.run.runId).toBe("secret");
    instance.refresh();
    instance.invalidate({ delayMs: 20 });
    deny(status);
    pending.resolve(snapshot([run("late")]));
    lateDetail.resolve(studioRunDetail(run("late")));
    await settle();
    instance.refresh(true);
    instance.selectRun("other");
    instance.setHistoryQuery({ query: "private" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(instance.getState()).toMatchObject({
      accessDenied: status,
      connected: false,
      selection: { status: "none" },
      manualRefreshing: false,
      snapshot: null,
    });
    expect(vi.getTimerCount()).toBe(0);
    instance.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
