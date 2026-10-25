import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { StoredRunSummary } from "../../../run-store/run-history.js";
import type { StoredPipelineRun, StoredPipelineStep } from "../../../run-store/run-store.js";
import { StepArtifacts } from "../components/artifacts.js";
import { preferredScrollBehavior } from "../components/common.js";
import type { StudioApi } from "../transport.js";
import { DEFAULT_DETAIL_RETRY_MS } from "../data-controller.js";
import type { StudioRunDetail } from "../../shared/schema.js";
import { duration, shortId, Status } from "../components/steps.js";
import { Drawer, EDGE_KIND_LABEL, Facts, runOffset, StepInspector } from "./inspector.js";

import {
  childStepTotal,
  edgeState,
  incomingEdges,
  type EdgeKind,
  type EdgeState,
} from "./dependencies.js";
import {
  buildGraphScene,
  CENTER_Y,
  RADIUS,
  LABEL_Y,
  FRAME_PADDING,
  FRAME_HEADER,
  type RunLoad,
  type RunScene,
  type ExpansionScene,
  type GraphScene,
} from "./scene.js";

const LABEL_CHARS = 18;
const MARGIN = 18;
/** Approximate advance of the 9px monospace frame header font. */
const HEADER_CHAR_WIDTH = 5.5;

const TERMINAL: Record<string, true> = { cancelled: true, completed: true, failed: true };

const ICON_PATH: Record<string, string> = {
  completed: "M-6 .5 -2 4.5 6.5-4.5",
  failed: "M-4.5-4.5 4.5 4.5M4.5-4.5-4.5 4.5",
  cancelled: "M-4-4H4V4H-4Z",
  skipped: "M-5 5 5-5",
};

type GraphSelection =
  | { kind: "step"; runId: string; stepId: string }
  | { kind: "edge"; runId: string; from: string; to: string }
  | { kind: "run"; runId: string }
  | { kind: "item"; runId: string; stepId: string; itemId: string };

/** Draw an edge as a gate once it trips, even when the source is also an input. */
function edgeLook(edge: Pick<RunScene["edges"][number], "kinds" | "state">): EdgeKind {
  return edge.state === "tripped" ? "gate" : edge.kinds[0]!;
}

const EDGE_STATE_COPY: Record<EdgeState, (from: string, to: string) => string> = {
  active: (from, to) => `${to} is running with ${from}'s output.`,
  blocked: (from, to) => `${from} did not produce an output, so ${to} could not use it.`,
  candidate: (from, to) =>
    `Candidate: ${to} has not started, so ${from}'s output is not consumed yet.`,
  settled: (from) => `The gate did not trip: ${from} neither failed nor was cancelled.`,
  tripped: (from, to) => `${from} failed or was cancelled, which skips ${to}.`,
  unused: (from, to) => `${to} did not receive ${from}'s output.`,
  used: (from, to) => `${from} produced an output that fed ${to}.`,
};

const EDGE_KIND_COPY: Record<EdgeKind, (from: string, to: string) => string> = {
  input: (from, to) => `${to} receives ${from}'s output as a required typed input.`,
  optional: (from, to) => `${to} receives ${from}'s output only when ${from} produced one.`,
  gate: (from, to) => `${to} is skipped when ${from} fails or is cancelled.`,
};

function nodeStatus(status: string | undefined): string {
  return status === undefined || status === "pending" ? "planned" : status;
}

function truncate(label: string, chars = LABEL_CHARS): string {
  return label.length > chars ? label.slice(0, Math.max(1, chars - 1)) + "…" : label;
}

interface GraphUi {
  readonly selection: GraphSelection | null;
  select(selection: GraphSelection): void;
  toggle(key: string, expanded: boolean): void;
  /** True while a node shows its one-shot terminal transition. */
  pulse(key: string, status: string): boolean;
}

function activate(action: () => void) {
  return (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    action();
  };
}

