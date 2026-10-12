import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  RUN_EVENT_DROP_TRIGGER_STATEMENTS,
  RUN_EVENT_INSERT_SQL,
  RUN_EVENT_STORE_VERSION,
  RUN_EVENT_TABLE_STATEMENTS,
  RUN_EVENT_TRIGGER_STATEMENTS,
  runEventListQuery,
  runEventRow,
  sqlScript,
  storedRunEvent,
  type RunEventRecord,
  type RunEventRow,
} from "./run-store-sql.js";
import type { PipelineRunEventQuery, PipelineRunEventStore } from "./run-store.js";

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): void;
}

interface SqliteDatabase {
  close(): void;
  exec(sql: string): void;
  prepare?(sql: string): SqliteStatement;
  query?(sql: string): SqliteStatement;
}

interface SqliteOpenOptions {
  create?: boolean;
  readOnly?: boolean;
  readonly?: boolean;
  readwrite?: boolean;
}

interface SqliteModule {
  Database?: new (filename: string, options?: SqliteOpenOptions) => SqliteDatabase;
  DatabaseSync?: new (filename: string, options?: SqliteOpenOptions) => SqliteDatabase;
}

/** Larger batches mean fewer commits but more tail loss on crash. */
const EXPORT_BATCH_SIZE = 64;

const RUN_EVENT_STORE_SCHEMA = `PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
${sqlScript(RUN_EVENT_TABLE_STATEMENTS)}
${sqlScript(RUN_EVENT_TRIGGER_STATEMENTS)}`;

/** SQLite event store plus the explicit all-history maintenance operation. */
export interface SqlitePipelineRunStore extends PipelineRunEventStore {
  /** Delete every recorded event and compact the database; individual mutation stays forbidden. */
  clearHistory(): void | Promise<void>;
}

function statement(database: SqliteDatabase, sql: string): SqliteStatement {
  const prepared = database.query?.(sql) ?? database.prepare?.(sql);
  if (!prepared) throw new Error("The current SQLite runtime does not support prepared queries.");
  return prepared;
}

function readStoreVersion(database: SqliteDatabase): number {
  // SAFETY: `PRAGMA user_version` always returns a single row with a
  // `user_version` column, so the first result row matches this shape.
  const versionRow = statement(database, "PRAGMA user_version").all()[0] as
    | { user_version?: number | bigint }
    | undefined;
  return Number(versionRow?.user_version ?? 0);
}

async function loadSqliteModule(): Promise<SqliteModule> {
  const specifier = "Bun" in globalThis ? "bun:sqlite" : "node:sqlite";
  // SAFETY: The dynamic import resolves to the built-in sqlite module whose
  // runtime shape is the `SqliteModule` interface we depend on.
  return (await import(specifier)) as SqliteModule;
}

async function openDatabase(
  filename: string,
  options: { create?: boolean; readOnly?: boolean } = {}
): Promise<SqliteDatabase> {
  const module = await loadSqliteModule();
  const Database = module.Database ?? module.DatabaseSync;
  if (!Database) throw new Error("No synchronous SQLite database implementation is available.");
  const bunSqlite = "Bun" in globalThis;
  const create = options.create !== false;
  const readOnly = options.readOnly === true;
  if (readOnly) {
    await sqliteAssertImmutableInspect(filename);
    const database = openReadableDatabase(
      Database,
      `${pathToFileURL(filename).href}?mode=ro&immutable=1`
    );
    try {
      await sqliteAssertImmutableInspect(filename);
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }
  if (!create) {
    if (bunSqlite) {
      return openReadableDatabase(Database, filename, { create: false, readwrite: true });
    }
    // Node's DatabaseSync ignores `{ create: false }` and creates an empty
    // file. `mode=rw` fails closed when the path is missing.
    return openReadableDatabase(Database, `${pathToFileURL(filename).href}?mode=rw`);
  }
  return new Database(filename);
}

function isMissingDirectoryEntry(error: NodeJS.ErrnoException): boolean {
  return error.code === "ENOENT";
}

async function sqliteSidecarExists(filename: string): Promise<boolean> {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    // SAFETY: Node fs rejects with ErrnoException. Only ENOENT is a missing
    // directory entry; EACCES/EPERM and other inspect failures stay present.
    if (isMissingDirectoryEntry(error as NodeJS.ErrnoException) === false) return true;
  }
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    // SAFETY: Same Node fs ErrnoException contract as the stat() branch.
    return isMissingDirectoryEntry(error as NodeJS.ErrnoException) === false;
  }
}

