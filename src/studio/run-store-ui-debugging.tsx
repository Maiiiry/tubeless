import { useState } from "preact/hooks";
import type { PipelineErrorCause } from "../core/pipeline.js";
import type { StoredPipelineLog, StoredPipelineRun } from "../run-store/run-store.js";

type RunError = NonNullable<StoredPipelineRun["error"]>;
type LogLevel = StoredPipelineLog["level"] | "all";
type LogStepFilter = "all" | "unattributed" | `step:${string}`;

export function formatValidationPath(path: readonly (number | string)[] | undefined): string {
  if (path === undefined) return "Path unavailable";
  return path.reduce<string>(
    (result, part) =>
      result +
      (typeof part === "number"
        ? `[${part}]`
        : /^[A-Za-z_$][\w$]*$/.test(part)
          ? `.${part}`
          : `[${JSON.stringify(part)}]`),
    "$"
  );
}

export function filterRunLogs(
  logs: readonly StoredPipelineLog[],
  query: string,
  level: LogLevel,
  stepFilter: LogStepFilter
): StoredPipelineLog[] {
  const needle = query.trim().toLowerCase();
  return logs.filter(
    (log) =>
      (level === "all" || log.level === level) &&
      (stepFilter === "all" ||
        (stepFilter === "unattributed"
          ? !log.stepId
          : log.stepId === stepFilter.slice("step:".length))) &&
      (!needle || log.message.toLowerCase().includes(needle))
  );
}

function Cause({ cause, label = "Cause" }: { cause: PipelineErrorCause; label?: string }) {
  return (
    <details class="debug-cause">
      <summary>
        {label}: {cause.name && `${cause.name}: `}
        {cause.message || "No message"}
      </summary>
      <div class="debug-cause-body">
        {cause.sourceCode && <div>Source code: {cause.sourceCode}</div>}
        {cause.cause && <Cause cause={cause.cause} />}
      </div>
    </details>
  );
}

interface ErrorDiagnosticsProps {
  error: RunError;
  /** Steps that recorded a failure; each links to its timeline row or graph node. */
  failedStepIds?: readonly string[];
  onSelectStep?(stepId: string): void;
}

export function ErrorDiagnostics({
  error,
  failedStepIds = [],
  onSelectStep,
}: ErrorDiagnosticsProps) {
  const fanOut = error.fanOut;
  return (
    <section aria-label="Run diagnostics" class="error-card">
      {failedStepIds.length > 0 && (
        <div class="error-steps">
          <span>Failed at</span>
          {failedStepIds.map((stepId) =>
            onSelectStep ? (
              <button type="button" key={stepId} onClick={() => onSelectStep(stepId)}>
                {stepId}
              </button>
            ) : (
              <code key={stepId}>{stepId}</code>
            )
          )}
        </div>
      )}
      <div class="error-code">
        {error.code} · {error.phase} · {error.kind}
        {error.sourceCode && ` · ${error.sourceCode}`}
      </div>
      <div class="error-message">{error.message}</div>
      {error.issues && error.issues.length > 0 && (
        <div class="debug-group">
          <strong>Validation issues · {error.issues.length}</strong>
          <ul class="debug-issues">
            {error.issues.map((issue, index) => (
              <li key={index}>
                <code>{formatValidationPath(issue.path)}</code>
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error.cause && (
        <div class="debug-group">
          <Cause cause={error.cause} />
        </div>
      )}
      {fanOut && (
        <div class="debug-group">
          <strong>Failed fan-out items · {fanOut.failureCount}</strong>
          {fanOut.failures.map((failure) => (
            <details class="debug-cause" key={failure.index}>
              <summary>
                #{failure.index + 1} · {failure.key}
                {failure.keyTruncated && " (key truncated)"} ·{" "}
                {failure.cancelled ? "cancelled" : "failed"} · {failure.error.message}
              </summary>
              <div class="debug-cause-body">
                {failure.error.name && <div>Type: {failure.error.name}</div>}
                {failure.error.sourceCode && <div>Source code: {failure.error.sourceCode}</div>}
                {failure.error.cause && <Cause cause={failure.error.cause} />}
              </div>
            </details>
          ))}
          {fanOut.omittedFailureCount > 0 && (
            <div class="debug-note">
              {fanOut.omittedFailureCount} more failures omitted from the recording
            </div>
          )}
          {fanOut.schedulerError && <Cause cause={fanOut.schedulerError} label="Scheduler error" />}
        </div>
      )}
    </section>
  );
}

function clock(timestampMs: number): string {
  if (!Number.isFinite(timestampMs) || Math.abs(timestampMs) > 8.64e15) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestampMs);
}

export function RunLogs({ logs }: { logs: readonly StoredPipelineLog[] }) {
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<LogLevel>("all");
  const [stepFilter, setStepFilter] = useState<LogStepFilter>("all");
  const stepIds = [...new Set(logs.flatMap((log) => (log.stepId ? [log.stepId] : [])))].sort();
  const visibleLogs = filterRunLogs(logs, query, level, stepFilter);
  return (
    <section aria-label="Run logs">
      <div class="section-title">
        <span>Logs</span>
        <span>
          {visibleLogs.length === logs.length
            ? logs.length
            : `${visibleLogs.length} of ${logs.length}`}
        </span>
      </div>
      <div class="log-filters">
        <label>
          <span>Search text</span>
          <input
            type="search"
            value={query}
            onInput={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search log messages"
          />
        </label>
        <label>
          <span>Level</span>
          <select
            value={level}
            onChange={(event) => setLevel(event.currentTarget.value as LogLevel)}
          >
            <option value="all">All levels</option>
            <option value="error">Error</option>
            <option value="warn">Warn</option>
            <option value="log">Log</option>
          </select>
        </label>
        <label>
          <span>Step</span>
          <select
            value={stepFilter}
            onChange={(event) => setStepFilter(event.currentTarget.value as LogStepFilter)}
          >
            <option value="all">All steps</option>
            {logs.some((log) => !log.stepId) && <option value="unattributed">No step</option>}
            {stepIds.map((id) => (
              <option value={`step:${id}`} key={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
      </div>
      {visibleLogs.length ? (
        <div class="logs">
          {visibleLogs.map((log) => (
            <div class="log-line" key={log.id}>
              <time class="log-time">{clock(log.timestampMs)}</time>
              <span class={`log-level ${log.level}`}>{log.level}</span>
              <span class="log-message">
                {log.stepId && (
                  <>
                    <b>{log.stepId}</b> ·{" "}
                  </>
                )}
                {log.message}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div class="log-empty">No logs match these filters.</div>
      )}
    </section>
  );
}
