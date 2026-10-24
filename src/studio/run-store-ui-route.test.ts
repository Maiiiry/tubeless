import { describe, expect, it } from "vitest";
import {
  parseStudioRoute,
  sameStudioRoute,
  studioPage,
  studioRouteUrl,
} from "./run-store-ui-route.js";

const base = "https://example.test/admin/pipelines/";

describe("Studio routes", () => {
  it.each([
    ["", {}, "activity"],
    ["?pipeline=import", { pipelineId: "import" }, "pipeline"],
    ["?pipeline=import&tab=graph", { pipelineId: "import", tab: "graph" }, "pipeline"],
    ["?run=r1", { runId: "r1" }, "run"],
    ["?pipeline=import&run=r1&step=s", { pipelineId: "import", runId: "r1", stepId: "s" }, "run"],
  ] as const)("reads %j", (search, route, page) => {
    expect(parseStudioRoute(base + search)).toEqual(route);
    expect(studioPage(route)).toBe(page);
  });

  it("drops parameters that do not apply to the page", () => {
    expect(parseStudioRoute(base + "?step=s&tab=graph")).toEqual({});
    expect(parseStudioRoute(base + "?run=r1&tab=versions")).toEqual({ runId: "r1" });
    expect(parseStudioRoute(base + "?pipeline=p&tab=other")).toEqual({ pipelineId: "p" });
    expect(parseStudioRoute(base + "?pipeline=&run=")).toEqual({});
  });

  it("writes only route parameters and keeps the mount and unrelated parameters", () => {
    const href = studioRouteUrl(base + "?run=old&step=x&keep=1", {
      pipelineId: "a b",
      runId: "r/1",
      stepId: "s",
    });
    expect(href).toBe(base + "?keep=1&pipeline=a+b&run=r%2F1&step=s");
    expect(parseStudioRoute(href)).toEqual({ pipelineId: "a b", runId: "r/1", stepId: "s" });
    expect(studioRouteUrl(base + "?pipeline=p&tab=graph", {})).toBe(base);
    expect(studioRouteUrl(base, { stepId: "s", tab: "graph" })).toBe(base);
  });

  it("compares routes by every field", () => {
    expect(sameStudioRoute({ runId: "r" }, { runId: "r" })).toBe(true);
    expect(sameStudioRoute({ runId: "r" }, { runId: "r", stepId: "s" })).toBe(false);
  });
});
