import { DatabaseSync } from "node:sqlite";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PipelineRunStudioEventState } from "../studio/run-store-ui-state.js";
import { assertRunStoreMigrationConfigured } from "./run-store-migrate.js";
import { openSqlitePipelineRunStore, upgradeSqlitePipelineRunStore } from "./run-store-sqlite.js";
import { createSteps, definePipeline } from "../core/pipeline.js";
import { createPipelineTestRuntime } from "../testing/testing.js";
import { projectPipelineRunStore, type StoredPipelineEvent } from "./run-store.js";

const directories: string[] = [];

const LEGACY_ATTRIBUTE_STORE_SQL = `
CREATE TABLE pipeline_run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  parent_run_id TEXT,
  pipeline_id TEXT NOT NULL,
  step_id TEXT,
  attempt_id TEXT,
  item_key TEXT,
  event_name TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  duration_ms REAL,
  attributes_json TEXT NOT NULL,
  error_json TEXT
);
CREATE TRIGGER pipeline_run_events_no_update
BEFORE UPDATE ON pipeline_run_events
BEGIN
  SELECT RAISE(ABORT, 'pipeline_run_events is append-only');
END;
CREATE TRIGGER pipeline_run_events_no_delete
BEFORE DELETE ON pipeline_run_events
BEGIN
  SELECT RAISE(ABORT, 'pipeline_run_events is append-only');
END;
`;

