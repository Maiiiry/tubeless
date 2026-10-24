import { renderToString } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { RUN_MODEL_VERSION } from "../core/pipeline.js";
import { createRunHistoryIndex, summarizeRun } from "../run-store/run-history.js";
import type { StoredPipelineRun } from "../run-store/run-store.js";
import type { StudioApi } from "./run-store-ui-client-transport.js";
import { StepInspector } from "./run-store-ui-inspector.js";
import { PipelinePage, plannedGraphDetail } from "./run-store-ui-pipeline.js";
import type { PipelineRunStudioCommand } from "./run-store-ui-protocol.js";
import { latestStatus, Rail, railPipelines } from "./run-store-ui-rail.js";
import { RunCrumbs, runLabel } from "./run-store-ui-runs.js";
import type { StudioPipelineSummary } from "./run-store-ui-schema.js";
import { StepRow } from "./run-store-ui-steps.js";
import { studioRunDetail } from "./run-store-ui.test-support.js";

const command = (id: string, name = id): PipelineRunStudioCommand => ({
  canPlan: true,
  id,
  name,
  parameters: [],
});

const summary = (
  pipelineId: string,
  overrides: Partial<StudioPipelineSummary> = {}
): StudioPipelineSummary => ({
  pipelineId,
  topLevelRunCount: 1,
  nestedRunCount: 0,
  runningCount: 0,
  latestStartedAtMs: 1,
  recent: [{ runId: `${pipelineId}-1`, status: "completed" }],
  ...overrides,
});

function run(overrides: Partial<StoredPipelineRun> = {}): StoredPipelineRun {
  return {
    dryRun: false,
    eventCount: 1,
    logCount: 0,
    logs: [],
    pipelineId: "import",
    runId: "run-1",
    startedAtMs: 1_000,
    status: "completed",
    steps: [],
    version: RUN_MODEL_VERSION,
    ...overrides,
  };
}

const unusedApi = {} as StudioApi;

describe("pipeline rail", () => {
  it("merges commands with recorded pipelines and separates nested-only pipelines", () => {
    const { pipelines, nested } = railPipelines(
      [command("publish", "Publish"), command("import", "Import rows")],
      [
        summary("import"),
        summary("legacy-job"),
        summary("read-page", { topLevelRunCount: 0, nestedRunCount: 2 }),
      ]
    );
    expect(
      pipelines.map((entry) => [entry.pipelineId, entry.name, Boolean(entry.summary)])
    ).toEqual([
      ["import", "Import rows", true],
      ["legacy-job", "legacy-job", true],
      ["publish", "Publish", false],
    ]);
    expect(nested.map((entry) => entry.pipelineId)).toEqual(["read-page"]);
  });

  it("shows the latest outcome, with any running run first", () => {
    expect(latestStatus(undefined)).toBe("idle");
    expect(latestStatus(summary("a", { recent: [{ runId: "1", status: "failed" }] }))).toBe(
      "failed"
    );
    expect(latestStatus(summary("a", { runningCount: 1 }))).toBe("running");
  });

  it("marks the open pipeline and reveals nested pipelines on demand", () => {
    const { pipelines, nested } = railPipelines(
      [command("import")],
      [summary("import"), summary("read-page", { topLevelRunCount: 0, nestedRunCount: 1 })]
    );
    const markup = renderToString(
      <Rail
        pipelines={pipelines}
        nested={nested}
        route={{ pipelineId: "import" }}
        runningCount={2}
        onNavigate={() => {}}
        footer={<span>footer</span>}
      />
    );
    expect(markup).toContain('class="rail-pipeline active" type="button" aria-current="page"');
    expect(markup).toContain("Nested pipelines · 1");
    expect(markup).not.toContain(">read-page</span>");
    expect(markup).toContain('<b class="nav-count running">2</b>');
    expect(markup).toContain("<span>footer</span>");
  });
});

