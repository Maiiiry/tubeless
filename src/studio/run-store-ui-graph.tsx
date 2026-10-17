import { Fragment, type ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { PipelineStepProgressDetail } from "../core/pipeline.js";
import type { StoredRunSummary } from "../run-store/run-history.js";
import type { StoredPipelineRun, StoredPipelineStep } from "../run-store/run-store.js";
import { StepArtifacts } from "./run-store-ui-artifacts.js";
import { layoutDag } from "./run-store-ui-graph-layout.js";
import type { StudioApi } from "./run-store-ui-client-transport.js";
import { DEFAULT_DETAIL_RETRY_MS } from "./run-store-ui-data-controller.js";
import {
  STUDIO_CHILD_PAGE_SIZE,
  type StudioChildStep,
  type StudioRunDetail,
} from "./run-store-ui-schema.js";
import { duration, shortId, Status, StepRow } from "./run-store-ui-steps.js";

const SLOT_WIDTH = 124;
const NODE_HEIGHT = 64;
const CENTER_Y = 20;
const RADIUS = 15;
const LABEL_Y = 50;
const LABEL_CHARS = 18;
const COLUMN_GAP = 14;
const ROW_GAP = 36;
const FRAME_PADDING = 12;
const FRAME_HEADER = 26;
const MORE_HEIGHT = 18;
const ITEM_COLUMNS = 4;
const ITEM_LIMIT = STUDIO_CHILD_PAGE_SIZE;
const MAX_DEPTH = 6;
const MARGIN = 18;
/** Approximate advance of the 9px monospace frame header font. */
const HEADER_CHAR_WIDTH = 5.5;

type EdgeKind = "input" | "optional" | "gate";
type EdgeState = "active" | "blocked" | "candidate" | "settled" | "tripped" | "unused" | "used";

const EDGE_KIND_LABEL: Record<EdgeKind, string> = {
  input: "Required input",
  optional: "Optional input",
  gate: "Failure gate",
};

const TERMINAL: Record<string, true> = { cancelled: true, completed: true, failed: true };

const ICON_PATH: Record<string, string> = {
  completed: "M-6 .5 -2 4.5 6.5-4.5",
  failed: "M-4.5-4.5 4.5 4.5M4.5-4.5-4.5 4.5",
  cancelled: "M-4-4H4V4H-4Z",
  skipped: "M-5 5 5-5",
};

/** Expanded child pipeline detail; `missing` when the store has no record of the run. */
type RunLoad = StudioRunDetail | "missing";

type GraphSelection =
  | { kind: "step"; runId: string; stepId: string }
  | { kind: "edge"; runId: string; from: string; to: string }
  | { kind: "run"; runId: string }
  | { kind: "item"; runId: string; stepId: string; itemId: string };

interface EdgeScene {
  from: string;
  to: string;
  kinds: EdgeKind[];
  state: EdgeState;
  path: string;
  head: string;
}

interface StepScene {
  key: string;
  step: StoredPipelineStep;
  x: number;
  y: number;
  width: number;
  height: number;
  itemCount: number;
  expanded: boolean;
  expansion?: ExpansionScene;
}

interface RunScene {
  run: StoredPipelineRun;
  width: number;
  height: number;
  steps: StepScene[];
  edges: EdgeScene[];
}

interface PlacedItem {
  x: number;
  y: number;
  width: number;
  height: number;
}

type ItemScene = PlacedItem &
  (
    | {
        kind: "run";
        summary: StoredRunSummary;
        label: string;
        /** Whether the graph can draw this run's steps inline, rather than only open it. */
        expandable: boolean;
        expanded: boolean;
        graph?: RunScene;
        unavailable: boolean;
      }
    | { kind: "item"; detail: PipelineStepProgressDetail; label: string }
  );

interface ExpansionScene {
  x: number;
  y: number;
  width: number;
  height: number;
  items: ItemScene[];
  links: string[];
  /** Explains items the expansion does not draw, and where to find them. */
  more?: string;
}

interface SceneContext {
  readonly loads: ReadonlyMap<string, RunLoad>;
  readonly toggles: ReadonlyMap<string, boolean>;
  /** Keys auto-expanded while running; they stay open until the user collapses them. */
  readonly opened: Set<string>;
  readonly canLoad: boolean;
  /** Nested runs the graph can expand; deeper runs only open on their own page. */
  readonly expandable: Set<string>;
  /** Expanded child runs whose detail must be loaded and refreshed. */
  readonly wanted: Set<string>;
  readonly runs: Map<string, StoredPipelineRun>;
  readonly children: Map<string, readonly StoredRunSummary[]>;
  /** Direct-child totals per parent step. The children map holds only the drawn page. */
  readonly childSteps: Map<string, readonly StudioChildStep[]>;
  readonly summaries: Map<string, StoredRunSummary>;
}

/** Open running work automatically and keep it open after it settles. */
function autoExpand(ctx: SceneContext, key: string, running: boolean): boolean {
  if (running) ctx.opened.add(key);
  return ctx.opened.has(key);
}

/** Group a step's planned dependencies by source, in required, optional, gate order. */
function incomingEdges(step: StoredPipelineStep): Map<string, EdgeKind[]> {
  const edges = new Map<string, EdgeKind[]>();
  const add = (ids: readonly string[] | undefined, kind: EdgeKind) => {
    for (const id of ids ?? []) edges.set(id, [...(edges.get(id) ?? []), kind]);
  };
  add(step.dependencies, "input");
  add(step.optionalDependencies, "optional");
  add(step.skipAfterFailureOf, "gate");
  return edges;
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
function edgeState(
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

/** Draw an edge as a gate once it trips, even when the source is also an input. */
function edgeLook(edge: Pick<EdgeScene, "kinds" | "state">): EdgeKind {
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

function runLabel(summary: StoredRunSummary, tools: ReadonlyMap<string, string>): string {
  const { itemKey, iteration } = summary.origin ?? {};
  return (
    (itemKey !== undefined ? tools.get(itemKey) : undefined) ??
    (iteration !== undefined ? `iteration ${iteration}` : (itemKey ?? summary.pipelineId))
  );
}

function truncate(label: string, chars = LABEL_CHARS): string {
  return label.length > chars ? label.slice(0, Math.max(1, chars - 1)) + "…" : label;
}

/** Top of the circle, where incoming connections end. */
function itemTop(item: PlacedItem & { kind: string; graph?: RunScene }): number {
  return item.y + (item.kind === "run" && item.graph ? 0 : CENTER_Y - RADIUS - 3);
}

function childStepTotal(
  childSteps: readonly StudioChildStep[],
  stepId: string,
  fallback: number
): number {
  const match = childSteps.find((entry) => entry.stepId === stepId);
  return match ? Math.max(match.count, fallback) : fallback;
}

function buildExpansion(
  run: StoredPipelineRun,
  step: StoredPipelineStep,
  childRuns: readonly StoredRunSummary[],
  details: readonly PipelineStepProgressDetail[],
  /** Progress rows the trace dropped; their depth is unknown, so they are not items. */
  unrecorded: number,
  totalRuns: number,
  ctx: SceneContext,
  depth: number
): ExpansionScene {
  const tools = new Map(run.agentTurn?.calls.map((call) => [call.callId, call.tool]) ?? []);
  const ordered = [...childRuns].sort(
    (left, right) =>
      (left.origin?.iteration ?? 0) - (right.origin?.iteration ?? 0) ||
      left.startedAtMs - right.startedAtMs
  );
  const runningRuns = ordered.filter((child) => child.subtreeIsRunning).length;
  const sized: ItemScene[] = [];
  for (const summary of ordered.slice(0, ITEM_LIMIT)) {
    const label = runLabel(summary, tools);
    const expandable = ctx.canLoad && depth + 1 < MAX_DEPTH;
    if (expandable) ctx.expandable.add(summary.runId);
    const expanded =
      expandable &&
      (ctx.toggles.get(summary.runId) ??
        autoExpand(ctx, summary.runId, summary.subtreeIsRunning && runningRuns === 1));
    const load = expanded ? ctx.loads.get(summary.runId) : undefined;
    if (expanded) ctx.wanted.add(summary.runId);
    const graph =
      load && load !== "missing"
        ? buildRunScene(load.run, load.children, ctx, depth + 1, load.childSteps)
        : undefined;
    sized.push({
      kind: "run",
      summary,
      label,
      expandable,
      expanded,
      graph,
      unavailable: load === "missing",
      x: 0,
      y: 0,
      width: graph ? Math.max(SLOT_WIDTH, graph.width + FRAME_PADDING * 2) : SLOT_WIDTH,
      height: graph ? FRAME_HEADER + graph.height + FRAME_PADDING : NODE_HEIGHT,
    });
  }
  const drawnRuns = sized.length;
  for (const detail of details.slice(0, Math.max(0, ITEM_LIMIT - sized.length))) {
    sized.push({
      kind: "item",
      detail,
      label: detail.name ?? tools.get(detail.id) ?? detail.id,
      x: 0,
      y: 0,
      width: SLOT_WIDTH,
      height: NODE_HEIGHT,
    });
  }
  const hiddenRuns = totalRuns - drawnRuns;
  const hiddenRows = details.length - (sized.length - drawnRuns);
  const more = [
    hiddenRuns > 0 && `+${hiddenRuns} more in the run list`,
    hiddenRows > 0 && `+${hiddenRows} more in the timeline`,
    unrecorded > 0 && `${unrecorded} progress rows not recorded`,
  ]
    .filter(Boolean)
    .join(" · ");
  const columns = step.nestedPipeline?.mode === "iterate" ? 1 : ITEM_COLUMNS;
  const rows: ItemScene[][] = [];
  for (let index = 0; index < sized.length; index += columns) {
    rows.push(sized.slice(index, index + columns));
  }
  const rowWidth = (row: readonly ItemScene[]) =>
    row.reduce((sum, item) => sum + item.width, 0) + (row.length - 1) * COLUMN_GAP;
  const innerWidth = Math.max(SLOT_WIDTH, ...rows.map(rowWidth));
  let y = FRAME_PADDING;
  for (const row of rows) {
    let x = FRAME_PADDING + (innerWidth - rowWidth(row)) / 2;
    for (const item of row) {
      item.x = x;
      item.y = y;
      x += item.width + COLUMN_GAP;
    }
    y += Math.max(...row.map((item) => item.height)) + (columns === 1 ? ROW_GAP / 2 : COLUMN_GAP);
  }
  const links =
    columns === 1
      ? sized.slice(1).map((item, index) => {
          const previous = sized[index]!;
          const x = previous.x + previous.width / 2;
          return `M${x} ${previous.y + previous.height - 4}V${itemTop(item)}`;
        })
      : [];
  const contentHeight = sized.length
    ? y - (columns === 1 ? ROW_GAP / 2 : COLUMN_GAP)
    : FRAME_PADDING;
  const width = innerWidth + FRAME_PADDING * 2;
  return {
    x: 0,
    y: NODE_HEIGHT,
    width,
    height: contentHeight + (more ? MORE_HEIGHT : 0) + FRAME_PADDING,
    items: sized,
    links,
    ...(more ? { more } : {}),
  };
}

function buildRunScene(
  run: StoredPipelineRun,
  children: readonly StoredRunSummary[],
  ctx: SceneContext,
  depth: number,
  childSteps: readonly StudioChildStep[] = []
): RunScene {
  ctx.runs.set(run.runId, run);
  ctx.children.set(run.runId, children);
  ctx.childSteps.set(run.runId, childSteps);
  for (const child of children) ctx.summaries.set(child.runId, child);
  const stepById = new Map(run.steps.map((step) => [step.id, step]));
  const steps: StepScene[] = run.steps.map((step) => {
    const key = `${run.runId}/${step.id}`;
    const childRuns = children.filter((child) => child.origin?.stepId === step.id);
    const runItems = new Set(childRuns.map((child) => child.origin?.itemKey));
    // Single and iterate steps report their child runs' progress as details; the runs show it.
    const mode = step.nestedPipeline?.mode;
    const mirrored = (mode === "single" || mode === "iterate") && childRuns.length > 0;
    const details = mirrored
      ? []
      : (step.progress?.details ?? []).filter(
          (detail) => !detail.depth && !runItems.has(detail.id)
        );
    const recorded = step.progress?.details ?? [];
    // The trace keeps a prefix of progress rows. Nested steps record every child as a run,
    // so only other steps lose information when rows are dropped. Dropped rows may be
    // nested at any depth, so they are reported, never counted as items.
    const unrecorded = step.nestedPipeline
      ? 0
      : Math.max(0, (step.progress?.detailCount ?? recorded.length) - recorded.length);
    const totalRuns = childStepTotal(childSteps, step.id, childRuns.length);
    const itemCount = totalRuns + details.length;
    const expanded =
      itemCount > 0 &&
      depth < MAX_DEPTH &&
      (ctx.toggles.get(key) ??
        autoExpand(ctx, key, step.status === "running" && childRuns.length > 0));
    const expansion = expanded
      ? buildExpansion(run, step, childRuns, details, unrecorded, totalRuns, ctx, depth)
      : undefined;
    const width = Math.max(SLOT_WIDTH, expansion?.width ?? 0);
    if (expansion) expansion.x = (width - expansion.width) / 2;
    return {
      key,
      step,
      x: 0,
      y: 0,
      width,
      height: expansion ? NODE_HEIGHT + expansion.height + 6 : NODE_HEIGHT,
      itemCount,
      expanded,
      expansion,
    };
  });
  const incoming = new Map(run.steps.map((step) => [step.id, incomingEdges(step)]));
  const layout = layoutDag(
    steps.map(({ key, width, height }) => ({ id: key, width, height })),
    run.steps.flatMap((step) =>
      [...incoming.get(step.id)!.keys()].map((from) => ({
        from: `${run.runId}/${from}`,
        to: `${run.runId}/${step.id}`,
      }))
    ),
    { columnGap: COLUMN_GAP, rowGap: ROW_GAP }
  );
  const byId = new Map<string, StepScene>();
  const layerTop: number[] = [];
  const layerOf = new Map<string, number>();
  for (const scene of steps) {
    const placed = layout.nodes.get(scene.key)!;
    scene.x = placed.x;
    scene.y = placed.y;
    byId.set(scene.step.id, scene);
    layerOf.set(scene.step.id, placed.layer);
    layerTop[placed.layer] = placed.y;
  }
  let width = layout.width;
  let lanes = 0;
  const edges: EdgeScene[] = [];
  for (const target of steps) {
    for (const [from, kinds] of incoming.get(target.step.id)!) {
      const source = byId.get(from);
      if (!source) continue;
      const sx = source.x + source.width / 2;
      const sy = source.y + (source.expansion ? source.height : LABEL_Y + 8);
      const tx = target.x + target.width / 2;
      const ty = target.y + CENTER_Y - RADIUS - 3;
      const first = layerOf.get(from)! + 1;
      const last = layerOf.get(target.step.id)!;
      const between = steps.filter((scene) => {
        const layer = layerOf.get(scene.step.id)!;
        return layer >= first && layer < last;
      });
      const blocked = between.some(
        (scene) =>
          scene.x < Math.max(sx, tx) + COLUMN_GAP &&
          scene.x + scene.width > Math.min(sx, tx) - COLUMN_GAP
      );
      let path: string;
      if (blocked) {
        // Skip-layer edges detour right of the layers they cross instead of through them.
        const lane =
          Math.max(...between.map((scene) => scene.x + scene.width)) + COLUMN_GAP / 2 + lanes * 6;
        lanes += 1;
        width = Math.max(width, lane + COLUMN_GAP / 2);
        const below = layerTop[first]! - ROW_GAP / 2;
        const above = layerTop[last]! - ROW_GAP / 2;
        path =
          `M${sx} ${sy}C${sx} ${below} ${lane} ${below} ${lane} ${layerTop[first]}` +
          `V${layerTop[last]! - ROW_GAP}C${lane} ${above} ${tx} ${above} ${tx} ${ty - 4}`;
      } else {
        const middle = (sy + ty) / 2;
        path = `M${sx} ${sy}C${sx} ${middle} ${tx} ${middle} ${tx} ${ty - 4}`;
      }
      edges.push({
        from,
        to: target.step.id,
        kinds,
        state: edgeState(kinds, stepById.get(from)!, target.step),
        path,
        head: `M${tx - 4} ${ty - 7}L${tx} ${ty}L${tx + 4} ${ty - 7}Z`,
      });
    }
  }
  return { run, width, height: layout.height, steps, edges };
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

function Facts({ rows }: { rows: readonly (readonly [string, ComponentChildren])[] }) {
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
  onOpenRun(runId: string): void;
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
            onClick={() => onOpenRun(child.runId)}
          >
            <Status value={child.status} />
            <strong>{child.origin?.itemKey ?? child.pipelineId}</strong>
            <small>
              {duration(child.durationMs)} · {child.stepCount} steps
            </small>
          </button>
        ))}
      </div>
    </div>
  );
}

const offset = (run: StoredPipelineRun, ms: number | undefined) =>
  ms === undefined ? "—" : "+" + duration(ms - run.startedAtMs);

function Inspector({
  selection,
  ctx,
  ui,
  onOpenRun,
}: {
  selection: GraphSelection | null;
  ctx: SceneContext;
  ui: GraphUi;
  onOpenRun(runId: string): void;
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
            <button class="primary-button" type="button" onClick={() => onOpenRun(summary.runId)}>
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
              ["Output ready", offset(run, source.finishedAtMs)],
              ["Consumed", offset(run, target.startedAtMs)],
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
      const statusOf = (id: string) => run.steps.find((candidate) => candidate.id === id)?.status;
      const inputs = [...incomingEdges(step)].map(([id, kinds]) => ({
        id,
        kinds,
        status: statusOf(id) ?? "planned",
        onSelect: () => ui.select({ kind: "edge", runId: run.runId, from: id, to: step.id }),
      }));
      const consumers = run.steps.flatMap((candidate) => {
        const kinds = incomingEdges(candidate).get(step.id);
        return kinds
          ? [
              {
                id: candidate.id,
                kinds,
                status: candidate.status,
                onSelect: () =>
                  ui.select({ kind: "edge", runId: run.runId, from: step.id, to: candidate.id }),
              },
            ]
          : [];
      });
      const childRuns = (ctx.children.get(run.runId) ?? []).filter(
        (child) => child.origin?.stepId === step.id
      );
      const childTotal = childStepTotal(
        ctx.childSteps.get(run.runId) ?? [],
        step.id,
        childRuns.length
      );
      return (
        <div class="graph-inspector">
          <div class="graph-kicker">Step · {run.pipelineId}</div>
          <div class="step-list">
            <StepRow step={step} />
          </div>
          <Facts
            rows={[
              ["Started", offset(run, step.startedAtMs)],
              ["Finished", offset(run, step.finishedAtMs)],
            ]}
          />
          <ConnectionList title="Inputs" empty="None: this step starts the graph." rows={inputs} />
          <ConnectionList
            title="Consumers"
            empty="None: no later step depends on this output."
            rows={consumers}
          />
          <ChildRunList runs={childRuns} total={childTotal} onOpenRun={onOpenRun} />
        </div>
      );
    }
  }
  return (
    <div class="graph-inspector">
      <div class="graph-kicker">Inspector</div>
      <p class="graph-hint">
        Select a step, connection, or nested run to inspect its inputs, outputs, and execution.
        Badges expand child pipelines, agent turns, and dynamic tool calls in place.
      </p>
    </div>
  );
}

