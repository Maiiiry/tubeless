import { STUDIO_HISTORY_PAGE_SIZE, type StudioRunDetail } from "./run-store-ui-schema.js";
import type { StoredRunSummary } from "../run-store/run-history.js";
import { Status, StepRow, duration, shortId } from "./run-store-ui-steps.js";
import { RunGraph } from "./run-store-ui-graph.js";
import { ErrorDiagnostics, RunLogs } from "./run-store-ui-debugging.js";
import { childStepTotal, Drawer, StepInspector } from "./run-store-ui-inspector.js";
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
  label: string;
  nowMs: number;
  onSelect(id: string): void;
  run: StoredRunSummary;
  selected: boolean;
}

function RunRow({ label, nowMs, onSelect, run, selected }: RunRowProps) {
  const activeSteps = run.activity;
  const nestedCount = run.descendantCount;
  return (
    <button
      class={`run-row ${run.status} ${selected ? "selected" : ""}`}
      data-run-id={run.runId}
      onClick={() => onSelect(run.runId)}
    >
      <div class="run-primary">
        <Status value={run.status} />
        <strong>{label}</strong>
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

export function NestedRuns({
  api,
  detail,
  onSelect,
}: {
  api?: Pick<StudioApi, "loadChildRuns">;
  detail: StudioRunDetail;
  /** Receives the child's pipeline so its run page can scope the list to it. */
  onSelect(id: string, pipelineId?: string): void;
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
              onClick={() => onSelect(child.runId, child.pipelineId)}
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
type RunTab = "steps" | "logs" | "nested" | "details";

const clockFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

/** A run's name within its pipeline: start time, plus the item or iteration it handled. */
export function runLabel({
  startedAtMs,
  itemKey,
  iteration,
}: {
  startedAtMs: number;
  itemKey?: string;
  iteration?: number;
}) {
  const time = Number.isFinite(startedAtMs) ? clockFormat.format(startedAtMs) : "";
  const handled = itemKey ?? (iteration !== undefined ? `#${iteration}` : undefined);
  return `Run ${time}${handled !== undefined ? ` · ${handled}` : ""}`;
}

/** Label inputs for a listed run, from its recorded origin. */
const summaryLabel = (run: StoredRunSummary) => ({
  startedAtMs: run.startedAtMs,
  itemKey: run.origin?.itemKey,
  iteration: run.origin?.iteration,
});

interface RunListProps {
  runs: readonly StoredRunSummary[];
  nowMs: number;
  onSelect(id: string): void;
  /** Highlights this run, or the top-level run that contains it. */
  selectedRunId?: string;
  selectedRootRunId?: string;
  /** Pipeline-scoped lists name runs by time instead of repeating the pipeline. */
  showPipeline: boolean;
  /** Display name for a pipeline ID, such as a registered command's name. */
  pipelineName?(pipelineId: string): string;
  title: string;
  subtitle: string;
  count: string;
  empty: { title: string; copy: string };
  matchingCount?: number;
  offset?: number;
  onPage?(offset: number): void;
}

export function RunList(props: RunListProps) {
  const active = props.runs.filter((run) => run.subtreeIsRunning);
  const recent = props.runs.filter((run) => !run.subtreeIsRunning);
  const offset = props.offset ?? 0;
  const matching = props.matchingCount ?? props.runs.length;
  const group = (label: string, runs: readonly StoredRunSummary[]) =>
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
            label={
              props.showPipeline
                ? (props.pipelineName?.(run.pipelineId) ?? run.pipelineId)
                : runLabel(summaryLabel(run))
            }
            selected={run.runId === props.selectedRunId || run.runId === props.selectedRootRunId}
          />
        ))}
      </>
    ) : null;
  return (
    <section class="sheet run-list-sheet">
      <div class="sheet-head">
        <div>
          <div class="sheet-title">{props.title}</div>
          <div class="sheet-subtitle">{props.subtitle}</div>
        </div>
        <span class="sheet-subtitle">{props.count}</span>
      </div>
      <div class="run-list">
        {props.runs.length ? (
          <>
            {group("Running now", active)}
            {group("Recent", recent)}
          </>
        ) : (
          <EmptyView title={props.empty.title} copy={props.empty.copy} />
        )}
      </div>
      {props.onPage && matching > STUDIO_HISTORY_PAGE_SIZE && (
        <div class="confirm-actions">
          <button
            class="secondary-button"
            disabled={!offset}
            onClick={() => props.onPage?.(Math.max(0, offset - STUDIO_HISTORY_PAGE_SIZE))}
          >
            Previous
          </button>
          <span>
            {offset + 1}–{offset + props.runs.length} of {matching}
          </span>
          <button
            class="secondary-button"
            disabled={offset + STUDIO_HISTORY_PAGE_SIZE >= matching}
            onClick={() => props.onPage?.(offset + STUDIO_HISTORY_PAGE_SIZE)}
          >
            Next
          </button>
        </div>
      )}
    </section>
  );
}

