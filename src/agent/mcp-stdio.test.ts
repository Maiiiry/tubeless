import { describe, expect, it } from "vitest";
import { stdioTransport } from "./mcp-stdio.js";

describe("MCP stdio shutdown", () => {
  it.skipIf(process.platform === "win32").each([false, true])(
    "bounds cleanup with an escaped descendant: %s",
    async (escaped) => {
      let ready!: (pid: number) => void;
      const started = new Promise<number>((resolve) => {
        ready = resolve;
      });
      const descendant = `
      process.on('SIGTERM', () => {});
      console.log(JSON.stringify({ jsonrpc: '2.0', method: 'ready', params: process.pid }));
      setInterval(() => {}, 1000);
    `;
      const launcher = `
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
        detached: ${escaped}, stdio: ['ignore', process.stdout, process.stderr]
      });
      process.stdin.resume();
      process.stdin.on('end', () => process.exit(0));
    `;
      const transport = await stdioTransport(
        "launcher",
        { command: process.execPath, args: ["-e", launcher] },
        {
          receive(message) {
            if (message.method === "ready") ready(Number(message.params));
          },
          fail() {},
        }
      );
      let pid: number | undefined;
      try {
        pid = await started;
        const closing = transport.close();
        expect(transport.close()).toBe(closing);
        await closing;
        if (!escaped) expect(() => process.kill(pid!, 0)).toThrow();
      } finally {
        if (pid !== undefined) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* Already reaped. */
          }
        }
        await transport.close();
      }
    },
    10_000
  );
});
