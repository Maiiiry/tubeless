import { expect, it } from "vitest";
import { activitySummary, studioRunUrl } from "./run-store-ui-client.js";
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
