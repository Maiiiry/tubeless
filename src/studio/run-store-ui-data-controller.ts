import type { StoredRunSummary } from "../run-store/run-history.js";
import type {
  StudioApi,
  StudioAccessDenied,
  StudioRunDetail,
  StudioSnapshot,
  StudioHistoryQuery,
} from "./run-store-ui-client-transport.js";

export type StudioRunSelection =
  | { status: "none" }
  | { status: "loading"; runId: string; summary?: StoredRunSummary }
  | { status: "unavailable"; runId: string }
  | { status: "ready"; runId: string; summary: StoredRunSummary; detail: StudioRunDetail };

export interface StudioDataState {
  accessDenied?: StudioAccessDenied;
  connected: boolean;
  historyQuery: { pipelineId?: string; query: string; offset: number };
  selection: StudioRunSelection;
  manualRefreshing: boolean;
  snapshot: StudioSnapshot | null;
  /** Pipeline scope that produced `snapshot.runs`; it lags `historyQuery` until a read lands. */
  snapshotPipelineId?: string;
}

export interface StudioDataInvalidation {
  delayMs?: number;
  resetHistory?: boolean;
}

type StudioDataListener = (state: StudioDataState) => void;
export const DEFAULT_DETAIL_RETRY_MS = 1_200;

function fingerprint(summary: StoredRunSummary): string {
  return [
    summary.runId,
    summary.eventCount,
    summary.subtreeEventCount,
    summary.rootRunId,
    summary.status,
  ].join(":");
}

function clearedSnapshot(snapshot: StudioSnapshot): StudioSnapshot {
  return {
    ...snapshot,
    activeRunCount: 0,
    completedRunCount: 0,
    definitions: [],
    pipelines: [],
    failedRunCount: 0,
    runCount: 0,
    eventCount: 0,
    rootRunCount: 0,
    matchingRootCount: 0,
    offset: 0,
    selectedRun: undefined,
    lastEventId: 0,
    liveRunIds: [],
    runs: [],
  };
}

/** Owns history queries, selection reconciliation and selection-scoped detail freshness. */
export class StudioDataController {
  readonly #api: StudioApi;
  readonly #unsubscribeAccess: (() => void) | undefined;
  readonly #detailRetryMs: number;
  readonly #listeners = new Set<StudioDataListener>();
  #detailRequest: object | null = null;
  #detailRetryTimeout: ReturnType<typeof setTimeout> | undefined;
  #detailFingerprint: string | null = null;
  #detailSelectionVersion = 0;
  #disposed = false;
  #invalidationTimeout: ReturnType<typeof setTimeout> | undefined;
  #manualRefreshPending = false;
  #snapshotEpoch = 0;
  #snapshotRefreshActive = false;
  #snapshotRefreshQueued = false;
  #state: StudioDataState;