function ExpandBadge({
  count,
  expanded,
  label,
  onToggle,
}: {
  count: number;
  expanded: boolean;
  label: string;
  onToggle(): void;
}) {
  const toggle = () => onToggle();
  return (
    <g
      class={`graph-badge${expanded ? " expanded" : ""}`}
      transform={`translate(${RADIUS - 2} ${RADIUS - 3})`}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
      onClick={(event) => {
        event.stopPropagation();
        toggle();
      }}
      onKeyDown={activate(toggle)}
    >
      <circle r={8} />
      <text dy={3}>{expanded ? "−" : count > 99 ? "99+" : count}</text>
    </g>
  );
}

interface GraphNodeProps {
  badge?: ComponentChildren;
  cx: number;
  kind: "item" | "run" | "step";
  label: string;
  onSelect(): void;
  pulse: boolean;
  selected: boolean;
  status: string;
  title: string;
}

function GraphNode(props: GraphNodeProps) {
  const icon = ICON_PATH[props.status];
  return (
    <g
      class={`graph-node ${props.kind} ${props.status}${props.selected ? " selected" : ""}${props.pulse ? " pulse" : ""}`}
      transform={`translate(${props.cx} ${CENTER_Y})`}
    >
      <g
        class="graph-hit"
        role="button"
        tabIndex={0}
        aria-pressed={props.selected}
        aria-label={`${props.title}: ${props.status}`}
        onClick={props.onSelect}
        onKeyDown={activate(props.onSelect)}
      >
        <title>{`${props.title} · ${props.status}`}</title>
        <circle class="graph-halo" r={RADIUS + 8} />
        <circle class="graph-focus" r={RADIUS + 4} />
        <circle class="graph-disc" r={RADIUS} />
        {props.kind === "run" && <circle class="graph-ring" r={RADIUS - 4} />}
        <circle class="graph-spinner" r={RADIUS} pathLength={100} />
        {icon && <path class="graph-icon" d={icon} pathLength={20} />}
        <text class="graph-label" y={LABEL_Y - CENTER_Y}>
          {truncate(props.label)}
        </text>
      </g>
      {props.badge}
    </g>
  );
}

function sameSelection(left: GraphSelection | null, right: GraphSelection): boolean {
  return left !== null && JSON.stringify(left) === JSON.stringify(right);
}

function ExpansionView({
  expansion,
  run,
  step,
  ui,
}: {
  expansion: ExpansionScene;
  run: StoredPipelineRun;
  step: StoredPipelineStep;
  ui: GraphUi;
}) {
  return (
    <g class="graph-expansion" transform={`translate(${expansion.x} ${expansion.y})`}>
      <rect class="graph-frame" width={expansion.width} height={expansion.height} rx={10} />
      {expansion.links.map((path) => (
        <path key={path} class="graph-sequence" d={path} />
      ))}
      {expansion.items.map((item) => {
        if (item.kind === "item") {
          const selection: GraphSelection = {
            kind: "item",
            runId: run.runId,
            stepId: step.id,
            itemId: item.detail.id,
          };
          const status = nodeStatus(item.detail.status ?? "running");
          return (
            <g key={"item:" + item.detail.id} transform={`translate(${item.x} ${item.y})`}>
              <GraphNode
                cx={item.width / 2}
                kind="item"
                label={item.label}
                title={item.label}
                status={status}
                selected={sameSelection(ui.selection, selection)}
                pulse={ui.pulse(`${run.runId}/${step.id}/${item.detail.id}`, status)}
                onSelect={() => ui.select(selection)}
              />
            </g>
          );
        }
        const { summary } = item;
        const selection: GraphSelection = { kind: "run", runId: summary.runId };
        const badge = (
          <ExpandBadge
            count={summary.stepCount}
            expanded={item.expanded}
            label={item.label}
            onToggle={() => ui.toggle(summary.runId, !item.expanded)}
          />
        );
        if (item.graph) {
          return (
            <g key={summary.runId} transform={`translate(${item.x} ${item.y})`}>
              <rect
                class={`graph-run-frame ${summary.status}${sameSelection(ui.selection, selection) ? " selected" : ""}`}
                width={item.width}
                height={item.height}
                rx={8}
              />
              <g
                class="graph-run-header"
                role="button"
                tabIndex={0}
                aria-label={`Inspect nested run ${item.label}`}
                onClick={() => ui.select(selection)}
                onKeyDown={activate(() => ui.select(selection))}
              >
                <rect width={item.width} height={FRAME_HEADER - 4} rx={8} />
                <text x={10} y={15}>
                  {truncate(
                    item.label === summary.pipelineId
                      ? item.label
                      : `${item.label} · ${summary.pipelineId}`,
                    Math.floor((item.width - 40) / HEADER_CHAR_WIDTH)
                  )}
                </text>
              </g>
              <g transform={`translate(${item.width - 12 - (RADIUS - 2)} ${11 - (RADIUS - 3)})`}>
                {badge}
              </g>
              <g transform={`translate(${(item.width - item.graph.width) / 2} ${FRAME_HEADER})`}>
                <RunSceneView scene={item.graph} ui={ui} />
              </g>
            </g>
          );
        }
        return (
          <g key={summary.runId} transform={`translate(${item.x} ${item.y})`}>
            <GraphNode
              cx={item.width / 2}
              kind="run"
              label={item.unavailable ? "unavailable" : item.expanded ? "loading…" : item.label}
              title={`${item.label} (${summary.pipelineId})`}
              status={summary.status}
              selected={sameSelection(ui.selection, selection)}
              pulse={ui.pulse(summary.runId, summary.status)}
              onSelect={() => ui.select(selection)}
              badge={item.unavailable || !item.expandable ? undefined : badge}
            />
          </g>
        );
      })}
      {expansion.more && (
        <text class="graph-more" x={expansion.width / 2} y={expansion.height - FRAME_PADDING}>
          {expansion.more}
        </text>
      )}
    </g>
  );
}

