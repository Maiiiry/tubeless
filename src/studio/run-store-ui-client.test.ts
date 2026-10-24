import { expect, it } from "vitest";
import {
  activitySummary,
  pipelineFromHistory,
  scopeForRun,
  studioRunUrl,
} from "./run-store-ui-client.js";
import { parseStudioRoute } from "./run-store-ui-route.js";

it("builds stable run links without list scope, step, or tab", () => {
  const original = "http://127.0.0.1:4317/?view=runs&pipeline=p&run=old&step=s#details";
  const linked = studioRunUrl(original, "child/with spaces");
  expect(linked).toBe("http://127.0.0.1:4317/?view=runs&run=child%2Fwith+spaces#details");
  expect(parseStudioRoute(linked)).toEqual({ runId: "child/with spaces" });
});

it("summarizes activity without inventing a success rate", () => {
  const empty = { activeRunCount: 0, completedRunCount: 0, failedRunCount: 0, runCount: 0 };
  expect(activitySummary(empty)).toBe("0 running · 0 recorded runs");
  expect(
    activitySummary({ activeRunCount: 2, completedRunCount: 9, failedRunCount: 4, runCount: 1 })
  ).toBe("2 running · 1 recorded run · 69% succeeded");
});

it("keeps the list scope for listed runs and follows unlisted runs to their pipeline", () => {
  const listed = [{ runId: "a" }, { runId: "b" }];
  const known = [
    { runId: "b", pipelineId: "enrich" },
    { runId: "child", pipelineId: "read-page" },
  ];
  expect(scopeForRun("b", undefined, listed, known)).toBeUndefined();
  expect(scopeForRun("b", "import", listed, known)).toBe("import");
  expect(scopeForRun("child", undefined, listed, known)).toBe("read-page");
  expect(scopeForRun("missing", "import", listed, known)).toBeUndefined();
});

it("keeps pipelines past the sidebar limit reachable from recorded history", () => {
  const definition = {
    activeRuns: 0,
    firstSeenAtMs: 1,
    lastSeenAtMs: 1,
    pipelineId: "old",
    runCount: 1,
  };
  const empty = { definitions: [], matchingRootCount: 0 };
  expect(
    pipelineFromHistory("old", { definitions: [definition], matchingRootCount: 0 }, false, "")
  ).toEqual({
    pipelineId: "old",
    name: "old",
  });
  expect(pipelineFromHistory("old", { ...empty, matchingRootCount: 3 }, true, "")).toBeDefined();
  expect(pipelineFromHistory("old", { ...empty, matchingRootCount: 3 }, false, "")).toBeUndefined();
  expect(pipelineFromHistory("old", empty, true, "")).toBeUndefined();
  expect(pipelineFromHistory("old", empty, true, "search")).toBeDefined();
  expect(pipelineFromHistory("old", null, true, "")).toBeUndefined();
});
