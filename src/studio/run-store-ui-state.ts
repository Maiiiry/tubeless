import {
  createPipelineRunProjector,
  type PipelineRunEventReader,
  type PipelineRunProjector,
  type PipelineRunStoreSnapshot,
  type StoredPipelineRun,
  type StoredPipelineDefinition,
} from "../run-store/run-store.js";
import { readPipelineEventPages } from "../run-store/run-store-reader.js";
import {
  createRunHistoryIndex,
  summarizeDefinition,
  summarizeRun,
  type RunHistoryIndex,
  type StoredRunSummary,
  type StoredDefinitionSummary,
} from "../run-store/run-history.js";
import { pageDirectChildren } from "./run-store-ui-children.js";
import {
  STUDIO_HISTORY_PAGE_SIZE,
  type StudioSnapshot,
  type StudioRunDetail,
  type StudioChildRuns,
  type StudioDefinitionRuns,
} from "./run-store-ui-schema.js";

export interface PipelineRunStudioHistoryMaintenance {
  clear(): void | Promise<void>;
  isBusy?(): boolean | Promise<boolean>;
}

/**
 * Detail projectors retain log and artifact bodies. This keeps the selected run
 * and the expanded children touched most recently; an older open is rebuilt on demand.
 */
export const STUDIO_OPEN_RUN_LIMIT = 32;

export class PipelineRunStudioHistoryBusyError extends Error {
  constructor() {
    super("Wait for active runs to finish before clearing history.");
    this.name = "PipelineRunStudioHistoryBusyError";
  }
}

/** Serializes incremental store reads and history clearing for one studio server. */
export class PipelineRunStudioEventState {
  #lastEventId: number | undefined;
  #operation: Promise<void> = Promise.resolve();
  #projector = createPipelineRunProjector({ retainLogs: false, retainArtifacts: false });
  /** Recent opens, oldest first. Each entry keeps log and artifact bodies for one run. */
  #runs = new Map<string, { lastEventId: number | undefined; projector: PipelineRunProjector }>();
  #revision = 0;
  #history:
    | {
        source: PipelineRunStoreSnapshot;
        index: RunHistoryIndex<StoredPipelineRun>;
        summaries: Map<string, StoredRunSummary>;
        roots: StoredRunSummary[];
        definitions: StoredDefinitionSummary[];
        eventCount: number;
        search?: { query: string; roots: StoredRunSummary[] };
      }
    | undefined;

