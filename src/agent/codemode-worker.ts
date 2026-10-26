import { createContext, Script } from "node:vm";
import { parentPort, workerData } from "node:worker_threads";
import type {
  CodemodeHostMessage,
  CodemodeWorkerData,
  CodemodeWorkerMessage,
} from "./codemode-protocol.js";

// Runs inside the script realm before model code. It creates `tools` and `console` there, so
// the script only reaches realm-local objects; the host bridge stays in this closure and
// exchanges JSON text only.
const SETUP = `(function (bridge, names, maxLines, maxCharacters) {
  "use strict";
  const { parse, stringify } = JSON;
  const freeze = Object.freeze;
  const logs = [];
  let characters = 0;
  let truncated = false;
  const text = (value) => {
    if (typeof value === "string") return value;
    try {
      const json = stringify(value);
      if (json !== undefined) return json;
    } catch {}
    try {
      return String(value);
    } catch {
      return "[unprintable]";
    }
  };
  const write = (...values) => {
    let line = "";
    for (let index = 0; index < values.length; index++)
      line += (index === 0 ? "" : " ") + text(values[index]);
    if (logs.length >= maxLines || characters + line.length > maxCharacters) {
      truncated = true;
      return;
    }
    logs.push(line);
    characters += line.length;
  };
  const tools = {};
  for (const name of parse(names)) {
    tools[name] = async (input) => {
      const reply = parse(await bridge(name, stringify(input === undefined ? null : input) ?? "null"));
      if (reply.ok) return reply.value;
      const error = new Error(reply.message);
      error.name = "ToolError";
      error.code = reply.code;
      throw error;
    };
  }
  Object.defineProperty(globalThis, "tools", { value: freeze(tools) });
  Object.defineProperty(globalThis, "console", {
    value: freeze({ log: write, info: write, warn: write, error: write, debug: write }),
  });
  return (value) => {
    let result;
    try {
      result = value === undefined ? "null" : (stringify(value) ?? "null");
    } catch {}
    return { result, logs: stringify(logs), truncated };
  };
})`;

type Finish = (value: unknown) => { result?: unknown; logs: unknown; truncated: unknown };

const data = workerData as CodemodeWorkerData;
const port = parentPort!;
const replies = new Map<number, (reply: string) => void>();
let nextCall = 0;

// Unawaited calls may reject after the script settles; the script's own result reports failures.
process.on("unhandledRejection", () => {});

port.on("message", ({ id, reply }: CodemodeHostMessage) => {
  const resolve = replies.get(id);
  replies.delete(id);
  resolve?.(reply);
});

function bridge(name: string, input: string): Promise<string> {
  return new Promise((resolve) => {
    const id = nextCall++;
    replies.set(id, resolve);
    port.postMessage({ type: "call", id, name, input } satisfies CodemodeWorkerMessage);
  });
}

/** Read a script-thrown value defensively; getters and coercions run script code. */
function describe(error: unknown): string {
  try {
    if (error === null || typeof error !== "object") return String(error);
    const { name, message, code, stack } = error as Record<string, unknown>;
    const location = typeof stack === "string" ? /codemode\.js:(\d+)(?::(\d+))?/.exec(stack) : null;
    const label =
      typeof code === "string"
        ? `${code}: `
        : typeof name === "string" && name !== "Error"
          ? `${name}: `
          : "";
    const position = location
      ? ` (line ${location[1]}${location[2] ? `, column ${location[2]}` : ""})`
      : "";
    return `${label}${String(message)}${position}`;
  } catch {
    return "Script failed with an unprintable error";
  }
}

function logLines(text: unknown): string[] {
  try {
    const parsed: unknown = typeof text === "string" ? JSON.parse(text) : undefined;
    return Array.isArray(parsed) ? parsed.filter((line) => typeof line === "string") : [];
  } catch {
    return [];
  }
}

async function main(): Promise<CodemodeWorkerMessage> {
  const context = createContext(
    {},
    { name: "codemode", codeGeneration: { strings: false, wasm: false } }
  );
  const finish: Finish = new Script(SETUP, { filename: "codemode-setup.js" }).runInContext(context)(
    bridge,
    JSON.stringify(data.tools),
    data.maxLogLines,
    data.maxLogCharacters
  );
  const failed = (message: string): CodemodeWorkerMessage => {
    const { logs, truncated } = finish(undefined);
    return { type: "done", ok: false, message, logs: logLines(logs), logsTruncated: !!truncated };
  };
  let script: () => unknown;
  try {
    script = new Script(`(async () => {\n${data.code}\n})`, {
      filename: "codemode.js",
      lineOffset: -1,
    }).runInContext(context);
  } catch (error) {
    return failed(describe(error));
  }
  try {
    const { result, logs, truncated } = finish(await script());
    if (typeof result !== "string") return failed("Script result must be JSON-serializable");
    return { type: "done", ok: true, result, logs: logLines(logs), logsTruncated: !!truncated };
  } catch (error) {
    return failed(describe(error));
  }
}

port.postMessage(await main());
