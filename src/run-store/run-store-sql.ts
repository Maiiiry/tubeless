import { decodeStoredTraceEvent } from "./run-store-event-decoder.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import type { PipelineRunEventQuery, StoredPipelineEvent } from "./run-store.js";

export const RUN_EVENT_STORE_VERSION = 4;

/** One statement per entry so drivers that execute a single statement per call can apply them. */
export const RUN_EVENT_TABLE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS pipeline_run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version INTEGER NOT NULL,
    run_id TEXT NOT NULL,
    correlation_id TEXT,
    parent_run_id TEXT,
    pipeline_id TEXT NOT NULL,
    step_id TEXT,
    attempt_id TEXT,
    item_key TEXT,
    event_name TEXT NOT NULL,
    timestamp_ms INTEGER NOT NULL,
    duration_ms REAL,
    payload_json TEXT NOT NULL,
    error_json TEXT,
    iteration_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS pipeline_run_events_run_id_idx ON pipeline_run_events(run_id, id)`,
  `CREATE INDEX IF NOT EXISTS pipeline_run_events_parent_run_id_idx ON pipeline_run_events(parent_run_id, id)`,
  `CREATE INDEX IF NOT EXISTS pipeline_run_events_pipeline_id_idx ON pipeline_run_events(pipeline_id, id DESC)`,
  `CREATE INDEX IF NOT EXISTS pipeline_run_events_timestamp_idx ON pipeline_run_events(timestamp_ms DESC)`,
];

export const RUN_EVENT_TRIGGER_STATEMENTS: readonly string[] = [
  `CREATE TRIGGER IF NOT EXISTS pipeline_run_events_no_update
  BEFORE UPDATE ON pipeline_run_events
  BEGIN
    SELECT RAISE(ABORT, 'pipeline_run_events is append-only');
  END`,
  `CREATE TRIGGER IF NOT EXISTS pipeline_run_events_no_delete
  BEFORE DELETE ON pipeline_run_events
  BEGIN
    SELECT RAISE(ABORT, 'pipeline_run_events is append-only');
  END`,
];

export const RUN_EVENT_DROP_TRIGGER_STATEMENTS: readonly string[] = [
  "DROP TRIGGER IF EXISTS pipeline_run_events_no_update",
  "DROP TRIGGER IF EXISTS pipeline_run_events_no_delete",
];

export const RUN_EVENT_INSERT_SQL = `INSERT INTO pipeline_run_events (
  version, run_id, correlation_id, parent_run_id, pipeline_id, step_id, attempt_id,
  item_key, event_name, timestamp_ms, duration_ms, payload_json, error_json, iteration_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** Join statements for drivers whose `exec` accepts a script. */
export function sqlScript(statements: readonly string[]): string {
  return statements.map((statement) => `${statement};`).join("\n");
}

export type RunEventRow = readonly [
  version: number,
  runId: string,
  correlationId: string | null,
  parentRunId: string | null,
  pipelineId: string,
  stepId: string | null,
  attemptId: string | null,
  itemKey: string | null,
  name: string,
  timestampMs: number,
  durationMs: number | null,
  payloadJson: string,
  errorJson: string | null,
  iterationJson: string | null,
];

export function runEventRow(event: PipelineTraceEvent): RunEventRow {
  const canonical = decodeStoredTraceEvent(event);
  return [
    canonical.version,
    canonical.runId,
    canonical.correlationId ?? null,
    canonical.parentRunId ?? null,
    canonical.pipelineId,
    "stepId" in canonical ? (canonical.stepId ?? null) : null,
    "attemptId" in canonical ? (canonical.attemptId ?? null) : null,
    canonical.itemKey ?? null,
    canonical.name,
    canonical.timestampMs,
    "durationMs" in canonical ? (canonical.durationMs ?? null) : null,
    JSON.stringify(canonical.payload),
    "error" in canonical && canonical.error ? JSON.stringify(canonical.error) : null,
    canonical.iteration ? JSON.stringify(canonical.iteration) : null,
  ];
}

/** One `pipeline_run_events` row as a SQLite driver returns it. */
export interface RunEventRecord {
  attempt_id: string | null;
  correlation_id: string | null;
  duration_ms: number | null;
  error_json: string | null;
  event_name: string;
  id: number | bigint;
  item_key: string | null;
  /** Absent when inspecting a legacy version 3 store without migrating it. */
  iteration_json?: string | null;
  parent_run_id: string | null;
  payload_json: string;
  pipeline_id: string;
  run_id: string;
  step_id: string | null;
  timestamp_ms: number | bigint;
  version: number;
}

export function storedRunEvent(row: RunEventRecord): StoredPipelineEvent {
  const encoded: Record<string, unknown> = {
    name: row.event_name,
    pipelineId: row.pipeline_id,
    runId: row.run_id,
    timestampMs: Number(row.timestamp_ms),
    version: row.version,
  };
  encoded.payload = JSON.parse(row.payload_json);
  if (row.attempt_id) encoded.attemptId = row.attempt_id;
  if (row.correlation_id != null) encoded.correlationId = row.correlation_id;
  if (row.duration_ms !== null) encoded.durationMs = Number(row.duration_ms);
  if (row.error_json) encoded.error = JSON.parse(row.error_json);
  if (row.item_key) encoded.itemKey = row.item_key;
  if (row.iteration_json) encoded.iteration = JSON.parse(row.iteration_json);
  if (row.parent_run_id) encoded.parentRunId = row.parent_run_id;
  if (row.step_id) encoded.stepId = row.step_id;
  return { ...decodeStoredTraceEvent(encoded), id: Number(row.id) };
}

// Binds the root run ID. UNION visits each run once, including cyclic or duplicate parent links.
// SQLite can build a transient join index for older read-only stores.
const RUN_TREE_CTE = `WITH RECURSIVE run_tree(run_id) AS (
      SELECT ?
      UNION
      SELECT event.run_id FROM pipeline_run_events AS event
      JOIN run_tree AS parent ON event.parent_run_id = parent.run_id
    )`;

/**
 * Start events of runs in a subtree that have no completion. Latest start first: a nested run
 * starts after its parent, so every child precedes its parent and the root comes last.
 */
export function openSubtreeStartsQuery(rootRunId: string): { sql: string; params: unknown[] } {
  return {
    sql: `${RUN_TREE_CTE} SELECT * FROM pipeline_run_events AS started
      WHERE started.event_name = 'pipeline.started'
        AND started.run_id IN (SELECT run_id FROM run_tree)
        AND NOT EXISTS (
          SELECT 1 FROM pipeline_run_events AS done
          WHERE done.run_id = started.run_id AND done.event_name = 'pipeline.completed'
        )
      ORDER BY started.id DESC`,
    params: [rootRunId],
  };
}

export function runEventListQuery(query: PipelineRunEventQuery): {
  sql: string;
  params: unknown[];
} {
  const predicates: string[] = [];
  const params: unknown[] = [];
  let subtree = "";
  if (query.rootRunId !== undefined) {
    subtree = RUN_TREE_CTE;
    params.push(query.rootRunId);
    predicates.push("run_id IN (SELECT run_id FROM run_tree)");
  }
  if (query.afterId !== undefined) {
    predicates.push("id > ?");
    params.push(query.afterId);
  }
  if (query.pipelineId !== undefined) {
    predicates.push("pipeline_id = ?");
    params.push(query.pipelineId);
  }
  if (query.runId !== undefined) {
    predicates.push("run_id = ?");
    params.push(query.runId);
  }
  params.push(Math.max(1, Math.min(100_000, Math.floor(query.limit ?? 20_000))));
  const where = predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "";
  return {
    sql: `${subtree} SELECT * FROM pipeline_run_events ${where} ORDER BY id ASC LIMIT ?`,
    params,
  };
}