async function sqliteSidecarTargets(filename: string): Promise<readonly string[]> {
  const targets: string[] = [];
  try {
    targets.push(await realpath(filename));
  } catch {
    // Missing or unresolvable; still check the given name.
  }
  if (targets.includes(filename) === false) targets.push(filename);
  return targets;
}

async function sqliteDatabaseHasMultipleLinks(filename: string): Promise<boolean> {
  for (const target of await sqliteSidecarTargets(filename)) {
    try {
      if ((await stat(target)).nlink > 1) return true;
    } catch {
      return true;
    }
  }
  return false;
}

async function sqliteAssertImmutableInspect(filename: string): Promise<void> {
  const pending = await sqlitePendingTransactionalSidecar(filename);
  if (pending !== undefined) {
    throw new Error(
      `${filename} has a write-ahead log or rollback journal that a read-only open cannot apply without writing a sidecar.`
    );
  }
  if (await sqliteDatabaseHasMultipleLinks(filename)) {
    throw new Error(
      `${filename} has multiple hard links; a read-only open cannot locate a writer's write-ahead log beside another name.`
    );
  }
}

async function sqlitePendingTransactionalSidecar(filename: string): Promise<string | undefined> {
  for (const target of await sqliteSidecarTargets(filename)) {
    for (const suffix of ["-journal", "-wal"] as const) {
      const sidecar = `${target}${suffix}`;
      if ((await sqliteSidecarExists(sidecar)) === false) continue;
      try {
        if ((await stat(sidecar)).size > 0) return sidecar;
      } catch {
        return sidecar;
      }
    }
  }
  return undefined;
}

