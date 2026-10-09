import type { ChildProcessWithoutNullStreams } from "node:child_process";
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
  const child: ChildProcessWithoutNullStreams = spawn(options.command, [...(options.args ?? [])], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
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
        if (line) events.receive(parseMessage(line));
      }
      if (buffer.length > MAX_MESSAGE_BYTES) throw new Error("MCP message exceeds 16 MiB");
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      child.kill("SIGKILL");
    }
  });

  return {
    send: (message) =>
      new Promise<void>((resolve, reject) => {
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) =>
          error ? reject(error) : resolve()
        );
      }),
    async close() {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      // Spec shutdown: close input, then escalate if the server does not exit.
      child.stdin.end();
      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        let timer: NodeJS.Timeout | undefined;
        const graceful = await Promise.race([
          exited.then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), CLOSE_GRACE_MS);
          }),
        ]);
        clearTimeout(timer);
        if (graceful) return;
        child.kill(signal);
      }
      await exited;
    },
  };
}
