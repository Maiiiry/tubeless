import { duplicateValues } from "../utilities/collections.js";
import { didYouMean } from "../utilities/suggest.js";
import type { CompiledPipeline } from "./pipeline-compiler.js";
import type { StepIds, TargetIds } from "./pipeline-definition.js";
import { decideStepDisposition } from "./pipeline-disposition.js";
import { pipelineDiagnostic } from "./pipeline-errors.js";
import { compiledStepGraph, liveStepGraph, type CompiledStepGraph } from "./pipeline-graph.js";
import type { AnyStep } from "./pipeline-steps.js";
import { STEP_NESTED_PIPELINE, STEP_REMOTE, STEP_AGENT } from "./pipeline-step-metadata.js";
import type {
  PipelineError,
  PipelinePlan,
  PipelinePlanStep,
  PipelineRunControls,
  PipelineStepReport,
  PipelineStepSelectionReason,
  PipelineStepSkipReason,
  PipelineStepSkippedReport,
  StandardSchemaV1,
} from "./pipeline-types.js";

export function stepToPlanStep<TOptions extends object>(
  step: AnyStep<TOptions>,
  selected: boolean,
  skipReason?: PipelineStepSkipReason,
  selectionReasons?: readonly PipelineStepSelectionReason[],
  graph: CompiledStepGraph<TOptions> = liveStepGraph(step)
): PipelinePlanStep {
  const reasons = selectionReasons ?? [{ kind: "all" }];
  const planStep: PipelinePlanStep = {
    dependencies: graph.dependsOn.map((dep) => dep.id),
    description: step.description,
    ...(step.metadata === undefined ? {} : { metadata: step.metadata }),
    dryRun: step.dryRun === "skip" ? "skip" : step.dryRun !== undefined ? "custom" : "run",
    id: step.id,
    name: step.name,
    optionalDependencies: graph.optionalDependsOn.map((dep) => dep.id),
    runtimeSkipPossible: step.skip !== undefined,
    selected,
    selectionReasons: reasons,
    skipAfterFailureOf: graph.skipAfterFailureOf.map((dep) => dep.id),
    skipReason,
  };
  if (step[STEP_NESTED_PIPELINE]) {
    planStep.nestedPipeline = {
      ...step[STEP_NESTED_PIPELINE],
      stepIds: [...step[STEP_NESTED_PIPELINE].stepIds],
    };
  }
  if (step[STEP_REMOTE]) {
    planStep.remote = { ...step[STEP_REMOTE] };
  }
  if (step[STEP_AGENT]) planStep.agent = step[STEP_AGENT];
  return planStep;
}

function addSelectionReason(
  reasonsByStepId: Map<string, PipelineStepSelectionReason[]>,
  stepId: string,
  reason: PipelineStepSelectionReason
): void {
  const reasons = reasonsByStepId.get(stepId) ?? [];
  const reasonKey = JSON.stringify(reason);
  if (!reasons.some((candidate) => JSON.stringify(candidate) === reasonKey)) {
    reasons.push(reason);
    reasonsByStepId.set(stepId, reasons);
  }
}

function targetSelectionReasons<TOptions extends object>(
  targets: readonly AnyStep<TOptions>[],
  stepGraph: ReadonlyMap<AnyStep, CompiledStepGraph>
): Map<string, PipelineStepSelectionReason[]> {
  const reasonsByStepId = new Map<string, PipelineStepSelectionReason[]>();

  for (const target of targets) {
    addSelectionReason(reasonsByStepId, target.id, { kind: "target", targetId: target.id });
    const expanded = new Set<AnyStep<TOptions>>();
    const includePrerequisites = (step: AnyStep<TOptions>): void => {
      if (expanded.has(step)) return;
      expanded.add(step);

      const graph = compiledStepGraph({ stepGraph }, step);
      for (const dependency of graph.dependsOn) {
        addSelectionReason(reasonsByStepId, dependency.id, {
          dependentId: step.id,
          kind: "required-dependency",
          targetId: target.id,
        });
        includePrerequisites(dependency);
      }
      for (const dependency of graph.skipAfterFailureOf) {
        addSelectionReason(reasonsByStepId, dependency.id, {
          dependentId: step.id,
          kind: "failure-gate",
          targetId: target.id,
        });
        includePrerequisites(dependency);
      }
      for (const dependency of graph.optionalDependsOn) {
        addSelectionReason(reasonsByStepId, dependency.id, {
          dependentId: step.id,
          kind: "optional-only",
          targetId: target.id,
        });
      }
    };
    includePrerequisites(target);
  }

  return reasonsByStepId;
}

function selectsStep(reason: PipelineStepSelectionReason): boolean {
  return !["not-selected", "optional-only", "outside-target-closure"].includes(reason.kind);
}