  constructor(
    api: StudioApi,
    {
      runId = null,
      pipelineId,
      detailRetryMs = DEFAULT_DETAIL_RETRY_MS,
    }: { runId?: string | null; pipelineId?: string; detailRetryMs?: number } = {}
  ) {
    this.#api = api;
    this.#detailRetryMs = detailRetryMs;
    this.#state = {
      connected: true,
      historyQuery: { pipelineId, query: "", offset: 0 },
      selection: runId ? { status: "loading", runId } : { status: "none" },
      manualRefreshing: false,
      snapshot: null,
    };
    this.#unsubscribeAccess = api.subscribeAccessDenied?.((status) => {
      this.#snapshotEpoch += 1;
      this.#retireDetail();
      if (this.#invalidationTimeout) clearTimeout(this.#invalidationTimeout);
      this.#invalidationTimeout = undefined;
      this.#snapshotRefreshQueued = false;
      this.#update({
        accessDenied: status,
        connected: false,
        snapshot: null,
        selection: { status: "none" },
        manualRefreshing: false,
      });
    });
  }

  getState(): StudioDataState {
    return this.#state;
  }

  subscribe(listener: StudioDataListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setHistoryQuery({
    pipelineId,
    query = "",
    offset = 0,
  }: Pick<StudioHistoryQuery, "pipelineId" | "query" | "offset">): void {
    if (this.#disposed || this.#state.accessDenied) return;
    const current = this.#state.historyQuery;
    if (current.pipelineId === pipelineId && current.query === query && current.offset === offset)
      return;
    this.#snapshotEpoch += 1;
    this.#update({ historyQuery: { pipelineId, query, offset } });
    this.refresh(true);
  }

  selectRun(runId: string | null): void {
    if (this.#disposed || this.#state.accessDenied || runId === this.#selectedRunId()) return;
    const summary = runId ? this.#findSummary(runId) : undefined;
    // Pipeline-scoped pages list runs at any depth; unscoped pages list top-level runs.
    const visible =
      summary &&
      this.#state.snapshot?.runs.some(
        (listed) => listed.runId === summary.rootRunId || listed.runId === summary.runId
      );
    const { pipelineId } = this.#state.historyQuery;
    this.#retireDetail();
    this.#snapshotEpoch += 1;
    this.#update({
      historyQuery: visible ? this.#state.historyQuery : { pipelineId, query: "", offset: 0 },
      selection: runId ? { status: "loading", runId, summary } : { status: "none" },
    });
    if (summary) {
      this.#detailFingerprint = fingerprint(summary);
      this.#loadDetail(this.#detailSelectionVersion);
    }
    this.refresh(true);
  }

  refresh(manual = false): void {
    if (this.#disposed || this.#state.accessDenied) return;
    if (manual) {
      this.#manualRefreshPending = true;
      this.#update({ manualRefreshing: true });
    }
    if (this.#snapshotRefreshActive) {
      if (manual) this.#snapshotRefreshQueued = true;
      return;
    }
    this.#startSnapshotRefresh();
  }

  invalidate({ delayMs = 0, resetHistory = false }: StudioDataInvalidation = {}): void {
    if (this.#disposed || this.#state.accessDenied) return;
    this.#snapshotEpoch += 1;
    const runId = this.#selectedRunId();
    if (resetHistory) {
      this.#retireDetail();
      this.#update({
        historyQuery: { pipelineId: this.#state.historyQuery.pipelineId, query: "", offset: 0 },
        selection: runId ? { status: "unavailable", runId } : { status: "none" },
        snapshot: this.#state.snapshot ? clearedSnapshot(this.#state.snapshot) : null,
      });
    } else {
      this.#invalidateDetail(delayMs);
    }
    if (this.#invalidationTimeout) clearTimeout(this.#invalidationTimeout);
    this.#invalidationTimeout = undefined;
    if (delayMs > 0) {
      this.#invalidationTimeout = setTimeout(() => {
        this.#invalidationTimeout = undefined;
        this.refresh(true);
      }, delayMs);
      return;
    }
    this.refresh(true);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#unsubscribeAccess?.();
    this.#disposed = true;
    this.#snapshotEpoch += 1;
    this.#retireDetail();
    if (this.#invalidationTimeout) clearTimeout(this.#invalidationTimeout);
    this.#invalidationTimeout = undefined;
    this.#listeners.clear();
  }

  #selectedRunId(): string | null {
    return this.#state.selection.status === "none" ? null : this.#state.selection.runId;
  }

  #findSummary(runId: string): StoredRunSummary | undefined {
    const { snapshot, selection } = this.#state;
    return (
      (snapshot?.selectedRun?.runId === runId ? snapshot.selectedRun : undefined) ??
      snapshot?.runs.find((run) => run.runId === runId) ??
      (selection.status === "ready"
        ? (selection.detail.children.find((run) => run.runId === runId) ??
          selection.detail.ancestors.find((run) => run.runId === runId))
        : undefined)
    );
  }

  #acceptSnapshot(snapshot: StudioSnapshot, snapshotPipelineId: string | undefined): void {
    let selection = this.#state.selection;
    const runId = this.#selectedRunId();
    if (runId) {
      const summary = snapshot.selectedRun ?? snapshot.runs.find((run) => run.runId === runId);
      if (summary?.runId === runId) {
        const nextFingerprint = fingerprint(summary);
        selection =
          selection.status === "ready"
            ? { ...selection, summary }
            : { status: "loading", runId, summary };
        const changed = nextFingerprint !== this.#detailFingerprint;
        this.#detailFingerprint = nextFingerprint;
        this.#update({ connected: true, snapshot, snapshotPipelineId, selection });
        if (changed) this.#loadDetail(this.#detailSelectionVersion);
        return;
      }
      this.#retireDetail();
      selection = { status: "unavailable", runId };
    }
    this.#update({ connected: true, snapshot, snapshotPipelineId, selection });
  }

  #startSnapshotRefresh(): void {
    if (this.#disposed || this.#state.accessDenied) return;
    this.#snapshotRefreshActive = true;
    const epoch = this.#snapshotEpoch;
    const query = this.#state.historyQuery;
    this.#manualRefreshPending = false;
    void this.#api
      .loadSnapshot({ ...query, selectedRunId: this.#selectedRunId() })
      .then((snapshot) => {
        if (this.#disposed || this.#state.accessDenied || epoch !== this.#snapshotEpoch) return;
        this.#acceptSnapshot(snapshot, query.pipelineId);
      })
      .catch(() => {
        if (this.#disposed || this.#state.accessDenied || epoch !== this.#snapshotEpoch) return;
        this.#update({ connected: false });
      })
      .finally(() => {
        if (this.#disposed || this.#state.accessDenied) return;
        this.#snapshotRefreshActive = false;
        if (this.#snapshotRefreshQueued) {
          this.#snapshotRefreshQueued = false;
          this.#startSnapshotRefresh();
          return;
        }
        if (!this.#manualRefreshPending) this.#update({ manualRefreshing: false });
      });
  }

  #loadDetail(selectionVersion: number): void {
    const runId = this.#selectedRunId();
    const startedFingerprint = this.#detailFingerprint;
    if (
      this.#disposed ||
      this.#state.accessDenied ||
      this.#detailRequest !== null ||
      this.#detailRetryTimeout !== undefined ||
      !runId ||
      !startedFingerprint ||
      selectionVersion !== this.#detailSelectionVersion
    )
      return;
    const request = {};
    this.#detailRequest = request;
    void this.#api
      .loadRunDetail(runId)
      .then((detail) => {
        if (!this.#detailRequestIsCurrent(request, selectionVersion)) return;
        this.#detailRequest = null;
        const selection = this.#state.selection;
        if (
          detail?.run.runId === runId &&
          (selection.status === "loading" || selection.status === "ready") &&
          selection.summary
        ) {
          this.#update({
            selection: { status: "ready", runId, summary: selection.summary, detail },
          });
          // Coalesce revisions received during this read into one follow-up.
          if (startedFingerprint !== this.#detailFingerprint) this.#loadDetail(selectionVersion);
        } else this.#scheduleDetailRetry(selectionVersion);
      })
      .catch(() => {
        if (!this.#detailRequestIsCurrent(request, selectionVersion)) return;
        this.#detailRequest = null;
        this.#scheduleDetailRetry(selectionVersion);
      });
  }

  #detailRequestIsCurrent(request: object, selectionVersion: number): boolean {
    return (
      !this.#disposed &&
      !this.#state.accessDenied &&
      this.#detailRequest === request &&
      this.#detailSelectionVersion === selectionVersion
    );
  }

  #scheduleDetailRetry(selectionVersion: number): void {
    if (
      this.#disposed ||
      this.#state.accessDenied ||
      selectionVersion !== this.#detailSelectionVersion
    )
      return;
    if (this.#detailRetryTimeout) clearTimeout(this.#detailRetryTimeout);
    this.#detailRetryTimeout = setTimeout(() => {
      this.#detailRetryTimeout = undefined;
      this.#loadDetail(selectionVersion);
    }, this.#detailRetryMs);
  }

  #invalidateDetail(delayMs: number): void {
    const currentFingerprint = this.#detailFingerprint;
    this.#retireDetail();
    this.#detailFingerprint = currentFingerprint;
    if (!currentFingerprint) return;
    const version = this.#detailSelectionVersion;
    if (delayMs > 0) {
      this.#detailRetryTimeout = setTimeout(() => {
        this.#detailRetryTimeout = undefined;
        this.#loadDetail(version);
      }, delayMs);
    } else this.#loadDetail(version);
  }

  #retireDetail(): void {
    this.#detailSelectionVersion += 1;
    this.#detailRequest = null;
    this.#detailFingerprint = null;
    if (this.#detailRetryTimeout) clearTimeout(this.#detailRetryTimeout);
    this.#detailRetryTimeout = undefined;
  }

  #update(update: Partial<StudioDataState>): void {
    this.#state = { ...this.#state, ...update };
    for (const listener of this.#listeners) listener(this.#state);
  }
}
