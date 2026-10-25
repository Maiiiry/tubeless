import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readlink, realpath, stat, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { PipelineRunEventStore } from "../run-store/run-store.js";
import {
  composeTraceExporters,
  type PipelineTraceExporter,
  type PipelineTraceEvent,
} from "../tracing/tracing.js";
import { toExitCode } from "../cli/cli-exit.js";
import { executePipelineCommand } from "./workbench-command-execution.js";
import { resolveWorkbenchRegistration } from "./workbench-project-loader.js";
import {
  errorMessage,
  manageWorkbenchSignal,
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeCliChunk,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";
import {
  parseSubcommandArgs,
  REGISTRATION_OPTIONS,
  RUN_HISTORY_OPTIONS,
  runWorkbenchSubcommand,
} from "./workbench-subcommand.js";

const RUN_USAGE = `Usage: tubeless run [options] <pipeline-id-or-file> [-- <command-args...>]

Execute a project pipeline or a directly exported pipeline or command using its validated CLI contract.

Options:
  -e, --export <name>   Select a pipeline or command export when the file has more than one
  -p, --project <path>  Resolve a pipeline or command id from this project file
      --store <path>    Append run events to a local SQLite database
      --trace <path>    Write NDJSON traces to a file, or - for stdout
                        (command output then goes to stderr)
  -h, --help            Show this workbench help

Pass application flags after --. For command help, use: tubeless run <file> -- --help
Schema-backed pipelines infer arguments; use definePipelineCommand for custom inputs.
`;

function parseRunArgs(argv: readonly string[]) {
  const separatorIndex = argv.indexOf("--");
  const workbenchArgs = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
  const commandArgs = separatorIndex === -1 ? [] : argv.slice(separatorIndex + 1);
  return {
    ...parseSubcommandArgs(workbenchArgs, { ...REGISTRATION_OPTIONS, ...RUN_HISTORY_OPTIONS }),
    commandArgs,
  };
}

export async function runCommand(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      usage: RUN_USAGE,
      parse: parseRunArgs,
      positionalCountError: { count: 1, message: "Pass exactly one pipeline ID or file." },
      run: executeRun,
    },
    argv,
    io
  );
}

