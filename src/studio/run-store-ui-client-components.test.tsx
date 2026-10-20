import { createRunHistoryIndex, summarizeRun } from "../run-store/run-history.js";
import { pageDirectChildren } from "./run-store-ui-children.js";
import { studioRunDetail } from "./run-store-ui.test-support.js";
import { StepArtifacts } from "./run-store-ui-artifacts.js";
import { renderToString } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { RUN_MODEL_VERSION, type PipelinePlan } from "../core/pipeline.js";
import type { StoredPipelineRun } from "../run-store/run-store.js";
import { StudioAccessNotice } from "./run-store-ui-client.js";
import { CommandFields } from "./run-store-ui-launch.js";
import { preferredScrollBehavior } from "./run-store-ui-common.js";
import { PipelinesView, PlanView } from "./run-store-ui-pipelines.js";
import type { StudioApi } from "./run-store-ui-client-transport.js";
import { isoTime, RunsView, runOutcome } from "./run-store-ui-runs.js";
import { Status, skipExplanation } from "./run-store-ui-steps.js";
import type { PipelineRunStudioCommand } from "./run-store-ui-protocol.js";

const command: PipelineRunStudioCommand = {
  canPlan: true,
  description: "A <checked> pipeline",
  id: "fixture",
  name: "Fixture",
  parameters: [
    {
      description: 'A "name"',
      flag: "--name",
      key: "displayName",
      multiple: false,
      positional: false,
      required: true,
      type: "string",
    },
  ],
};

function run(overrides: Partial<StoredPipelineRun> = {}): StoredPipelineRun {
  return {
    dryRun: false,
    eventCount: 1,
    logCount: 0,
    logs: [],
    pipelineId: "fixture",
    runId: "run-1",
    startedAtMs: 1_000,
    status: "running",
    steps: [],
    version: RUN_MODEL_VERSION,
    ...overrides,
  };
}

