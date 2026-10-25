import type { StoredPipelineStep } from "../../../run-store/run-store.js";
import type { StudioChildStep } from "../../shared/schema.js";

export type EdgeState =
  | "active"
  | "blocked"
  | "candidate"
  | "settled"
  | "tripped"
  | "unused"
  | "used";

export type EdgeKind = "input" | "optional" | "gate";

/** Group a step's planned dependencies by source, in required, optional, gate order. */
export function incomingEdges(step: StoredPipelineStep): Map<string, EdgeKind[]> {
  const edges = new Map<string, EdgeKind[]>();
  const add = (ids: readonly string[] | undefined, kind: EdgeKind) => {
    for (const id of ids ?? []) edges.set(id, [...(edges.get(id) ?? []), kind]);
  };
  add(step.dependencies, "input");
  add(step.optionalDependencies, "optional");
  add(step.skipAfterFailureOf, "gate");
  return edges;
}

/** Child runs a step started, bounded by the recorded per-step total. */
export function childStepTotal(
  childSteps: readonly StudioChildStep[],
  stepId: string,
  fallback: number
): number {
  const match = childSteps.find((entry) => entry.stepId === stepId);
  return match ? Math.max(match.count, fallback) : fallback;
}

/** Completed steps and policy skips publish an output that consumers receive. */
function producedOutput(step: StoredPipelineStep): boolean {
  return step.status === "completed" || step.skipReason === "policy";
}

/**
 * Visual state of one dependency edge from all of its kinds and its endpoint steps.
 * Gates trip on a failed or cancelled source, matching the engine's step disposition.
 * A step's own skip policy runs after its inputs are built, so a policy skip still
 * received them; other skips happen before inputs exist.
 */
export function edgeState(
  kinds: readonly EdgeKind[],
  source: StoredPipelineStep,
  target: StoredPipelineStep
): EdgeState {
  const gate = kinds.includes("gate");
  const failed = source.status === "failed" || source.status === "cancelled";
  if (gate && failed) return "tripped";
  if (target.status === "planned") return "candidate";
  if (kinds.length === 1 && gate) return "settled";
  if (!producedOutput(source)) return failed ? "blocked" : "unused";
  if (target.status === "running") return "active";
  return target.status === "skipped" && target.skipReason !== "policy" ? "unused" : "used";
}