function openReadableDatabase(
  Database: new (filename: string, options?: SqliteOpenOptions) => SqliteDatabase,
  filename: string,
  options?: SqliteOpenOptions
): SqliteDatabase {
  const database = options === undefined ? new Database(filename) : new Database(filename, options);
  try {
    statement(database, "PRAGMA user_version").all();
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

/** Options for `openSqlitePipelineRunStore`. */
export interface OpenSqlitePipelineRunStoreOptions {
  /**
   * When `false`, reject a path that is not already a versioned run store
   * and do not create parent directories or a database file.
   * Defaults to `true` so `run --store` and `ui` can create the database.
   */
  readonly initialize?: boolean;
  /**
   * Open the file without creating it or writing WAL/sidecars.
   * A leftover empty `-wal` is ignored and the main file is opened
   * immutable. A non-empty `-wal` or `-journal`, a multiply linked
   * database file, or a WAL that appears during the open or a later
   * `listEvents` is refused so pending events are not dropped.
   * `history` uses this so a supplied finished artifact can be inspected
   * without rewriting `-shm`.
   */
  readonly readOnly?: boolean;
}

/**
 * Open the optional local SQLite trace store used by `tubeless run --store`,
 * `tubeless history`, and `tubeless ui`. The main executor never imports this
 * module. `export()` buffers up to 64 events and commits them in one
 * transaction, plus on `flush()`, same-instance `listEvents`/`clearHistory`,
 * and `close()`. Other connections cannot see the unflushed tail; a crash can
 * lose it. Finished `tubeless run --store` invocations flush at completion.
 */
export async function openSqlitePipelineRunStore(
  filename: string,
  options: OpenSqlitePipelineRunStoreOptions = {}
): Promise<SqlitePipelineRunStore> {
  const readOnly = options.readOnly === true;
  const initialize = options.initialize !== false && !readOnly;
  const resolvedFilename = filename === ":memory:" ? filename : path.resolve(filename);
  if (resolvedFilename !== ":memory:" && initialize) {
    await mkdir(path.dirname(resolvedFilename), { recursive: true });
  }
  if (resolvedFilename !== ":memory:" && !initialize) {
    try {
      await stat(resolvedFilename);
    } catch {
      throw new Error(`${resolvedFilename} is not a pipeline run store.`);
    }
  }
  const database = await openDatabase(resolvedFilename, { create: initialize, readOnly });
  try {
    const version = readStoreVersion(database);
    if (version !== 0 && version !== 3 && version !== RUN_EVENT_STORE_VERSION) {
      throw new Error(
        `Unsupported pipeline run store schema version ${version}; expected ${RUN_EVENT_STORE_VERSION}.`
      );
    }
    if (!initialize && version === 0) {
      throw new Error(`${resolvedFilename} is not a pipeline run store.`);
    }
    if (!readOnly && version === 3) {
      database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE pipeline_run_events ADD COLUMN iteration_json TEXT;
        PRAGMA user_version = ${RUN_EVENT_STORE_VERSION};
        COMMIT;
      `);
    }
    if (initialize) {
      database.exec(RUN_EVENT_STORE_SCHEMA);
      database.exec(`PRAGMA user_version = ${RUN_EVENT_STORE_VERSION}`);
    }
  } catch (error) {
    database.close();
    throw error;
  }
  const insert = readOnly ? undefined : statement(database, RUN_EVENT_INSERT_SQL);
  let closed = false;
  let exportError: Error | undefined;
  const pending: RunEventRow[] = [];

  function drain(): void {
    if (!insert || pending.length === 0) return;
    try {
      database.exec("BEGIN IMMEDIATE");
      for (const row of pending) insert.run(...row);
      database.exec("COMMIT");
      pending.length = 0;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {}
      exportError = error instanceof Error ? error : new Error(String(error));
      throw exportError;
    }
  }

  return {
    export(event) {
      if (closed) throw new Error("Cannot append to a closed pipeline run store.");
      if (!insert) throw new Error("Cannot append to a read-only pipeline run store.");
      if (exportError) throw exportError;
      try {
        pending.push(runEventRow(event));
        if (pending.length >= EXPORT_BATCH_SIZE) drain();
      } catch (error) {
        exportError = error instanceof Error ? error : new Error(String(error));
        throw exportError;
      }
    },
    flush() {
      if (exportError) throw exportError;
      drain();
    },
    async listEvents(query: PipelineRunEventQuery = {}) {
      if (closed) throw new Error("Cannot query a closed pipeline run store.");
      drain();
      if (readOnly && resolvedFilename !== ":memory:") {
        await sqliteAssertImmutableInspect(resolvedFilename);
      }
      const { sql, params } = runEventListQuery(query);
      // SAFETY: The SELECT * columns match the RunEventRecord interface exactly
      // (the table schema is owned by run-store-sql.ts), so each result row is one.
      const rows = statement(database, sql).all(...params) as RunEventRecord[];
      if (readOnly && resolvedFilename !== ":memory:") {
        await sqliteAssertImmutableInspect(resolvedFilename);
      }
      return rows.map(storedRunEvent);
    },
    clearHistory() {
      if (closed) throw new Error("Cannot clear a closed pipeline run store.");
      drain();
      try {
        database.exec(`BEGIN IMMEDIATE;
${sqlScript(RUN_EVENT_DROP_TRIGGER_STATEMENTS)}
DELETE FROM pipeline_run_events;
${sqlScript(RUN_EVENT_TRIGGER_STATEMENTS)}
COMMIT;`);
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {}
        throw error;
      }
      try {
        database.exec("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
      } catch {
        // Deletion has committed. Compaction is best effort and must not make
        // callers retain a projection of history that no longer exists.
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        if (!exportError) drain();
      } catch {
        // exportError is recorded by drain; close still releases the handle.
      }
      database.close();
      if (exportError) throw exportError;
    },
  };
}