function insertLegacy(
  database: DatabaseSync,
  event: {
    readonly attemptId?: string;
    readonly attributes: unknown;
    readonly correlationId?: string;
    readonly durationMs?: number;
    readonly error?: unknown;
    readonly id: number;
    readonly name: string;
    readonly stepId?: string;
    readonly timestampMs?: number;
    readonly version?: number;
  }
): void {
  const correlation = event.correlationId === undefined ? "" : ", correlation_id";
  const correlationSlot = event.correlationId === undefined ? "" : ", ?";
  const statement = database.prepare(
    `INSERT INTO pipeline_run_events (
      id, version, run_id, pipeline_id, step_id, attempt_id, event_name, timestamp_ms,
      duration_ms, attributes_json, error_json${correlation}
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${correlationSlot})`
  );
  const params = [
    event.id,
    event.version ?? 1,
    "run-1",
    "import",
    event.stepId ?? null,
    event.attemptId ?? null,
    event.name,
    event.timestampMs ?? 10,
    event.durationMs ?? null,
    JSON.stringify(event.attributes),
    event.error === undefined ? null : JSON.stringify(event.error),
  ];
  if (event.correlationId !== undefined) params.push(event.correlationId);
  statement.run(...params);
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

async function openTempStore() {
  const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
  directories.push(directory);
  return openSqlitePipelineRunStore(path.join(directory, "runs.sqlite"));
}

function startedEvent(runId: string, timestampMs: number, pipelineId = "import") {
  return {
    name: "pipeline.started" as const,
    payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
    pipelineId,
    runId,
    timestampMs,
    version: 2 as const,
  };
}

describe("SQLite pipeline run store", () => {
  it("invalidates Studio history even when post-commit compaction fails", async () => {
    const store = await openTempStore();
    await store.export(startedEvent("clear", 1));
    const state = new PipelineRunStudioEventState(store);
    expect((await state.workspace()).runs).toHaveLength(1);
    const original = DatabaseSync.prototype.exec;
    const injected = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql
    ) {
      if (sql.startsWith("VACUUM;")) throw new Error("compaction failed");
      return original.call(this, sql);
    });
    try {
      await expect(state.clear({ clear: () => store.clearHistory() })).resolves.toEqual({
        eventCount: 1,
        runCount: 1,
      });
      expect(await store.listEvents()).toEqual([]);
      expect((await state.workspace()).runs).toEqual([]);
    } finally {
      injected.mockRestore();
      await store.close();
    }
  });

  it("preserves history and its Studio projection when deletion cannot commit", async () => {
    const store = await openTempStore();
    await store.export(startedEvent("clear", 1));
    const state = new PipelineRunStudioEventState(store);
    expect((await state.workspace()).runs).toHaveLength(1);
    const original = DatabaseSync.prototype.exec;
    const injected = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql
    ) {
      if (sql.includes("DELETE FROM pipeline_run_events"))
        return original.call(this, sql.replace("COMMIT;", "SELECT missing_clear_table;"));
      return original.call(this, sql);
    });
    try {
      await expect(state.clear({ clear: () => store.clearHistory() })).rejects.toThrow(
        "missing_clear_table"
      );
      expect(await store.listEvents()).toHaveLength(1);
      expect((await state.workspace()).runs).toHaveLength(1);
    } finally {
      injected.mockRestore();
      await store.close();
    }
  });
  it("preserves iteration relations and projected history after closing and reopening", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-iteration-store-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    const { step } = createSteps<{ count: number }>();
    const work = step("work", { run: (_inputs, context) => context.options.count + 1 });
    const child = definePipeline({ id: "child", steps: [work], finalize: work });
    const repeat = createSteps().iteratePipeline("repeat", {
      pipeline: child,
      maxIterations: 2,
      initialState: () => 0,
      mapOptions: (count) => ({ count }),
      transition: (result) =>
        result === 2 ? { kind: "finish", result } : { kind: "next", state: result },
    });
    const parent = definePipeline({ id: "parent", steps: [repeat], finalize: repeat });
    const captured: StoredPipelineEvent[] = [];
    const runtime = createPipelineTestRuntime();
    try {
      expect(
        await parent.runOrThrow(
          {},
          {},
          {
            ...runtime.context,
            tracing: {
              exporter: {
                export: async (event) => {
                  captured.push({ ...event, id: captured.length + 1 });
                  await store.export(event);
                },
              },
            },
          }
        )
      ).toBe(2);
    } finally {
      await store.close();
    }
    expect(runtime.logs.filter((entry) => entry.level === "warn")).toEqual([]);
    const reopened = await openSqlitePipelineRunStore(filename, { readOnly: true });
    try {
      const persisted = await reopened.listEvents();
      const children = persisted.filter(
        (event) => event.name === "pipeline.started" && event.pipelineId === "child"
      );
      expect(children.map((event) => event.iteration?.index)).toEqual([1, 2]);
      expect(persisted).toEqual(captured);
      expect(projectPipelineRunStore(persisted, 0)).toEqual(projectPipelineRunStore(captured, 0));
    } finally {
      await reopened.close();
    }
  });

  it("persists ordered events and rejects mutation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const store = await openSqlitePipelineRunStore(filename);

    await store.export({
      correlationId: "job-1",
      name: "pipeline.started",
      payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
      pipelineId: "import",
      runId: "run-1",
      timestampMs: 10,
      version: 2,
    });
    await store.export({
      attemptId: "attempt-1",
      name: "pipeline.log",
      payload: { level: "warn", message: "slow source" },
      pipelineId: "import",
      runId: "run-1",
      stepId: "load",
      timestampMs: 11,
      version: 2,
    });

    expect(await store.listEvents({ runId: "run-1" })).toEqual([
      expect.objectContaining({ correlationId: "job-1", id: 1, name: "pipeline.started" }),
      expect.objectContaining({
        attemptId: "attempt-1",
        id: 2,
        payload: { level: "warn", message: "slow source" },
      }),
    ]);
    await store.close();

    const database = new DatabaseSync(filename);
    expect(() => database.exec("UPDATE pipeline_run_events SET pipeline_id = 'changed'")).toThrow(
      "pipeline_run_events is append-only"
    );
    expect(() => database.exec("DELETE FROM pipeline_run_events")).toThrow(
      "pipeline_run_events is append-only"
    );
    database.close();

    const reopened = await openSqlitePipelineRunStore(filename);
    expect(await reopened.listEvents()).toHaveLength(2);
    await reopened.close();
  });

  it.each([true, false])(
    "reads schema version 3 without writing and appends after an explicit upgrade (initialize=%s)",
    async (initialize) => {
      const directory = await mkdtemp(path.join(tmpdir(), "tubeless-legacy-iteration-store-"));
      directories.push(directory);
      const filename = path.join(directory, "runs.sqlite");
      const original = await openSqlitePipelineRunStore(filename);
      const legacy = startedEvent("run-1", 10);
      await original.export(legacy);
      await original.close();
      const database = new DatabaseSync(filename);
      // Recreate the previous table layout while retaining its events, indexes and triggers.
      database.exec(
        "ALTER TABLE pipeline_run_events DROP COLUMN iteration_json; PRAGMA user_version = 3;"
      );
      database.close();
      const before = await readFile(filename);
      const reader = await openSqlitePipelineRunStore(filename, { readOnly: true });
      try {
        expect(await reader.listEvents()).toEqual([{ ...legacy, id: 1 }]);
        expect(() => reader.export(legacy)).toThrow("read-only");
      } finally {
        await reader.close();
      }
      expect(await readFile(filename)).toEqual(before);

      const iteration = { runId: "run-1", stepId: "repeat", attemptId: "repeat-attempt", index: 1 };
      const child = {
        ...startedEvent("child-run", 11, "child"),
        parentRunId: "run-1",
        iteration,
        version: 3 as const,
      };
      await expect(openSqlitePipelineRunStore(filename, { initialize })).rejects.toThrow(
        "tubeless upgrade --yes"
      );
      expect(await readFile(filename)).toEqual(before);

      await upgradeSqlitePipelineRunStore(filename);
      const writer = await openSqlitePipelineRunStore(filename, { initialize });
      try {
        await writer.export(child);
      } finally {
        await writer.close();
      }
      const reopened = await openSqlitePipelineRunStore(filename, { readOnly: true });
      try {
        expect(await reopened.listEvents()).toEqual([
          { ...legacy, id: 1 },
          { ...child, id: 2 },
        ]);
      } finally {
        await reopened.close();
      }
      const migrated = new DatabaseSync(filename);
      try {
        expect(migrated.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 4 });
        expect(() =>
          migrated.exec("UPDATE pipeline_run_events SET pipeline_id = 'changed'")
        ).toThrow("append-only");
      } finally {
        migrated.close();
      }
    }
  );

  it("refuses to stamp a store when the schema version has no migration", () => {
    expect(() => assertRunStoreMigrationConfigured(5, 4)).toThrow(
      "Add a pipeline run store migration for schema version 5 before opening the store."
    );
    expect(() => assertRunStoreMigrationConfigured(4, 4)).not.toThrow();
  });

  it.each([1, 2, 5])("refuses unsupported store schema version %i", async (storeVersion) => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-version-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const database = new DatabaseSync(filename);
    database.exec(`PRAGMA user_version = ${storeVersion}`);
    database.close();

    await expect(openSqlitePipelineRunStore(filename)).rejects.toThrow(
      `Unsupported pipeline run store schema version ${storeVersion}`
    );
  });

  it("refuses a current store whose version stamp does not match its columns", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-mismatched-version-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    await store.export(startedEvent("run-1", 10));
    await store.close();
    const stamped = new DatabaseSync(filename);
    stamped.exec("PRAGMA user_version = 1");
    stamped.close();

    await expect(openSqlitePipelineRunStore(filename)).rejects.toThrow(
      "Unsupported pipeline run store schema version 1"
    );
    const unchanged = new DatabaseSync(filename);
    try {
      expect(unchanged.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 1 });
      expect(unchanged.prepare("SELECT payload_json FROM pipeline_run_events").get()).toMatchObject(
        {
          payload_json: expect.any(String),
        }
      );
    } finally {
      unchanged.close();
    }
  });

  it("reads schema version 1 without writing and upgrades a writable open", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-v1-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const database = new DatabaseSync(filename);
    database.exec(LEGACY_ATTRIBUTE_STORE_SQL);
    database.exec("PRAGMA user_version = 1");
    insertLegacy(database, {
      attributes: {
        dry_run: false,
        plan_ok: true,
        step_count: 1,
        target_ids: '["sync-schema"]',
      },
      id: 40,
      name: "pipeline.started",
    });
    insertLegacy(database, {
      attemptId: "attempt-1",
      attributes: { status: "failed" },
      durationMs: 4,
      error: {
        cause: { message: "bad xml", name: "Error" },
        code: "PIPES_STEP_FAILED",
        kind: "step",
        message: "Invalid ThML XML",
        phase: "execution",
      },
      id: 41,
      name: "step.failed",
      stepId: "inspect-source",
    });
    database.close();
    const before = await readFile(filename);

    const reader = await openSqlitePipelineRunStore(filename, { readOnly: true });
    let legacyEvents: readonly StoredPipelineEvent[];
    try {
      legacyEvents = await reader.listEvents();
      expect(() => reader.export(startedEvent("run-2", 11))).toThrow("read-only");
    } finally {
      await reader.close();
    }
    expect(await readFile(filename)).toEqual(before);
    expect(legacyEvents).toEqual([
      {
        id: 40,
        name: "pipeline.started",
        payload: { dryRun: false, planOk: true, stepCount: 1, targetIds: ["sync-schema"] },
        pipelineId: "import",
        runId: "run-1",
        timestampMs: 10,
        version: 2,
      },
      expect.objectContaining({
        error: expect.objectContaining({ code: "TUBELESS_STEP_FAILED" }),
        id: 41,
        name: "step.failed",
        payload: { status: "failed" },
        stepId: "inspect-source",
      }),
    ]);

    await expect(openSqlitePipelineRunStore(filename)).rejects.toThrow("tubeless upgrade --yes");
    expect(await readFile(filename)).toEqual(before);

    await upgradeSqlitePipelineRunStore(filename);
    const writer = await openSqlitePipelineRunStore(filename);
    try {
      expect(await writer.listEvents()).toEqual(legacyEvents);
      expect(projectPipelineRunStore([...legacyEvents], 0).runs).toHaveLength(1);
      await writer.export(startedEvent("run-2", 12));
      expect((await writer.listEvents()).map((event) => event.id)).toEqual([40, 41, 42]);
    } finally {
      await writer.close();
    }
    const migrated = new DatabaseSync(filename);
    try {
      expect(migrated.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 4 });
      expect(
        migrated
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'pipeline_run_events_%' ORDER BY name"
          )
          .all()
      ).toEqual([
        { name: "pipeline_run_events_parent_run_id_idx" },
        { name: "pipeline_run_events_pipeline_id_idx" },
        { name: "pipeline_run_events_run_id_idx" },
        { name: "pipeline_run_events_timestamp_idx" },
      ]);
      expect(() => migrated.exec("DELETE FROM pipeline_run_events")).toThrow("append-only");
    } finally {
      migrated.close();
    }
  });

  it("upgrades a schema version 2 store that already has correlation ids", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-v2-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const database = new DatabaseSync(filename);
    database.exec(LEGACY_ATTRIBUTE_STORE_SQL);
    database.exec("ALTER TABLE pipeline_run_events ADD COLUMN correlation_id TEXT");
    database.exec("PRAGMA user_version = 2");
    insertLegacy(database, {
      attributes: { dryRun: true, planOk: true, stepCount: 0, targetIds: [] },
      correlationId: "job-1",
      id: 1,
      name: "pipeline.started",
      version: 2,
    });
    database.close();

    await upgradeSqlitePipelineRunStore(filename);
    const store = await openSqlitePipelineRunStore(filename, { initialize: false });
    try {
      expect(await store.listEvents()).toEqual([
        expect.objectContaining({ correlationId: "job-1", id: 1, version: 2 }),
      ]);
    } finally {
      await store.close();
    }
  });

  it("keeps a saved id counter that is ahead of the copied rows", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-sequence-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const database = new DatabaseSync(filename);
    database.exec(LEGACY_ATTRIBUTE_STORE_SQL);
    database.exec("PRAGMA user_version = 1");
    insertLegacy(database, {
      attributes: { dry_run: false, plan_ok: true, step_count: 0, target_ids: "[]" },
      id: 7,
      name: "pipeline.started",
    });
    database.exec("UPDATE sqlite_sequence SET seq = 80 WHERE name = 'pipeline_run_events'");
    expect(
      database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'pipeline_run_events'").get()
    ).toMatchObject({ seq: 80 });
    database.close();

    await upgradeSqlitePipelineRunStore(filename);
    const store = await openSqlitePipelineRunStore(filename, { initialize: false });
    try {
      await store.export(startedEvent("run-2", 12));
      expect((await store.listEvents()).map((event) => event.id)).toEqual([7, 81]);
    } finally {
      await store.close();
    }
  });

  it("does not move the id counter backwards when it is behind the copied rows", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-sequence-behind-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const database = new DatabaseSync(filename);
    database.exec(LEGACY_ATTRIBUTE_STORE_SQL);
    database.exec("PRAGMA user_version = 1");
    insertLegacy(database, {
      attributes: { dry_run: false, plan_ok: true, step_count: 0, target_ids: "[]" },
      id: 7,
      name: "pipeline.started",
    });
    database.exec("UPDATE sqlite_sequence SET seq = 3 WHERE name = 'pipeline_run_events'");
    database.close();

    await upgradeSqlitePipelineRunStore(filename);
    const store = await openSqlitePipelineRunStore(filename, { initialize: false });
    try {
      await store.export(startedEvent("run-2", 12));
      expect((await store.listEvents()).map((event) => event.id)).toEqual([7, 8]);
    } finally {
      await store.close();
    }
  });

  it("keeps the id counter of a cleared older store", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-cleared-sequence-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const database = new DatabaseSync(filename);
    database.exec(LEGACY_ATTRIBUTE_STORE_SQL);
    database.exec("PRAGMA user_version = 1");
    database.exec("INSERT INTO sqlite_sequence(name, seq) VALUES ('pipeline_run_events', 80)");
    database.close();

    await upgradeSqlitePipelineRunStore(filename);
    const store = await openSqlitePipelineRunStore(filename, { initialize: false });
    try {
      await store.export(startedEvent("run-2", 12));
      expect((await store.listEvents()).map((event) => event.id)).toEqual([81]);
    } finally {
      await store.close();
    }
  });

  it("rolls back an attribute upgrade without changing the stored schema", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-v1-rollback-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const database = new DatabaseSync(filename);
    database.exec(LEGACY_ATTRIBUTE_STORE_SQL);
    database.exec("PRAGMA user_version = 1");
    insertLegacy(database, {
      attributes: { dry_run: false, plan_ok: true, step_count: 0, target_ids: "[]" },
      id: 1,
      name: "pipeline.started",
    });
    insertLegacy(database, {
      attributes: { status: "running" },
      id: 2,
      name: "pipeline.completed",
    });
    database.close();

    await expect(upgradeSqlitePipelineRunStore(filename)).rejects.toThrow(
      "Cannot upgrade pipeline run event 2 (pipeline.completed)"
    );
    const unchanged = new DatabaseSync(filename);
    try {
      expect(unchanged.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 1 });
      expect(
        unchanged.prepare("SELECT attributes_json FROM pipeline_run_events WHERE id = 1").get()
      ).toBeTruthy();
      expect(() => unchanged.exec("DELETE FROM pipeline_run_events")).toThrow("append-only");
      expect(
        unchanged
          .prepare("SELECT name FROM sqlite_master WHERE name = 'pipeline_run_events_next'")
          .get()
      ).toBeUndefined();
    } finally {
      unchanged.close();
    }
  });

  it("clears all history while preserving append-only protection", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-clear-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    await store.export({
      name: "pipeline.started",
      payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
      pipelineId: "import",
      runId: "run-1",
      timestampMs: 10,
      version: 2,
    });

    await store.clearHistory();
    expect(await store.listEvents()).toEqual([]);
    await store.export({
      name: "pipeline.started",
      payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
      pipelineId: "import",
      runId: "run-2",
      timestampMs: 20,
      version: 2,
    });
    expect(await store.listEvents()).toEqual([expect.objectContaining({ id: 2, runId: "run-2" })]);
    await store.close();

    const database = new DatabaseSync(filename);
    expect(() => database.exec("DELETE FROM pipeline_run_events")).toThrow(
      "pipeline_run_events is append-only"
    );
    database.close();
  });

  it("treats afterId as an exclusive ascending cursor", async () => {
    const store = await openTempStore();
    await store.export(startedEvent("run-1", 10));
    await store.export(startedEvent("run-1", 11));
    await store.export(startedEvent("run-1", 12));

    const [first, second, third] = await store.listEvents();
    expect(await store.listEvents({ afterId: first!.id })).toEqual([
      expect.objectContaining({ id: second!.id, timestampMs: 11 }),
      expect.objectContaining({ id: third!.id, timestampMs: 12 }),
    ]);
    await store.close();
  });

  it("clamps listEvents limit to a non-empty page", async () => {
    const store = await openTempStore();
    for (let timestampMs = 10; timestampMs <= 14; timestampMs += 1) {
      await store.export(startedEvent("run-1", timestampMs));
    }

    expect(await store.listEvents({ limit: 2 })).toEqual([
      expect.objectContaining({ id: 1, timestampMs: 10 }),
      expect.objectContaining({ id: 2, timestampMs: 11 }),
    ]);
    expect(await store.listEvents({ limit: 0 })).toEqual([
      expect.objectContaining({ id: 1, timestampMs: 10 }),
    ]);
    expect(await store.listEvents({ limit: 999_999 })).toHaveLength(5);
    await store.close();
  });

  it("composes runId and pipelineId filters with afterId", async () => {
    const store = await openTempStore();
    await store.export(startedEvent("run-1", 10, "import"));
    await store.export(startedEvent("run-2", 11, "publish"));
    await store.export(startedEvent("run-1", 12, "import"));
    await store.export(startedEvent("run-2", 13, "publish"));

    const [first] = await store.listEvents({ runId: "run-1" });
    expect(await store.listEvents({ afterId: first!.id, runId: "run-1" })).toEqual([
      expect.objectContaining({ id: 3, runId: "run-1", pipelineId: "import" }),
    ]);
    expect(await store.listEvents({ afterId: first!.id, pipelineId: "import" })).toEqual([
      expect.objectContaining({ id: 3, pipelineId: "import", runId: "run-1" }),
    ]);
    await store.close();
  });

  it("returns every stored row when the default limit is used", async () => {
    const store = await openTempStore();
    await store.export(startedEvent("run-1", 10));
    await store.export(startedEvent("run-1", 11));
    await store.export(startedEvent("run-1", 12));

    expect(await store.listEvents()).toHaveLength(3);
    await store.close();
  });

  it("keeps the first inserted row when paging after id 0", async () => {
    const store = await openTempStore();
    await store.export(startedEvent("run-1", 10));
    await store.export(startedEvent("run-1", 11));

    const events = await store.listEvents();
    expect(events[0]?.id).toBe(1);
    expect(await store.listEvents({ afterId: 0 })).toEqual(events);
    await store.close();
  });

  it("can reopen an existing store without initializing it", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    await store.export(startedEvent("run-1", 10));
    await store.close();

    const reopened = await openSqlitePipelineRunStore(filename, { initialize: false });
    expect(await reopened.listEvents()).toHaveLength(1);
    await reopened.close();
  });

  it("reads an initialized store from a read-only file and directory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    await store.export(startedEvent("run-1", 10));
    await store.close();
    await chmod(filename, 0o444);
    await chmod(directory, 0o555);
    try {
      const reopened = await openSqlitePipelineRunStore(filename, {
        initialize: false,
        readOnly: true,
      });
      expect(await reopened.listEvents()).toHaveLength(1);
      await reopened.close();
    } finally {
      await chmod(directory, 0o755);
      await chmod(filename, 0o644);
    }
  });

  it("does not create a shared-memory sidecar during a read-only open of a WAL snapshot", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    await store.export(startedEvent("run-1", 10));
    await store.close();
    await unlink(`${filename}-shm`).catch(() => {});
    const reopened = await openSqlitePipelineRunStore(filename, {
      initialize: false,
      readOnly: true,
    });
    expect(await reopened.listEvents()).toHaveLength(1);
    await reopened.close();
    await expect(stat(`${filename}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not create a shared-memory sidecar when a WAL snapshot is opened through a symlink", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const alias = path.join(directory, "alias", "store.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    await store.export(startedEvent("run-1", 10));
    await store.close();
    await mkdir(path.dirname(alias));
    await symlink(filename, alias);
    await unlink(`${filename}-shm`).catch(() => {});
    const reopened = await openSqlitePipelineRunStore(alias, {
      initialize: false,
      readOnly: true,
    });
    expect(await reopened.listEvents()).toHaveLength(1);
    await reopened.close();
    await expect(stat(`${filename}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(`${alias}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not mutate an existing shared-memory sidecar during a read-only open", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    await store.export(startedEvent("run-1", 10));
    await store.close();
    const marker = Buffer.alloc(32_768, 0x5a);
    await writeFile(`${filename}-shm`, marker);
    const reopened = await openSqlitePipelineRunStore(filename, {
      initialize: false,
      readOnly: true,
    });
    expect(await reopened.listEvents()).toHaveLength(1);
    await reopened.close();
    expect(await readFile(`${filename}-shm`)).toEqual(marker);
  });

  it("refuses a read-only open when a WAL sidecar still has pending bytes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    await store.export(startedEvent("run-1", 10));
    await store.close();
    const shmBefore = await readFile(`${filename}-shm`).catch(() => undefined);
    await writeFile(`${filename}-wal`, "not a checkpointed wal");
    const walBefore = await readFile(`${filename}-wal`);
    await expect(
      openSqlitePipelineRunStore(filename, { initialize: false, readOnly: true })
    ).rejects.toThrow(/write-ahead|journal|sidecar/i);
    expect(await readFile(`${filename}-wal`)).toEqual(walBefore);
    if (shmBefore === undefined) {
      await expect(stat(`${filename}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(await readFile(`${filename}-shm`)).toEqual(shmBefore);
    }
  });

  it("refuses a read-only open when a stale alias WAL sits beside a newer target WAL", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const alias = path.join(directory, "alias", "store.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    await store.export(startedEvent("run-1", 10));
    await store.close();
    await mkdir(path.dirname(alias));
    await symlink(filename, alias);
    await writeFile(`${alias}-wal`, "");
    await writeFile(`${filename}-wal`, "not a checkpointed wal");
    await expect(
      openSqlitePipelineRunStore(alias, { initialize: false, readOnly: true })
    ).rejects.toThrow(/write-ahead|journal|sidecar/i);
  });

  it("refuses a read-only open of a hard-linked store while a writer holds a WAL", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const alias = path.join(directory, "alias", "store.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    await store.export(startedEvent("run-1", 10));
    await store.close();
    await mkdir(path.dirname(alias));
    await link(filename, alias);
    expect((await stat(filename)).nlink).toBe(2);
    const writer = await openSqlitePipelineRunStore(filename, { initialize: false });
    await writer.export(startedEvent("run-2", 20));
    try {
      await expect(
        openSqlitePipelineRunStore(alias, { initialize: false, readOnly: true })
      ).rejects.toThrow(/hard link|write-ahead|journal|sidecar/i);
    } finally {
      await writer.close();
    }
  });

  it("refuses a read-only open when the store file has multiple hard links", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const alias = path.join(directory, "alias", "store.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    await store.export(startedEvent("run-1", 10));
    await store.close();
    await mkdir(path.dirname(alias));
    await link(filename, alias);
    expect((await stat(filename)).nlink).toBe(2);
    await expect(
      openSqlitePipelineRunStore(alias, { initialize: false, readOnly: true })
    ).rejects.toThrow(/hard link/i);
    await expect(
      openSqlitePipelineRunStore(filename, { initialize: false, readOnly: true })
    ).rejects.toThrow(/hard link/i);
  });

  it("refuses a read-only open when a WAL sidecar beside the realpath has pending bytes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const alias = path.join(directory, "alias", "store.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    await store.export(startedEvent("run-1", 10));
    await store.close();
    await mkdir(path.dirname(alias));
    await symlink(filename, alias);
    const shmBefore = await readFile(`${filename}-shm`).catch(() => undefined);
    await writeFile(`${filename}-wal`, "not a checkpointed wal");
    await expect(
      openSqlitePipelineRunStore(alias, { initialize: false, readOnly: true })
    ).rejects.toThrow(/write-ahead|journal|sidecar/i);
    if (shmBefore === undefined) {
      await expect(stat(`${filename}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(await readFile(`${filename}-shm`)).toEqual(shmBefore);
    }
    await expect(stat(`${alias}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("surfaces the first codec failure from flush and close", async () => {
    const store = await openTempStore();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => {
      void store.export({
        name: "step.attempted",
        payload: {
          attempt: 1,
          // SAFETY: malformed runtime input proves the SQLite adapter invokes
          // the same codec as the NDJSON reader.
          attributes: cycle as import("../tracing/tracing-contracts.js").PipelineTraceAttributes,
        },
        pipelineId: "import",
        runId: "run-1",
        stepId: "load",
        timestampMs: 10,
        version: 2,
      });
    }).toThrow(/attribute.*values/i);
    expect(() => store.flush!()).toThrow(/attribute.*values/i);
    expect(() => store.close()).toThrow(/attribute.*values/i);
  });

  it("does not treat a dangling WAL sidecar symlink as absent", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    await store.export(startedEvent("run-1", 10));
    await store.close();
    await unlink(`${filename}-wal`).catch(() => {});
    await unlink(`${filename}-shm`).catch(() => {});
    const missingWal = path.join(directory, "missing-wal");
    await symlink(missingWal, `${filename}-wal`);
    expect((await lstat(`${filename}-wal`)).isSymbolicLink()).toBe(true);
    await expect(stat(`${filename}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      openSqlitePipelineRunStore(filename, { initialize: false, readOnly: true })
    ).rejects.toThrow(/write-ahead|journal|sidecar/i);
    await expect(stat(`${filename}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a read-only open when a dangling WAL sidecar sits on a read-only volume", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    await store.export(startedEvent("run-1", 10));
    await store.close();
    await unlink(`${filename}-wal`).catch(() => {});
    const missingWal = path.join(directory, "missing-wal");
    await symlink(missingWal, `${filename}-wal`);
    expect((await lstat(`${filename}-wal`)).isSymbolicLink()).toBe(true);
    await expect(stat(`${filename}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
    await chmod(filename, 0o444);
    await chmod(directory, 0o555);
    try {
      await expect(
        openSqlitePipelineRunStore(filename, { initialize: false, readOnly: true })
      ).rejects.toThrow(/write-ahead|journal|sidecar/i);
    } finally {
      await chmod(directory, 0o755);
      await chmod(filename, 0o644);
    }
  });

  it("refuses a read-only open when a rollback journal still has pending bytes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    await store.export(startedEvent("run-1", 10));
    await store.close();
    await writeFile(`${filename}-journal`, "not a recovered journal");
    const journalBefore = await readFile(`${filename}-journal`);
    await expect(
      openSqlitePipelineRunStore(filename, { initialize: false, readOnly: true })
    ).rejects.toThrow(/write-ahead|journal|sidecar/i);
    expect(await readFile(`${filename}-journal`)).toEqual(journalBefore);
  });

  it("rejects a missing path when initialize is false without creating it", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const nested = path.join(directory, "missing", "runs.sqlite");
    const sibling = path.join(directory, "runs.sqlite");
    await expect(openSqlitePipelineRunStore(nested, { initialize: false })).rejects.toThrow(
      "is not a pipeline run store"
    );
    await expect(openSqlitePipelineRunStore(sibling, { initialize: false })).rejects.toThrow(
      "is not a pipeline run store"
    );
    await expect(stat(nested)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.dirname(nested))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(sibling)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an uninitialized file when initialize is false", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "empty.sqlite");
    const database = new DatabaseSync(filename);
    database.close();
    await expect(openSqlitePipelineRunStore(filename, { initialize: false })).rejects.toThrow(
      "is not a pipeline run store"
    );
  });

  it("refuses listEvents when a writer starts after the immutable open", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    await store.export(startedEvent("run-1", 10));
    await store.close();

    const reader = await openSqlitePipelineRunStore(filename, {
      initialize: false,
      readOnly: true,
    });
    expect(await reader.listEvents()).toEqual([expect.objectContaining({ runId: "run-1" })]);
    const writer = await openSqlitePipelineRunStore(filename, { initialize: false });
    try {
      await writer.export(startedEvent("run-2", 20));
      expect(await reader.listEvents()).toEqual([expect.objectContaining({ runId: "run-1" })]);
      writer.flush!();
      await expect(reader.listEvents()).rejects.toThrow(/write-ahead|journal|sidecar/i);
    } finally {
      await writer.close();
      await reader.close();
    }
  });

  it("returns every exported event from listEvents without an explicit flush", async () => {
    const store = await openTempStore();
    for (let timestampMs = 10; timestampMs < 110; timestampMs += 1) {
      await store.export(startedEvent("run-1", timestampMs));
    }
    expect(await store.listEvents()).toHaveLength(100);
    await store.close();
  });

  it("makes flush durable to a later read-only reopen", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    await store.export(startedEvent("run-1", 10));
    await store.export(startedEvent("run-1", 11));
    await store.export(startedEvent("run-1", 12));
    store.flush!();
    const peek = new DatabaseSync(filename);
    expect(
      (
        peek.prepare("SELECT COUNT(*) AS n FROM pipeline_run_events").all() as {
          n: number | bigint;
        }[]
      )[0]?.n
    ).toEqual(3);
    peek.close();
    await store.close();
    const reader = await openSqlitePipelineRunStore(filename, {
      initialize: false,
      readOnly: true,
    });
    expect(await reader.listEvents()).toEqual([
      expect.objectContaining({ runId: "run-1", timestampMs: 10 }),
      expect.objectContaining({ runId: "run-1", timestampMs: 11 }),
      expect.objectContaining({ runId: "run-1", timestampMs: 12 }),
    ]);
    await reader.close();
  });

  it("keeps the first mid-batch drain failure sticky on export and flush", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    await store.export(startedEvent("run-1", 10));
    await store.export(startedEvent("run-1", 11));
    const injector = new DatabaseSync(filename);
    injector.exec(`
      CREATE TRIGGER fail_insert BEFORE INSERT ON pipeline_run_events
      BEGIN
        SELECT RAISE(ABORT, 'injected insert failure');
      END;
    `);
    injector.close();
    expect(() => store.flush!()).toThrow(/injected insert failure/);
    expect(() => store.export(startedEvent("run-1", 12))).toThrow(/injected insert failure/);
    expect(() => store.flush!()).toThrow(/injected insert failure/);
    expect(() => store.close()).toThrow(/injected insert failure/);
  });

  it("surfaces a begin failure from close when another connection holds the lock", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    await store.export(startedEvent("run-1", 10));
    const locker = new DatabaseSync(filename);
    locker.exec("BEGIN EXCLUSIVE");
    try {
      expect(() => store.close()).toThrow(/busy|locked|database is locked/i);
    } finally {
      locker.exec("ROLLBACK");
      locker.close();
    }
  });

  it("persists unflushed exports when close drains the buffer", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    await store.export(startedEvent("run-1", 10));
    await store.export(startedEvent("run-1", 11));
    await store.close();
    const reopened = await openSqlitePipelineRunStore(filename, { initialize: false });
    expect(await reopened.listEvents()).toEqual([
      expect.objectContaining({ runId: "run-1", timestampMs: 10 }),
      expect.objectContaining({ runId: "run-1", timestampMs: 11 }),
    ]);
    await reopened.close();
  });

  it("does not create a missing file when Node opens an existing-only URI", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const missing = path.join(directory, "missing.sqlite");
    expect(() => new DatabaseSync(`${pathToFileURL(missing).href}?mode=rw`)).toThrow(
      /unable to open/i
    );
    await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