function RunSceneView({ scene, ui }: { scene: RunScene; ui: GraphUi }) {
  const runId = scene.run.runId;
  return (
    <g class="graph-run">
      {scene.edges.map((edge) => {
        const selection: GraphSelection = { kind: "edge", runId, from: edge.from, to: edge.to };
        const select = () => ui.select(selection);
        return (
          <g
            key={edge.from + "->" + edge.to}
            class={`graph-edge-group ${edgeLook(edge)} ${edge.state}${sameSelection(ui.selection, selection) ? " selected" : ""}`}
            role="button"
            tabIndex={0}
            aria-label={`Connection ${edge.from} to ${edge.to}`}
            onClick={select}
            onKeyDown={activate(select)}
          >
            <title>{`${edge.from} → ${edge.to} · ${edge.kinds.map((kind) => EDGE_KIND_LABEL[kind]).join(", ")}`}</title>
            <path class="graph-edge-hit" d={edge.path} />
            <path class="graph-edge" d={edge.path} />
            {edge.state === "active" && <path class="graph-edge-flow" d={edge.path} />}
            <path class="graph-edge-head" d={edge.head} />
          </g>
        );
      })}
      {scene.steps.map((node) => {
        const { step } = node;
        const selection: GraphSelection = { kind: "step", runId, stepId: step.id };
        return (
          <g key={step.id} transform={`translate(${node.x} ${node.y})`}>
            {node.expansion && (
              <ExpansionView expansion={node.expansion} run={scene.run} step={step} ui={ui} />
            )}
            <GraphNode
              cx={node.width / 2}
              kind="step"
              label={step.name || step.id}
              title={step.name ? `${step.name} (${step.id})` : step.id}
              status={step.status}
              selected={sameSelection(ui.selection, selection)}
              pulse={ui.pulse(node.key, step.status)}
              onSelect={() => ui.select(selection)}
              badge={
                node.itemCount > 0 && (
                  <ExpandBadge
                    count={node.itemCount}
                    expanded={node.expanded}
                    label={step.name || step.id}
                    onToggle={() => ui.toggle(node.key, !node.expanded)}
                  />
                )
              }
            />
          </g>
        );
      })}
    </g>
  );
}