async function executeRun(
  parsed: ReturnType<typeof parseRunArgs>,
  io: WorkbenchCliIo
): Promise<number> {
  const registration = await resolveWorkbenchRegistration(
    parsed.positionals[0]!,
    parsed.values.export,
    parsed.values.project,
    io,
    RUN_USAGE
  );
  if ("exitCode" in registration) return registration.exitCode;
  const loaded = await registration.loadCommand(io);
  if ("exitCode" in loaded) return loaded.exitCode;

  const storePath = parsed.values.store ? path.resolve(io.cwd, parsed.values.store) : undefined;
  const tracePath =
    parsed.values.trace && parsed.values.trace !== "-"
      ? path.resolve(io.cwd, parsed.values.trace)
      : undefined;
  if (
    storePath !== undefined &&
    tracePath !== undefined &&
    (await destinationsConflict(storePath, tracePath))
  ) {
    return writeUsageError(io, "--store and --trace cannot write to the same path.", RUN_USAGE);
  }

  let managedSignal: ReturnType<typeof manageWorkbenchSignal> | undefined;
  let store: PipelineRunEventStore | undefined;
  let closeTrace: (() => Promise<void>) | undefined;
  let bindTraceSignal: ((signal: AbortSignal) => void) | undefined;
  let exitCode: number = TUBELESS_WORKBENCH_EXIT_CODE.execution;
  try {
    const exporters: PipelineTraceExporter[] = [];
    if (parsed.values.store) {
      const { openSqlitePipelineRunStore } = await import("../run-store/run-store-sqlite.js");
      store = await openSqlitePipelineRunStore(path.resolve(io.cwd, parsed.values.store));
      exporters.push(store);
    }
    if (parsed.values.trace) {
      const writer = await createRunTraceWriter(parsed.values.trace, io, io.signal);
      bindTraceSignal = writer.bindSignal;
      closeTrace = writer.close;
      exporters.push(writer.exporter);
    }
    managedSignal = manageWorkbenchSignal(io);
    bindTraceSignal?.(managedSignal.signal);
    const pipelineContext =
      exporters.length > 0
        ? { tracing: { exporter: composeTraceExporters(exporters) } }
        : undefined;
    const commandIo =
      parsed.values.trace === "-"
        ? { ...loaded.commandIo, stdout: loaded.commandIo.stderr }
        : loaded.commandIo;
    exitCode = await executePipelineCommand(
      loaded.command,
      parsed.commandArgs,
      commandIo,
      managedSignal.signal,
      pipelineContext
    );
    if (exitCode === TUBELESS_WORKBENCH_EXIT_CODE.success && managedSignal.wasInterrupted()) {
      exitCode = TUBELESS_WORKBENCH_EXIT_CODE.cancellation;
    }
  } catch (error) {
    io.stderr.write(`Error: ${errorMessage(error)}\n`);
    const interrupted = managedSignal?.wasInterrupted() ?? io.signal?.aborted === true;
    exitCode = interrupted ? TUBELESS_WORKBENCH_EXIT_CODE.cancellation : toExitCode(error);
  } finally {
    try {
      await closeTrace?.();
    } catch (error) {
      io.stderr.write(`Error: ${errorMessage(error)}\n`);
      if (exitCode === TUBELESS_WORKBENCH_EXIT_CODE.success) exitCode = toExitCode(error);
    }
    try {
      await store?.close();
    } catch (error) {
      io.stderr.write(`Error: ${errorMessage(error)}\n`);
      if (exitCode === TUBELESS_WORKBENCH_EXIT_CODE.success) exitCode = toExitCode(error);
    }
    managedSignal?.cleanup();
  }
  return exitCode;
}

async function createRunTraceWriter(
  destination: string,
  io: WorkbenchCliIo,
  signal?: AbortSignal
): Promise<{
  bindSignal(signal: AbortSignal): void;
  close(): Promise<void>;
  exporter: PipelineTraceExporter;
}> {
  let writeSignal = signal;
  // Nested runs share this exporter but have separate emission queues. Serialize
  // at the destination so only one flush/error/close listener set is active.
  let writes = Promise.resolve();
  const writeEvent = (output: WorkbenchCliIo["stdout"], event: PipelineTraceEvent) => {
    const chunk = `${JSON.stringify(event)}\n`;
    writes = writes.then(() => writeCliChunk(output, chunk, writeSignal));
    return writes;
  };

  if (destination === "-") {
    let writeError: Error | undefined;
    return {
      bindSignal(next) {
        writeSignal = next;
      },
      close: async () => {
        if (writeSignal?.aborted) return;
        if (writeError) throw writeError;
      },
      exporter: {
        async export(event) {
          if (writeError) throw writeError;
          try {
            await writeEvent(io.stdout, event);
          } catch (error) {
            writeError = error instanceof Error ? error : new Error(String(error));
            throw writeError;
          }
        },
      },
    };
  }

  const filename = path.resolve(io.cwd, destination);
  await mkdir(path.dirname(filename), { recursive: true });
  const stream = createWriteStream(filename);
  let writeError: Error | undefined;
  stream.on("error", (error) => {
    writeError = error;
  });
  const destroyOnAbort = () => {
    if (!stream.destroyed) stream.destroy();
  };
  // The signal is caller-owned and may outlive this writer (embedders reuse
  // one signal across runs), so never leave a stale listener behind: detach
  // before rebinding and on every terminal close path.
  let boundSignal: AbortSignal | undefined;
  const detachSignal = () => {
    boundSignal?.removeEventListener("abort", destroyOnAbort);
    boundSignal = undefined;
  };
  const bindSignal = (next: AbortSignal) => {
    detachSignal();
    writeSignal = next;
    if (next.aborted) {
      destroyOnAbort();
      return;
    }
    boundSignal = next;
    next.addEventListener("abort", destroyOnAbort, { once: true });
  };
  await waitForWriteStreamOpen(stream, signal);
  if (writeSignal) bindSignal(writeSignal);
  return {
    bindSignal,
    close: () =>
      new Promise((resolve, reject) => {
        const retainedError =
          writeError ?? (stream.errored instanceof Error ? stream.errored : undefined);
        detachSignal();
        if (retainedError) {
          reject(retainedError);
          return;
        }
        if (writeSignal?.aborted || stream.destroyed) {
          destroyOnAbort();
          resolve();
          return;
        }
        stream.end((error?: Error | null) => {
          if (error) reject(error);
          else if (writeError) reject(writeError);
          else resolve();
        });
      }),
    exporter: {
      async export(event) {
        if (writeError) throw writeError;
        await writeEvent(stream, event);
        if (writeError) throw writeError;
      },
    },
  };
}