/** Selection modes conflict when both controls are present, including empty arrays. */
export function hasConflictingSelectionControls(controls: {
  stepIds?: readonly string[];
  targets?: readonly string[];
}): boolean {
  return controls.stepIds !== undefined && controls.targets !== undefined;
}

/** One `Did you mean …?` sentence per mistyped id, naming the id when several were requested. */
function selectionSuggestions(ids: readonly string[], candidates: readonly string[]): string[] {
  const uniqueIds = [...new Set(ids)];
  return uniqueIds.flatMap((id) => {
    const suggestion = didYouMean(id, candidates);
    if (suggestion === undefined) return [];
    return [
      uniqueIds.length === 1 ? suggestion : `${suggestion.slice(0, -1)} for ${JSON.stringify(id)}?`,
    ];
  });
}

/** Near-miss targets, plus the declared target list whenever some id has no near-miss. */
function targetHints(
  pipelineId: string,
  ids: readonly string[],
  declaredTargetIds: ReadonlySet<string>
): string[] {
  const declared = [...declaredTargetIds];
  const hints = selectionSuggestions(ids, declared);
  if (hints.length < new Set(ids).size) {
    hints.push(
      declared.length === 0
        ? `Pipeline ${pipelineId} declares no targets.`
        : `Declared targets: ${declared.join(", ")}.`
    );
  }
  return hints;
}

function withHints(message: string, hints: readonly string[]): string {
  return hints.length === 0 ? message : `${message}. ${hints.join(" ")}`;
}

export function buildPipelinePlan<
  TSteps extends readonly AnyStep[],
  TResult,
  TTargets extends readonly TSteps[number][],
  TResultSchema extends StandardSchemaV1 | undefined,
