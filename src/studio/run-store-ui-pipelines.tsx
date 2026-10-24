import { MetadataDetails, MetadataExplorer } from "./run-store-ui-metadata.js";
import { NestedDetail } from "./run-store-ui-steps.js";
import type {
  PipelinePlan,
  PipelinePlanStep,
  PipelineStepSelectionReason,
  PipelineStepSkipReason,
} from "../core/pipeline.js";

function selectionReasonText(reason: PipelineStepSelectionReason): string {
  switch (reason.kind) {
    case "all":
      return "Included because no step or target filter was set.";
    case "exact":
      return "Explicitly listed in the exact step selection.";
    case "target":
      return `Requested target “${reason.targetId}”.`;
    case "required-dependency":
      return `Required input for “${reason.dependentId}” on the path to target “${reason.targetId}”.`;
    case "failure-gate":
      return `Failure gate for “${reason.dependentId}” on the path to target “${reason.targetId}”.`;
    case "optional-only":
      return `Optional input for “${reason.dependentId}” on the path to target “${reason.targetId}”; this link does not select it.`;
    case "outside-target-closure":
      return "Outside the selected targets and their prerequisite paths.";
    case "not-selected":
      return "Not listed in the exact step selection.";
  }
}

function plannedSkipText(reason: PipelineStepSkipReason): string {
  switch (reason) {
    case "dry-run":
      return "Its dry-run policy skips this step.";
    case "unmet-dependency":
      return "A required input is unavailable in this selection or dry run.";
    case "failed-dependency":
      return "A failure gate failed or was cancelled.";
    case "fail-fast":
      return "Execution stops after an earlier failure.";
    case "policy":
      return "Its runtime skip policy omits this step.";
    case "filtered":
      return "Excluded by the selection filter.";
  }
}

function PlanReferences({
  ids,
  stepsById,
}: {
  ids: readonly string[];
  stepsById: ReadonlyMap<string, PipelinePlanStep>;
}) {
  return (
    <span class="plan-references">
      {ids.map((id) => (
        <span key={id}>
          <code>{id}</code>
          {stepsById.get(id)?.selected === false && " (not selected)"}
        </span>
      ))}
    </span>
  );
}

export function PlanView({ plan }: { plan: PipelinePlan }) {
  const selected = plan.steps.filter((step) => step.selected && !step.skipReason).length;
  const stepsById = new Map(plan.steps.map((step) => [step.id, step]));
  const selectionMode = plan.steps.some((step) =>
    step.selectionReasons.some((reason) => reason.kind === "target")
  )
    ? {
        title: "Targets with prerequisites",
        detail:
          "Targets include required inputs and failure gates recursively. Optional inputs are not added unless selected for another reason.",
      }
    : plan.steps.some((step) =>
          step.selectionReasons.some(
            (reason) => reason.kind === "exact" || reason.kind === "not-selected"
          )
        )
      ? {
          title: "Exact steps",
          detail:
            "Only listed steps are selected. Required inputs and failure gates are not added automatically, so missing required inputs can skip a selected step.",
        }
      : {
          title: "All steps",
          detail: "No selection filter is set; every declared step is selected.",
        };
  return (
    <>
      {plan.errors.length > 0 && (
        <div class="launch-error">
          {plan.errors.map((error) => (
            <div key={error.message}>{error.message}</div>
          ))}
        </div>
      )}
      <div class="plan-summary">
        <strong>{plan.pipelineId}</strong>
        <span>
          {selected} of {plan.steps.length} steps planned to run{plan.dryRun ? " · dry run" : ""}
        </span>
      </div>
      {plan.steps.length > 0 && (
        <div class="plan-selection-mode">
          <strong>{selectionMode.title}</strong>
          <span>{selectionMode.detail}</span>
        </div>
      )}
      <MetadataDetails metadata={plan.definition?.metadata} />
      <MetadataExplorer steps={plan.steps} />
      <div class="plan-steps">
        {plan.steps.map((step) => {
          const disposition = !step.selected
            ? "Not selected"
            : step.skipReason === "dry-run"
              ? "Dry-run skip"
              : step.skipReason
                ? "Skipped"
                : "Will run";
          const nested = step.nestedPipeline;
          const remote = step.remote;
          const kind = remote
            ? "Remote step"
            : nested
              ? nested.mode === "iterate"
                ? "Pipeline iteration"
                : nested.mode === "for-each"
                  ? "Pipeline fan-out"
                  : "Nested pipeline"
              : "Step";
          return (
            <div class="plan-step" key={step.id}>
              <div class="plan-step-title">
                <strong>{step.name || step.id}</strong>
                {step.name && step.name !== step.id && <code class="plan-step-id">{step.id}</code>}
                <span class={`plan-kind${nested ? " pipeline" : ""}`}>{kind}</span>
              </div>
              {step.description && <small>{step.description}</small>}
              <MetadataDetails metadata={step.metadata} />
              <span class={`plan-disposition${disposition === "Will run" ? "" : " skipped"}`}>
                {disposition}
              </span>
              <ul class="plan-explanation">
                {step.selectionReasons.map((reason, index) => (
                  <li key={index}>
                    <strong>{step.selected ? "Selected" : "Omitted"}</strong>
                    <span>{selectionReasonText(reason)}</span>
                  </li>
                ))}
                <li>
                  <strong>Required inputs</strong>
                  {step.dependencies.length > 0 ? (
                    <span>
                      <PlanReferences ids={step.dependencies} stepsById={stepsById} /> — unavailable
                      inputs skip this step.
                    </span>
                  ) : (
                    <span>No required inputs.</span>
                  )}
                </li>
                {step.optionalDependencies.length > 0 && (
                  <li>
                    <strong>Optional inputs</strong>
                    <span>
                      <PlanReferences ids={step.optionalDependencies} stepsById={stepsById} /> —
                      unavailable inputs do not block it.
                    </span>
                  </li>
                )}
                {step.skipAfterFailureOf.length > 0 && (
                  <li>
                    <strong>Failure gates</strong>
                    <span>
                      <PlanReferences ids={step.skipAfterFailureOf} stepsById={stepsById} /> —
                      failure or cancellation skips this step.
                    </span>
                  </li>
                )}
                {step.selected && step.skipReason && (
                  <li>
                    <strong>Planned skip</strong>
                    <span>{plannedSkipText(step.skipReason)}</span>
                  </li>
                )}
                {step.selected && !step.skipReason && step.runtimeSkipPossible && (
                  <li>
                    <strong>Runtime policy</strong>
                    <span>This step may still skip when it runs.</span>
                  </li>
                )}
              </ul>
              {nested && (
                <NestedDetail
                  label={nested.pipelineId}
                  secondary={`${nested.stepIds.length} declared steps${
                    nested.mode === "iterate"
                      ? ` per iteration, at most ${nested.maxIterations} iterations`
                      : nested.mode === "for-each"
                        ? " per runtime item"
                        : ""
                  }`}
                  stepIds={nested.stepIds}
                />
              )}
              {remote && <NestedDetail label={remote.engine} secondary={remote.target} />}
            </div>
          );
        })}
      </div>
    </>
  );
}
