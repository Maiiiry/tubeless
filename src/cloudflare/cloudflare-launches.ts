import {
  openSubtreeStartsQuery,
  storedRunEvent,
  type RunEventRecord,
} from "../run-store/run-store-sql.js";
import { PIPELINE_TRACE_VERSION } from "../tracing/tracing-constants.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import type { DurableRunStore } from "./cloudflare-run-store.js";
import type { DurableStorageLike } from "./cloudflare-storage.js";

export type LaunchState = "starting" | "running" | "finished" | "failed";

export interface LaunchRecord {
  readonly launchId: string;
  readonly commandId: string;
  readonly runId?: string;
  readonly pipelineId?: string;
  readonly dryRun: boolean;
  readonly stepCount: number;
  readonly state: LaunchState;
  /** The run object was cleared to execute user code; a start failure must not close it. */
  readonly admitted: boolean;
  readonly lastBatch: number;
  readonly createdAtMs: number;
}

export interface BatchOutcome {
  readonly duplicate: boolean;
  /** The launch was already terminal, so this new batch was not appended. */
  readonly dropped: boolean;
  readonly boundRunId?: string;
  readonly terminal: boolean;
}

const TERMINAL: ReadonlySet<LaunchState> = new Set(["finished", "failed"]);

type PipelineStartedEvent = Extract<PipelineTraceEvent, { name: "pipeline.started" }>;

/** A failed completion mirroring the identity core gives a run's own completion event. */
function hostTerminatedEvent(
  started: PipelineStartedEvent,
  message: string,
  nowMs: number
): PipelineTraceEvent {
  return {
    version: PIPELINE_TRACE_VERSION,
    name: "pipeline.completed",
    runId: started.runId,
    pipelineId: started.pipelineId,
    ...(started.parentRunId === undefined ? {} : { parentRunId: started.parentRunId }),
    ...(started.correlationId === undefined ? {} : { correlationId: started.correlationId }),
    ...(started.itemKey === undefined ? {} : { itemKey: started.itemKey }),
    ...(started.iteration === undefined ? {} : { iteration: started.iteration }),
    timestampMs: nowMs,
    payload: {
      dryRun: started.payload.dryRun,
      errorCount: 1,
      finalized: false,
      status: "failed",
      stepCount: started.payload.stepCount,
    },
    error: { code: "TUBELESS_RUN_CANCELLED", kind: "cancellation", message, phase: "execution" },
  };
}