>(
  compiled: CompiledPipeline<TSteps, TResult, TTargets, TResultSchema>,
  controls: PipelineRunControls<StepIds<TSteps>, TargetIds<TTargets>>
): PipelinePlan {
  const dryRun = controls.dryRun === true;
  const steps = compiled.orderedSteps;
  const errors: PipelineError[] = [];

  const knownStepIds = new Set(compiled.stepIds);
  const declaredTargetIds = new Set(compiled.declaredTargets.map((target) => target.id));
  const requestedStepIds = controls.stepIds ?? [];
  const requestedTargets = controls.targets ?? [];
  if (controls.cache !== undefined && !["use", "recompute", "bypass"].includes(controls.cache)) {
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_RUN_CACHE_INVALID",
        "planning",
        "validation",
        "cache must be use, recompute, or bypass"
      )
    );
  }
  const maxConcurrency = controls.maxConcurrency ?? 1;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_RUN_CONCURRENCY_INVALID",
        "planning",
        "validation",
        "maxConcurrency must be a positive finite integer"
      )
    );
  }
  if (hasConflictingSelectionControls(controls)) {
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_PLANNING_SELECTION_CONFLICT",
        "planning",
        "selection",
        `Pipeline ${compiled.id} cannot combine exact stepIds filtering with dependency-aware targets`
      )
    );
  }
  if (controls.stepIds !== undefined && controls.stepIds.length === 0) {
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_PLANNING_STEP_SELECTION_EMPTY",
        "planning",
        "selection",
        `Pipeline ${compiled.id} received an empty stepIds array; omit stepIds to run every step, or pass at least one step id`
      )
    );
  }
  if (controls.targets !== undefined && controls.targets.length === 0) {
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_PLANNING_TARGET_SELECTION_EMPTY",
        "planning",
        "selection",
        `Pipeline ${compiled.id} received an empty targets array; omit targets to run every step, or pass at least one target step id`
      )
    );
  }
  const duplicateRequestedStepIds = duplicateValues(requestedStepIds);
  if (duplicateRequestedStepIds.length > 0) {
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_PLANNING_STEP_SELECTION_DUPLICATE",
        "planning",
        "selection",
        `Pipeline ${compiled.id} requested duplicate step ids: ${duplicateRequestedStepIds.join(", ")}`
      )
    );
  }
  const unknownRequestedStepIds = requestedStepIds.filter((stepId) => !knownStepIds.has(stepId));
  if (unknownRequestedStepIds.length > 0) {
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_PLANNING_STEP_UNKNOWN",
        "planning",
        "selection",
        withHints(
          `Pipeline ${compiled.id} requested unknown step ids: ${unknownRequestedStepIds.join(", ")}`,
          selectionSuggestions(unknownRequestedStepIds, compiled.stepIds)
        )
      )
    );
  }
  const duplicateTargets = duplicateValues(requestedTargets);
  if (duplicateTargets.length > 0) {
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_PLANNING_TARGET_SELECTION_DUPLICATE",
        "planning",
        "selection",
        `Pipeline ${compiled.id} requested duplicate targets: ${duplicateTargets.join(", ")}`
      )
    );
  }
  const unknownTargets = requestedTargets.filter((stepId) => !knownStepIds.has(stepId));
  if (unknownTargets.length > 0) {
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_PLANNING_TARGET_UNKNOWN",
        "planning",
        "selection",
        withHints(
          `Pipeline ${compiled.id} requested unknown targets: ${unknownTargets.join(", ")}`,
          targetHints(compiled.id, unknownTargets, declaredTargetIds)
        )
      )
    );
  }
  const undeclaredTargets = requestedTargets.filter(
    (stepId) => knownStepIds.has(stepId) && !declaredTargetIds.has(stepId)
  );
  if (undeclaredTargets.length > 0) {
    const uniqueUndeclared = [...new Set(undeclaredTargets)];
    errors.push(
      pipelineDiagnostic(
        "TUBELESS_PLANNING_TARGET_UNDECLARED",
        "planning",
        "selection",
        withHints(
          `Pipeline ${compiled.id} requested undeclared targets: ${undeclaredTargets.join(", ")}`,
          [
            uniqueUndeclared.length === 1
              ? `${JSON.stringify(uniqueUndeclared[0])} is a step, not a declared target; select steps exactly with stepIds.`
              : "These are steps, not declared targets; select steps exactly with stepIds.",
            ...targetHints(compiled.id, undeclaredTargets, declaredTargetIds),
          ]
        )
      )
    );
  }

  if (errors.length > 0) {
    return {
      dryRun,
      errors,
      ok: false,
      pipelineId: compiled.id,
      definition: compiled.definition,
      steps: [],
    };
  }

  let selectionReasonsByStepId: Map<string, PipelineStepSelectionReason[]>;
  if (controls.stepIds !== undefined) {
    const selectedIds = new Set(controls.stepIds);
    selectionReasonsByStepId = new Map(
      steps.map((step) => [
        step.id,
        selectedIds.has(step.id)
          ? ([{ kind: "exact" }] satisfies PipelineStepSelectionReason[])
          : ([{ kind: "not-selected" }] satisfies PipelineStepSelectionReason[]),
      ])
    );
  } else if (controls.targets !== undefined) {
    const stepsById = new Map(steps.map((step) => [step.id, step]));
    const selectedTargets = controls.targets.map((target) => stepsById.get(target)!);
    selectionReasonsByStepId = targetSelectionReasons(selectedTargets, compiled.stepGraph);
    for (const step of steps) {
      const reasons = selectionReasonsByStepId.get(step.id) ?? [];
      const selected = reasons.some(selectsStep);
      selectionReasonsByStepId.set(
        step.id,
        selected
          ? reasons.filter(selectsStep)
          : reasons.length > 0
            ? reasons
            : [{ kind: "outside-target-closure" }]
      );
    }
  } else {
    selectionReasonsByStepId = new Map(
      steps.map((step) => [step.id, [{ kind: "all" }] satisfies PipelineStepSelectionReason[]])
    );
  }
  const planSteps: PipelinePlanStep[] = [];
  // Accumulated planned skip/complete reports so later steps see the same
  // unmet-dependency chain as today's skipReason walk (not one empty map).
  const plannedReportsByStepId = new Map<string, PipelineStepReport>();
  for (const step of steps) {
    const selectionReasons = selectionReasonsByStepId.get(step.id)!;
    const selected = selectionReasons.some(selectsStep);
    const graph = compiledStepGraph(compiled, step);
    const planned = stepToPlanStep(step, selected, undefined, selectionReasons, graph);
    const disposition = decideStepDisposition({
      dryRun,
      graph,
      planned,
      reportsByStepId: plannedReportsByStepId,
      step,
    });
    const skipReason = disposition.kind === "skip" ? disposition.reason : undefined;
    const planStep = stepToPlanStep(step, selected, skipReason, selectionReasons, graph);
    planSteps.push(planStep);
    if (disposition.kind === "skip") {
      const report: PipelineStepSkippedReport = {
        id: step.id,
        name: step.name,
        description: step.description,
        finishedAtMs: 0,
        reason: disposition.reason,
        status: "skipped",
      };
      if (disposition.dependencyId) report.dependencyId = disposition.dependencyId;
      if (disposition.message) report.message = disposition.message;
      plannedReportsByStepId.set(step.id, report);
    } else {
      // Synthetic complete so isRequiredDependencyMet treats will-run deps as met.
      plannedReportsByStepId.set(step.id, {
        attemptId: "",
        id: step.id,
        name: step.name,
        description: step.description,
        finishedAtMs: 0,
        startedAtMs: 0,
        status: "completed",
      });
    }
  }

  return {
    dryRun,
    errors,
    ok: errors.length === 0,
    pipelineId: compiled.id,
    definition: compiled.definition,
    steps: planSteps,
  };
}

export function planStepById(plan: PipelinePlan): Map<string, PipelinePlanStep> {
  return new Map(plan.steps.map((step) => [step.id, step]));
}