describe("Studio components", () => {
  it("renders form controls from descriptors", () => {
    const markup = renderToString(
      <CommandFields command={command} values={[[""]]} onChange={() => {}} />
    );
    expect(markup).toContain("Display Name");
    expect(markup).toContain("A &quot;name&quot;");
    expect(markup).toContain("required");
  });

  it("escapes command data in the catalog", () => {
    const markup = renderToString(<PipelinesView commands={[command]} onConfigure={() => {}} />);
    expect(markup).toContain("A &lt;checked> pipeline");
    expect(markup).not.toContain("<checked>");
  });

  it("shows artifact lineage and escapes metadata without making URIs executable", () => {
    const root = run({
      steps: [
        {
          id: "save",
          status: "completed",
          artifacts: [
            {
              operation: "reuse",
              preview: true,
              attemptId: "attempt",
              timestampMs: 1,
              artifact: {
                id: "<model>",
                uri: "javascript:alert(1)",
                version: "v2",
                metadata: { tag: "<script>" },
              },
            },
          ],
        },
      ],
    });
    const index = createRunHistoryIndex([root]);
    const markup = renderToString(
      <RunsView
        canCancel={false}
        cancelling={false}
        liveRunIds={[]}
        nowMs={2000}
        onCancel={() => {}}
        onCopyLink={() => {}}
        onSelect={() => {}}
        roots={index.roots.map((run) => summarizeRun(run, index))}
        selection={{
          status: "ready",
          runId: root.runId,
          summary: summarizeRun(root, index),
          detail: studioRunDetail(root),
        }}
        latestRunId={root.runId}
        totalRunCount={1}
      />
    );
    expect(markup).toContain("Preview reuse: &lt;model>");
    expect(markup).toContain("v2");
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain('href="javascript:');
  });

  it("renders run hierarchy from explicit data only", () => {
    const root = run();
    const index = createRunHistoryIndex([root]);
    const markup = renderToString(
      <RunsView
        canCancel
        cancelling={false}
        liveRunIds={[root.runId]}
        nowMs={2_000}
        onCancel={() => {}}
        onCopyLink={() => {}}
        onSelect={() => {}}
        roots={index.roots.map((run) => summarizeRun(run, index))}
        selection={{
          status: "ready",
          runId: root.runId,
          summary: summarizeRun(root, index),
          detail: studioRunDetail(root),
        }}
        latestRunId={root.runId}
        totalRunCount={1}
      />
    );
    expect(markup).toContain("Pipeline runs");
    expect(markup).toContain("Cancel run");
    expect(markup).toContain('title="Copy run link"');
    expect(markup).toContain('aria-label="Copy run link"');
    expect(markup).not.toContain(">Copy run link</button>");
    expect(markup).toContain("1s ago");
  });

  it("lists the first page of direct children and offers the rest", () => {
    const root = run({
      runId: "root",
      steps: [
        {
          id: "fan",
          status: "running",
          dependencies: [],
          optionalDependencies: [],
          skipAfterFailureOf: [],
        },
      ],
    });
    const children = Array.from({ length: 20 }, (_, index) =>
      run({
        runId: `child-${index}`,
        parentRunId: "root",
        parentStepId: "fan",
        pipelineId: `child-${index}`,
        startedAtMs: 2_000 + index,
      })
    );
    const index = createRunHistoryIndex([root, ...children]);
    const summaries = index.childrenOf(root.runId).map((child) => summarizeRun(child, index));
    const window = pageDirectChildren(summaries, ["fan"], 0);
    const markup = renderToString(
      <RunsView
        api={
          {
            loadChildRuns: async () => ({ children: [], page: 1, childCount: 20 }),
          } as unknown as StudioApi
        }
        canCancel={false}
        cancelling={false}
        liveRunIds={[]}
        nowMs={3_000}
        onCancel={() => {}}
        onCopyLink={() => {}}
        onSelect={() => {}}
        roots={index.roots.map((entry) => summarizeRun(entry, index))}
        selection={{
          status: "ready",
          runId: root.runId,
          summary: summarizeRun(root, index),
          detail: {
            ...studioRunDetail(root),
            children: window.children,
            childCount: window.childCount,
            childSteps: window.childSteps,
            descendantCount: 20,
          },
        }}
        latestRunId={root.runId}
        totalRunCount={21}
      />
    );
    expect(markup.match(/class="nested-run"/g)).toHaveLength(16);
    expect(markup).toContain("20 direct");
    expect(markup).toContain("child-0");
    expect(markup).not.toContain("child-19");
    expect(markup).toContain("Show more");
  });

  it("distinguishes a missing linked run from a run whose details are loading", () => {
    const root = run();
    const index = createRunHistoryIndex([root]);
    const props = {
      canCancel: false,
      cancelling: false,
      liveRunIds: [],
      nowMs: 2_000,
      onCancel: () => {},
      onCopyLink: () => {},
      onSelect: () => {},
      roots: index.roots.map((run) => summarizeRun(run, index)),
      latestRunId: root.runId,
      totalRunCount: 1,
    };
    const missing = renderToString(
      <RunsView {...props} selection={{ status: "unavailable", runId: "deleted-run" }} />
    );
    expect(missing).toContain("Run unavailable");
    expect(missing).toContain("deleted-run");
    expect(missing).toContain("Select latest run");
    const loading = renderToString(
      <RunsView
        {...props}
        selection={{ status: "loading", runId: root.runId, summary: summarizeRun(root, index) }}
      />
    );
    expect(loading).toContain("Loading run");
    expect(loading).not.toContain("Run unavailable");
  });

  it.each([0, 1, 3, 5])("summarizes %s running steps without completed names", (count) => {
    const root = run({
      steps: [
        { id: "done", name: "Completed task", status: "completed" },
        ...Array.from({ length: count }, (_, index) => ({
          id: `step-${index}`,
          name: index === 1 ? undefined : `Task ${index}`,
          status: "running" as const,
          progress: { completed: 1, message: "Loading records" },
        })),
      ],
    });
    const index = createRunHistoryIndex([root]);
    const markup = renderToString(
      <RunsView
        canCancel={false}
        cancelling={false}
        liveRunIds={[root.runId]}
        nowMs={2_000}
        onCancel={() => {}}
        onCopyLink={() => {}}
        onSelect={() => {}}
        roots={index.roots.map((run) => summarizeRun(run, index))}
        selection={{ status: "none" }}
        latestRunId={root.runId}
        totalRunCount={1}
      />
    );
    expect(markup).not.toContain("Completed task");
    if (count > 1) {
      expect(markup).toContain(`${count} steps running`);
      expect(markup).toContain(`Task 0, step-1, Task 2${count > 3 ? " +2 more" : ""}`);
      expect(markup).not.toContain("Task 3");
      expect(markup).not.toContain("Loading records");
    } else {
      expect(markup).toContain(count === 1 ? "Task 0" : "Starting");
      expect(markup).toContain(count === 1 ? "Loading records" : "Execution in progress");
    }
  });

  it("renders plan data without controller state", () => {
    const plan: PipelinePlan = {
      dryRun: true,
      errors: [],
      ok: true,
      pipelineId: "fixture",
      steps: [
        {
          dependencies: [],
          dryRun: "run",
          id: "load",
          optionalDependencies: [],
          runtimeSkipPossible: false,
          selected: true,
          selectionReasons: [{ kind: "exact" }],
          skipAfterFailureOf: [],
        },
      ],
    };
    const markup = renderToString(<PlanView plan={plan} />);
    expect(markup).toContain("1 of 1 steps planned to run · dry run");
    expect(markup).toContain("Exact steps");
    expect(markup).toContain("Explicitly listed in the exact step selection.");
    expect(markup).toContain("<strong>Required inputs</strong><span>No required inputs.</span>");
  });

  it("explains target closure, shared prerequisites, and optional omissions", () => {
    const plan: PipelinePlan = {
      dryRun: false,
      errors: [],
      ok: true,
      pipelineId: "publish",
      steps: [
        {
          dependencies: [],
          dryRun: "run",
          id: "source",
          optionalDependencies: [],
          runtimeSkipPossible: false,
          selected: true,
          selectionReasons: [
            { kind: "required-dependency", dependentId: "publish", targetId: "publish" },
            { kind: "required-dependency", dependentId: "validate", targetId: "publish" },
          ],
          skipAfterFailureOf: [],
        },
        {
          dependencies: [],
          dryRun: "run",
          id: "optional",
          optionalDependencies: [],
          runtimeSkipPossible: false,
          selected: false,
          selectionReasons: [
            { kind: "optional-only", dependentId: "publish", targetId: "publish" },
          ],
          skipAfterFailureOf: [],
          skipReason: "filtered",
        },
        {
          dependencies: ["source"],
          dryRun: "run",
          id: "validate",
          optionalDependencies: [],
          runtimeSkipPossible: false,
          selected: true,
          selectionReasons: [{ kind: "failure-gate", dependentId: "publish", targetId: "publish" }],
          skipAfterFailureOf: [],
        },
        {
          dependencies: ["source"],
          dryRun: "run",
          id: "publish",
          optionalDependencies: ["optional"],
          runtimeSkipPossible: false,
          selected: true,
          selectionReasons: [{ kind: "target", targetId: "publish" }],
          skipAfterFailureOf: ["validate"],
        },
        {
          dependencies: [],
          dryRun: "run",
          id: "unrelated",
          optionalDependencies: [],
          runtimeSkipPossible: false,
          selected: false,
          selectionReasons: [{ kind: "outside-target-closure" }],
          skipAfterFailureOf: [],
          skipReason: "filtered",
        },
      ],
    };
    const markup = renderToString(<PlanView plan={plan} />);
    expect(markup).toContain("Targets with prerequisites");
    expect(markup).toContain("Required input for “publish” on the path to target “publish”.");
    expect(markup).toContain("Required input for “validate” on the path to target “publish”.");
    expect(markup).toContain("Failure gate for “publish” on the path to target “publish”.");
    expect(markup).toContain(
      "Optional input for “publish” on the path to target “publish”; this link does not select it."
    );
    expect(markup).toContain("Outside the selected targets and their prerequisite paths.");
    expect(markup).toContain("<code>optional</code> (not selected)");
    expect(markup).toContain("failure or cancellation skips this step");
  });

  it("shows that exact selection can leave required inputs unavailable", () => {
    const plan: PipelinePlan = {
      dryRun: true,
      errors: [],
      ok: true,
      pipelineId: "exact",
      steps: [
        {
          dependencies: [],
          dryRun: "run",
          id: "source",
          optionalDependencies: [],
          runtimeSkipPossible: false,
          selected: false,
          selectionReasons: [{ kind: "not-selected" }],
          skipAfterFailureOf: [],
          skipReason: "filtered",
        },
        {
          dependencies: ["source"],
          dryRun: "run",
          id: "publish",
          optionalDependencies: [],
          runtimeSkipPossible: false,
          selected: true,
          selectionReasons: [{ kind: "exact" }],
          skipAfterFailureOf: [],
          skipReason: "unmet-dependency",
        },
      ],
    };
    const markup = renderToString(<PlanView plan={plan} />);
    expect(markup).toContain("Exact steps");
    expect(markup).toContain("Required inputs and failure gates are not added automatically");
    expect(markup).toContain("<code>source</code> (not selected)");
    expect(markup).toContain("A required input is unavailable in this selection or dry run.");
    expect(markup).toContain("0 of 2 steps planned to run · dry run");
  });

  it("escapes status labels and rejects invalid dates", () => {
    const markup = renderToString(<Status value={'failed"><script>'} />);
    expect(markup).toContain("&lt;script>");
    expect(markup).not.toContain("<script>");
    expect(isoTime(Number.POSITIVE_INFINITY)).toBe("");
  });
});