/** Owns launch admission state in the Studio object; all transitions are transactional. */
export class LaunchRegistry {
  constructor(
    private readonly storage: Pick<DurableStorageLike, "sql" | "transactionSync">,
    private readonly store: DurableRunStore
  ) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS tubeless_launches (
      launch_id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL,
      run_id TEXT,
      pipeline_id TEXT,
      dry_run INTEGER NOT NULL DEFAULT 0,
      step_count INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL,
      admitted INTEGER NOT NULL DEFAULT 0,
      last_batch INTEGER NOT NULL DEFAULT -1,
      created_at_ms INTEGER NOT NULL
    )`);
    storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS tubeless_launches_run_id_idx ON tubeless_launches(run_id)"
    );
  }

  create(launchId: string, commandId: string, nowMs: number): void {
    this.storage.sql.exec(
      "INSERT INTO tubeless_launches (launch_id, command_id, state, created_at_ms) VALUES (?, ?, 'starting', ?)",
      launchId,
      commandId,
      nowMs
    );
  }

  get(launchId: string): LaunchRecord | undefined {
    const row = this.storage.sql
      .exec("SELECT * FROM tubeless_launches WHERE launch_id = ?", launchId)
      .toArray()[0];
    if (!row) return undefined;
    return {
      launchId: String(row.launch_id),
      commandId: String(row.command_id),
      ...(row.run_id == null ? {} : { runId: String(row.run_id) }),
      ...(row.pipeline_id == null ? {} : { pipelineId: String(row.pipeline_id) }),
      dryRun: Number(row.dry_run) === 1,
      stepCount: Number(row.step_count),
      // SAFETY: state is only ever written from LaunchState literals in this class.
      state: row.state as LaunchState,
      admitted: Number(row.admitted) === 1,
      lastBatch: Number(row.last_batch),
      createdAtMs: Number(row.created_at_ms),
    };
  }

  /** Clear an open launch to execute; a closed or unknown launch must never run user code. */
  admit(launchId: string): boolean {
    return this.storage.transactionSync(() => {
      const launch = this.get(launchId);
      if (!launch || TERMINAL.has(launch.state)) return false;
      this.storage.sql.exec(
        "UPDATE tubeless_launches SET admitted = 1 WHERE launch_id = ?",
        launchId
      );
      return true;
    });
  }

  /**
   * Batches are strictly serial: a sequence at or below the last accepted batch is an idempotent
   * duplicate, and the next batch must be exactly `lastBatch + 1`. A gap throws without writing.
   */
  acceptBatch(
    launchId: string,
    sequence: number,
    events: readonly PipelineTraceEvent[]
  ): BatchOutcome {
    return this.storage.transactionSync(() => {
      const launch = this.get(launchId);
      if (!launch) throw new Error(`Unknown launch ${JSON.stringify(launchId)}.`);
      if (sequence <= launch.lastBatch)
        return { duplicate: true, dropped: false, terminal: TERMINAL.has(launch.state) };
      if (sequence > launch.lastBatch + 1)
        throw new Error(
          `Launch ${launchId} expected batch ${launch.lastBatch + 1} but received ${sequence}.`
        );
      if (TERMINAL.has(launch.state)) {
        // A reconciled failure already closed this run; keep exactly one completion in history.
        this.storage.sql.exec(
          "UPDATE tubeless_launches SET last_batch = ? WHERE launch_id = ?",
          sequence,
          launchId
        );
        return { duplicate: false, dropped: true, terminal: true };
      }
      this.store.append(events);
      let { runId, pipelineId, dryRun, stepCount, state } = launch;
      let boundRunId: string | undefined;
      for (const event of events) {
        if (
          runId === undefined &&
          event.name === "pipeline.started" &&
          event.parentRunId === undefined
        ) {
          runId = event.runId;
          pipelineId = event.pipelineId;
          dryRun = event.payload.dryRun;
          stepCount = event.payload.stepCount;
          state = "running";
          boundRunId = runId;
        } else if (
          runId !== undefined &&
          event.name === "pipeline.completed" &&
          event.runId === runId
        ) {
          state = "finished";
        }
      }
      this.storage.sql.exec(
        `UPDATE tubeless_launches
         SET run_id = ?, pipeline_id = ?, dry_run = ?, step_count = ?, state = ?, last_batch = ?
         WHERE launch_id = ?`,
        runId ?? null,
        pipelineId ?? null,
        dryRun ? 1 : 0,
        stepCount,
        state,
        sequence,
        launchId
      );
      return {
        duplicate: false,
        dropped: false,
        ...(boundRunId ? { boundRunId } : {}),
        terminal: TERMINAL.has(state),
      };
    });
  }

  fail(launchId: string, message: string, nowMs: number): void {
    this.storage.transactionSync(() => {
      const launch = this.get(launchId);
      if (!launch || TERMINAL.has(launch.state)) return;
      if (launch.runId)
        this.store.append(this.#openSubtreeCompletions(launch.runId, message, nowMs));
      this.storage.sql.exec(
        "UPDATE tubeless_launches SET state = 'failed' WHERE launch_id = ?",
        launchId
      );
    });
  }

  /** Close the bound run and every nested run it left open, children before parents. */
  #openSubtreeCompletions(rootRunId: string, message: string, nowMs: number) {
    const { sql, params } = openSubtreeStartsQuery(rootRunId);
    // SAFETY: SELECT * over the owned pipeline_run_events table returns RunEventRecord rows.
    const rows = this.storage.sql.exec(sql, ...params).toArray() as unknown as RunEventRecord[];
    const closed = new Set<string>();
    const completions: PipelineTraceEvent[] = [];
    for (const row of rows) {
      const started = storedRunEvent(row);
      if (started.name !== "pipeline.started" || closed.has(started.runId)) continue;
      closed.add(started.runId);
      completions.push(hostTerminatedEvent(started, message, nowMs));
    }
    return completions;
  }

  liveRunIds(): string[] {
    return this.storage.sql
      .exec(
        "SELECT run_id FROM tubeless_launches WHERE state = 'running' AND run_id IS NOT NULL ORDER BY created_at_ms"
      )
      .toArray()
      .map((row) => String(row.run_id));
  }

  launchIdForRun(runId: string): string | undefined {
    const row = this.storage.sql
      .exec("SELECT launch_id FROM tubeless_launches WHERE run_id = ? AND state = 'running'", runId)
      .toArray()[0];
    return row ? String(row.launch_id) : undefined;
  }

  stale(cutoffMs: number): string[] {
    return this.storage.sql
      .exec(
        "SELECT launch_id FROM tubeless_launches WHERE state IN ('starting', 'running') AND created_at_ms <= ? ORDER BY created_at_ms",
        cutoffMs
      )
      .toArray()
      .map((row) => String(row.launch_id));
  }

  hasActive(): boolean {
    return (
      this.storage.sql
        .exec("SELECT 1 FROM tubeless_launches WHERE state IN ('starting', 'running') LIMIT 1")
        .toArray().length > 0
    );
  }
}
