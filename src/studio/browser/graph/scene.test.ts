import { describe, expect, it } from "vitest";
import { createRunHistoryIndex, summarizeRun } from "../../../run-store/run-history.js";
import type { StoredPipelineRun } from "../../../run-store/run-store.js";
import type { StudioRunDetail } from "../../shared/schema.js";
import { pageDirectChildren } from "../../server/children.js";
import { run, step } from "./graph.test-support.js";
import { buildGraphScene, type RunLoad } from "./scene.js";

function details(runs: readonly StoredPipelineRun[]): StudioRunDetail[] {
  const index = createRunHistoryIndex(runs);
  return runs.map((run) => {
    const page = pageDirectChildren(
      index.childrenOf(run.runId).map((child) => summarizeRun(child, index)),
      run.steps.map((step) => step.id),
      0
    );
    return { run, ancestors: [], descendantCount: index.descendantCount(run.runId), ...page };
  });
}

function nestedRuns(status: "running" | "completed" = "running", count = 2) {
  return Array.from({ length: count }, (_, index) =>
    run({
      runId: `run-${index}`,
      pipelineId: "nested",
      parentRunId: index > 0 ? `run-${index - 1}` : undefined,
      status,
      steps: [
        step("child", status, {
          nestedPipeline: {
            mode: "single",
            pipelineId: "nested",
            stepCount: 1,
            stepIds: ["child"],
          },
        }),
      ],
    })
  );
}

const options = () => ({
  opened: new Set<string>(),
  loads: new Map<string, RunLoad>(),
  toggles: new Map<string, boolean>(),
  canLoad: true,
});

describe("graph scenes", () => {
  it("builds nested geometry and inspection indexes without mutating the previous expansion state", () => {
    const [root, child] = details(nestedRuns());
    const inputs = options();
    inputs.loads.set(child.run.runId, child);
    const before = structuredClone({ root, child });
    const graph = buildGraphScene(root, inputs);

    expect([...graph.wanted]).toEqual(["run-1"]);
    expect([...graph.runs.keys()]).toEqual(["run-0", "run-1"]);
    expect(graph.summaries.get("run-1")?.parentRunId).toBe("run-0");
    expect(graph.scene.steps[0].expansion?.items[0]).toMatchObject({
      kind: "run",
      expanded: true,
      graph: { run: { runId: "run-1" } },
    });
    expect(graph.opened.has("run-0/child")).toBe(true);
    expect(inputs.opened.size).toBe(0);
    expect({ root, child }).toEqual(before);
    expect(inputs.loads.get("run-1")).toBe(child);
  });

  it("retains automatic expansion after completion and respects explicit collapse without changing old scenes", () => {
    const [running] = details(nestedRuns());
    const first = buildGraphScene(running, options());
    const [completed] = details(nestedRuns("completed"));
    const next = { ...options(), opened: first.opened };
    const retained = buildGraphScene(completed, next);
    expect([...retained.wanted]).toEqual(["run-1"]);

    next.toggles.set("run-0/child", false);
    const collapsed = buildGraphScene(completed, next);
    expect(collapsed.scene.steps[0].expanded).toBe(false);
    expect(collapsed.wanted.size).toBe(0);
    expect([...first.wanted]).toEqual(["run-1"]);
    expect([...retained.wanted]).toEqual(["run-1"]);
    expect(first.scene.steps[0].expanded).toBe(true);
  });

  it("distinguishes unavailable child detail from a graph without loading capability", () => {
    const [root] = details(nestedRuns());
    const inputs = options();
    inputs.loads.set("run-1", "missing");
    const missing = buildGraphScene(root, inputs);
    expect(missing.scene.steps[0].expansion?.items[0]).toMatchObject({
      kind: "run",
      expanded: true,
      unavailable: true,
      graph: undefined,
    });
    expect(missing.runs.has("run-1")).toBe(false);

    const readOnly = buildGraphScene(root, { ...inputs, canLoad: false });
    expect(readOnly.scene.steps[0].expansion?.items[0]).toMatchObject({
      kind: "run",
      expandable: false,
      expanded: false,
    });
    expect(readOnly.wanted.size).toBe(0);
  });

  it("bounds nested scene construction and requests detail only for drawable runs", () => {
    const all = details(nestedRuns("running", 9));
    const inputs = options();
    for (const detail of all.slice(1)) inputs.loads.set(detail.run.runId, detail);
    const graph = buildGraphScene(all[0], inputs);
    expect([...graph.wanted]).toEqual(["run-1", "run-2", "run-3", "run-4", "run-5"]);
    expect(graph.runs.has("run-5")).toBe(true);
    expect(graph.summaries.has("run-6")).toBe(true);
    expect(graph.expandable.has("run-6")).toBe(false);
    expect(graph.runs.has("run-6")).toBe(false);
  });
});
