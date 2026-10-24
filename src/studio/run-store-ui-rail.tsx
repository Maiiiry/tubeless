import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { StudioPipelineSummary } from "./run-store-ui-schema.js";
import type { PipelineRunStudioCommand } from "./run-store-ui-protocol.js";
import { studioPage, type StudioRoute } from "./run-store-ui-route.js";

/** A pipeline Studio can show: a registered command, recorded runs, or both. */
export interface RailPipeline {
  pipelineId: string;
  name: string;
  command?: PipelineRunStudioCommand;
  summary?: StudioPipelineSummary;
}

const byName = (left: RailPipeline, right: RailPipeline) =>
  left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
  left.pipelineId.localeCompare(right.pipelineId);

/**
 * Merge registered commands with recorded pipelines. Pipelines recorded only as child
 * runs, and not registered, are listed separately so they stay reachable.
 */
export function railPipelines(
  commands: readonly PipelineRunStudioCommand[],
  summaries: readonly StudioPipelineSummary[]
): { pipelines: RailPipeline[]; nested: RailPipeline[] } {
  const entries = new Map<string, RailPipeline>();
  for (const command of commands)
    entries.set(command.id, { pipelineId: command.id, name: command.name, command });
  for (const summary of summaries) {
    const entry = entries.get(summary.pipelineId);
    if (entry) entry.summary = summary;
    else
      entries.set(summary.pipelineId, {
        pipelineId: summary.pipelineId,
        name: summary.pipelineId,
        summary,
      });
  }
  const pipelines: RailPipeline[] = [];
  const nested: RailPipeline[] = [];
  for (const entry of entries.values())
    (entry.command || entry.summary?.topLevelRunCount ? pipelines : nested).push(entry);
  return { pipelines: pipelines.sort(byName), nested: nested.sort(byName) };
}

/** Latest outcome for the status dot; any running run wins. */
export function latestStatus(summary: StudioPipelineSummary | undefined): string {
  if (!summary) return "idle";
  return summary.runningCount ? "running" : (summary.recent[0]?.status ?? "idle");
}

function PipelineRow({
  pipeline,
  active,
  onOpen,
}: {
  pipeline: RailPipeline;
  active: boolean;
  onOpen(): void;
}) {
  const recent = [...(pipeline.summary?.recent ?? [])].reverse();
  const status = latestStatus(pipeline.summary);
  return (
    <button
      class={`rail-pipeline${active ? " active" : ""}`}
      type="button"
      aria-current={active ? "page" : undefined}
      title={
        pipeline.name === pipeline.pipelineId
          ? pipeline.name
          : `${pipeline.name} (${pipeline.pipelineId})`
      }
      onClick={onOpen}
    >
      <i class={`rail-dot ${status}`} aria-label={status} role="img" />
      <span class="rail-name">{pipeline.name}</span>
      {recent.length > 0 && (
        <span class="rail-strip" aria-hidden="true">
          {recent.map((run) => (
            <i key={run.runId} class={run.status} />
          ))}
        </span>
      )}
    </button>
  );
}

const FILTER_THRESHOLD = 8;

interface RailProps {
  pipelines: readonly RailPipeline[];
  nested: readonly RailPipeline[];
  route: StudioRoute;
  /** Pipeline of the open run, highlighted when the run list is not scoped to it. */
  runPipelineId?: string;
  runningCount: number;
  onNavigate(route: StudioRoute): void;
  /** Connection, store, and maintenance controls at the bottom of the rail. */
  footer: ComponentChildren;
}

export function Rail({
  pipelines,
  nested,
  route,
  runPipelineId,
  runningCount,
  onNavigate,
  footer,
}: RailProps) {
  const [filter, setFilter] = useState("");
  const [nestedOpen, setNestedOpen] = useState(false);
  const page = studioPage(route);
  const activePipeline = route.pipelineId ?? (page === "run" ? runPipelineId : undefined);
  const needle = filter.trim().toLowerCase();
  const matches = (pipeline: RailPipeline) =>
    !needle ||
    pipeline.name.toLowerCase().includes(needle) ||
    pipeline.pipelineId.toLowerCase().includes(needle);
  const visible = pipelines.filter(matches);
  const visibleNested = nested.filter(matches);
  const activeIsNested = nested.some((entry) => entry.pipelineId === activePipeline);
  useEffect(() => {
    if (activeIsNested) setNestedOpen(true);
  }, [activeIsNested]);
  const showNested = nestedOpen || Boolean(needle);
  const open = (pipelineId: string) => onNavigate({ pipelineId });
  return (
    <aside class="rail">
      <div class="brand">
        <div class="mark" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M3 4.5h6a3 3 0 0 1 3 3v6" stroke="#f7f8f3" strokeWidth="1.5" />
            <circle cx="3" cy="4.5" r="2" fill="#7396ff" />
            <circle cx="12" cy="13.5" r="2" fill="#63d297" />
          </svg>
        </div>
        <div class="brand-copy">
          <strong>Tubeless</strong>
          <small>Studio</small>
        </div>
      </div>
      <nav class="nav" aria-label="Studio sections">
        <button
          class={page === "activity" ? "active" : ""}
          type="button"
          title="Activity"
          aria-current={page === "activity" ? "page" : undefined}
          onClick={() => onNavigate({})}
        >
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2.5 10h3l2-5 4 10 2-5h4" />
          </svg>
          <span>Activity</span>
          {runningCount > 0 && <b class="nav-count running">{runningCount}</b>}
        </button>
      </nav>
      <div class="rail-section">
        <div class="rail-label">Pipelines</div>
        {pipelines.length + nested.length > FILTER_THRESHOLD && (
          <input
            class="rail-filter"
            type="search"
            value={filter}
            placeholder="Filter pipelines"
            aria-label="Filter pipelines"
            onInput={(event) => setFilter(event.currentTarget.value)}
          />
        )}
        <div class="rail-pipelines">
          {visible.map((pipeline) => (
            <PipelineRow
              key={pipeline.pipelineId}
              pipeline={pipeline}
              active={pipeline.pipelineId === activePipeline}
              onOpen={() => open(pipeline.pipelineId)}
            />
          ))}
          {pipelines.length === 0 && nested.length === 0 && (
            <p class="rail-empty">No pipelines yet. Record a run or register a command.</p>
          )}
          {needle && visible.length + visibleNested.length === 0 && (
            <p class="rail-empty">No pipelines match.</p>
          )}
          {nested.length > 0 && (
            <>
              <button
                class="rail-group"
                type="button"
                aria-expanded={showNested}
                onClick={() => setNestedOpen((current) => !current)}
              >
                Nested pipelines · {nested.length}
              </button>
              {showNested &&
                visibleNested.map((pipeline) => (
                  <PipelineRow
                    key={pipeline.pipelineId}
                    pipeline={pipeline}
                    active={pipeline.pipelineId === activePipeline}
                    onOpen={() => open(pipeline.pipelineId)}
                  />
                ))}
            </>
          )}
        </div>
        <select
          class="rail-select"
          aria-label="Open pipeline"
          value={activePipeline ?? ""}
          onChange={(event) => {
            const value = event.currentTarget.value;
            onNavigate(value ? { pipelineId: value } : {});
          }}
        >
          <option value="">Activity</option>
          {[...pipelines, ...nested].map((pipeline) => (
            <option key={pipeline.pipelineId} value={pipeline.pipelineId}>
              {pipeline.name}
            </option>
          ))}
        </select>
      </div>
      <div class="rail-foot">{footer}</div>
    </aside>
  );
}