  constructor(private readonly store: Pick<PipelineRunEventReader, "listEvents">) {}

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async #appendNewEvents(): Promise<void> {
    for await (const page of readPipelineEventPages(this.store, {
      afterId: this.#lastEventId,
      limit: 100_000,
    })) {
      this.#projector.append(page);
      this.#lastEventId = page.at(-1)!.id;
      this.#revision += 1;
    }
  }

  /** Fold one run from its last event id. The first open reads the run; later polls read the tail. */
  async #openRun(runId: string): Promise<StoredPipelineRun | undefined> {
    const cached = this.#runs.get(runId) ?? {
      lastEventId: undefined,
      projector: createPipelineRunProjector(),
    };
    let seen = cached.lastEventId !== undefined;
    for await (const page of readPipelineEventPages(this.store, {
      afterId: cached.lastEventId,
      limit: 100_000,
      runId,
    })) {
      cached.projector.append(page);
      cached.lastEventId = page.at(-1)!.id;
      seen = true;
    }
    if (!seen) return undefined;
    this.#retainRun(runId, cached);
    return cached.projector.snapshot().runs.find((entry) => entry.runId === runId);
  }

  /** Remember a run and drop the oldest projector once retention is full. */
  #retainRun(
    runId: string,
    cached: { lastEventId: number | undefined; projector: PipelineRunProjector }
  ): void {
    this.#runs.delete(runId);
    this.#runs.set(runId, cached);
    while (this.#runs.size > STUDIO_OPEN_RUN_LIMIT) {
      const oldest = this.#runs.keys().next().value;
      if (oldest === undefined) return;
      this.#runs.delete(oldest);
    }
  }

  #indexedHistory() {
    const source = this.#projector.snapshot();
    if (this.#history?.source === source) return this.#history;
    const index = createRunHistoryIndex(source.runs);
    const summaries = new Map(source.runs.map((run) => [run.runId, summarizeRun(run, index)]));
    const roots = index.roots
      .map((run) => summaries.get(run.runId)!)
      .sort(
        (left, right) =>
          Number(right.subtreeIsRunning) - Number(left.subtreeIsRunning) ||
          right.startedAtMs - left.startedAtMs
      );
    this.#history = {
      source,
      index,
      summaries,
      roots,
      definitions: source.definitions.map(summarizeDefinition),
      eventCount: source.runs.reduce((sum, run) => sum + run.eventCount, 0),
    };
    return this.#history;
  }

  workspace(query = "", offset = 0, selectedRunId?: string | null): Promise<StudioSnapshot> {
    return this.#serialize(async () => {
      await this.#appendNewEvents();
      const history = this.#indexedHistory();
      let roots = history.roots;
      if (query) {
        if (history.search?.query !== query) {
          const matches = history.index.matchingRootIds(query);
          history.search = { query, roots: roots.filter((run) => matches.has(run.runId)) };
        }
        roots = history.search.roots;
      }
      const { source } = history;
      const pageOffset = Math.min(
        offset,
        Math.max(0, Math.ceil(roots.length / STUDIO_HISTORY_PAGE_SIZE) - 1) *
          STUDIO_HISTORY_PAGE_SIZE
      );
      return {
        activeRunCount: source.activeRunCount,
        completedRunCount: source.completedRunCount,
        failedRunCount: source.failedRunCount,
        generatedAtMs: source.generatedAtMs,
        lastEventId: source.lastEventId,
        revision: this.#revision,
        runCount: source.runs.length,
        eventCount: history.eventCount,
        rootRunCount: history.roots.length,
        matchingRootCount: roots.length,
        offset: pageOffset,
        definitions: history.definitions,
        liveRunIds: [],
        runs: roots.slice(pageOffset, pageOffset + STUDIO_HISTORY_PAGE_SIZE),
        selectedRun: selectedRunId ? history.summaries.get(selectedRunId) : undefined,
      };
    });
  }

  detail(runId: string): Promise<StudioRunDetail | undefined> {
    return this.#serialize(async () => {
      await this.#appendNewEvents();
      const history = this.#indexedHistory();
      const run = await this.#openRun(runId);
      if (!run) return undefined;
      const stored = history.source.runs.find((entry) => entry.runId === runId);
      const window = pageDirectChildren(
        this.#directChildren(history, runId),
        (stored ?? run).steps.map((step) => step.id),
        0
      );
      return {
        run,
        ancestors: history.index.ancestorsOf(runId).map((run) => history.summaries.get(run.runId)!),
        children: window.children,
        childCount: window.childCount,
        childSteps: window.childSteps,
        descendantCount: history.index.descendantCount(runId),
      };
    });
  }

  childRuns(runId: string, page: number): Promise<StudioChildRuns | undefined> {
    return this.#serialize(async () => {
      await this.#appendNewEvents();
      const history = this.#indexedHistory();
      const run = history.source.runs.find((entry) => entry.runId === runId);
      if (!run) return undefined;
      const window = pageDirectChildren(
        this.#directChildren(history, runId),
        run.steps.map((step) => step.id),
        page
      );
      return { children: window.children, page, childCount: window.childCount };
    });
  }

  #directChildren(
    history: {
      index: RunHistoryIndex<StoredPipelineRun>;
      summaries: Map<string, StoredRunSummary>;
    },
    runId: string
  ): StoredRunSummary[] {
    return history.index.childrenOf(runId).map((run) => history.summaries.get(run.runId)!);
  }

  definition(
    pipelineId: string,
    definitionId?: string
  ): Promise<StoredPipelineDefinition | undefined> {
    return this.#serialize(async () => {
      await this.#appendNewEvents();
      return this.#indexedHistory().source.definitions.find(
        (entry) => entry.pipelineId === pipelineId && entry.identity?.definitionId === definitionId
      );
    });
  }

  definitionRuns(
    pipelineId: string,
    definitionId?: string,
    offset = 0
  ): Promise<StudioDefinitionRuns | undefined> {
    return this.#serialize(async () => {
      await this.#appendNewEvents();
      const history = this.#indexedHistory();
      const runs = history.source.runs.filter(
        (run) =>
          run.pipelineId === pipelineId && run.definitionIdentity?.definitionId === definitionId
      );
      if (!runs.length) return undefined;
      const pageOffset = Math.min(
        offset,
        Math.max(0, Math.ceil(runs.length / STUDIO_HISTORY_PAGE_SIZE) - 1) *
          STUDIO_HISTORY_PAGE_SIZE
      );
      return {
        runs: runs
          .slice(pageOffset, pageOffset + STUDIO_HISTORY_PAGE_SIZE)
          .map((run) => history.summaries.get(run.runId)!),
        offset: pageOffset,
        runCount: runs.length,
      };
    });
  }

  clear(
    history: PipelineRunStudioHistoryMaintenance
  ): Promise<{ eventCount: number; runCount: number }> {
    return this.#serialize(async () => {
      if (await history.isBusy?.()) throw new PipelineRunStudioHistoryBusyError();
      await this.#appendNewEvents();
      const snapshot = this.#projector.snapshot();
      await history.clear();
      this.#lastEventId = undefined;
      this.#projector.clear();
      this.#runs.clear();
      this.#history = undefined;
      this.#revision += 1;
      return {
        eventCount: snapshot.runs.reduce((n, run) => n + run.eventCount, 0),
        runCount: snapshot.runs.length,
      };
    });
  }
}