/** Track statuses across renders so only observed terminal transitions animate. */
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
  onOpenRun(runId: string): void;
}

/** Live top-to-bottom DAG of one run's steps with expandable child pipelines. */
export function RunGraph({ detail, api, onOpenRun }: RunGraphProps) {
  const [toggles, setToggles] = useState<ReadonlyMap<string, boolean>>(new Map());
  const opened = useRef(new Set<string>());
  const [loads, setLoads] = useState<ReadonlyMap<string, RunLoad>>(new Map());
  const [selection, setSelection] = useState<GraphSelection | null>(null);
  const loadedKeys = useRef(new Map<string, string>());
  const [retry, setRetry] = useState(0);
  const pulse = usePulse();
  const ctx: SceneContext = {
    loads,
    toggles,
    opened: opened.current,
    canLoad: api !== undefined,
    expandable: new Set(),
    wanted: new Set(),
    runs: new Map(),
    children: new Map(),
    childSteps: new Map(),
    summaries: new Map(),
  };
  const scene = buildRunScene(detail.run, detail.children, ctx, 0, detail.childSteps);
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
    select: setSelection,
    toggle: (key, expanded) => setToggles((previous) => new Map(previous).set(key, expanded)),
    pulse,
  };
  const width = scene.width + MARGIN * 2;
  const height = scene.height + MARGIN * 2;
  return (
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
      <Inspector selection={selection} ctx={ctx} ui={ui} onOpenRun={onOpenRun} />
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
      </div>
    </section>
  );
}
