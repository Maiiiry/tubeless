import { awaitWithAbort, throwIfAborted } from "../utilities/abort.js";
import {
  MAX_MESSAGE_BYTES,
  parseMessage,
  type McpTransport,
  type McpTransportEvents,
} from "./mcp-session.js";

/** A local server process speaking JSON-RPC over stdin and stdout. */
export interface McpStdioOptions {
  readonly command: string;
  readonly args?: readonly string[];
  /** Added to the inherited process environment. */
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

const CLOSE_GRACE_MS = 2_000;

/** Spawn a local server speaking newline-delimited JSON-RPC over stdin and stdout. */
export async function stdioTransport(
  label: string,
  options: McpStdioOptions,
  events: McpTransportEvents
): Promise<McpTransport> {
  // Loaded lazily so HTTP-only applications never touch Node process APIs.
  const { spawn } = await import("node:child_process");
  const grouped = process.platform !== "win32";
  const child = spawn(options.command, [...(options.args ?? [])], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: grouped,
    windowsHide: true,
  });
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let closing: Promise<void> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      if (grouped) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  };
  const waitForClose = () =>
    awaitWithAbort(exited, AbortSignal.timeout(CLOSE_GRACE_MS), "MCP shutdown").then(
      () => true,
      () => false
    );
  let stderr = "";
  const fail = (detail: string) =>
    events.fail(
      new Error(
        `MCP server ${label} ${detail}${stderr.trim() ? `: ${stderr.trim().slice(-1024)}` : ""}`
      )
    );
  child.once("error", (error) => fail(`failed to start (${error.message})`));
  child.once("exit", (code, signal) => fail(`exited (${signal ?? code})`));
  child.stdin.on("error", (error) => fail(`closed its input (${error.message})`));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4096);
  });

  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    try {
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES)
          throw new Error("MCP message exceeds 16 MiB");
        if (line) events.receive(parseMessage(line));
      }
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES)
        throw new Error("MCP message exceeds 16 MiB");
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      kill("SIGKILL");
    }
  });

  return {
    async send(message, signal) {
      throwIfAborted(signal, "Send MCP message");
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) =>
          error ? reject(error) : resolve()
        );
      });
    },
    close() {
      closing ??= (async () => {
        try {
          if (child.pid === undefined) return;
          child.stdin.end();
          for (const signal of ["SIGTERM", "SIGKILL"] as const) {
            if (await waitForClose()) return;
            kill(signal);
          }
          await waitForClose();
        } finally {
          // A launcher may exit before its descendants, or a descendant may escape its group.
          kill("SIGKILL");
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
        }
      })();
      return closing;
    },
  };
}
