import { RUN_MODEL_VERSION } from "../../../core/pipeline.js";
import type { StoredPipelineRun, StoredPipelineStep } from "../../../run-store/run-store.js";

export function run(overrides: Partial<StoredPipelineRun> = {}): StoredPipelineRun {
  return {
    dryRun: false,
    eventCount: 1,
    logCount: 0,
    logs: [],
    pipelineId: "parent",
    runId: "root",
    startedAtMs: 1_000,
    status: "running",
    steps: [],
    version: RUN_MODEL_VERSION,
    ...overrides,
  };
}

export function step(
  id: string,
  status: StoredPipelineStep["status"],
  overrides: Partial<StoredPipelineStep> = {}
): StoredPipelineStep {
  return {
    id,
    status,
    dependencies: [],
    optionalDependencies: [],
    skipAfterFailureOf: [],
    ...overrides,
  };
}
