import { Worker } from "node:worker_threads";
import { createAbortError, throwIfAborted } from "../utilities/abort.js";
import type {
  CodemodeHostMessage,
  CodemodeReply,
  CodemodeWorkerData,
  CodemodeWorkerMessage,
} from "./codemode-protocol.js";

/** A completed script's JSON result text and bounded console lines, or a recoverable failure. */
export type CodemodeScriptOutcome =
  | {
      readonly ok: true;
      readonly result: string;
      readonly logs: readonly string[];
      readonly logsTruncated: boolean;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly logs: readonly string[];
      readonly logsTruncated: boolean;
    };

export interface CodemodeScript {
  readonly code: string;
  readonly tools: readonly string[];
  readonly timeoutMs: number;
  readonly maxLogLines: number;
  readonly maxLogCharacters: number;
  readonly signal?: AbortSignal;
  /** Dispatch one script call. Rejections are fatal; recoverable failures resolve `ok: false`. */
  call(name: string, input: unknown, signal: AbortSignal): Promise<CodemodeReply>;
}

type Stop =
  | { readonly kind: "done"; readonly message: Extract<CodemodeWorkerMessage, { type: "done" }> }
  | { readonly kind: "timeout" | "abort" | "fatal" }
  | { readonly kind: "crash"; readonly error: unknown };

function workerUrl(): URL {
  return import.meta.url.endsWith(".ts")
    ? new URL("../../dist/agent/codemode-worker.js", import.meta.url)
    : new URL("./codemode-worker.js", import.meta.url);
}

// --input-type is valid for the caller's eval/stdin but not this file-based worker.
const execArgv = () =>
  process.execArgv.filter(
    (arg, index, args) =>
      arg !== "--input-type" &&
      !arg.startsWith("--input-type=") &&
      args[index - 1] !== "--input-type"
  );

/**
 * Run one script in a fresh worker thread. The host owns the deadline and termination; calls
 * still running when the script returns are drained, and other stops abort them first.
 */
export async function runCodemodeScript(script: CodemodeScript): Promise<CodemodeScriptOutcome> {
  const { signal } = script;
  throwIfAborted(signal, "Codemode script");
  const nested = new AbortController();
  const active = new Set<Promise<void>>();
  let stopped: Stop | undefined;
  let fatal: { error: unknown } | undefined;
  let settle!: (reason: Stop) => void;
  const settled = new Promise<Stop>((resolve) => {
    settle = resolve;
  });
  const stop = (reason: Stop) => {
    if (stopped) return;
    stopped = reason;
    settle(reason);
  };
  const worker = new Worker(workerUrl(), {
    workerData: {
      code: script.code,
      tools: script.tools,
      maxLogLines: script.maxLogLines,
      maxLogCharacters: script.maxLogCharacters,
    } satisfies CodemodeWorkerData,
    execArgv: execArgv(),
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
  });
  const dispatch = (id: number, name: string, input: string) => {
    const task = (async () => {
      let reply: CodemodeReply;
      try {
        reply = await script.call(name, JSON.parse(input), nested.signal);
      } catch (error) {
        // Failures caused by an earlier stop are cancellations of that stop, not new faults.
        if (!stopped || stopped.kind === "done") fatal ??= { error };
        stop({ kind: "fatal" });
        return;
      }
      if (!stopped)
        worker.postMessage({
          type: "reply",
          id,
          reply: JSON.stringify(reply),
        } satisfies CodemodeHostMessage);
    })();
    active.add(task);
    void task.finally(() => active.delete(task));
  };
  worker.on("message", (message: CodemodeWorkerMessage) => {
    if (stopped) return;
    if (message.type === "call") dispatch(message.id, message.name, message.input);
    else stop({ kind: "done", message });
  });
  worker.on("error", (error) => stop({ kind: "crash", error }));
  worker.on("exit", (code) =>
    stop({ kind: "crash", error: new Error(`Sandbox exited with code ${code}`) })
  );
  const timer = setTimeout(() => stop({ kind: "timeout" }), script.timeoutMs);
  const onAbort = () => stop({ kind: "abort" });
  signal?.addEventListener("abort", onAbort, { once: true });
  const outcome = await settled;
  clearTimeout(timer);
  signal?.removeEventListener("abort", onAbort);
  if (outcome.kind !== "done") nested.abort(signal?.aborted ? signal.reason : undefined);
  await worker.terminate();
  while (active.size > 0) await Promise.allSettled([...active]);
  if (signal?.aborted) throw createAbortError(signal, "Codemode script");
  if (fatal) throw fatal.error;
  const empty = { logs: [], logsTruncated: false };
  switch (outcome.kind) {
    case "timeout":
      return {
        ok: false,
        code: "CODEMODE_TIMEOUT",
        message: `Script exceeded ${script.timeoutMs} ms`,
        ...empty,
      };
    case "crash":
      return {
        ok: false,
        code: "CODEMODE_SANDBOX_ERROR",
        message: `Sandbox stopped: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`,
        ...empty,
      };
    case "done": {
      const { message } = outcome;
      const { logs, logsTruncated } = message;
      return message.ok
        ? { ok: true, result: message.result, logs, logsTruncated }
        : {
            ok: false,
            code: "CODEMODE_SCRIPT_ERROR",
            message: message.message,
            logs,
            logsTruncated,
          };
    }
    default:
      throw new Error(`Codemode script stopped unexpectedly (${outcome.kind})`);
  }
}
