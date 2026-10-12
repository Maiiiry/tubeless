import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  RUN_EVENT_INSERT_SQL,
  RUN_EVENT_TABLE_STATEMENTS,
  RUN_EVENT_TRIGGER_STATEMENTS,
  runEventListQuery,
  runEventRow,
  storedRunEvent,
  type RunEventRecord,
} from "./run-store-sql.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";

const started: PipelineTraceEvent = {
  version: 3,
  name: "pipeline.started",
  runId: "run-1",
  pipelineId: "demo",
  timestampMs: 10,
  payload: { dryRun: false, planOk: true, stepCount: 1, targetIds: [] },
};

function database() {
  const db = new DatabaseSync(":memory:");
  for (const statement of [...RUN_EVENT_TABLE_STATEMENTS, ...RUN_EVENT_TRIGGER_STATEMENTS])
    db.exec(statement);
  return db;
}

describe("shared run-store SQL", () => {
  it("round-trips an event through each statement individually", () => {
    const db = database();
    db.prepare(RUN_EVENT_INSERT_SQL).run(...runEventRow(started));
    const { sql, params } = runEventListQuery({ runId: "run-1" });
    // SAFETY: SELECT * over the owned table returns RunEventRecord rows.
    const rows = db.prepare(sql).all(...(params as never[])) as unknown as RunEventRecord[];
    expect(rows.map(storedRunEvent)).toEqual([{ ...started, id: 1 }]);
  });

  it("keeps the table append-only", () => {
    const db = database();
    db.prepare(RUN_EVENT_INSERT_SQL).run(...runEventRow(started));
    expect(() => db.exec("DELETE FROM pipeline_run_events")).toThrow(/append-only/);
  });

  it("builds subtree, cursor, pipeline and limit predicates with bound values", () => {
    const query = runEventListQuery({ rootRunId: "r", afterId: 4, pipelineId: "p", limit: 0 });
    expect(query.sql).toContain("WITH RECURSIVE run_tree");
    expect(query.params).toEqual(["r", 4, "p", 1]);
    expect(runEventListQuery({ limit: 1e9 }).params).toEqual([100_000]);
    expect(runEventListQuery({}).params).toEqual([20_000]);
  });
});