async function waitForWriteStreamOpen(stream: WriteStream, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    stream.destroy();
    throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
  }
  if (stream.errored) throw stream.errored;
  if (!stream.pending) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      stream.destroy();
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off("open", onOpen);
      stream.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    stream.once("open", onOpen);
    stream.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function destinationsConflict(storePath: string, tracePath: string): Promise<boolean> {
  if (await pathsShareIdentity(storePath, tracePath)) return true;
  const storeTargets = new Set([storePath, await canonicalDestination(storePath)]);
  for (const storeTarget of storeTargets) {
    for (const suffix of ["-journal", "-shm", "-wal"] as const) {
      if (await pathsShareIdentity(`${storeTarget}${suffix}`, tracePath)) return true;
    }
  }
  return false;
}

async function canonicalDestination(filename: string, depth = 0): Promise<string> {
  if (depth > 32) return path.resolve(filename);
  try {
    return await realpath(filename);
  } catch {
    // Missing leaf or dangling symlink.
  }
  try {
    const target = await readlink(filename);
    return canonicalDestination(path.resolve(path.dirname(filename), target), depth + 1);
  } catch {
    // Not a symlink.
  }
  const resolved = path.resolve(filename);
  const parent = path.dirname(resolved);
  if (parent === resolved) return resolved;
  return path.join(await canonicalDestination(parent, depth + 1), path.basename(resolved));
}

async function pathsShareIdentity(left: string, right: string): Promise<boolean> {
  const [leftPath, rightPath] = await Promise.all([
    canonicalDestination(left),
    canonicalDestination(right),
  ]);
  if (leftPath === rightPath) return true;
  try {
    const [leftStat, rightStat] = await Promise.all([stat(left), stat(right)]);
    if (leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino) return true;
  } catch {
    // One or both dests do not exist yet.
  }
  if (leftPath.toLowerCase() !== rightPath.toLowerCase()) return false;
  return directoryIgnoresCase(
    (await nearestExistingDirectory(path.dirname(leftPath))) ??
      (await nearestExistingDirectory(path.dirname(rightPath)))
  );
}

async function nearestExistingDirectory(dir: string): Promise<string | undefined> {
  let current = dir;
  while (true) {
    try {
      if ((await stat(current)).isDirectory()) return current;
    } catch {
      // Missing or not a directory; walk toward the root.
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function directoryIgnoresCase(dir: string | undefined): Promise<boolean> {
  if (dir === undefined) return true;
  const id = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const probe = path.join(dir, `.tubeless-case-${id}-a`);
  const flipped = path.join(dir, `.tubeless-case-${id}-A`);
  try {
    await writeFile(probe, "", { flag: "wx" });
  } catch {
    // Cannot probe; treat a case-fold match as a collision so --trace cannot
    // truncate a store on a case-insensitive volume.
    return true;
  }
  try {
    const [probeStat, flippedStat] = await Promise.all([stat(probe), stat(flipped)]);
    return probeStat.dev === flippedStat.dev && probeStat.ino === flippedStat.ino;
  } catch {
    return false;
  } finally {
    await unlink(probe).catch(() => {});
  }
}