/** Drawer content for the current selection, or null when nothing valid is selected. */
function inspectorContent({
  selection,
  ctx,
  ui,
  onOpenRun,
}: {
  selection: GraphSelection | null;
  ctx: GraphScene;
  ui: GraphUi;
  onOpenRun(runId: string, pipelineId?: string): void;
}) {
  const run = selection ? ctx.runs.get(selection.runId) : undefined;
  if (selection?.kind === "run") {
    const summary = ctx.summaries.get(selection.runId);
    if (summary) {
      const parent = summary.parentRunId ? ctx.runs.get(summary.parentRunId) : undefined;
      const tool = parent?.agentTurn?.calls.find(
        (call) => call.callId === summary.origin?.itemKey
      )?.tool;
      const expanded = ctx.wanted.has(summary.runId);
      return (
        <div class="graph-inspector">
          <div class="graph-kicker">Nested run</div>
          <h3>{summary.pipelineId}</h3>
          <Status value={summary.status} />
          <Facts
            rows={[
              ["Run", <code title={summary.runId}>{shortId(summary.runId)}</code>],
              ...(summary.origin?.stepId
                ? [["Started by", <code>{summary.origin.stepId}</code>] as const]
                : []),
              ...(tool ? [["Tool", <code>{tool}</code>] as const] : []),
              ...(summary.origin?.iteration !== undefined
                ? [["Iteration", String(summary.origin.iteration)] as const]
                : []),
              ...(summary.origin?.itemKey !== undefined && !tool
                ? [["Item", <code>{summary.origin.itemKey}</code>] as const]
                : []),
              ["Duration", duration(summary.durationMs)],
              ["Steps", String(summary.stepCount)],
              ["Nested", String(summary.descendantCount)],
            ]}
          />
          <div class="graph-actions">
            <button
              class="primary-button"
              type="button"
              onClick={() => onOpenRun(summary.runId, summary.pipelineId)}
            >
              Open run
            </button>
            {ctx.expandable.has(summary.runId) && (
              <button
                class="secondary-button"
                type="button"
                onClick={() => ui.toggle(summary.runId, !expanded)}
              >
                {expanded ? "Collapse steps" : "Show steps"}
              </button>
            )}
          </div>
          {ctx.canLoad && !ctx.expandable.has(summary.runId) && (
            <p class="graph-hint">
              This run is nested too deeply to draw here. Open it to see its steps.
            </p>
          )}
        </div>
      );
    }
  }
  if (run && selection?.kind === "item") {
    const step = run.steps.find((candidate) => candidate.id === selection.stepId);
    const detail = step?.progress?.details?.find((candidate) => candidate.id === selection.itemId);
    if (step && detail) {
      return (
        <div class="graph-inspector">
          <div class="graph-kicker">Dynamic item · {step.name || step.id}</div>
          <h3>{detail.name ?? detail.id}</h3>
          <Status
            value={nodeStatus(detail.status ?? "running")}
            outputSource={detail.outputSource}
          />
          <Facts
            rows={[
              ["Item", <code>{detail.id}</code>],
              ...(detail.label ? [["Activity", detail.label] as const] : []),
              ...(detail.total !== undefined
                ? [["Progress", `${detail.completed ?? 0} / ${detail.total}`] as const]
                : []),
            ]}
          />
          <p class="graph-hint">
            Reported by {step.id}'s progress. No nested run was recorded for this item.
          </p>
          <div class="graph-actions">
            <button
              class="secondary-button"
              type="button"
              onClick={() => ui.select({ kind: "step", runId: run.runId, stepId: step.id })}
            >
              Inspect {step.id}
            </button>
          </div>
        </div>
      );
    }
  }
  if (run && selection?.kind === "edge") {
    const source = run.steps.find((step) => step.id === selection.from);
    const target = run.steps.find((step) => step.id === selection.to);
    const kinds = target ? incomingEdges(target).get(selection.from) : undefined;
    if (source && target && kinds) {
      const state = edgeState(kinds, source, target);
      return (
        <div class="graph-inspector">
          <div class="graph-kicker">Connection · {run.pipelineId}</div>
          <h3>
            {source.id} → {target.id}
          </h3>
          {kinds.map((kind) => (
            <p class="graph-hint" key={kind}>
              <b>{EDGE_KIND_LABEL[kind]}.</b> {EDGE_KIND_COPY[kind](source.id, target.id)}
            </p>
          ))}
          <p class={`graph-edge-state ${state}`}>{EDGE_STATE_COPY[state](source.id, target.id)}</p>
          <Facts
            rows={[
              ["Source", <Status value={source.status} outputSource={source.outputSource} />],
              ["Target", <Status value={target.status} outputSource={target.outputSource} />],
              ["Output ready", runOffset(run, source.finishedAtMs)],
              ["Consumed", runOffset(run, target.startedAtMs)],
            ]}
          />
          {source.artifacts && source.artifacts.length > 0 && (
            <div class="graph-io">
              <h4>Recorded source artifacts</h4>
              <StepArtifacts artifacts={source.artifacts} stepId={source.id} />
            </div>
          )}
          <div class="graph-actions">
            {[source, target].map((step) => (
              <button
                class="secondary-button"
                type="button"
                key={step.id}
                onClick={() => ui.select({ kind: "step", runId: run.runId, stepId: step.id })}
              >
                Inspect {step.id}
              </button>
            ))}
          </div>
        </div>
      );
    }
  }
  if (run && selection?.kind === "step") {
    const step = run.steps.find((candidate) => candidate.id === selection.stepId);
    if (step) {
      const childRuns = (ctx.children.get(run.runId) ?? []).filter(
        (child) => child.origin?.stepId === step.id
      );
      return (
        <StepInspector
          run={run}
          step={step}
          childRuns={childRuns}
          childTotal={childStepTotal(
            ctx.childSteps.get(run.runId) ?? [],
            step.id,
            childRuns.length
          )}
          onOpenRun={onOpenRun}
          onSelectInput={(id) =>
            ui.select({ kind: "edge", runId: run.runId, from: id, to: step.id })
          }
          onSelectConsumer={(id) =>
            ui.select({ kind: "edge", runId: run.runId, from: step.id, to: id })
          }
        />
      );
    }
  }
  return null;
}

