import { createRunHistoryIndex } from "../run-store/run-history.js";
import { expect, it } from "vitest";
import { RUN_MODEL_VERSION } from "../core/pipeline.js";
import {
  resolveSelectedRunId,
  resolveStudioView,
  runIdFromStudioUrl,
  studioRunUrl,
} from "./run-store-ui-client.js";
import type { StoredPipelineRun } from "../run-store/run-store.js";

function run(
  overrides: Partial<StoredPipelineRun> & Pick<StoredPipelineRun, "runId">
): StoredPipelineRun {
  return {
    dryRun: false,
    eventCount: 1,
    logCount: 0,
    logs: [],
    pipelineId: overrides.pipelineId ?? overrides.runId,
    startedAtMs: 1,
    status: "completed",
    steps: [],
    version: RUN_MODEL_VERSION,
    ...overrides,
  };
}

it("builds store-local run links without losing other URL state", () => {
  const original = "http://127.0.0.1:4317/?view=runs&run=old#details";
  const linked = studioRunUrl(original, "child/with spaces");
  expect(linked).toBe("http://127.0.0.1:4317/?view=runs&run=child%2Fwith+spaces#details");
  expect(runIdFromStudioUrl(linked)).toBe("child/with spaces");
  expect(runIdFromStudioUrl("http://127.0.0.1:4317/")).toBeNull();
  expect(runIdFromStudioUrl("http://127.0.0.1:4317/?run=")).toBeNull();
});

it("preserves an explicitly selected or linked run even when it is unavailable", () => {
  const previous = run({ runId: "previous", startedAtMs: 1 });
  const currentIndex = createRunHistoryIndex([previous]);

  expect(resolveSelectedRunId("launched", currentIndex.roots)).toBe("launched");
  expect(resolveSelectedRunId("missing", currentIndex.roots)).toBe("missing");
  expect(resolveSelectedRunId(null, currentIndex.roots)).toBe("previous");
  expect(resolveSelectedRunId(null, [])).toBeNull();

  const launched = run({ runId: "launched", startedAtMs: 2 });
  const refreshedIndex = createRunHistoryIndex([previous, launched]);
  expect(resolveSelectedRunId("launched", refreshedIndex.roots)).toBe("launched");
});

it("leaves the Definitions view when loaded history has no definitions", () => {
  const empty = { definitions: [] };
  const recorded = { definitions: [{}] };
  expect(resolveStudioView("definitions", empty)).toBe("runs");
  expect(resolveStudioView("definitions", recorded)).toBe("definitions");
  expect(resolveStudioView("definitions", null)).toBe("definitions");
  expect(resolveStudioView("pipelines", empty)).toBe("pipelines");
});
