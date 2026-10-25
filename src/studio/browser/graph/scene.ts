import type { PipelineStepProgressDetail } from "../../../core/pipeline.js";
import type { StoredRunSummary } from "../../../run-store/run-history.js";
import type { StoredPipelineRun, StoredPipelineStep } from "../../../run-store/run-store.js";
import { STUDIO_CHILD_PAGE_SIZE } from "../../shared/limits.js";
import type { StudioChildStep, StudioRunDetail } from "../../shared/schema.js";
import {
  childStepTotal,
  edgeState,
  incomingEdges,
  type EdgeKind,
  type EdgeState,
} from "./dependencies.js";
import { layoutDag } from "./layout.js";

const SLOT_WIDTH = 124;
const NODE_HEIGHT = 64;
export const CENTER_Y = 20;
export const RADIUS = 15;
export const LABEL_Y = 50;
const COLUMN_GAP = 14;
const ROW_GAP = 36;
export const FRAME_PADDING = 12;
export const FRAME_HEADER = 26;
const MORE_HEIGHT = 18;
const ITEM_COLUMNS = 4;
const ITEM_LIMIT = STUDIO_CHILD_PAGE_SIZE;
const MAX_DEPTH = 6;
/** Expanded child pipeline detail; `missing` when the store has no record of the run. */
export type RunLoad = StudioRunDetail | "missing";

interface EdgeScene {
  readonly from: string;
  readonly to: string;
  readonly kinds: readonly EdgeKind[];
  readonly state: EdgeState;
  readonly path: string;
  readonly head: string;
}

interface StepScene {
  readonly key: string;
  readonly step: StoredPipelineStep;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly itemCount: number;
  readonly expanded: boolean;
  readonly expansion?: ExpansionScene;
}

export interface RunScene {
  readonly run: StoredPipelineRun;
  readonly width: number;
  readonly height: number;
  readonly steps: readonly StepScene[];
  readonly edges: readonly EdgeScene[];
}

interface PlacedItem {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

type ItemScene = PlacedItem &
  (
    | {
        readonly kind: "run";
        readonly summary: StoredRunSummary;
        readonly label: string;
        /** Whether the graph can draw this run's steps inline, rather than only open it. */
        readonly expandable: boolean;
        readonly expanded: boolean;
        readonly graph?: RunScene;
        readonly unavailable: boolean;
      }
    | { readonly kind: "item"; readonly detail: PipelineStepProgressDetail; readonly label: string }
  );

export interface ExpansionScene {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly items: readonly ItemScene[];
  readonly links: readonly string[];
  /** Explains items the expansion does not draw, and where to find them. */
  readonly more?: string;
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

export interface GraphScene {
  readonly scene: RunScene;
  readonly canLoad: boolean;
  readonly opened: ReadonlySet<string>;
  readonly expandable: ReadonlySet<string>;
  readonly wanted: ReadonlySet<string>;
  readonly runs: ReadonlyMap<string, StoredPipelineRun>;
  readonly children: ReadonlyMap<string, readonly StoredRunSummary[]>;
  readonly childSteps: ReadonlyMap<string, readonly StudioChildStep[]>;
  readonly summaries: ReadonlyMap<string, StoredRunSummary>;
}

/** Build a scene and its inspection index without mutating the previous expansion state. */
export function buildGraphScene(
  detail: StudioRunDetail,
  options: {
    readonly loads: ReadonlyMap<string, RunLoad>;
    readonly toggles: ReadonlyMap<string, boolean>;
    readonly opened: ReadonlySet<string>;
    readonly canLoad: boolean;
  }
): GraphScene {
  const ctx: SceneContext = {
    ...options,
    opened: new Set(options.opened),
    expandable: new Set(),
    wanted: new Set(),
    runs: new Map(),
    children: new Map(),
    childSteps: new Map(),
    summaries: new Map(),
  };
  const scene = buildRunScene(detail.run, detail.children, ctx, 0, detail.childSteps);
  return {
    scene,
    canLoad: ctx.canLoad,
    opened: ctx.opened,
    expandable: ctx.expandable,
    wanted: ctx.wanted,
    runs: ctx.runs,
    children: ctx.children,
    childSteps: ctx.childSteps,
    summaries: ctx.summaries,
  };
}

/** Open running work automatically and keep it open after it settles. */
function autoExpand(ctx: SceneContext, key: string, running: boolean): boolean {
  if (running) ctx.opened.add(key);
  return ctx.opened.has(key);
}

function runLabel(summary: StoredRunSummary, tools: ReadonlyMap<string, string>): string {
  const { itemKey, iteration } = summary.origin ?? {};
  return (
    (itemKey !== undefined ? tools.get(itemKey) : undefined) ??
    (iteration !== undefined ? `iteration ${iteration}` : (itemKey ?? summary.pipelineId))
  );
}

/** Top of the circle, where incoming connections end. */
function itemTop(item: PlacedItem & { kind: string; graph?: RunScene }): number {
  return item.y + (item.kind === "run" && item.graph ? 0 : CENTER_Y - RADIUS - 3);
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
  const placed: ItemScene[] = [];
  let y = FRAME_PADDING;
  for (const row of rows) {
    let x = FRAME_PADDING + (innerWidth - rowWidth(row)) / 2;
    for (const item of row) {
      placed.push({ ...item, x, y });
      x += item.width + COLUMN_GAP;
    }
    y += Math.max(...row.map((item) => item.height)) + (columns === 1 ? ROW_GAP / 2 : COLUMN_GAP);
  }
  const links =
    columns === 1
      ? placed.slice(1).map((item, index) => {
          const previous = placed[index]!;
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
    items: placed,
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
  const unplaced: StepScene[] = run.steps.map((step) => {
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
    return {
      key,
      step,
      x: 0,
      y: 0,
      width,
      height: expansion ? NODE_HEIGHT + expansion.height + 6 : NODE_HEIGHT,
      itemCount,
      expanded,
      expansion: expansion ? { ...expansion, x: (width - expansion.width) / 2 } : undefined,
    };
  });
  const incoming = new Map(run.steps.map((step) => [step.id, incomingEdges(step)]));
  const layout = layoutDag(
    unplaced.map(({ key, width, height }) => ({ id: key, width, height })),
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
  const steps = unplaced.map((scene) => {
    const placed = layout.nodes.get(scene.key)!;
    const node = { ...scene, x: placed.x, y: placed.y };
    byId.set(node.step.id, node);
    layerOf.set(node.step.id, placed.layer);
    layerTop[placed.layer] = placed.y;
    return node;
  });
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
