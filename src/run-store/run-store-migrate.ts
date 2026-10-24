import { upgradeLegacyAttributeRow, type LegacyAttributeRow } from "./legacy-trace-event.js";
import {
  RUN_EVENT_STORE_VERSION,
  RUN_EVENT_TABLE_STATEMENTS,
  RUN_EVENT_TRIGGER_STATEMENTS,
  runEventRow,
} from "./run-store-sql.js";

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): void;
}

interface RunStoreDatabase {
  exec(sql: string): void;
  prepare?(sql: string): SqliteStatement;
  query?(sql: string): SqliteStatement;
}

/**
 * Highest schema version this file knows how to produce.
 * `RUN_EVENT_STORE_VERSION` must stay equal to it. Bump both in the same change
 * and append a step below. `tubeless upgrade` runs every missing step in order.
 */
const MIGRATED_STORE_VERSION = 4;

/** Schema version 3 is the payload table before iteration relations existed. */
const PAYLOAD_STORE_VERSION = 3;

export function unsupportedRunStoreSchema(version: number): Error {
  return new Error(
    `Unsupported pipeline run store schema version ${version}; expected ${RUN_EVENT_STORE_VERSION}.`
  );
}

/** Fail closed when the stamped schema has no migration step in this file. */
export function assertRunStoreMigrationConfigured(
  storeVersion: number = RUN_EVENT_STORE_VERSION,
  migratedVersion: number = MIGRATED_STORE_VERSION
): void {
  if (storeVersion !== migratedVersion) {
    throw new Error(
      `Add a pipeline run store migration for schema version ${storeVersion} before opening the store.`
    );
  }
}

/** Writable opens refuse an older file. `tubeless upgrade --yes` is the writer. */
export function runStoreUpgradeRequired(filename: string, version: number): Error {
  return new Error(
    `${filename} is pipeline run store schema version ${version}. Run \`tubeless upgrade --yes --store ${filename}\` before writing. The upgrade rewrites the history file and cannot be undone.`
  );
}

export function readSqliteUserVersion(database: RunStoreDatabase): number {
  // SAFETY: `PRAGMA user_version` always returns a single row with a
  // `user_version` column, so the first result row matches this shape.
  const versionRow = statement(database, "PRAGMA user_version").all()[0] as
    | { user_version?: number | bigint }
    | undefined;
  return Number(versionRow?.user_version ?? 0);
}

export function runStoreColumnNames(database: RunStoreDatabase): ReadonlySet<string> {
  // SAFETY: `PRAGMA table_info` returns one row per column with a `name` field.
  const rows = statement(database, "PRAGMA table_info(pipeline_run_events)").all() as {
    name?: string;
  }[];
  return new Set(rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])));
}

export function supportedRunStoreLayout(version: number, columns: ReadonlySet<string>): boolean {
  if (!isEventTable(columns)) return false;
  if (version === 1) return isAttributeStore(columns) && !columns.has("correlation_id");
  if (version === 2) return isAttributeStore(columns) && columns.has("correlation_id");
  if (version === PAYLOAD_STORE_VERSION)
    return isPayloadStore(columns) && !columns.has("iteration_json");
  if (version === MIGRATED_STORE_VERSION) {
    return isPayloadStore(columns) && columns.has("iteration_json");
  }
  return false;
}

/**
 * Move a writable store from any older schema to the current one.
 * The upgrade commits once. A thrown error rolls it back and leaves the
 * previous schema, events, and append-only triggers in place.
 */
export function upgradeSqliteRunStore(database: RunStoreDatabase): void {
  assertRunStoreMigrationConfigured();
  const steps: Partial<Record<number, (database: RunStoreDatabase) => void>> = {
    1: addCorrelationColumn,
    2: rewriteAttributeEvents,
    3: addIterationColumn,
  };
  // One transaction covers every missing step. A bad event rolls the store
  // back to the schema it had when the open started.
  inTransaction(database, () => {
    for (;;) {
      const version = readSqliteUserVersion(database);
      if (version === RUN_EVENT_STORE_VERSION) return;
      const step = steps[version];
      if (step === undefined) throw unsupportedRunStoreSchema(version);
      step(database);
      if (readSqliteUserVersion(database) <= version) {
        throw new Error(`Pipeline run store schema version ${version} did not advance.`);
      }
    }
  });
}

function statement(database: RunStoreDatabase, sql: string): SqliteStatement {
  const prepared = database.query?.(sql) ?? database.prepare?.(sql);
  if (!prepared) throw new Error("The current SQLite runtime does not support prepared queries.");
  return prepared;
}

function isEventTable(columns: ReadonlySet<string>): boolean {
  return (
    columns.has("id") &&
    columns.has("run_id") &&
    columns.has("event_name") &&
    columns.has("timestamp_ms")
  );
}

function isAttributeStore(columns: ReadonlySet<string>): boolean {
  return (
    columns.has("attributes_json") && !columns.has("payload_json") && !columns.has("iteration_json")
  );
}

function isPayloadStore(columns: ReadonlySet<string>): boolean {
  return (
    columns.has("payload_json") && columns.has("correlation_id") && !columns.has("attributes_json")
  );
}

