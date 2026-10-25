import { createRunHistoryIndex, summarizeRun } from "../run-store/run-history.js";
import type { StoredPipelineRun } from "../run-store/run-store.js";
import type { StudioSnapshot, StudioRunDetail } from "./run-store-ui-schema.js";
import { summarizePipelines } from "./run-store-ui-state.js";

export function studioSnapshot(
  runs: readonly StoredPipelineRun[],
  selectedRunId?: string | null
): StudioSnapshot {
  const index = createRunHistoryIndex(runs);
  return {
    activeRunCount: runs.filter((run) => run.status === "running").length,
    completedRunCount: runs.filter((run) => run.status === "completed").length,
    failedRunCount: runs.filter((run) => run.status === "failed").length,
    definitions: [],
    pipelines: summarizePipelines(runs.map((run) => summarizeRun(run, index))),
    generatedAtMs: 1,
    lastEventId: 1,
    revision: 1,
    runCount: runs.length,
    eventCount: runs.reduce((sum, run) => sum + run.eventCount, 0),
    rootRunCount: index.roots.length,
    matchingRootCount: index.roots.length,
    offset: 0,
    runs: index.roots.map((run) => summarizeRun(run, index)),
    selectedRun:
      selectedRunId && index.runById(selectedRunId)
        ? summarizeRun(index.runById(selectedRunId)!, index)
        : undefined,
    liveRunIds: [],
  };
}

export function studioRunDetail(run: StoredPipelineRun): StudioRunDetail {
  return { run, ancestors: [], children: [], childCount: 0, childSteps: [], descendantCount: 0 };
}
