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
import { PipelinesView } from "./run-store-ui-pipelines.js";
import { RunsView } from "./run-store-ui-runs.js";
import { LaunchModal } from "./run-store-ui-launch.js";
import { DefinitionHistory } from "./run-store-ui-definitions.js";

function Metrics({ commandCount, snapshot }: { commandCount: number; snapshot: StudioSnapshot }) {
  const terminal = snapshot.completedRunCount + snapshot.failedRunCount;
  const success = terminal ? Math.round((snapshot.completedRunCount / terminal) * 100) : 0;
  const pipelineCount =
    commandCount || new Set(snapshot.definitions.map(({ pipelineId }) => pipelineId)).size;
  const metrics = [
    [
      "Active now",
      snapshot.activeRunCount,
      snapshot.activeRunCount ? "Live execution in progress" : "No work in flight",
    ],
    ["Recorded runs", snapshot.runCount, "Append-only local history"],
    ["Success rate", success + "%", terminal + " terminal runs"],
    [
      "Pipelines",
      pipelineCount,
      commandCount ? "Available to configure" : "Observed in run history",
    ],
  ];
  return (
    <>
      {metrics.map(([label, value, note]) => (
        <article class="metric" key={label}>
          <div class="metric-label">{label}</div>
          <div class="metric-value">{value}</div>
          <div class="metric-note">{note}</div>
        </article>
      ))}
    </>
  );
}

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

export type StudioView = "pipelines" | "runs" | "definitions";

const viewHeadings: Record<StudioView, { title: string; lede: string }> = {
  pipelines: { title: "Pipelines", lede: "Choose a declared workflow to configure and run." },
  runs: { title: "Runs", lede: "Live work and durable history in one place." },
  definitions: {
    title: "Definitions",
    lede: "Recorded pipeline versions, their runs, and what changed between them.",
  },
};

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

export function runIdFromStudioUrl(href: string): string | null {
  return new URL(href).searchParams.get("run") || null;
}

export function studioRunUrl(href: string, runId: string): string {
  const url = new URL(href);
  url.searchParams.set("run", runId);
  return url.href;
}

/** Leave the Definitions view once a loaded history has none, e.g. after Clear history. */
export function resolveStudioView(
  view: StudioView,
  snapshot: { readonly definitions: readonly unknown[] } | null | undefined
): StudioView {
  return view === "definitions" && snapshot && snapshot.definitions.length === 0 ? "runs" : view;
}