it.each(["completed", "failed", "cancelled"])("renders %s with override provenance", (status) => {
  const markup = renderToString(<Status value={status} outputSource="override" />);
  expect(markup).toContain(`${status} (overridden)`);
  expect(markup).toContain(`status ${status}`);
});

it.each(["completed", "failed", "cancelled"])("renders %s with cache provenance", (status) => {
  const markup = renderToString(<Status value={status} outputSource="cache" />);
  expect(markup).toContain("(cached)");
});

it("distinguishes cached outputs from application artifacts and offers filters", () => {
  const markup = renderToString(
    <StepArtifacts
      stepId="count"
      artifacts={[
        {
          operation: "reuse",
          preview: false,
          timestampMs: 2000,
          attemptId: "cache",
          artifact: {
            id: "cache-id",
            uri: "file:///tmp/count.cache",
            byteSize: 42,
            metadata: {
              tubelessCache: { implementationVersion: "v1", createdAtMs: 1000, ageMs: 1000 },
            },
          },
        },
        {
          operation: "write",
          preview: false,
          timestampMs: 2000,
          attemptId: "app",
          artifact: { id: "application" },
        },
      ]}
    />
  );
  expect(markup).toContain("Cached output reuse");
  expect(markup).toContain("Created: 1970-01-01T00:00:01.000Z");
  expect(markup).toContain("Age at reuse: 1000 ms");
  expect(markup).toContain("Location: file:///tmp/count.cache");
  expect(markup).toContain("Size: 42 bytes");
  expect(markup).toContain("Application artifacts");
  expect(markup).toContain("Artifact write: application");
  expect(markup).toContain("current cache availability is not checked");
});

