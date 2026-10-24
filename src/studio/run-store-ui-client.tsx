import { shortId } from "./run-store-ui-steps.js";
import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  type StudioApi,
  type StudioSnapshot,
  createStudioApi,
} from "./run-store-ui-client-transport.js";
import { StudioDataController } from "./run-store-ui-data-controller.js";
import type { PipelineRunStudioCommand } from "./run-store-ui-protocol.js";
import { commandDescription, errorMessage } from "./run-store-ui-common.js";
import { RunCrumbs, RunList, RunsView } from "./run-store-ui-runs.js";
import { LaunchModal } from "./run-store-ui-launch.js";
import { PipelinePage } from "./run-store-ui-pipeline.js";
import { latestStatus, Rail, railPipelines } from "./run-store-ui-rail.js";
import {
  parseStudioRoute,
  studioPage,
  studioRouteUrl,
  type StudioRoute,
} from "./run-store-ui-route.js";

interface ClearHistoryModalProps {
  api: StudioApi;
  onCleared(eventCount: number): void;
  onClose(): void;
  snapshot: StudioSnapshot;
}

function ClearHistoryModal({ api, onCleared, onClose, snapshot }: ClearHistoryModalProps) {
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState("");
  const confirmButton = useRef<HTMLButtonElement>(null);
  useEffect(() => confirmButton.current?.focus(), []);
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !clearing) onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [clearing, onClose]);
  const runCount = snapshot.runCount;
  const eventCount = snapshot.eventCount;
  const close = () => {
    if (!clearing) onClose();
  };
  const clear = async () => {
    if (clearing) return;
    setClearing(true);
    setError("");
    try {
      onCleared((await api.clearHistory()).eventCount);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setClearing(false);
    }
  };
  return (
    <div
      class="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="clearHistoryTitle"
      onClick={(event) => event.target === event.currentTarget && close()}
    >
      <div class="modal confirm-modal">
        <div class="modal-head">
          <div>
            <div class="detail-kicker">Local maintenance</div>
            <h2 id="clearHistoryTitle">Clear run history?</h2>
            <p>This permanently resets the local studio history.</p>
          </div>
          <button class="close-button" type="button" aria-label="Close" onClick={close}>
            ×
          </button>
        </div>
        <div class="confirm-body">
          <p class="confirm-copy">
            Remove {runCount} recorded run{runCount === 1 ? "" : "s"} and {eventCount} event
            {eventCount === 1 ? "" : "s"} from this SQLite store.
            {snapshot.activeRunCount
              ? ` ${snapshot.activeRunCount} recorded run${
                  snapshot.activeRunCount === 1 ? " is" : "s are"
                } still marked active; continue only if no external process is writing to this store.`
              : ""}
          </p>
          <div class="confirm-warning">
            This cannot be undone. Pipeline definitions and execution remain unchanged; only
            recorded local events are removed.
          </div>
          {error && <div class="launch-error">{error}</div>}
          <div class="confirm-actions">
            <button class="secondary-button" type="button" onClick={close}>
              Cancel
            </button>
            <button
              ref={confirmButton}
              class="danger-button"
              type="button"
              disabled={clearing}
              onClick={() => void clear()}
            >
              {clearing ? "Clearing…" : "Clear history"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const studioMount =
  typeof document === "undefined"
    ? ""
    : (document.querySelector<HTMLMetaElement>('meta[name="tubeless-studio-mount"]')?.content ??
      "");

const defaultStudioApi = createStudioApi(fetch, studioMount);

export function connectionPresentation(connected: boolean) {
  return {
    className: `pulse${connected ? "" : " lost"}`,
    label: connected ? "Connected · local" : "Connection lost",
  };
}

/** A stable link to one run: no list scope, step, or tab. */
export function studioRunUrl(href: string, runId: string): string {
  return studioRouteUrl(href, { runId });
}

/** Activity headline: work in flight, recorded runs, and the share that succeeded. */
export function activitySummary(
  snapshot: Pick<
    StudioSnapshot,
    "activeRunCount" | "completedRunCount" | "failedRunCount" | "runCount"
  >
): string {
  const terminal = snapshot.completedRunCount + snapshot.failedRunCount;
  const parts = [
    `${snapshot.activeRunCount} running`,
    `${snapshot.runCount} recorded run${snapshot.runCount === 1 ? "" : "s"}`,
  ];
  if (terminal)
    parts.push(`${Math.round((snapshot.completedRunCount / terminal) * 100)}% succeeded`);
  return parts.join(" · ");
}

export function StudioAccessNotice({ status, href }: { status: 401 | 403; href: string }) {
  return (
    <main class="workspace">
      <div role="alert">
        <h1>{status === 401 ? "Sign in to continue" : "Access denied"}</h1>
        <p>
          {status === 401
            ? "Your access has expired. Open Studio again to sign in through your application."
            : "Your account cannot access this Studio. Open Studio again after your access is restored."}
        </p>
        <a href={href}>Open Studio again</a>
      </div>
    </main>
  );
}

function StudioApp({ api = defaultStudioApi }: { api?: StudioApi }) {
  const initialRoute = useMemo(() => parseStudioRoute(window.location.href), []);
  const dataController = useMemo(
    () =>
      new StudioDataController(api, {
        runId: initialRoute.runId ?? null,
        pipelineId: initialRoute.pipelineId,
      }),
    [api, initialRoute]
  );
  const [route, setRoute] = useState<StudioRoute>(initialRoute);
  const [data, setData] = useState(() => dataController.getState());
  const { accessDenied, connected, historyQuery, selection, manualRefreshing, snapshot } = data;
  const [commands, setCommands] = useState<PipelineRunStudioCommand[]>([]);
  const [commandsLoaded, setCommandsLoaded] = useState(false);
  const [canCancel, setCanCancel] = useState(false);
  const [canClearHistory, setCanClearHistory] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [launchCommandId, setLaunchCommandId] = useState<string | null>(null);
  const [clearHistoryOpen, setClearHistoryOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [nowMs, setNowMs] = useState(Date.now);

  useEffect(() => {
    setData(dataController.getState());
    return dataController.subscribe(setData);
  }, [dataController]);

  useEffect(() => () => dataController.dispose(), [dataController]);

  useEffect(() => {
    if (accessDenied) {
      setCommands([]);
      setCanCancel(false);
      setCanClearHistory(false);
      setLaunchCommandId(null);
      setClearHistoryOpen(false);
      setToast("");
      return;
    }
    void api
      .loadCommands()
      .then((loaded) => {
        if (!dataController.getState().accessDenied) setCommands(loaded);
      })
      .catch((error) => {
        if (!dataController.getState().accessDenied) setToast(errorMessage(error));
      })
      .finally(() => {
        if (!dataController.getState().accessDenied) setCommandsLoaded(true);
      });
    void api
      .loadCapabilities()
      .then((capabilities) => {
        if (dataController.getState().accessDenied) return;
        setCanCancel(capabilities.canCancel);
        setCanClearHistory(capabilities.canClearHistory);
      })
      .catch((error) => {
        if (!dataController.getState().accessDenied) setToast(errorMessage(error));
      });
    dataController.refresh();
    const interval = setInterval(() => {
      dataController.refresh();
      setNowMs(Date.now());
    }, 1200);
    return () => clearInterval(interval);
  }, [accessDenied, api, dataController]);

  /** Point history at the route's scope, then select its run. */
  const applyRoute = (next: StudioRoute) => {
    const current = dataController.getState().historyQuery;
    const sameScope = current.pipelineId === next.pipelineId;
    dataController.setHistoryQuery({
      pipelineId: next.pipelineId,
      query: sameScope ? current.query : "",
      offset: sameScope ? current.offset : 0,
    });
    dataController.selectRun(next.runId ?? null);
    setRoute(next);
  };

  useEffect(() => {
    const onPopState = () => applyRoute(parseStudioRoute(window.location.href));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [dataController]);

  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(""), 4200);
    return () => clearTimeout(timeout);
  }, [toast]);

  const { pipelines, nested } = useMemo(
    () => railPipelines(commands, snapshot?.pipelines ?? []),
    [commands, snapshot?.pipelines]
  );

  /** Move between pages; tab and drawer changes replace the entry instead of adding one. */
  const navigate = (next: StudioRoute, { replace = false }: { replace?: boolean } = {}) => {
    if (dataController.getState().accessDenied) return;
    const href = studioRouteUrl(window.location.href, next);
    if (href !== window.location.href) {
      if (replace) window.history.replaceState(null, "", href);
      else window.history.pushState(null, "", href);
    }
    applyRoute(next);
  };
  const showToast = (message: string) => {
    if (!dataController.getState().accessDenied) setToast(message);
  };
  const copyRunLink = async (runId: string) => {
    try {
      await navigator.clipboard.writeText(studioRunUrl(window.location.href, runId));
      showToast("Run link copied");
    } catch {
      showToast("Could not copy run link. Copy the address from your browser instead.");
    }
  };
  const cancelRun = async (runId: string) => {
    if (dataController.getState().accessDenied || !canCancel || cancelling) return;
    setCancelling(true);
    try {
      await api.cancelRun(runId);
      showToast("Run cancelled · " + shortId(runId));
      dataController.invalidate({ delayMs: 80 });
    } catch (caught) {
      showToast(errorMessage(caught));
    } finally {
      setCancelling(false);
    }
  };

  if (accessDenied) return <StudioAccessNotice status={accessDenied} href={window.location.href} />;

  const page = studioPage(route);
  const connection = connectionPresentation(connected);
  const entries = [...pipelines, ...nested];
  const pipeline = route.pipelineId
    ? entries.find((entry) => entry.pipelineId === route.pipelineId)
    : undefined;
  const detail = selection.status === "ready" ? selection.detail : undefined;
  const runPipelineId =
    detail?.run.pipelineId ??
    (selection.status === "loading" ? selection.summary?.pipelineId : undefined);
  const runPipeline = entries.find((entry) => entry.pipelineId === runPipelineId);
  const launchTarget = (page === "run" ? runPipeline : pipeline)?.command;
  const roots = snapshot?.runs ?? [];
  const runsInView = [...roots, ...(detail ? [...detail.ancestors, ...detail.children] : [])];
  const pipelineName = (pipelineId: string) =>
    entries.find((entry) => entry.pipelineId === pipelineId)?.name ?? pipelineId;
  /** Keep a run's list scoped to its own pipeline when that is already the scope or known. */
  const openRun = (runId: string, stepId?: string) => {
    const pipelineId =
      route.pipelineId && roots.some((run) => run.runId === runId)
        ? route.pipelineId
        : runsInView.find((run) => run.runId === runId)?.pipelineId;
    navigate({ pipelineId, runId, stepId });
  };
  const pageUnavailable =
    page === "pipeline" && commandsLoaded && snapshot !== null && pipeline === undefined;
  const heading =
    page === "activity"
      ? { title: "Activity", lede: snapshot ? activitySummary(snapshot) : "Loading history…" }
      : page === "pipeline"
        ? {
            title: pipeline?.name ?? route.pipelineId ?? "",
            lede: pipeline?.command
              ? commandDescription(pipeline.command)
              : "Recorded pipeline · launch it from the CLI or register a command to run it here.",
          }
        : { title: runPipeline?.name ?? runPipelineId ?? "Run", lede: "" };
  const searchPlaceholder =
    page === "activity"
      ? "Filter runs or IDs"
      : page === "pipeline"
        ? "Filter this pipeline's runs"
        : route.pipelineId
          ? "Filter these runs"
          : "Filter runs or IDs";
  const showSearch = !(page === "pipeline" && route.tab);

  return (
    <>
      <div class="shell">
        <Rail
          pipelines={pipelines}
          nested={nested}
          route={route}
          runPipelineId={runPipelineId}
          runningCount={snapshot?.activeRunCount ?? 0}
          onNavigate={(next) => navigate(next)}
          footer={
            <>
              <div class="connection">
                <i class={connection.className} />
                <span>{connection.label}</span>
              </div>
              <div class="database">append-only SQLite</div>
              {canClearHistory && (
                <button
                  class="rail-action"
                  id="clearHistoryButton"
                  type="button"
                  aria-label="Clear history"
                  disabled={!snapshot?.runCount}
                  title={
                    snapshot?.activeRunCount
                      ? "Clear history, including runs left active by an interrupted process"
                      : "Clear history"
                  }
                  onClick={() => setClearHistoryOpen(true)}
                >
                  <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    aria-hidden="true"
                  >
                    <path d="M3 4.5h10M6 2.5h4M5 4.5l.5 9h5l.5-9M7 7v4M9 7v4" />
                  </svg>
                  <span>Clear history…</span>
                </button>
              )}
            </>
          }
        />
        <main class="workspace">
          <header class="topbar">
            <div class="topbar-copy">
              {page === "run" && detail && (
                <RunCrumbs
                  detail={detail}
                  summary={selection.status === "ready" ? selection.summary : undefined}
                  onOpenPipeline={(pipelineId) => navigate({ pipelineId })}
                  onOpenRun={openRun}
                  pipelineName={pipelineName}
                />
              )}
              <h1>
                {page === "pipeline" && pipeline && (
                  <i class={`rail-dot ${latestStatus(pipeline.summary)}`} aria-hidden="true" />
                )}
                {heading.title}
              </h1>
              {heading.lede && <p class="lede">{heading.lede}</p>}
            </div>
            <div class="toolbar">
              {showSearch && (
                <input
                  class="search"
                  type="search"
                  value={historyQuery.query}
                  placeholder={searchPlaceholder}
                  aria-label="Filter runs"
                  onInput={(event) =>
                    dataController.setHistoryQuery({
                      pipelineId: route.pipelineId,
                      query: event.currentTarget.value.trim(),
                    })
                  }
                />
              )}
              {launchTarget ? (
                <button
                  class="primary-button"
                  title={`Run ${launchTarget.name}`}
                  onClick={() => setLaunchCommandId(launchTarget.id)}
                >
                  Run
                </button>
              ) : (
                commands.length > 0 && (
                  <button
                    class="primary-button"
                    onClick={() => setLaunchCommandId(commands[0]?.id ?? "")}
                  >
                    Run pipeline
                  </button>
                )
              )}
              <button
                class={`icon-button${manualRefreshing ? " spinning" : ""}`}
                type="button"
                title="Refresh now"
                aria-label="Refresh now"
                onClick={() => dataController.refresh(true)}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M16.5 7A7 7 0 1 0 17 11" />
                  <path d="M16.5 3v4h-4" />
                </svg>
              </button>
            </div>
          </header>
          {snapshot && page === "activity" && (
            <RunList
              runs={roots}
              nowMs={nowMs}
              onSelect={(runId) => navigate({ runId })}
              showPipeline
              pipelineName={pipelineName}
              title="Recent runs"
              subtitle="Top-level runs · nested work stays with its parent"
              count={`${snapshot.matchingRootCount} top-level · ${snapshot.runCount} total`}
              empty={{
                title: "No recorded runs",
                copy: commands.length
                  ? "Open a pipeline in the sidebar and choose Run to record its history."
                  : "Record a run with --store, then open it here.",
              }}
              matchingCount={snapshot.matchingRootCount}
              offset={snapshot.offset}
              onPage={(offset) => dataController.setHistoryQuery({ ...historyQuery, offset })}
            />
          )}
          {snapshot && page === "pipeline" && pipeline && (
            <PipelinePage
              api={api}
              pipeline={pipeline}
              tab={route.tab}
              onTab={(tab) => navigate({ pipelineId: pipeline.pipelineId, tab }, { replace: true })}
              runs={roots}
              matchingRunCount={snapshot.matchingRootCount}
              offset={snapshot.offset}
              onPage={(offset) => dataController.setHistoryQuery({ ...historyQuery, offset })}
              nowMs={nowMs}
              onOpenRun={(runId) => navigate({ pipelineId: pipeline.pipelineId, runId })}
              definitions={snapshot.definitions.filter(
                (definition) => definition.pipelineId === pipeline.pipelineId
              )}
            />
          )}
          {pageUnavailable && (
            <div class="sheet">
              <div class="unavailable-run">
                <strong>Pipeline unavailable</strong>
                <p>
                  This pipeline is not registered and has no recorded runs in this Studio. The link
                  may refer to another store, or its history was cleared.
                </p>
                <code>{route.pipelineId}</code>
                <button class="secondary-button" type="button" onClick={() => navigate({})}>
                  Open Activity
                </button>
              </div>
            </div>
          )}
          {snapshot && page === "run" && (
            <RunsView
              api={api}
              pipelineId={route.pipelineId}
              pipelineName={pipelineName}
              offset={snapshot.offset}
              matchingRootCount={snapshot.matchingRootCount}
              onPage={(offset) => dataController.setHistoryQuery({ ...historyQuery, offset })}
              canCancel={canCancel}
              cancelling={cancelling}
              liveRunIds={snapshot.liveRunIds ?? []}
              nowMs={nowMs}
              onCancel={(id) => void cancelRun(id)}
              onCopyLink={(id) => void copyRunLink(id)}
              onSelect={(runId) => openRun(runId)}
              roots={roots}
              selection={selection}
              latestRunId={roots[0]?.runId}
              totalRunCount={snapshot.runCount}
              stepId={route.stepId}
              onSelectStep={(stepId) =>
                navigate({ ...route, stepId: stepId ?? undefined }, { replace: true })
              }
            />
          )}
        </main>
      </div>
      {launchCommandId !== null && (
        <LaunchModal
          api={api}
          commands={commands}
          commandId={launchCommandId}
          onClose={() => setLaunchCommandId(null)}
          onLaunched={(runId, commandId) => {
            if (dataController.getState().accessDenied) return;
            setLaunchCommandId(null);
            navigate({ pipelineId: commandId, runId });
            showToast("Run accepted · " + shortId(runId));
            dataController.invalidate({ delayMs: 80 });
          }}
        />
      )}
      {clearHistoryOpen && snapshot && (
        <ClearHistoryModal
          api={api}
          snapshot={snapshot}
          onClose={() => setClearHistoryOpen(false)}
          onCleared={(eventCount) => {
            if (dataController.getState().accessDenied) return;
            setClearHistoryOpen(false);
            showToast("Cleared " + eventCount + " recorded event" + (eventCount === 1 ? "" : "s"));
            dataController.invalidate({ resetHistory: true });
          }}
        />
      )}
      {toast && (
        <div class="toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}

/** Mount the local Studio browser application. */
export function initStudio(): void {
  const root = document.querySelector("#studio-root");
  if (!(root instanceof HTMLElement)) throw new Error("Missing #studio-root");
  render(<StudioApp />, root);
}
