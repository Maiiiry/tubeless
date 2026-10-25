import { createInterface, type Interface } from "node:readline/promises";
import { Writable } from "node:stream";
import { createReporterTheme } from "../../reporter/reporter.js";
import { completeAgentCommand } from "./commands.js";
import type { WorkbenchCliIo } from "../workbench-shared.js";

/** Read pipes with backpressure; request interactive input only while the agent is idle. */
export class AgentInput implements AsyncIterable<string> {
  private readonly readline: Interface;
  private readonly pipedLines?: AsyncIterableIterator<string>;
  private readonly closed = new AbortController();
  private readonly prompt: string;
  private running = false;
  readonly interactive: boolean;

  constructor(io: WorkbenchCliIo, onInterrupt: () => void) {
    if (!io.stdin) throw new Error("Agent REPL requires stdin; use --prompt for one run.");
    this.interactive =
      io.stdin.isTTY === true && io.stdout.isTTY === true && process.env.TERM !== "dumb";
    const theme = createReporterTheme({ terminal: { isTTY: this.interactive } });
    this.prompt = `${theme.styled.start("◯╱◯")} ${theme.styled.pipeline("❯")} `;
    const output = new Writable({
      write: (chunk, _encoding, callback) => {
        if (!this.running) io.stdout.write(String(chunk));
        callback();
      },
    });
    Object.defineProperty(output, "columns", { get: () => io.stdout.columns });
    this.readline = createInterface({
      input: io.stdin,
      output,
      terminal: this.interactive,
      completer: completeAgentCommand,
    });
    if (!this.interactive) this.pipedLines = this.readline[Symbol.asyncIterator]();
    this.readline.on("close", () => this.closed.abort());
    this.readline.on("SIGINT", onInterrupt);
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<string> {
    try {
      if (this.pipedLines) {
        yield* this.pipedLines;
        return;
      }
      while (!this.closed.signal.aborted) {
        let line: string;
        try {
          line = await this.readline.question(this.prompt, { signal: this.closed.signal });
        } catch (error) {
          if (this.closed.signal.aborted) return;
          throw error;
        }
        yield line;
      }
    } finally {
      this.close();
    }
  }

  setRunning(running: boolean): void {
    if (!running && this.interactive && !this.closed.signal.aborted) {
      this.readline.write(null, { ctrl: true, name: "u" });
    }
    this.running = running;
  }

  close(): void {
    this.readline.close();
  }
}