it.each([401, 403] as const)(
  "renders an accessible %s notice with a full-page mounted return link",
  (status) => {
    const html = renderToString(
      <StudioAccessNotice
        status={status}
        href="https://example.test/admin/pipelines/?run=selected"
      />
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain(status === 401 ? "Sign in to continue" : "Access denied");
    expect(html).toContain('href="https://example.test/admin/pipelines/?run=selected"');
    expect(html).not.toContain("<button");
  }
);

describe("run detail hierarchy", () => {
  const failedRun = run({
    status: "failed",
    durationMs: 4,
    error: {
      code: "TUBELESS_STEP_FAILED",
      kind: "step",
      message: "valid-prices: expected values between 0 and 10000",
      phase: "execution",
    },
    definitionIdentity: {
      definitionId: "sha256:" + "a".repeat(64),
      implementationVersion: "v7",
      structuralFingerprint: "sha256:" + "b".repeat(64),
      version: 1,
    },
    steps: [
      { id: "prices", status: "completed" },
      {
        id: "valid-prices",
        status: "failed",
        dependencies: ["prices"],
        attempt: {
          attemptId: "attempt-valid-prices",
          retries: [2],
          startedAtMs: 1_000,
          status: "failed",
        },
      },
      {
        id: "summarize",
        status: "skipped",
        dependencies: ["valid-prices"],
        skipReason: "unmet-dependency",
      },
      {
        id: "publish",
        status: "skipped",
        skipAfterFailureOf: ["valid-prices"],
        skipReason: "failed-dependency",
      },
    ],
  });

  function renderDetail(target: StoredPipelineRun) {
    const index = createRunHistoryIndex([target]);
    return renderToString(
      <RunsView
        canCancel={false}
        cancelling={false}
        liveRunIds={[]}
        nowMs={2_000}
        onCancel={() => {}}
        onCopyLink={() => {}}
        onSelect={() => {}}
        roots={index.roots.map((entry) => summarizeRun(entry, index))}
        selection={{
          status: "ready",
          runId: target.runId,
          summary: summarizeRun(target, index),
          detail: studioRunDetail(target),
        }}
        totalRunCount={1}
      />
    );
  }

  it("leads with the outcome and links diagnostics to the failed step", () => {
    const markup = renderDetail(failedRun);
    expect(markup).toContain("Failed at valid-prices · 2 skipped");
    expect(markup).toMatch(/Failed at<\/span><button type="button">valid-prices<\/button>/);
    const order = ["Error diagnostics", "Step timeline", "run-definition"].map((marker) =>
      markup.indexOf(marker)
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((position) => position >= 0)).toBe(true);
  });

  it("explains skips and keeps execution identifiers out of step rows", () => {
    const markup = renderDetail(failedRun);
    expect(markup).toContain("Skipped because required input “valid-prices” was failed.");
    expect(markup).toContain("Skipped because failure gate “valid-prices” failed.");
    expect(markup).toContain("1 retry");
    expect(markup).toContain('title="attempt-valid-prices"');
    expect(markup).not.toContain(">attempt-valid-prices<");
    expect(markup).not.toContain("Observed definitions");
  });

  it("folds definition identity into a disclosure", () => {
    const markup = renderDetail(failedRun);
    expect(markup).toContain('<details class="run-definition">');
    expect(markup).toContain("<code>aaaaaaaaaaaa</code> · implementation v7");
    expect(markup).toContain("sha256:" + "b".repeat(64));
  });

  it.each([
    [
      run({ status: "completed", durationMs: 1_500, steps: [{ id: "a", status: "completed" }] }),
      "Completed 1 step in 1.5 s",
    ],
    [
      run({
        status: "running",
        steps: [
          { id: "a", status: "completed" },
          { id: "b", status: "running" },
          { id: "c", status: "planned" },
        ],
      }),
      "Running · 1 of 3 steps finished",
    ],
    [
      run({
        status: "cancelled",
        steps: [
          { id: "a", status: "completed" },
          { id: "b", status: "cancelled" },
        ],
      }),
      "Cancelled after 1 of 2 steps",
    ],
    [
      run({
        status: "failed",
        error: {
          code: "TUBELESS_STEP_FAILED",
          kind: "validation",
          message: "bad input",
          phase: "planning",
        },
      }),
      "Failed: bad input",
    ],
  ] as const)("summarizes %#", (target, expected) => {
    expect(runOutcome(target)).toBe(expected);
  });

  it("names skips that no recorded input explains generically", () => {
    expect(
      skipExplanation({ id: "x", status: "skipped", skipReason: "failed-dependency" }, [])
    ).toBe("Skipped because a failure gate failed or was cancelled.");
    expect(skipExplanation({ id: "x", status: "skipped", skipReason: "fail-fast" }, [])).toBe(
      "Not started: the run stopped after an earlier failure."
    );
    expect(skipExplanation({ id: "x", status: "completed" }, [])).toBeUndefined();
  });

  it("folds execution controls behind a disclosure", () => {
    const markup = renderToString(
      <CommandFields
        command={{
          ...command,
          parameters: [
            ...command.parameters,
            {
              flag: "--dry-run",
              group: "execution",
              key: "dryRun",
              multiple: false,
              positional: false,
              required: false,
              type: "boolean",
            },
          ],
        }}
        values={[[""], [false]]}
        onChange={() => {}}
      />
    );
    expect(markup).toContain('<details class="form-section execution-controls">');
    expect(markup.indexOf("Pipeline inputs")).toBeLessThan(markup.indexOf("Execution controls"));
  });
});

it("scrolls instantly when the user prefers reduced motion", () => {
  expect(preferredScrollBehavior(() => ({ matches: true }))).toBe("auto");
  expect(preferredScrollBehavior(() => ({ matches: false }))).toBe("smooth");
  expect(preferredScrollBehavior(undefined)).toBe("smooth");
});
