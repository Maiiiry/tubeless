import { stat } from "node:fs/promises";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { TUBELESS_WORKBENCH_EXIT_CODE } from "../cli/cli-exit.js";
import { loadPlanSourceModule, type WorkbenchPlanSource } from "./pipeline-module.js";
import { tubelessErrorKind } from "../utilities/tubeless-error.js";

export { TUBELESS_WORKBENCH_EXIT_CODE };

/** Default local SQLite path shared by `tubeless run --store`, `history`, and `ui`. */
export const DEFAULT_PIPELINE_RUN_STORE = ".tubeless/runs.sqlite";

export interface WorkbenchCliIo {
  cwd: string;
  signal?: AbortSignal;
  stdin?: Readable & { isTTY?: boolean };
  stderr: { write(chunk: string): boolean | void };
  stdout: {
    write(chunk: string): boolean | void;
    isTTY?: boolean;
    columns?: number;
    rows?: number;
  };
}

/** Neutralize controls in untrusted text while keeping terminal layout caller-owned. */
export function terminalSafeText(value: string): string {
  return value.replace(
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    " "
  );
}

function abortReason(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("Aborted");
}

/** Write a chunk and wait until it is flushed or the destination fails. */
export async function writeCliChunk(
  output: { write(chunk: string): boolean | void },
  chunk: string,
  signal?: AbortSignal
): Promise<void> {
  interface CallbackWriter {
    destroyed?: boolean;
    errored?: Error | null;
    off?(event: string, listener: (...args: never[]) => void): unknown;
    once?(event: string, listener: (...args: never[]) => void): unknown;
    write(chunk: string, callback?: (error?: Error | null) => void): boolean | void;
  }
  // SAFETY: destroyed/errored/once/off and write(chunk, cb) are Node writable
  // stream signals. Test IO objects omit those fields and skip the flush wait.
  const stream = output as CallbackWriter;
  if (signal?.aborted) throw abortReason(signal);
  if (stream.destroyed) {
    throw stream.errored instanceof Error
      ? stream.errored
      : new Error("Cannot write to a closed stream.");
  }
  if (typeof stream.once !== "function" || typeof stream.off !== "function") {
    output.write(chunk);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      fail(abortReason(signal));
    };
    const onError = (error: Error) => {
      fail(error);
    };
    const onClose = () => {
      fail(
        stream.errored instanceof Error
          ? stream.errored
          : new Error("Cannot write to a closed stream.")
      );
    };
    const cleanup = () => {
      stream.off!("error", onError);
      stream.off!("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    stream.once!("error", onError);
    stream.once!("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    if (stream.destroyed) {
      onClose();
      return;
    }
    stream.write(chunk, (error) => {
      if (error) fail(error);
      else succeed();
    });
  });
}

export function writeUsageError(io: WorkbenchCliIo, message: string, usage: string): number {
  io.stderr.write(`Error: ${message}\n\n${usage}`);
  return TUBELESS_WORKBENCH_EXIT_CODE.usage;
}

function isDefinitionError(error: unknown): boolean {
  // Dual library copies under dynamic import break instanceof; identify
  // errors by branded discriminant, then the historical name used by loaded modules.
  return (
    tubelessErrorKind(error) === "pipeline-definition" ||
    (error instanceof Error && error.name === "PipelineDefinitionError")
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function loadWorkbenchModule<T>(
  fileArgument: string,
  io: WorkbenchCliIo,
  load: (filePath: string) => Promise<T>
): Promise<T | { exitCode: number }> {
  const filePath = path.resolve(io.cwd, fileArgument);
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error(`${filePath} is not a file.`);
    return await load(filePath);
  } catch (error) {
    const exitCode = isDefinitionError(error)
      ? TUBELESS_WORKBENCH_EXIT_CODE.definition
      : TUBELESS_WORKBENCH_EXIT_CODE.load;
    io.stderr.write(`Error: ${errorMessage(error)}\n`);
    return { exitCode };
  }
}

export async function loadPlanSource(
  fileArgument: string,
  exportName: string | undefined,
  io: WorkbenchCliIo
): Promise<{ source: WorkbenchPlanSource } | { exitCode: number }> {
  return loadWorkbenchModule(fileArgument, io, async (filePath) => ({
    source: await loadPlanSourceModule(filePath, exportName),
  }));
}

export { hostedCommandContext as commandContext } from "../hosting/hosting-commands.js";

export interface ManagedWorkbenchSignal {
  cleanup(): void;
  signal: AbortSignal;
  wasInterrupted(): boolean;
}

/** Watch for the first terminal signal, then restore default signal handling. */
export function onFirstProcessSignal(
  signals: readonly NodeJS.Signals[],
  onFirst: (signal: NodeJS.Signals) => void
): () => void {
  let handled = false;
  const removeAll = (): void => {
    for (const { signal, listener } of listeners) {
      process.removeListener(signal, listener);
    }
  };
  const listeners = signals.map((signal) => {
    const listener = (): void => {
      if (handled) return;
      handled = true;
      removeAll();
      onFirst(signal);
    };
    process.on(signal, listener);
    return { signal, listener };
  });
  return removeAll;
}

export function manageWorkbenchSignal(io: WorkbenchCliIo): ManagedWorkbenchSignal {
  if (io.signal) {
    return {
      cleanup: () => {},
      signal: io.signal,
      wasInterrupted: () => io.signal?.aborted === true,
    };
  }

  const controller = new AbortController();
  let interrupted = false;
  const dispose = onFirstProcessSignal(["SIGINT"], () => {
    interrupted = true;
    io.stderr.write("SIGINT received; cancelling pipeline work.\n");
    controller.abort();
  });
  return {
    cleanup: dispose,
    signal: controller.signal,
    wasInterrupted: () => interrupted,
  };
}
