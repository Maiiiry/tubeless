import { renderToString } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { createSteps, definePipeline, RUN_MODEL_VERSION } from "../core/pipeline.js";
import { createRunHistoryIndex, summarizeRun } from "../run-store/run-history.js";
import {
  projectPipelineRun,
  type StoredPipelineEvent,
  type StoredPipelineRun,
  type StoredPipelineStep,
} from "../run-store/run-store.js";
import { pageDirectChildren } from "./run-store-ui-children.js";
import { expandedRunWatchKey, expandedRunsToLoad, RunGraph } from "./run-store-ui-graph.js";

function run(overrides: Partial<StoredPipelineRun> = {}): StoredPipelineRun {
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

function step(
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

/** Render the graph for `root` with its direct children attributed by the history index. */
function graph(root: StoredPipelineRun, children: readonly StoredPipelineRun[] = []) {
  const index = createRunHistoryIndex([root, ...children]);
  const summaries = index.childrenOf(root.runId).map((child) => summarizeRun(child, index));
  const window = pageDirectChildren(
    summaries,
    root.steps.map((step) => step.id),
    0
  );
  const markup = renderToString(
    <RunGraph
      detail={{
        run: root,
        ancestors: [],
        children: window.children,
        childCount: window.childCount,
        childSteps: window.childSteps,
        descendantCount: index.descendantCount(root.runId),
      }}
      onOpenRun={() => {}}
    />
  );
  const count = (needle: string) => markup.split(needle).length - 1;
  return { markup, count };
}

describe("RunGraph", () => {
  it("draws step states and edge states from planned dependencies", () => {
    const { markup } = graph(
      run({
        steps: [
          step("load", "completed"),
          step("transform", "running", { dependencies: ["load"] }),
          step("report", "planned", { dependencies: ["transform"] }),
          step("check", "failed"),
          step("alert", "skipped", { skipAfterFailureOf: ["check"] }),
          step("stop", "cancelled", { optionalDependencies: ["check"] }),
        ],
      })
    );
    for (const [id, status] of [
      ["load", "completed"],
      ["transform", "running"],
      ["report", "planned"],
      ["check", "failed"],
      ["alert", "skipped"],
      ["stop", "cancelled"],
    ]) {
      expect(markup).toContain(`aria-label="${id}: ${status}"`);
      expect(markup).toContain(`graph-node step ${status}`);
    }
    expect(markup).toContain('class="graph-edge-group input active"');
    expect(markup).toContain('class="graph-edge-group input candidate"');
    expect(markup).toContain('class="graph-edge-group gate tripped"');
    expect(markup).toContain('class="graph-edge-group optional blocked"');
    // Only an edge feeding a running step animates its flow.
    expect(markup.split('class="graph-edge-flow"').length - 1).toBe(1);
  });

  it("trips gates on cancellation and never animates a missing optional input", () => {
    const { markup, count } = graph(
      run({
        steps: [
          step("stopped", "cancelled"),
          step("broken", "failed"),
          step("gated", "skipped", { skipAfterFailureOf: ["stopped"] }),
          step("both", "skipped", { dependencies: ["broken"], skipAfterFailureOf: ["broken"] }),
          step("fallback", "running", { optionalDependencies: ["broken"] }),
        ],
      })
    );
    // A cancelled gate source and a failed source that is both input and gate trip the gate.
    expect(count('class="graph-edge-group gate tripped"')).toBe(2);
    expect(markup).toContain('class="graph-edge-group optional blocked"');
    expect(count('class="graph-edge-flow"')).toBe(0);
  });

  it("shows inputs as used by a step its own policy skipped", () => {
    const { markup } = graph(
      run({
        steps: [
          step("source", "completed"),
          step("policy", "skipped", { dependencies: ["source"], skipReason: "policy" }),
          step("dry", "skipped", { optionalDependencies: ["source"], skipReason: "dry-run" }),
        ],
      })
    );
    expect(markup).toContain('class="graph-edge-group input used"');
    expect(markup).toContain('class="graph-edge-group optional unused"');
  });

  it("says where undrawn items are and how many progress rows the trace dropped", () => {
    const call = {
      agentRunId: "agent",
      turn: 1,
      callId: "c0",
      tool: "search",
      parentAttemptId: "attempt",
    };
    const details = Array.from({ length: 20 }, (_, index) => ({
      id: `c${index}`,
      status: "completed" as const,
    }));
    const root = run({
      agentTurn: { agentRunId: "agent", index: 1, calls: [call] },
      steps: [
        step("calls", "running", {
          attempt: { attemptId: "attempt", retries: [], startedAtMs: 1_000, status: "running" },
          progress: { completed: 20, detailCount: 300, details },
        }),
      ],
    });
    const { markup, count } = graph(root, [
      run({ runId: "tool-run", parentRunId: "root", itemKey: "c0", agentCall: call }),
    ]);
    // One tool run and 15 of the 19 remaining recorded calls fill the 16 drawn slots.
    expect(count("graph-node run ") + count("graph-node item ")).toBe(16);
    expect(markup).toContain("+4 more in the timeline · 280 progress rows not recorded");
  });

  it("counts child runs the canvas does not draw", () => {
    const children = Array.from({ length: 20 }, (_, index) =>
      run({
        runId: `item-${index}`,
        parentRunId: "root",
        parentStepId: "fan",
        pipelineId: "child",
        startedAtMs: 2_000 + index,
      })
    );
    const { markup, count } = graph(run({ steps: [step("fan", "running")] }), children);
    expect(count("graph-node run ")).toBe(16);
    expect(markup).toContain("+4 more in the run list");
  });

  it("counts only recorded direct items when dropped rows may be nested", () => {
    const details = Array.from({ length: 10 }, (_, index) => ({ id: `row-${index}` }));
    // The 30 dropped rows could be nested under any recorded row, so none count as items.
    const { markup } = graph(
      run({
        status: "completed",
        steps: [
          step("batch", "completed", { progress: { completed: 10, detailCount: 40, details } }),
        ],
      })
    );
    expect(markup).toContain('aria-label="Expand batch"');
    expect(markup).toContain('<text dy="3">10</text>');
  });

  it("treats a policy skip's published output as consumed, unlike a filtered skip", async () => {
    const { step: define } = createSteps();
    const cached = define("cached", {
      skip: () => ({ reason: "already cached", value: "cached rows" }),
      run: () => "fresh rows",
    });
    const absent = define("absent", { run: () => "unused rows" });
    const report = define("report", {
      dependsOn: [cached],
      optionalDependsOn: [absent],
      run: ({ cached: rows }) => rows,
    });
    const pipeline = definePipeline({ id: "skips", steps: [cached, absent, report] });
    const events: StoredPipelineEvent[] = [];
    const exporter = {
      export: (event: object) =>
        void events.push({ ...event, id: events.length } as StoredPipelineEvent),
    };
    await pipeline.runOrThrow({}, { stepIds: ["cached", "report"] }, { tracing: { exporter } });

    const recorded = projectPipelineRun(events);
    expect(recorded.steps.map(({ id, status, skipReason }) => [id, status, skipReason])).toEqual([
      ["cached", "skipped", "policy"],
      ["absent", "skipped", "filtered"],
      ["report", "completed", undefined],
    ]);
    const { markup } = graph(recorded);
    expect(markup).toContain('class="graph-edge-group input used"');
    expect(markup).toContain('class="graph-edge-group optional unused"');
  });

  it("expands a running fan-out into its attributed child runs", () => {
    const root = run({
      steps: [
        step("fanout", "running", {
          nestedPipeline: {
            mode: "for-each",
            pipelineId: "child",
            stepCount: 1,
            stepIds: ["work"],
          },
        }),
        step("after", "planned", { dependencies: ["fanout"] }),
      ],
    });
    const child = (itemKey: string, status: StoredPipelineRun["status"]) =>
      run({ runId: `child-${itemKey}`, parentRunId: "root", pipelineId: "child", itemKey, status });
    const { markup, count } = graph(root, [
      child("first", "completed"),
      child("second", "running"),
    ]);
    expect(markup).toContain('class="graph-expansion"');
    expect(count("graph-node run ")).toBe(2);
    expect(markup).toContain('aria-label="first (child): completed"');
    expect(markup).toContain('aria-label="second (child): running"');
    expect(markup).toContain('aria-label="Collapse fanout"');
  });

  it("keeps finished fan-outs collapsed behind a count badge", () => {
    const root = run({
      status: "completed",
      steps: [
        step("fanout", "completed", {
          nestedPipeline: {
            mode: "for-each",
            pipelineId: "child",
            stepCount: 1,
            stepIds: ["work"],
          },
        }),
      ],
    });
    const { markup } = graph(root, [
      run({
        runId: "child-a",
        parentRunId: "root",
        pipelineId: "child",
        itemKey: "a",
        status: "completed",
      }),
    ]);
    expect(markup).not.toContain('class="graph-expansion"');
    expect(markup).toContain('aria-label="Expand fanout"');
  });

  it("labels dynamic agent tool calls by tool without duplicating calls that started runs", () => {
    const root = run({
      pipelineId: "agent/turn",
      agentTurn: {
        agentRunId: "agent",
        index: 1,
        calls: [
          {
            agentRunId: "agent",
            turn: 1,
            callId: "c1",
            tool: "search",
            parentAttemptId: "attempt",
          },
          {
            agentRunId: "agent",
            turn: 1,
            callId: "c3",
            tool: "summarize",
            parentAttemptId: "attempt",
          },
        ],
      },
      steps: [
        step("decide", "completed"),
        step("calls", "running", {
          dependencies: ["decide"],
          attempt: { attemptId: "attempt", retries: [], startedAtMs: 1_000, status: "running" },
          progress: {
            completed: 1,
            total: 3,
            details: [
              { id: "c1", status: "completed" },
              { id: "c2", status: "failed" },
              { id: "c3", status: "running" },
            ],
          },
        }),
      ],
    });
    const { markup, count } = graph(root, [
      run({
        runId: "tool-run",
        parentRunId: "root",
        pipelineId: "agent/tool/summarize",
        itemKey: "c3",
        agentCall: {
          agentRunId: "agent",
          turn: 1,
          callId: "c3",
          tool: "summarize",
          parentAttemptId: "attempt",
        },
      }),
    ]);
    expect(markup).toContain('aria-label="search: completed"');
    expect(markup).toContain('aria-label="c2: failed"');
    expect(markup).toContain('aria-label="summarize (agent/tool/summarize): running"');
    expect(count("graph-node item ")).toBe(2);
    expect(count("graph-node run ")).toBe(1);
  });
});

describe("expanded run detail refresh", () => {
  const child = (
    eventCount: number,
    subtreeEventCount = eventCount,
    status: StoredPipelineRun["status"] = "running"
  ) => expandedRunWatchKey({ eventCount, runId: "child", status, subtreeEventCount });

  it("loads an expanded child until that child's fingerprint is recorded", () => {
    const key = child(2, 4);
    const loaded = new Map<string, string>();
    expect(expandedRunsToLoad([key], loaded)).toEqual([{ key, runId: "child" }]);
    loaded.set("child", key);
    expect(expandedRunsToLoad([key], loaded)).toEqual([]);
    expect(expandedRunsToLoad([child(3, 4)], loaded)).toEqual([
      { key: child(3, 4), runId: "child" },
    ]);
    expect(expandedRunsToLoad([child(2, 5)], loaded)).toEqual([
      { key: child(2, 5), runId: "child" },
    ]);
    expect(expandedRunsToLoad([child(2, 4, "completed")], loaded)).toEqual([
      { key: child(2, 4, "completed"), runId: "child" },
    ]);
  });

  it("retries a failed child without reloading a sibling that already loaded", () => {
    const sibling = expandedRunWatchKey({
      eventCount: 1,
      runId: "sibling",
      status: "completed",
      subtreeEventCount: 1,
    });
    const key = child(2);
    const loaded = new Map<string, string>([["sibling", sibling]]);
    expect(expandedRunsToLoad([sibling, key], loaded)).toEqual([{ key, runId: "child" }]);
    expect(expandedRunsToLoad([], loaded)).toEqual([]);
  });
});
