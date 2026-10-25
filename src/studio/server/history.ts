import type {
  PipelineRunStoreSnapshot,
  StoredPipelineRun,
  StoredPipelineDefinition,
} from "../../run-store/run-store.js";
import {
  createRunHistoryIndex,
  summarizeDefinition,
  summarizeRun,
  type StoredRunSummary,
} from "../../run-store/run-history.js";
import { pageDirectChildren } from "./children.js";
import {
  STUDIO_HISTORY_PAGE_SIZE,
  STUDIO_PIPELINE_LIMIT,
  STUDIO_PIPELINE_RECENT_RUNS,
} from "../shared/limits.js";
import type {
  StudioPipelineSummary,
  StudioSnapshot,
  StudioRunDetail,
  StudioChildRuns,
  StudioDefinitionRuns,
} from "../shared/schema.js";

/** Queries one projected history revision without reading or mutating storage. */
export class StudioHistory {
  readonly #index;
  readonly #summaries;
  readonly #roots;
  readonly #definitions;
  readonly #pipelines;
  readonly #eventCount;
  #search: { query: string; pipelineId: string; roots: StoredRunSummary[] } | undefined;

  constructor(private readonly source: PipelineRunStoreSnapshot) {
    this.#index = createRunHistoryIndex(source.runs);
    this.#summaries = new Map(
      source.runs.map((run) => [run.runId, summarizeRun(run, this.#index)])
    );
    this.#roots = this.#index.roots
      .map((run) => this.#summaries.get(run.runId)!)
      .sort(
        (left, right) =>
          Number(right.subtreeIsRunning) - Number(left.subtreeIsRunning) ||
          right.startedAtMs - left.startedAtMs
      );
    this.#definitions = source.definitions.map(summarizeDefinition);
    this.#pipelines = summarizePipelines(this.#summaries.values());
    this.#eventCount = source.runs.reduce((sum, run) => sum + run.eventCount, 0);
  }

  matches(source: PipelineRunStoreSnapshot): boolean {
    return this.source === source;
  }

  #directChildren(runId: string): StoredRunSummary[] {
    return this.#index.childrenOf(runId).map((run) => this.#summaries.get(run.runId)!);
  }

  /**
   * One page of history. Without a pipeline, top-level runs whose subtree matches the
   * search. With one, that pipeline's runs at any depth whose own identifiers match.
   */
  workspace(
    revision: number,
    query = "",
    offset = 0,
    selectedRunId?: string | null,
    pipelineId = ""
  ): StudioSnapshot {
    let roots = this.#roots;
    if (query || pipelineId) {
      if (this.#search?.query !== query || this.#search.pipelineId !== pipelineId) {
        this.#search = {
          query,
          pipelineId,
          roots: pipelineId
            ? pipelineRuns(this.#summaries.values(), pipelineId, query)
            : matchingRoots(roots, this.#index.matchingRootIds(query)),
        };
      }
      roots = this.#search.roots;
    }
    const source = this.source;
    const pageOffset = Math.min(
      offset,
      Math.max(0, Math.ceil(roots.length / STUDIO_HISTORY_PAGE_SIZE) - 1) * STUDIO_HISTORY_PAGE_SIZE
    );
    return {
      activeRunCount: source.activeRunCount,
      completedRunCount: source.completedRunCount,
      failedRunCount: source.failedRunCount,
      generatedAtMs: source.generatedAtMs,
      lastEventId: source.lastEventId,
      revision,
      runCount: source.runs.length,
      eventCount: this.#eventCount,
      rootRunCount: this.#roots.length,
      matchingRootCount: roots.length,
      offset: pageOffset,
      definitions: this.#definitions,
      pipelines: this.#pipelines,
      liveRunIds: [],
      runs: roots.slice(pageOffset, pageOffset + STUDIO_HISTORY_PAGE_SIZE),
      selectedRun: selectedRunId ? this.#summaries.get(selectedRunId) : undefined,
    };
  }

  detail(run: StoredPipelineRun): StudioRunDetail {
    const runId = run.runId;
    const stored = this.#index.runById(runId);
    const window = pageDirectChildren(
      this.#directChildren(runId),
      (stored ?? run).steps.map((step) => step.id),
      0
    );
    return {
      run,
      ancestors: this.#index.ancestorsOf(runId).map((run) => this.#summaries.get(run.runId)!),
      children: window.children,
      childCount: window.childCount,
      childSteps: window.childSteps,
      descendantCount: this.#index.descendantCount(runId),
    };
  }

  childRuns(runId: string, page: number): StudioChildRuns | undefined {
    const run = this.#index.runById(runId);
    if (!run) return undefined;
    const window = pageDirectChildren(
      this.#directChildren(runId),
      run.steps.map((step) => step.id),
      page
    );
    return { children: window.children, page, childCount: window.childCount };
  }

  definition(pipelineId: string, definitionId?: string): StoredPipelineDefinition | undefined {
    return this.source.definitions.find(
      (entry) => entry.pipelineId === pipelineId && entry.identity?.definitionId === definitionId
    );
  }

  definitionRuns(
    pipelineId: string,
    definitionId?: string,
    offset = 0
  ): StudioDefinitionRuns | undefined {
    const runs = this.source.runs.filter(
      (run) =>
        run.pipelineId === pipelineId && run.definitionIdentity?.definitionId === definitionId
    );
    if (!runs.length) return undefined;
    const pageOffset = Math.min(
      offset,
      Math.max(0, Math.ceil(runs.length / STUDIO_HISTORY_PAGE_SIZE) - 1) * STUDIO_HISTORY_PAGE_SIZE
    );
    return {
      runs: runs
        .slice(pageOffset, pageOffset + STUDIO_HISTORY_PAGE_SIZE)
        .map((run) => this.#summaries.get(run.runId)!),
      offset: pageOffset,
      runCount: runs.length,
    };
  }
}

const matchingRoots = (roots: readonly StoredRunSummary[], matches: ReadonlySet<string>) =>
  roots.filter((run) => matches.has(run.runId));

const newestFirst = (left: StoredRunSummary, right: StoredRunSummary) =>
  right.startedAtMs - left.startedAtMs;

function pipelineRuns(
  summaries: Iterable<StoredRunSummary>,
  pipelineId: string,
  query: string
): StoredRunSummary[] {
  const needle = query.toLowerCase();
  return [...summaries]
    .filter(
      (run) =>
        run.pipelineId === pipelineId &&
        (!needle ||
          run.runId.toLowerCase().includes(needle) ||
          !!run.correlationId?.toLowerCase().includes(needle))
    )
    .sort(
      (left, right) =>
        Number(right.subtreeIsRunning) - Number(left.subtreeIsRunning) || newestFirst(left, right)
    );
}

/** Per-pipeline activity for the navigation rail, most recently active first. */
export function summarizePipelines(summaries: Iterable<StoredRunSummary>): StudioPipelineSummary[] {
  const byPipeline = new Map<
    string,
    { topLevel: StoredRunSummary[]; nested: StoredRunSummary[] }
  >();
  for (const run of summaries) {
    const entry = byPipeline.get(run.pipelineId) ?? { topLevel: [], nested: [] };
    (run.rootRunId === run.runId ? entry.topLevel : entry.nested).push(run);
    byPipeline.set(run.pipelineId, entry);
  }
  return [...byPipeline]
    .map(([pipelineId, { topLevel, nested }]) => {
      const all = [...topLevel, ...nested];
      // A loop rather than Math.max(...): spreading every run can exceed the call stack.
      const latest = all.reduce((newest, run) =>
        run.startedAtMs > newest.startedAtMs ? run : newest
      );
      const recent = (topLevel.length ? topLevel : nested)
        .sort(newestFirst)
        .slice(0, STUDIO_PIPELINE_RECENT_RUNS)
        .map(({ runId, status }) => ({ runId, status }));
      return {
        pipelineId,
        topLevelRunCount: topLevel.length,
        nestedRunCount: nested.length,
        runningCount: all.filter((run) => run.status === "running").length,
        latestStartedAtMs: latest.startedAtMs,
        latestStatus: latest.status,
        recent,
      };
    })
    .sort((left, right) => right.latestStartedAtMs - left.latestStartedAtMs)
    .slice(0, STUDIO_PIPELINE_LIMIT);
}