export function resolveSelectedRunId(
  selectedRunId: string | null,
  roots: readonly { runId: string }[]
): string | null {
  return selectedRunId ?? roots[0]?.runId ?? null;
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
  const dataController = useMemo(
    () => new StudioDataController(api, { runId: runIdFromStudioUrl(window.location.href) }),
    [api]
  );
  const [data, setData] = useState(() => dataController.getState());
  const { accessDenied, connected, historyQuery, selection, manualRefreshing, snapshot } = data;
  const selectedRunId = selection.status === "none" ? null : selection.runId;
  const [commands, setCommands] = useState<PipelineRunStudioCommand[]>([]);
  const [commandsLoaded, setCommandsLoaded] = useState(false);
  const [view, setView] = useState<StudioView>("runs");
  const [commandQuery, setCommandQuery] = useState("");
  const query = view === "runs" ? historyQuery.query : commandQuery;
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
        if (dataController.getState().accessDenied) return;
        setCommands(loaded);
        if (loaded.length && !runIdFromStudioUrl(window.location.href)) setView("pipelines");
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

  useEffect(() => {
    const onPopState = () => {
      dataController.setHistoryQuery({});
      dataController.selectRun(runIdFromStudioUrl(window.location.href));
      setView("runs");
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [dataController]);

  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(""), 4200);
    return () => clearTimeout(timeout);
  }, [toast]);

  const roots = snapshot?.runs ?? [];

  useEffect(() => {
    const next = resolveStudioView(view, snapshot);
    if (next !== view) setView(next);
  }, [snapshot, view]);

  useEffect(() => {
    if (!snapshot || !commandsLoaded || view !== "runs" || selectedRunId) return;
    const next = resolveSelectedRunId(selectedRunId, roots);
    if (!next) return;
    window.history.replaceState(null, "", studioRunUrl(window.location.href, next));
    dataController.selectRun(next);
  }, [commandsLoaded, dataController, roots, selectedRunId, snapshot, view]);

  const showToast = (message: string) => {
    if (!dataController.getState().accessDenied) setToast(message);
  };
  const selectRun = (runId: string) => {
    if (dataController.getState().accessDenied) return;
    if (runId !== selectedRunId) {
      window.history.pushState(null, "", studioRunUrl(window.location.href, runId));
    }
    dataController.selectRun(runId);
    setView("runs");
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
  const filteredCommands = commands.filter(
    (command) =>
      !query ||
      command.name.toLowerCase().includes(query.toLowerCase()) ||
      commandDescription(command).toLowerCase().includes(query.toLowerCase())
  );
  const isPipelines = view === "pipelines";
  const definitions = snapshot?.definitions ?? [];

  if (accessDenied) return <StudioAccessNotice status={accessDenied} href={window.location.href} />;

  const connection = connectionPresentation(connected);

  return (
    <>
      <div class="shell">
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
              <small>Local studio</small>
            </div>
          </div>
          <div class="rail-label">Workspace</div>
          <nav class="nav" aria-label="Studio sections">
            {commands.length > 0 && (
              <button
                class={isPipelines ? "active" : ""}
                type="button"
                title="Pipelines"
                onClick={() => setView("pipelines")}
              >
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M4 5h7M4 10h12M9 15h7" />
                  <circle cx="14.5" cy="5" r="1.5" />
                  <circle cx="5.5" cy="15" r="1.5" />
                </svg>
                <span>Pipelines</span>
                <b class="nav-count">{commands.length}</b>
              </button>
            )}
            <button
              class={view === "runs" ? "active" : ""}
              type="button"
              title="Runs"
              onClick={() => setView("runs")}
            >
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M10 3v4l2.5 1.5M17 10a7 7 0 1 1-2.05-4.95" />
                <path d="M14.5 2.8v3.5H18" />
              </svg>
              <span>Runs</span>
              <b class="nav-count">{snapshot?.runCount ?? 0}</b>
            </button>
            {definitions.length > 0 && (
              <button
                class={view === "definitions" ? "active" : ""}
                type="button"
                title="Definitions"
                onClick={() => setView("definitions")}
              >
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="3" y="3" width="6" height="6" rx="1.5" />
                  <rect x="11" y="11" width="6" height="6" rx="1.5" />
                  <path d="M9 6h3a2 2 0 0 1 2 2v3" />
                </svg>
                <span>Definitions</span>
                <b class="nav-count">{definitions.length}</b>
              </button>
            )}
          </nav>
          <div class="rail-foot">
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
          </div>
        </aside>
        <main class="workspace">
          <header class="topbar">
            <div>
              <h1>{viewHeadings[view].title}</h1>
              <p class="lede">{viewHeadings[view].lede}</p>
            </div>
            <div class="toolbar">
              {view !== "definitions" && (
                <input
                  class="search"
                  type="search"
                  value={query}
                  placeholder={isPipelines ? "Filter pipelines" : "Filter runs or IDs"}
                  aria-label="Filter"
                  onInput={(event) => {
                    const value = event.currentTarget.value.trim();
                    if (isPipelines) setCommandQuery(value);
                    else dataController.setHistoryQuery({ query: value });
                  }}
                />
              )}
              {commands.length > 0 && (
                <button
                  class="primary-button"
                  onClick={() => setLaunchCommandId(commands[0]?.id ?? "")}
                >
                  Run pipeline
                </button>
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
          {snapshot && (
            <>
              {isPipelines && (
                <section class="metrics">
                  <Metrics commandCount={commands.length} snapshot={snapshot} />
                </section>
              )}
              {isPipelines && (
                <PipelinesView commands={filteredCommands} onConfigure={setLaunchCommandId} />
              )}
              {view === "runs" && (
                <RunsView
                  api={api}
                  offset={snapshot.offset}
                  matchingRootCount={snapshot.matchingRootCount}
                  onPage={(offset) => dataController.setHistoryQuery({ ...historyQuery, offset })}
                  canCancel={canCancel}
                  cancelling={cancelling}
                  liveRunIds={snapshot.liveRunIds ?? []}
                  nowMs={nowMs}
                  onCancel={(id) => void cancelRun(id)}
                  onCopyLink={(id) => void copyRunLink(id)}
                  onSelect={selectRun}
                  roots={roots}
                  selection={selection}
                  latestRunId={roots[0]?.runId}
                  totalRunCount={snapshot.runCount}
                />
              )}
              {/* Stay mounted so the chosen definition and comparison survive view changes. */}
              <div hidden={view !== "definitions"}>
                <DefinitionHistory definitions={definitions} api={api} onSelect={selectRun} />
              </div>
            </>
          )}
        </main>
      </div>
      {launchCommandId !== null && (
        <LaunchModal
          api={api}
          commands={commands}
          commandId={launchCommandId}
          onClose={() => setLaunchCommandId(null)}
          onLaunched={(runId) => {
            if (dataController.getState().accessDenied) return;
            selectRun(runId);
            dataController.setHistoryQuery({});
            setLaunchCommandId(null);
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