function usePulse(): (key: string, status: string) => boolean {
  const seen = useRef(new Map<string, string>());
  const pulsing = useRef(new Set<string>());
  return (key, status) => {
    const previous = seen.current.get(key);
    seen.current.set(key, status);
    if (previous !== undefined && previous !== status) {
      if (TERMINAL[status]) pulsing.current.add(key);
      else pulsing.current.delete(key);
    }
    return pulsing.current.has(key);
  };
}

/** Fingerprint of one expanded child. Detail reloads only when this value changes. */
export function expandedRunWatchKey(
  summary: Pick<StoredRunSummary, "runId" | "eventCount" | "subtreeEventCount" | "status">
): string {
  return JSON.stringify([
    summary.runId,
    summary.eventCount,
    summary.subtreeEventCount,
    summary.status,
  ]);
}

/**
 * Expanded children whose last successful load does not match `keys`.
 * A missing entry is loaded again, so a failed request is retried without a fingerprint change.
 */
export function expandedRunsToLoad(
  keys: readonly string[],
  loaded: ReadonlyMap<string, string>
): { key: string; runId: string }[] {
  const pending: { key: string; runId: string }[] = [];
  for (const key of keys) {
    const runId: unknown = JSON.parse(key)[0];
    if (typeof runId === "string" && loaded.get(runId) !== key) pending.push({ key, runId });
  }
  return pending;
}

export interface RunGraphProps {
  detail: StudioRunDetail;
  /** Loads nested run steps for in-place expansion; nested runs stay collapsed without it. */
  api?: Pick<StudioApi, "loadRunDetail">;
  onOpenRun(runId: string, pipelineId?: string): void;
  /** Top-level step to select, following the page URL. */
  selectedStepId?: string;
  /** Changes when a diagnostic asks to reveal the selected step. */
  focusRequest?: number;
  /** Reports a top-level step selection, or null for any other selection or none. */
  onSelectStep?(stepId: string | null): void;
}

