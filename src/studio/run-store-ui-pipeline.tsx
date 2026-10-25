import { useCallback } from "preact/hooks";
import type { RUN_MODEL_VERSION } from "../core/pipeline-ids.js";
import type { StoredDefinitionSummary, StoredRunSummary } from "../run-store/run-history.js";
import type { StoredPipelineStep } from "../run-store/run-store.js";
import type { StudioApi } from "./run-store-ui-client-transport.js";
import { EmptyView } from "./run-store-ui-common.js";
import { DefinitionHistory } from "./run-store-ui-definitions.js";
import { RunGraph } from "./run-store-ui-graph.js";
import type { RailPipeline } from "./run-store-ui-rail.js";
import { useStudioResource } from "./run-store-ui-resource.js";
import type { StudioPipelineTab } from "./run-store-ui-route.js";
import { RunList } from "./run-store-ui-runs.js";
import type { StudioRunDetail } from "./run-store-ui-schema.js";

/** Planned structure shared by recorded definitions and plan previews. */
type PlannedStep = Pick<
  StoredPipelineStep,
  | "dependencies"
  | "description"
  | "id"
  | "name"
  | "nestedPipeline"
  | "optionalDependencies"
  | "remote"
  | "skipAfterFailureOf"
>;

// Studio imports only core types; a version change fails type checking here.
const PLANNED_RUN_VERSION: typeof RUN_MODEL_VERSION = 2;

/** A run-shaped view of a pipeline's declared steps, all planned, for the graph. */
export function plannedGraphDetail(
  pipelineId: string,
  steps: readonly PlannedStep[]
): StudioRunDetail {
  return {
    run: {
      dryRun: false,
      eventCount: 0,
      logCount: 0,
      logs: [],
      pipelineId,
      runId: `definition:${pipelineId}`,
      startedAtMs: 0,
      status: "completed",
      steps: steps.map((step) => ({
        id: step.id,
        name: step.name,
        description: step.description,
        dependencies: [...(step.dependencies ?? [])],
        optionalDependencies: [...(step.optionalDependencies ?? [])],
        skipAfterFailureOf: [...(step.skipAfterFailureOf ?? [])],
        nestedPipeline: step.nestedPipeline,
        remote: step.remote,
        status: "planned",
      })),
      version: PLANNED_RUN_VERSION,
    },
    ancestors: [],
    children: [],
    childCount: 0,
    childSteps: [],
    descendantCount: 0,
  };
}

/** The latest recorded definition, or the current plan for a command that never ran. */
function PipelineGraph({
  api,
  pipeline,
  definitions,
}: {
  api: StudioApi;
  pipeline: RailPipeline;
  definitions: readonly StoredDefinitionSummary[];
}) {
  const latest = [...definitions].sort((left, right) => right.lastSeenAtMs - left.lastSeenAtMs)[0];
  const hasDefinition = latest !== undefined;
  const definitionId = latest?.identity?.definitionId;
  const planCommandId = pipeline.command?.canPlan ? pipeline.command.id : undefined;
  const { pipelineId } = pipeline;
  const key = hasDefinition
    ? `definition:${definitionId ?? "legacy"}`
    : planCommandId
      ? `plan:${planCommandId}`
      : "";
  // Legacy observations can replace their graph, and a later run can complete an identified
  // definition's truncated snapshot; reload on that revision, not on every history refresh.
  const revision = definitionId ? latest?.runCount : latest?.lastSeenAtMs;
  const load = useCallback(async (): Promise<readonly PlannedStep[]> => {
    if (hasDefinition) return (await api.loadDefinition(pipelineId, definitionId)).steps;
    if (planCommandId)
      return (await api.previewPlan(planCommandId, {})).steps.map(
        ({ nestedPipeline, ...step }) => ({
          ...step,
          nestedPipeline: nestedPipeline && {
            mode: nestedPipeline.mode,
            maxIterations: nestedPipeline.maxIterations,
            pipelineId: nestedPipeline.pipelineId,
            stepCount: nestedPipeline.stepIds.length,
            stepIds: [...nestedPipeline.stepIds],
          },
        })
      );
    return [];
  }, [api, definitionId, hasDefinition, pipelineId, planCommandId, revision]);
  const steps = useStudioResource(api, key, load);
  if (!key) {
    return (
      <EmptyView
        title="No graph recorded"
        copy="Run this pipeline with a store to record its definition and draw its steps."
      />
    );
  }
  if (steps.error) {
    return (
      <div class="graph-source" role="alert">
        Could not load the step graph: {steps.error}{" "}
        <button class="secondary-button" type="button" onClick={steps.reload}>
          Retry
        </button>
      </div>
    );
  }
  if (!steps.value) return <EmptyView title="Loading graph" copy="Loading the declared steps." />;
  return (
    <>
      <p class="graph-source">
        {latest
          ? `Declared steps from the latest recorded definition${latest.identity ? ` ${latest.identity.definitionId.slice(7, 19)}` : ""}.`
          : "Declared steps from the current plan. Nothing has been recorded for this pipeline yet."}
      </p>
      {steps.value.length ? (
        <RunGraph
          detail={plannedGraphDetail(pipeline.pipelineId, steps.value)}
          onOpenRun={() => {}}
        />
      ) : (
        <EmptyView title="No steps" copy="This pipeline declares no steps." />
      )}
    </>
  );
}

