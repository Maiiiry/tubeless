import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqlitePipelineRunStore } from "../run-store/run-store-sqlite.js";
import { runWorkbenchCli } from "./workbench.js";
import { captureIo } from "./workbench.test-support.js";
import { TUBELESS_WORKBENCH_EXIT_CODE } from "./workbench-shared.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

function legacyStore(directory: string): string {
  const filename = path.join(directory, "runs.sqlite");
  const database = new DatabaseSync(filename);
  database.exec(`
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
    INSERT INTO pipeline_run_events (
      id, version, run_id, pipeline_id, event_name, timestamp_ms, attributes_json
    ) VALUES (
      4, 1, 'run-1', 'import', 'pipeline.started', 10,
      '{"dry_run":false,"plan_ok":true,"step_count":0,"target_ids":"[]"}'
    );
    PRAGMA user_version = 1;
  `);
  database.close();
  return filename;
}

describe("tubeless upgrade", () => {
  it("refuses to rewrite a store without --yes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-upgrade-confirm-"));
    directories.push(directory);
    const filename = legacyStore(directory);
    const io = captureIo(directory);

    expect(await runWorkbenchCli(["upgrade", "--store", filename], io)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.usage
    );
    expect(io.errors.join("")).toContain("cannot be undone");
    expect(io.errors.join("")).toContain("--yes");
    const database = new DatabaseSync(filename);
    try {
      expect(database.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 1 });
    } finally {
      database.close();
    }
  });

  it("upgrades an older store after --yes and leaves a current store unchanged", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-upgrade-yes-"));
    directories.push(directory);
    const filename = legacyStore(directory);
    const io = captureIo(directory);

    expect(await runWorkbenchCli(["upgrade", "--yes", "--store", filename], io)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(io.output.join("")).toContain("from schema version 1 to 4");
    const reader = await openSqlitePipelineRunStore(filename, { readOnly: true });
    try {
      expect(await reader.listEvents()).toEqual([
        expect.objectContaining({ id: 4, name: "pipeline.started", version: 2 }),
      ]);
    } finally {
      await reader.close();
    }

    const again = captureIo(directory);
    expect(await runWorkbenchCli(["upgrade", "--yes", "--store", filename], again)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(again.output.join("")).toContain("already schema version 4");
  });

  it("reports a missing store without rewriting anything", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-upgrade-missing-"));
    directories.push(directory);
    const io = captureIo(directory);

    expect(await runWorkbenchCli(["upgrade", "--yes", "--store", "missing.sqlite"], io)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.load
    );
    expect(io.errors.join("")).toContain("Run store not found");
  });
});