/** Live top-to-bottom DAG of one run's steps with expandable child pipelines. */
export function RunGraph({
  detail,
  api,
  onOpenRun,
  selectedStepId,
  focusRequest,
  onSelectStep,
}: RunGraphProps) {
  const runId = detail.run.runId;
  const [toggles, setToggles] = useState<ReadonlyMap<string, boolean>>(new Map());
  const opened = useRef<ReadonlySet<string>>(new Set());
  const [loads, setLoads] = useState<ReadonlyMap<string, RunLoad>>(new Map());
  const [selection, setSelection] = useState<GraphSelection | null>(() =>
    selectedStepId ? { kind: "step", runId, stepId: selectedStepId } : null
  );
  const loadedKeys = useRef(new Map<string, string>());
  const [retry, setRetry] = useState(0);
  const pulse = usePulse();
  const drawer = useRef<HTMLDivElement>(null);
  const select = (next: GraphSelection | null) => {
    setSelection(next);
    onSelectStep?.(next?.kind === "step" && next.runId === runId ? next.stepId : null);
  };
  // Follow the page's step: select it, or drop a top-level step selection it no longer names.
  useEffect(() => {
    setSelection((current) => {
      const ownStep = current?.kind === "step" && current.runId === runId;
      if (!selectedStepId) return ownStep ? null : current;
      return ownStep && current.stepId === selectedStepId
        ? current
        : { kind: "step", runId, stepId: selectedStepId };
    });
  }, [runId, selectedStepId]);
  useEffect(() => {
    if (focusRequest)
      drawer.current?.scrollIntoView({ block: "nearest", behavior: preferredScrollBehavior() });
  }, [focusRequest]);
  const ctx = buildGraphScene(detail, {
    loads,
    toggles,
    opened: opened.current,
    canLoad: api !== undefined,
  });
  opened.current = ctx.opened;
  const { scene } = ctx;
  const watch = [...ctx.wanted]
    .sort()
    .map((runId) => expandedRunWatchKey(ctx.summaries.get(runId)!))
    .join("\n");

  // Reload an expanded child when its own event count, subtree size, or status changes.
  // A failed request is not recorded, so the retry loads that child again even when a
  // finished run will not change its fingerprint. The last loaded detail stays in place.
  useEffect(() => {
    if (!api || !watch) return;
    const pending = expandedRunsToLoad(watch.split("\n"), loadedKeys.current);
    if (pending.length === 0) return;
    let current = true;
    let retryQueued = false;
    for (const { key, runId } of pending) {
      api.loadRunDetail(runId).then(
        (loaded) => {
          if (!current) return;
          loadedKeys.current.set(runId, key);
          setLoads((previous) => new Map(previous).set(runId, loaded ?? "missing"));
        },
        () => {
          if (current && !retryQueued) {
            retryQueued = true;
            setTimeout(() => {
              if (current) setRetry((count) => count + 1);
            }, DEFAULT_DETAIL_RETRY_MS);
          }
        }
      );
    }
    return () => {
      current = false;
    };
  }, [api, watch, retry]);

  const ui: GraphUi = {
    selection,
    select,
    toggle: (key, expanded) => setToggles((previous) => new Map(previous).set(key, expanded)),
    pulse,
  };
  const width = scene.width + MARGIN * 2;
  const height = scene.height + MARGIN * 2;
  const inspector = inspectorContent({ selection, ctx, ui, onOpenRun });
  return (
    <div class={`steps-layout${inspector ? " has-drawer" : ""}`}>
      <section class="graph-panel" aria-label="Run graph">
        <div class="graph-canvas">
          <svg
            width={width}
            height={height}
            viewBox={`${-MARGIN} ${-MARGIN} ${width} ${height}`}
            role="group"
            aria-label={`${detail.run.pipelineId} step graph`}
          >
            <RunSceneView scene={scene} ui={ui} />
          </svg>
        </div>
        <div class="graph-legend" aria-hidden="true">
          <span>
            <i class="running" />
            Running
          </span>
          <span>
            <i class="completed" />
            Completed
          </span>
          <span>
            <i class="failed" />
            Failed
          </span>
          <span>
            <i class="cancelled" />
            Cancelled
          </span>
          <span>
            <i class="skipped" />
            Skipped
          </span>
          <span>
            <i class="planned" />
            Planned
          </span>
          <span>
            <b class="candidate" />
            Candidate input
          </span>
          <span>
            <b class="used" />
            Consumed input
          </span>
          <span>
            <b class="gate" />
            Failure gate
          </span>
          <span>
            <i class="run" />
            Nested run
          </span>
          {!inspector && (
            <span class="graph-legend-hint">
              Select a step, connection, or nested run to inspect it.
            </span>
          )}
        </div>
      </section>
      {inspector && (
        <div ref={drawer} class="drawer-slot">
          <Drawer onClose={() => select(null)}>{inspector}</Drawer>
        </div>
      )}
    </div>
  );
}