interface PipelinePageProps {
  api: StudioApi;
  pipeline: RailPipeline;
  tab?: StudioPipelineTab;
  onTab(tab: StudioPipelineTab | undefined): void;
  runs: readonly StoredRunSummary[];
  /** The run list still shows another scope while this pipeline's history loads. */
  listLoading?: boolean;
  matchingRunCount: number;
  offset: number;
  onPage(offset: number): void;
  nowMs: number;
  onOpenRun(runId: string): void;
  definitions: readonly StoredDefinitionSummary[];
}

export function PipelinePage({
  api,
  pipeline,
  tab,
  onTab,
  runs,
  listLoading = false,
  matchingRunCount,
  offset,
  onPage,
  nowMs,
  onOpenRun,
  definitions,
}: PipelinePageProps) {
  const summary = pipeline.summary;
  const runCount = (summary?.topLevelRunCount ?? 0) + (summary?.nestedRunCount ?? 0);
  const tabs: [StudioPipelineTab | undefined, string][] = [
    [undefined, `Runs · ${runCount}`],
    ["graph", "Graph"],
    ...(definitions.length
      ? [["versions", `Versions · ${definitions.length}`] as [StudioPipelineTab, string]]
      : []),
  ];
  const activeTab = tab === "versions" && !definitions.length ? undefined : tab;
  return (
    <div class="pipeline-page">
      <div class="run-tabs" role="tablist" aria-label="Pipeline sections">
        {tabs.map(([id, label]) => (
          <button
            type="button"
            role="tab"
            key={id ?? "runs"}
            aria-selected={activeTab === id}
            onClick={() => onTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {activeTab === undefined && (
        <RunList
          runs={runs}
          nowMs={nowMs}
          onSelect={onOpenRun}
          showPipeline={false}
          title="Runs"
          subtitle={
            summary?.nestedRunCount
              ? "Including runs started by other pipelines"
              : "Newest first · running runs on top"
          }
          count={`${matchingRunCount} shown`}
          empty={
            listLoading
              ? { title: "Loading runs", copy: "Loading this list." }
              : {
                  title: "No recorded runs",
                  copy: pipeline.command
                    ? "Choose Run to start this pipeline and record its history."
                    : "No runs of this pipeline match.",
                }
          }
          matchingCount={matchingRunCount}
          offset={offset}
          onPage={onPage}
        />
      )}
      {activeTab === "graph" && (
        <section class="sheet pipeline-graph">
          <div class="detail-body">
            <PipelineGraph api={api} pipeline={pipeline} definitions={definitions} />
          </div>
        </section>
      )}
      {activeTab === "versions" && (
        <DefinitionHistory definitions={definitions} api={api} onSelect={onOpenRun} />
      )}
    </div>
  );
}