interface RunCrumbsProps {
  detail: StudioRunDetail;
  /** The selected run's summary, which attributes older recordings to a starting step. */
  summary?: StoredRunSummary;
  onOpenPipeline(pipelineId: string): void;
  /** Opens a run, optionally with one of its steps selected. */
  onOpenRun(runId: string, stepId?: string): void;
  pipelineName?(pipelineId: string): string;
}

interface Crumb {
  runId: string;
  pipelineId: string;
  startedAtMs: number;
  itemKey?: string;
  iteration?: number;
  /** Step in the parent run that started this run. */
  stepId?: string;
}

/** Path from the top-level run to this one, through each pipeline and starting step. */
export function RunCrumbs({
  detail,
  summary,
  onOpenPipeline,
  onOpenRun,
  pipelineName = (pipelineId) => pipelineId,
}: RunCrumbsProps) {
  const { run } = detail;
  const chain: Crumb[] = [
    ...detail.ancestors.map((ancestor) => ({
      runId: ancestor.runId,
      pipelineId: ancestor.pipelineId,
      startedAtMs: ancestor.startedAtMs,
      itemKey: ancestor.origin?.itemKey,
      iteration: ancestor.origin?.iteration,
      stepId: ancestor.origin?.stepId,
    })),
    {
      runId: run.runId,
      pipelineId: run.pipelineId,
      startedAtMs: run.startedAtMs,
      itemKey: run.itemKey ?? summary?.origin?.itemKey,
      iteration: run.iteration?.index ?? summary?.origin?.iteration,
      stepId: run.parentStepId ?? summary?.origin?.stepId,
    },
  ];
  return (
    <nav class="crumbs" aria-label="Run location">
      {chain.map((crumb, index) => {
        const parent = chain[index - 1];
        return (
          <span key={crumb.runId}>
            {parent && crumb.stepId && (
              <>
                <button type="button" onClick={() => onOpenRun(parent.runId, crumb.stepId)}>
                  {crumb.stepId}
                </button>
                <i>/</i>
              </>
            )}
            <button type="button" onClick={() => onOpenPipeline(crumb.pipelineId)}>
              {pipelineName(crumb.pipelineId)}
            </button>
            <i>/</i>
            {index === chain.length - 1 ? (
              <span aria-current="page">{runLabel(crumb)}</span>
            ) : (
              <>
                <button type="button" onClick={() => onOpenRun(crumb.runId)}>
                  {runLabel(crumb)}
                </button>
                <i>/</i>
              </>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/** Exact identifiers behind a run: IDs, event count, and the definition that produced it. */
export function RunDetails({ run }: { run: StoredPipelineRun }) {
  return (
    <dl class="run-definition-facts">
      <dt>Run ID</dt>
      <dd>
        <code>{run.runId}</code>
      </dd>
      {run.correlationId && (
        <>
          <dt>Correlation ID</dt>
          <dd>
            <code>{run.correlationId}</code>
          </dd>
        </>
      )}
      <dt>Started</dt>
      <dd>
        <code>{isoTime(run.startedAtMs)}</code>
      </dd>
      <dt>Events</dt>
      <dd>{run.eventCount}</dd>
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
  );
}

interface RunDetailProps {
  api?: StudioApi;
  canCancel: boolean;
  cancelling: boolean;
  liveRunIds: readonly string[];
  nowMs: number;
  onCancel(id: string): void;
  onCopyLink(id: string): void;
  /** Opens a run; nested-run links pass the run's pipeline when they know it. */
  onSelect(id: string, pipelineId?: string): void;
  onStepView?(view: StepView): void;
  selection: StudioRunSelection;
  stepView?: StepView;
  latestRunId?: string;
  /** Step shown in the inspector drawer. */
  stepId?: string;
  onSelectStep?(stepId: string | null): void;
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
  stepId,
  onSelectStep,
}: RunDetailProps) {
  const [tab, setTab] = useState<RunTab>("steps");
  const [focusRequest, setFocusRequest] = useState(0);
  useEffect(() => {
    if (stepId) setTab("steps");
  }, [stepId]);
  useEffect(() => {
    if (!focusRequest || !stepId || stepView !== "timeline") return;
    const row = document.querySelector<HTMLElement>(
      `.step-list [data-step-id="${CSS.escape(stepId)}"]`
    );
    if (!row) return;
    row.scrollIntoView({ block: "center", behavior: preferredScrollBehavior() });
    row.classList.remove("focused");
    void row.offsetWidth;
    row.classList.add("focused");
  }, [focusRequest]);
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
  const { run } = detail;
  const drawerStep = stepId ? run.steps.find((step) => step.id === stepId) : undefined;
  const revealStep = (id: string) => {
    setTab("steps");
    onSelectStep?.(id);
    setFocusRequest((request) => request + 1);
  };
  const tabs: [RunTab, string][] = [
    ["steps", `Steps · ${run.steps.length}`],
    ...(run.logs.length ? [["logs", `Logs · ${run.logs.length}`] as [RunTab, string]] : []),
    ...(detail.childCount
      ? [["nested", `Nested runs · ${detail.descendantCount}`] as [RunTab, string]]
      : []),
    ["details", "Details"],
  ];
  const activeTab = tabs.some(([id]) => id === tab) ? tab : "steps";
  return (
    <article class="sheet detail">
      <div class="detail-body">
        <div class="detail-heading">
          <div class="detail-heading-copy">
            <h2 class={`run-outcome ${run.status}`}>{runOutcome(run)}</h2>
            <p class="run-meta">
              <span title={isoTime(run.startedAtMs)}>Started {dateTime(run.startedAtMs)}</span>
              <span>{relativeTime(run.startedAtMs, nowMs)}</span>
              <span>{duration(run.durationMs)}</span>
              {run.correlationId && <span>Correlation {run.correlationId}</span>}
              {run.dryRun && <span>Dry run</span>}
            </p>
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
              onSelectStep={revealStep}
            />
          </>
        )}
        <div class="run-tabs" role="tablist" aria-label="Run sections">
          {tabs.map(([id, label]) => (
            <button
              type="button"
              role="tab"
              key={id}
              aria-selected={activeTab === id}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        {activeTab === "steps" && (
          <>
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
              <RunGraph
                key={run.runId}
                detail={detail}
                api={api}
                onOpenRun={onSelect}
                selectedStepId={stepId}
                focusRequest={focusRequest}
                onSelectStep={(id) => onSelectStep?.(id)}
              />
            ) : (
              <div class={`steps-layout${drawerStep ? " has-drawer" : ""}`}>
                <div class="step-list">
                  {run.steps.map((step) => (
                    <StepRow
                      key={step.id}
                      step={step}
                      steps={run.steps}
                      selected={step.id === drawerStep?.id}
                      onSelect={onSelectStep && (() => onSelectStep(step.id))}
                    />
                  ))}
                </div>
                {drawerStep && (
                  <div class="drawer-slot">
                    <Drawer onClose={() => onSelectStep?.(null)}>
                      <StepInspector
                        run={run}
                        step={drawerStep}
                        childRuns={detail.children.filter(
                          (child) => child.origin?.stepId === drawerStep.id
                        )}
                        childTotal={childStepTotal(
                          detail.childSteps,
                          drawerStep.id,
                          detail.children.filter((child) => child.origin?.stepId === drawerStep.id)
                            .length
                        )}
                        onOpenRun={onSelect}
                        onSelectInput={(id) => onSelectStep?.(id)}
                        onSelectConsumer={(id) => onSelectStep?.(id)}
                      />
                    </Drawer>
                  </div>
                )}
              </div>
            )}
          </>
        )}
        {activeTab === "logs" && <RunLogs key={run.runId} logs={run.logs} />}
        {activeTab === "nested" && (
          <NestedRuns key={run.runId} api={api} detail={detail} onSelect={onSelect} />
        )}
        {activeTab === "details" && <RunDetails run={run} />}
      </div>
    </article>
  );
}

interface RunsViewProps extends RunDetailProps {
  roots: readonly StoredRunSummary[];
  /** Pipeline whose runs the list shows; absent for all top-level runs. */
  pipelineId?: string;
  /** The run list still shows another scope while this one loads. */
  listLoading?: boolean;
  pipelineName?(pipelineId: string): string;
  matchingRootCount?: number;
  offset?: number;
  onPage?(offset: number): void;
  totalRunCount: number;
}

/** Run page: the scoped run list beside one run's details. */
export function RunsView(props: RunsViewProps) {
  const [stepView, setStepView] = useState<StepView>(props.stepView ?? "timeline");
  const selected =
    props.selection.status === "ready" || props.selection.status === "loading"
      ? props.selection
      : undefined;
  const matching = props.matchingRootCount ?? props.roots.length;
  return (
    <div class="content-grid run-page">
      <RunList
        runs={props.roots}
        nowMs={props.nowMs}
        onSelect={props.onSelect}
        selectedRunId={selected?.runId}
        selectedRootRunId={props.pipelineId ? undefined : selected?.summary?.rootRunId}
        showPipeline={!props.pipelineId}
        pipelineName={props.pipelineName}
        title={
          props.pipelineId
            ? `${props.pipelineName?.(props.pipelineId) ?? props.pipelineId} runs`
            : "Pipeline runs"
        }
        subtitle={
          props.pipelineId
            ? "Including runs started by other pipelines"
            : "Top-level runs · nested work stays with its parent"
        }
        count={
          props.pipelineId
            ? plural(matching, "run")
            : `${matching} top-level · ${props.totalRunCount} total`
        }
        empty={
          props.listLoading
            ? { title: "Loading runs", copy: "Loading this list." }
            : {
                title: "No recorded runs",
                copy: "Start a run from a pipeline page to create local history.",
              }
        }
        matchingCount={matching}
        offset={props.offset}
        onPage={props.onPage}
      />
      <RunDetail
        key={selected?.runId ?? props.selection.status}
        {...props}
        stepView={stepView}
        onStepView={setStepView}
      />
    </div>
  );
}
