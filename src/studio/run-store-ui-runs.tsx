import { STUDIO_HISTORY_PAGE_SIZE, type StudioRunDetail } from "./run-store-ui-schema.js";
import type { StoredRunSummary } from "../run-store/run-history.js";
import { Status, StepRow, duration, shortId } from "./run-store-ui-steps.js";
import { RunGraph } from "./run-store-ui-graph.js";
import { ErrorDiagnostics, RunLogs } from "./run-store-ui-debugging.js";
import { useEffect, useState } from "preact/hooks";
import type { StoredPipelineRun } from "../run-store/run-store.js";
import type { StudioApi } from "./run-store-ui-client-transport.js";
import type { StudioRunSelection } from "./run-store-ui-data-controller.js";
import { EmptyView, preferredScrollBehavior } from "./run-store-ui-common.js";

function dateTime(ms: number): string {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return "";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(
    ms
  );
}

export function isoTime(ms: number): string {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return "";
  return new Date(ms).toISOString();
}

function relativeTime(ms: number, nowMs: number): string {
  const delta = Math.max(0, nowMs - ms);
  if (delta < 60000) return Math.floor(delta / 1000) + "s ago";
  if (delta < 3600000) return Math.floor(delta / 60000) + "m ago";
  if (delta < 86400000) return Math.floor(delta / 3600000) + "h ago";
  return Math.floor(delta / 86400000) + "d ago";
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Lead with what happened: where a run failed or stopped, or how much it finished. */
export function runOutcome(run: StoredPipelineRun): string {
  const total = run.steps.length;
  const count = (status: string) => run.steps.filter((step) => step.status === status).length;
  const skipped = count("skipped");
  const skippedNote = skipped ? ` · ${skipped} skipped` : "";
  switch (run.status) {
    case "running": {
      const finished = total - count("running") - count("planned");
      return total ? `Running · ${finished} of ${plural(total, "step")} finished` : "Starting";
    }
    case "completed":
      return `Completed ${plural(count("completed"), "step")} in ${duration(run.durationMs)}${skippedNote}`;
    case "cancelled":
      return `Cancelled after ${count("completed")} of ${plural(total, "step")}${skippedNote}`;
    case "failed": {
      const failed = run.steps.filter((step) => step.status === "failed").map((step) => step.id);
      if (failed.length) return `Failed at ${failed.join(", ")}${skippedNote}`;
      return run.error?.message ? `Failed: ${run.error.message}` : "Failed";
    }
  }
  return run.status;
}

interface RunRowProps {
  nowMs: number;
  onSelect(id: string): void;
  run: StoredRunSummary;
  selectedRootRunId?: string;
}

function RunRow({ nowMs, onSelect, run, selectedRootRunId }: RunRowProps) {
  const activeSteps = run.activity;
  const nestedCount = run.descendantCount;
  return (
    <button
      class={`run-row ${run.status} ${selectedRootRunId === run.runId ? "selected" : ""}`}
      data-run-id={run.runId}
      onClick={() => onSelect(run.runId)}
    >
      <div class="run-primary">
        <Status value={run.status} />
        <strong>{run.pipelineId}</strong>
        <time
          class="run-time"
          datetime={isoTime(run.startedAtMs)}
          title={dateTime(run.startedAtMs)}
        >
          {relativeTime(run.startedAtMs, nowMs)}
        </time>
      </div>
      <div class="run-secondary">
        <code>{shortId(run.runId)}</code>
        <i class="dot" />
        {run.correlationId && (
          <>
            <span>correlation {run.correlationId}</span>
            <i class="dot" />
          </>
        )}
        <span>{duration(run.durationMs)}</span>
        <i class="dot" />
        <span>{plural(run.stepCount, "step")}</span>
        {nestedCount > 0 && (
          <>
            <i class="dot" />
            <span>
              {nestedCount} nested run{nestedCount === 1 ? "" : "s"}
            </span>
          </>
        )}
        {run.dryRun && (
          <>
            <i class="dot" />
            <span>dry run</span>
          </>
        )}
      </div>
      {run.status === "running" && (
        <div class="run-activity">
          <strong>
            {activeSteps.count > 1
              ? `${activeSteps.count} steps running`
              : activeSteps.names[0] || "Starting"}
          </strong>
          <span>
            {activeSteps.count > 1
              ? `${activeSteps.names.join(", ")}${activeSteps.count > 3 ? ` +${activeSteps.count - 3} more` : ""}`
              : activeSteps.message || "Execution in progress"}
          </span>
        </div>
      )}
    </button>
  );
}

function stepSummary(run: StoredPipelineRun): string {
  const order = ["running", "failed", "cancelled", "skipped", "completed", "planned"] as const;
  return (
    order
      .map((value) => [value, run.steps.filter((step) => step.status === value).length] as const)
      .filter(([, count]) => count)
      .map(([value, count]) => count + " " + value)
      .join(" · ") || "No steps"
  );
}

function visibleChildren(
  first: readonly StoredRunSummary[],
  extra: readonly StoredRunSummary[]
): StoredRunSummary[] {
  const children = [...first];
  const seen = new Set(children.map((child) => child.runId));
  for (const child of extra) {
    if (seen.has(child.runId)) continue;
    seen.add(child.runId);
    children.push(child);
  }
  return children;
}

function NestedRuns({
  api,
  detail,
  onSelect,
}: {
  api?: Pick<StudioApi, "loadChildRuns">;
  detail: StudioRunDetail;
  onSelect(id: string): void;
}) {
  const [extra, setExtra] = useState<readonly StoredRunSummary[]>([]);
  const [nextPage, setNextPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const children = visibleChildren(detail.children, extra);
  if (detail.childCount === 0) return null;
  const showMore = () => {
    if (!api || loading || exhausted || children.length >= detail.childCount) return;
    setLoading(true);
    setError(undefined);
    api.loadChildRuns(detail.run.runId, nextPage).then(
      (page) => {
        setLoading(false);
        if (!page) {
          setError("This run is no longer in history.");
          setExhausted(true);
          return;
        }
        const seen = new Set(children.map((child) => child.runId));
        const added = page.children.filter((child) => !seen.has(child.runId));
        if (added.length === 0) {
          setExhausted(true);
          return;
        }
        setExtra((current) => [...current, ...added]);
        setNextPage(page.page + 1);
      },
      (cause: unknown) => {
        setLoading(false);
        setError(cause instanceof Error ? cause.message : "Could not load more runs.");
      }
    );
  };
  return (
    <>
      <div class="section-title">
        <span>Nested runs</span>
        <span>
          {detail.childCount} direct · {detail.descendantCount} total
        </span>
      </div>
      <div class="nested-runs">
        {children.map((child) => {
          const descendantCount = child.descendantCount;
          return (
            <button
              class="nested-run"
              type="button"
              key={child.runId}
              onClick={() => onSelect(child.runId)}
            >
              <Status value={child.status} />
              <strong>{child.pipelineId}</strong>
              <small>
                {duration(child.durationMs)} · {plural(child.stepCount, "step")}
                {descendantCount ? " · " + descendantCount + " nested" : ""}
              </small>
            </button>
          );
        })}
      </div>
      {error && <p role="alert">{error}</p>}
      {api && !exhausted && children.length < detail.childCount && (
        <div class="confirm-actions">
          <button class="secondary-button" type="button" disabled={loading} onClick={showMore}>
            {loading ? "Loading…" : "Show more"}
          </button>
        </div>
      )}
    </>
  );
}

type StepView = "timeline" | "graph";

interface RunDetailProps {
  api?: StudioApi;
  canCancel: boolean;
  cancelling: boolean;
  liveRunIds: readonly string[];
  nowMs: number;
  onCancel(id: string): void;
  onCopyLink(id: string): void;
  onSelect(id: string): void;
  onStepView?(view: StepView): void;
  selection: StudioRunSelection;
  stepView?: StepView;
  latestRunId?: string;
}

function RunDetail({
  api,
  canCancel,
  cancelling,
  liveRunIds,
  nowMs,
  onCancel,
  onCopyLink,
  onSelect,
  onStepView,
  selection,
  stepView = "timeline",
  latestRunId,
}: RunDetailProps) {
  const [focus, setFocus] = useState<{ stepId: string; request: number } | undefined>();
  const readyRunId = selection.status === "ready" ? selection.detail.run.runId : undefined;
  useEffect(() => setFocus(undefined), [readyRunId]);
  useEffect(() => {
    if (!focus || stepView !== "timeline") return;
    const row = document.querySelector<HTMLElement>(
      `.step-list [data-step-id="${CSS.escape(focus.stepId)}"]`
    );
    if (!row) return;
    row.scrollIntoView({ block: "center", behavior: preferredScrollBehavior() });
    row.classList.remove("focused");
    void row.offsetWidth;
    row.classList.add("focused");
  }, [focus, stepView]);
  if (selection.status !== "ready") {
    if (selection.status === "unavailable") {
      return (
        <div class="sheet detail">
          <div class="unavailable-run">
            <strong>Run unavailable</strong>
            <p>
              This run is not in this Studio history. It may have been deleted, or this link may
              refer to another local store.
            </p>
            <code>{selection.runId}</code>
            {latestRunId && (
              <button class="secondary-button" type="button" onClick={() => onSelect(latestRunId)}>
                Select latest run
              </button>
            )}
          </div>
        </div>
      );
    }
    return (
      <div class="sheet detail">
        <EmptyView
          title={selection.status === "loading" ? "Loading run" : "Select a run"}
          copy={
            selection.status === "loading"
              ? "Loading this run's recorded details."
              : "Choose a run from the history to inspect its steps, retry telemetry, logs, and errors."
          }
        />
      </div>
    );
  }
  const { detail } = selection;
  const { run, ancestors } = detail;
  return (
    <article class="sheet detail">
      <div class="detail-body">
        {ancestors.length > 0 && (
          <div class="run-parentage">
            {ancestors.map((ancestor) => (
              <span key={ancestor.runId}>
                <button type="button" onClick={() => onSelect(ancestor.runId)}>
                  {ancestor.pipelineId}
                </button>
                <span> / </span>
              </span>
            ))}
            <span>{run.pipelineId}</span>
          </div>
        )}
        <div class="detail-heading">
          <div class="detail-heading-copy">
            <div class="detail-kicker">
              {run.parentRunId ? "Nested run" : "Top-level run"} ·{" "}
              {relativeTime(run.startedAtMs, nowMs)}
            </div>
            <h2>{run.pipelineId}</h2>
            <p class={`run-outcome ${run.status}`}>{runOutcome(run)}</p>
            <div class="run-id">{run.runId}</div>
            {run.correlationId && <div class="run-id">Correlation: {run.correlationId}</div>}
          </div>
          <div class="detail-heading-actions">
            <Status value={run.status} />
            <button
              class="icon-button"
              type="button"
              title="Copy run link"
              aria-label="Copy run link"
              onClick={() => onCopyLink(run.runId)}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
              >
                <rect x="7" y="5" width="10" height="12" rx="2" />
                <path d="M13 5V4a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2" />
              </svg>
            </button>
            {canCancel &&
              run.status === "running" &&
              !run.parentRunId &&
              liveRunIds.includes(run.runId) && (
                <button
                  class="danger-button"
                  type="button"
                  disabled={cancelling}
                  onClick={() => onCancel(run.runId)}
                >
                  Cancel run
                </button>
              )}
          </div>
        </div>
        <div class="detail-meta">
          <div>
            <label>Started</label>
            <span title={isoTime(run.startedAtMs)}>{dateTime(run.startedAtMs)}</span>
          </div>
          <div>
            <label>Duration</label>
            <span>{duration(run.durationMs)}</span>
          </div>
          <div>
            <label>Steps</label>
            <span>{run.steps.length}</span>
          </div>
          <div>
            <label>Events</label>
            <span>{run.eventCount}</span>
          </div>
        </div>
        {run.error && (
          <>
            <div class="section-title">
              <span>Error diagnostics</span>
            </div>
            <ErrorDiagnostics
              error={run.error}
              failedStepIds={run.steps
                .filter((step) => step.status === "failed")
                .map((step) => step.id)}
              onSelectStep={(stepId) =>
                setFocus((current) => ({ stepId, request: (current?.request ?? 0) + 1 }))
              }
            />
          </>
        )}
        <div class="section-title">
          <span>{stepView === "graph" ? "Step graph" : "Step timeline"}</span>
          <span class="section-title-actions">
            {stepSummary(run)}
            {onStepView && run.steps.length > 0 && (
              <span class="view-toggle" role="group" aria-label="Step view">
                {(["timeline", "graph"] as const).map((view) => (
                  <button
                    type="button"
                    key={view}
                    aria-pressed={stepView === view}
                    onClick={() => onStepView(view)}
                  >
                    {view === "graph" ? "Graph" : "Timeline"}
                  </button>
                ))}
              </span>
            )}
          </span>
        </div>
        {run.steps.length === 0 ? (
          <EmptyView
            title="No planned steps"
            copy="This run ended before a step plan was recorded."
          />
        ) : stepView === "graph" ? (
          <RunGraph key={run.runId} detail={detail} api={api} onOpenRun={onSelect} focus={focus} />
        ) : (
          <div class="step-list">
            {run.steps.map((step) => (
              <StepRow key={step.id} step={step} steps={run.steps} />
            ))}
          </div>
        )}
        <NestedRuns key={run.runId} api={api} detail={detail} onSelect={onSelect} />
        {run.logs.length > 0 && <RunLogs key={run.runId} logs={run.logs} />}
        <details class="run-definition">
          <summary>
            Definition{" "}
            <code>
              {run.definitionIdentity
                ? run.definitionIdentity.definitionId.slice(7, 19)
                : "not recorded (legacy trace)"}
            </code>{" "}
            · implementation {run.definitionIdentity?.implementationVersion ?? "unknown"}
          </summary>
          <dl class="run-definition-facts">
            <dt>Definition ID</dt>
            <dd>
              <code>{run.definitionIdentity?.definitionId ?? "Not recorded (legacy trace)"}</code>
            </dd>
            {run.definitionIdentity && (
              <>
                <dt>Structural fingerprint</dt>
                <dd>
                  <code>{run.definitionIdentity.structuralFingerprint}</code>
                </dd>
              </>
            )}
            <dt>Implementation</dt>
            <dd>{run.definitionIdentity?.implementationVersion ?? "Unknown"}</dd>
          </dl>
        </details>
      </div>
    </article>
  );
}

interface RunsViewProps extends RunDetailProps {
  roots: readonly StoredRunSummary[];
  matchingRootCount?: number;
  offset?: number;
  onPage?(offset: number): void;
  totalRunCount: number;
}

export function RunsView(props: RunsViewProps) {
  const [stepView, setStepView] = useState<StepView>(props.stepView ?? "timeline");
  const activeRuns = props.roots.filter((run) => run.subtreeIsRunning);
  const historicalRuns = props.roots.filter((run) => !run.subtreeIsRunning);
  const list = (label: string, runs: readonly StoredRunSummary[]) =>
    runs.length ? (
      <>
        <div class="run-group">
          {label} · {runs.length}
        </div>
        {runs.map((run) => (
          <RunRow
            key={run.runId}
            nowMs={props.nowMs}
            onSelect={props.onSelect}
            run={run}
            selectedRootRunId={
              props.selection.status === "ready" || props.selection.status === "loading"
                ? props.selection.summary?.rootRunId
                : undefined
            }
          />
        ))}
      </>
    ) : null;
  return (
    <>
      <div class="content-grid">
        <section class="sheet">
          <div class="sheet-head">
            <div>
              <div class="sheet-title">Pipeline runs</div>
              <div class="sheet-subtitle">Top-level runs · nested work stays with its parent</div>
            </div>
            <span class="sheet-subtitle">
              {props.matchingRootCount ?? props.roots.length} top-level · {props.totalRunCount}{" "}
              total
            </span>
          </div>
          <div class="run-list">
            {props.roots.length ? (
              <>
                {list("Running now", activeRuns)}
                {list("Recent", historicalRuns)}
              </>
            ) : (
              <EmptyView
                title="No recorded runs"
                copy="Choose Pipelines to start a run and create local history."
              />
            )}
          </div>
          {props.onPage && (props.matchingRootCount ?? 0) > STUDIO_HISTORY_PAGE_SIZE && (
            <div class="confirm-actions">
              <button
                class="secondary-button"
                disabled={!props.offset}
                onClick={() =>
                  props.onPage?.(Math.max(0, (props.offset ?? 0) - STUDIO_HISTORY_PAGE_SIZE))
                }
              >
                Previous
              </button>
              <span>
                {(props.offset ?? 0) + 1}–{(props.offset ?? 0) + props.roots.length} of{" "}
                {props.matchingRootCount}
              </span>
              <button
                class="secondary-button"
                disabled={
                  (props.offset ?? 0) + STUDIO_HISTORY_PAGE_SIZE >= (props.matchingRootCount ?? 0)
                }
                onClick={() => props.onPage?.((props.offset ?? 0) + STUDIO_HISTORY_PAGE_SIZE)}
              >
                Next
              </button>
            </div>
          )}
        </section>
        <RunDetail {...props} stepView={stepView} onStepView={setStepView} />
      </div>
    </>
  );
}
