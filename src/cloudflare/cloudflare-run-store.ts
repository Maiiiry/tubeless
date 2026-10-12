import type { PipelineRunEventQuery, PipelineRunEventReader } from "../run-store/run-store.js";
import {
  RUN_EVENT_INSERT_SQL,
  RUN_EVENT_STORE_VERSION,
  RUN_EVENT_TABLE_STATEMENTS,
  RUN_EVENT_TRIGGER_STATEMENTS,
  runEventListQuery,
  runEventRow,
  storedRunEvent,
  type RunEventRecord,
} from "../run-store/run-store-sql.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import type { DurableStorageLike } from "./cloudflare-storage.js";

export interface DurableRunStore extends PipelineRunEventReader {
  /** Append events; callers own the surrounding transactionSync. */
  append(events: readonly PipelineTraceEvent[]): void;
}

/** Event store over Durable Object SQLite. Schema version lives in a table, not user_version. */
export function openDurableRunStore(
  storage: Pick<DurableStorageLike, "sql" | "transactionSync">
): DurableRunStore {
  const { sql } = storage;
  storage.transactionSync(() => {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS tubeless_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    );
    const row = sql
      .exec("SELECT value FROM tubeless_meta WHERE key = 'run_event_store_version'")
      .toArray()[0];
    if (row === undefined) {
      for (const statement of [...RUN_EVENT_TABLE_STATEMENTS, ...RUN_EVENT_TRIGGER_STATEMENTS])
        sql.exec(statement);
      sql.exec(
        "INSERT INTO tubeless_meta (key, value) VALUES ('run_event_store_version', ?)",
        String(RUN_EVENT_STORE_VERSION)
      );
    } else if (row.value !== String(RUN_EVENT_STORE_VERSION)) {
      throw new Error(
        `Unsupported pipeline run store schema version ${String(row.value)}; expected ${RUN_EVENT_STORE_VERSION}.`
      );
    }
  });
  return {
    append(events) {
      for (const event of events) sql.exec(RUN_EVENT_INSERT_SQL, ...runEventRow(event));
    },
    async listEvents(query: PipelineRunEventQuery = {}) {
      const { sql: text, params } = runEventListQuery(query);
      // SAFETY: SELECT * over the owned pipeline_run_events table returns RunEventRecord rows.
      const rows = sql.exec(text, ...params).toArray() as unknown as RunEventRecord[];
      return rows.map(storedRunEvent);
    },
    close() {},
  };
}