describe("pipeline page", () => {
  it("draws declared steps as a planned graph", () => {
    const detail = plannedGraphDetail("import", [
      { id: "load", dependencies: [], optionalDependencies: [], skipAfterFailureOf: [] },
      {
        id: "save",
        dependencies: ["load"],
        optionalDependencies: [],
        skipAfterFailureOf: ["load"],
      },
    ]);
    expect(detail.run.steps.map((step) => [step.id, step.status, step.dependencies])).toEqual([
      ["load", "planned", []],
      ["save", "planned", ["load"]],
    ]);
  });

  it("offers Versions only when a definition was recorded", () => {
    const root = run();
    const index = createRunHistoryIndex([root]);
    const props = {
      api: unusedApi,
      pipeline: { pipelineId: "import", name: "Import rows", summary: summary("import") },
      onTab: () => {},
      runs: [summarizeRun(root, index)],
      matchingRunCount: 1,
      offset: 0,
      onPage: () => {},
      nowMs: 2_000,
      onOpenRun: () => {},
    };
    const plain = renderToString(<PipelinePage {...props} definitions={[]} />);
    expect(plain).toContain('aria-selected="true">Runs · 1</button>');
    expect(plain).not.toContain("Versions");
    expect(plain).toContain(runLabel({ startedAtMs: 1_000 }));
    const versioned = renderToString(
      <PipelinePage
        {...props}
        tab="versions"
        definitions={[
          { activeRuns: 0, firstSeenAtMs: 1, lastSeenAtMs: 1, pipelineId: "import", runCount: 1 },
        ]}
      />
    );
    expect(versioned).toContain('aria-selected="true">Versions · 1</button>');
  });
});

describe("run navigation", () => {
  it("names runs by time and the item or iteration they handled", () => {
    expect(runLabel({ startedAtMs: Number.NaN })).toBe("Run ");
    expect(runLabel({ startedAtMs: 0, itemKey: "row-3" })).toMatch(/· row-3$/);
    expect(runLabel({ startedAtMs: 0, iteration: 2 })).toMatch(/· #2$/);
  });

  it("walks the breadcrumb through each pipeline and starting step", () => {
    const parent = run({ runId: "parent", pipelineId: "paginated" });
    const child = run({
      runId: "child",
      pipelineId: "read-page",
      parentRunId: "parent",
      parentStepId: "pages",
      iteration: { runId: "parent", stepId: "pages", attemptId: "a", index: 2 },
    });
    const index = createRunHistoryIndex([parent, child]);
    const markup = renderToString(
      <RunCrumbs
        detail={{ ...studioRunDetail(child), ancestors: [summarizeRun(parent, index)] }}
        onOpenPipeline={() => {}}
        onOpenRun={() => {}}
        pipelineName={(id) => (id === "paginated" ? "Paginated rows" : id)}
      />
    );
    const text = markup.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");
    expect(text).toMatch(
      /^\|Paginated rows\|\/\|Run [^|]+\|\/\|pages\|\/\|read-page\|\/\|Run [^|]+ · #2\|$/
    );
    expect(markup).toContain('aria-current="page"');
  });

  it("selects a step from its title and shows its own logs and the run error", () => {
    const failed = run({
      status: "failed",
      error: {
        code: "TUBELESS_STEP_FAILED",
        kind: "step",
        message: "bad price",
        phase: "execution",
      },
      logs: [
        { id: 1, level: "warn", message: "price out of range", stepId: "check", timestampMs: 1 },
        { id: 2, level: "log", message: "other step", stepId: "load", timestampMs: 1 },
      ],
      steps: [
        { id: "load", status: "completed" },
        { id: "check", status: "failed", dependencies: ["load"] },
      ],
    });
    const row = renderToString(
      <StepRow step={failed.steps[1]!} steps={failed.steps} selected onSelect={() => {}} />
    );
    expect(row).toContain('class="step failed selectable selected"');
    expect(row).toContain(
      '<button class="step-title" type="button" aria-pressed="true">check</button>'
    );
    const drawer = renderToString(
      <StepInspector
        run={failed}
        step={failed.steps[1]!}
        childRuns={[]}
        childTotal={0}
        onOpenRun={() => {}}
        onSelectInput={() => {}}
        onSelectConsumer={() => {}}
      />
    );
    expect(drawer).toContain("bad price");
    expect(drawer).toContain("Logs (1)");
    expect(drawer).toContain("price out of range");
    expect(drawer).not.toContain("other step");
  });
});