function inTransaction(database: RunStoreDatabase, change: () => void): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    change();
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // The failed change is the error callers can act on.
    }
    throw error;
  }
}

function addCorrelationColumn(database: RunStoreDatabase): void {
  if (!supportedRunStoreLayout(1, runStoreColumnNames(database)))
    throw unsupportedRunStoreSchema(1);
  database.exec("ALTER TABLE pipeline_run_events ADD COLUMN correlation_id TEXT");
  database.exec("PRAGMA user_version = 2");
}

function addIterationColumn(database: RunStoreDatabase): void {
  if (!supportedRunStoreLayout(PAYLOAD_STORE_VERSION, runStoreColumnNames(database))) {
    throw unsupportedRunStoreSchema(PAYLOAD_STORE_VERSION);
  }
  database.exec("ALTER TABLE pipeline_run_events ADD COLUMN iteration_json TEXT");
  database.exec(`PRAGMA user_version = ${MIGRATED_STORE_VERSION}`);
}

/**
 * Copy attribute rows into the payload table. Append-only triggers reject
 * UPDATE, and the old column name cannot stay, so the replacement is a new
 * table committed with the previous events still intact if any row fails.
 */
function rewriteAttributeEvents(database: RunStoreDatabase): void {
  if (!supportedRunStoreLayout(2, runStoreColumnNames(database)))
    throw unsupportedRunStoreSchema(2);
  database.exec(`CREATE TABLE pipeline_run_events_next (
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
      error_json TEXT
    )`);
  const rows = statement(
    database,
    `SELECT id, version, run_id, correlation_id, parent_run_id, pipeline_id, step_id,
        attempt_id, item_key, event_name, timestamp_ms, duration_ms, attributes_json, error_json
       FROM pipeline_run_events ORDER BY id`
  ).all() as LegacyAttributeRow[];
  const insert = statement(
    database,
    `INSERT INTO pipeline_run_events_next (
        id, version, run_id, correlation_id, parent_run_id, pipeline_id, step_id, attempt_id,
        item_key, event_name, timestamp_ms, duration_ms, payload_json, error_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const row of rows) {
    const event = upgradeLegacyAttributeRow(row);
    const [
      version,
      runId,
      correlationId,
      parentRunId,
      pipelineId,
      stepId,
      attemptId,
      itemKey,
      name,
      timestampMs,
      durationMs,
      payloadJson,
      errorJson,
      iterationJson,
    ] = runEventRow(event);
    if (iterationJson !== null) {
      throw new Error(
        `Cannot upgrade pipeline run event ${String(row.id)} (${row.event_name}): iteration metadata is not stored before schema version ${MIGRATED_STORE_VERSION}.`
      );
    }
    insert.run(
      Number(row.id),
      version,
      runId,
      correlationId,
      parentRunId,
      pipelineId,
      stepId,
      attemptId,
      itemKey,
      name,
      timestampMs,
      durationMs,
      payloadJson,
      errorJson
    );
  }
  // Read the counter before DROP. Dropping the table deletes its sqlite_sequence row,
  // and a cleared store can have a counter ahead of MAX(id).
  const preservedSeq = savedEventSequence(database);
  database.exec("DROP TABLE pipeline_run_events");
  database.exec("ALTER TABLE pipeline_run_events_next RENAME TO pipeline_run_events");
  for (const sql of RUN_EVENT_TABLE_STATEMENTS) {
    if (sql.startsWith("CREATE INDEX")) database.exec(sql);
  }
  for (const sql of RUN_EVENT_TRIGGER_STATEMENTS) database.exec(sql);
  resetEventSequence(database, preservedSeq);
  database.exec(`PRAGMA user_version = ${PAYLOAD_STORE_VERSION}`);
}

function savedEventSequence(database: RunStoreDatabase): number {
  if (!hasSqliteSequence(database)) return 0;
  const row = statement(
    database,
    "SELECT seq FROM sqlite_sequence WHERE name = 'pipeline_run_events'"
  ).all()[0] as { seq?: number | bigint } | undefined;
  const seq = Number(row?.seq ?? 0);
  return Number.isFinite(seq) ? seq : 0;
}

function resetEventSequence(database: RunStoreDatabase, preservedSeq: number): void {
  if (!hasSqliteSequence(database)) return;
  const row = statement(
    database,
    "SELECT COALESCE(MAX(id), 0) AS max_id FROM pipeline_run_events"
  ).all()[0] as { max_id?: number | bigint } | undefined;
  const maxId = Number(row?.max_id ?? 0);
  const seq = Math.max(preservedSeq, Number.isFinite(maxId) ? maxId : 0);
  database.exec(
    "DELETE FROM sqlite_sequence WHERE name IN ('pipeline_run_events', 'pipeline_run_events_next')"
  );
  statement(
    database,
    "INSERT INTO sqlite_sequence(name, seq) VALUES ('pipeline_run_events', ?)"
  ).run(seq);
}

function hasSqliteSequence(database: RunStoreDatabase): boolean {
  return (
    statement(
      database,
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'"
    ).all().length > 0
  );
}
