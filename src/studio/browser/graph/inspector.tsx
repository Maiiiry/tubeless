import { Fragment, type ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import type { StoredRunSummary } from "../../../run-store/run-history.js";
import type { StoredPipelineRun, StoredPipelineStep } from "../../../run-store/run-store.js";
import { ErrorDiagnostics, LogLines } from "../components/debugging.js";
import { duration, Status, StepRow } from "../components/steps.js";

import { incomingEdges, type EdgeKind } from "./dependencies.js";

export const EDGE_KIND_LABEL: Record<EdgeKind, string> = {
  input: "Required input",
  optional: "Optional input",
  gate: "Failure gate",
};

/** Elapsed time from the run's start, for step timing facts. */
export const runOffset = (run: StoredPipelineRun, ms: number | undefined) =>
  ms === undefined ? "—" : "+" + duration(ms - run.startedAtMs);

export function Facts({ rows }: { rows: readonly (readonly [string, ComponentChildren])[] }) {
  return (
    <dl class="graph-facts">
      {rows.map(([label, value]) => (
        <Fragment key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function ConnectionList({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: readonly { id: string; kinds: readonly EdgeKind[]; status: string; onSelect(): void }[];
}) {
  return (
    <div class="graph-io">
      <h4>{title}</h4>
      {rows.length === 0 && <p class="graph-hint">{empty}</p>}
      {rows.map((row) => (
        <button type="button" key={row.id} onClick={row.onSelect}>
          <Status value={row.status} />
          <code>{row.id}</code>
          <small>{row.kinds.map((kind) => EDGE_KIND_LABEL[kind]).join(" + ")}</small>
        </button>
      ))}
    </div>
  );
}

function ChildRunList({
  runs,
  total,
  onOpenRun,
}: {
  runs: readonly StoredRunSummary[];
  total: number;
  onOpenRun(runId: string, pipelineId?: string): void;
}) {
  if (runs.length === 0) return null;
  const label = total > runs.length ? `${runs.length} of ${total}` : String(runs.length);
  return (
    <div class="graph-io">
      <h4>Nested runs ({label})</h4>
      <div class="nested-runs">
        {runs.map((child) => (
          <button
            class="nested-run"
            type="button"
            key={child.runId}
            onClick={() => onOpenRun(child.runId, child.pipelineId)}
          >
            <Status value={child.status} />
            <strong>{child.origin?.itemKey ?? child.pipelineId}</strong>
            <small>
              {duration(child.durationMs)} · {child.stepCount} step
              {child.stepCount === 1 ? "" : "s"}
            </small>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Side panel for one selection; Escape or × closes it. */
export function Drawer({ children, onClose }: { children: ComponentChildren; onClose(): void }) {
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector(".modal-backdrop")) onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [onClose]);
  return (
    <aside class="step-drawer" aria-label="Inspector">
      <button class="close-button drawer-close" type="button" aria-label="Close" onClick={onClose}>
        ×
      </button>
      {children}
    </aside>
  );
}

interface StepInspectorProps {
  run: StoredPipelineRun;
  step: StoredPipelineStep;
  /** Child runs this step started, as far as they are loaded. */
  childRuns: readonly StoredRunSummary[];
  childTotal: number;
  onOpenRun(runId: string, pipelineId?: string): void;
  onSelectInput(stepId: string): void;
  onSelectConsumer(stepId: string): void;
}

/** Everything recorded about one step: outcome, timing, connections, error, children, logs. */
export function StepInspector({
  run,
  step,
  childRuns,
  childTotal,
  onOpenRun,
  onSelectInput,
  onSelectConsumer,
}: StepInspectorProps) {
  const statusOf = (id: string) => run.steps.find((candidate) => candidate.id === id)?.status;
  const inputs = [...incomingEdges(step)].map(([id, kinds]) => ({
    id,
    kinds,
    status: statusOf(id) ?? "planned",
    onSelect: () => onSelectInput(id),
  }));
  const consumers = run.steps.flatMap((candidate) => {
    const kinds = incomingEdges(candidate).get(step.id);
    return kinds
      ? [
          {
            id: candidate.id,
            kinds,
            status: candidate.status,
            onSelect: () => onSelectConsumer(candidate.id),
          },
        ]
      : [];
  });
  const logs = run.logs.filter((log) => log.stepId === step.id);
  return (
    <div class="graph-inspector">
      <div class="graph-kicker">Step · {run.pipelineId}</div>
      <div class="step-list">
        <StepRow step={step} steps={run.steps} />
      </div>
      <Facts
        rows={[
          ["Started", runOffset(run, step.startedAtMs)],
          ["Finished", runOffset(run, step.finishedAtMs)],
        ]}
      />
      {step.status === "failed" && run.error && <ErrorDiagnostics error={run.error} />}
      <ConnectionList title="Inputs" empty="None: this step starts the graph." rows={inputs} />
      <ConnectionList
        title="Consumers"
        empty="None: no later step depends on this output."
        rows={consumers}
      />
      <ChildRunList runs={childRuns} total={childTotal} onOpenRun={onOpenRun} />
      {logs.length > 0 && (
        <div class="graph-io">
          <h4>Logs ({logs.length})</h4>
          <LogLines logs={logs} showStep={false} />
        </div>
      )}
    </div>
  );
}
