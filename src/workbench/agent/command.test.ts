import { PassThrough, Readable } from "node:stream";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runWorkbenchCli } from "../workbench.js";
import { captureIo, writeModule, execFileAsync } from "../workbench.test-support.js";

async function fixture() {
  return writeModule(`
    let markStarted;
    export const started = new Promise((resolve) => { markStarted = resolve; });
    export default ({ model }) => async (request, context) => {
      if (request.task === "broken") throw new Error("fixture failure");
      if (request.task === "wait") {
        markStarted();
        await new Promise((resolve) => {
          if (context.signal.aborted) return resolve();
          context.signal.addEventListener("abort", resolve, { once: true });
        });
        context.signal.throwIfAborted();
      }
      if ((request.task === "tools" && request.conversation === null) || request.task === "loop") {
        context.log.log("fixture log %s", "hello\u001b[2J");
        return {
          decision: { kind: "continue", calls: [{ id: "files", tool: "list", input: { path: "." } }] },
          conversation: { called: true },
        };
      }
      return {
        decision: { kind: "finish", result: { answer: model + ":" + request.task + ":" + (request.outcomes[0]?.tool ?? request.conversation?.previousTask ?? "fresh") } },
        conversation: { previousTask: request.task },
      };
    };
  `);
}

describe("tubeless agent", () => {
  it("offers help without credentials, stdin or loading a model module", async () => {
    const io = captureIo("/tmp");
    expect(
      await runWorkbenchCli(
        ["agent", "--help", "--model-module", "missing.ts", "--env-file", "missing.env"],
        io
      )
    ).toBe(0);
    expect(io.output.join("")).toContain("/model [name]");
    expect(io.errors).toEqual([]);
  });

  it("runs piped prompts serially and retains conversation across model changes until cleared", async () => {
    const { directory } = await fixture();
    const io = {
      ...captureIo(directory),
      stdin: Readable.from([
        "\nfirst\n/model changed\nsecond\n/clear\nthird\n/help\n/quit\nignored\n",
      ]),
    };
    expect(
      await runWorkbenchCli(["agent", "--model", "initial", "--model-module", "pipeline.mjs"], io)
    ).toBe(0);
    const output = io.output.join("");
    expect(output).toContain("initial:first:fresh");
    expect(output).toContain("changed:second:first");
    expect(output).toContain("changed:third:fresh");
    expect(output).toContain("Conversation cleared.");
    expect(output).not.toContain("ignored");
    expect(output).not.toContain("\u001b");
    expect(io.errors).toEqual([]);
  });

  it("uses the pipeline reporter for nested turns, tool progress and scoped logs before the answer", async () => {
    vi.stubEnv("CI", "false");
    vi.stubEnv("TERM", "xterm-256color");
    vi.stubEnv("FORCE_COLOR", "1");
    const { directory } = await fixture();
    const io = captureIo(directory);
    try {
      expect(
        await runWorkbenchCli(
          ["agent", "--model-module", "pipeline.mjs", "--model", "fixture", "--prompt", "tools"],
          { ...io, stdout: { ...io.stdout, isTTY: true, columns: 140, rows: 30 } }
        )
      ).toBe(0);
      const output = io.output.join("");
      expect(output).toContain("Pipeline tubeless-agent");
      expect(output).toContain("Turn 1");
      expect(output).toContain("Turn 2");
      expect(output).toContain("Plan next action");
      expect(output).toContain("Tool calls");
      expect(output).toContain("Update context");
      expect(output).toContain('List ".": completed (1 entry)');
      expect(output).not.toContain("iteration-1");
      expect(output).not.toContain("files: completed");
      expect(output).toContain("fixture log hello");
      expect(output).toContain("Logs");
      expect(output).toContain("\u001b[0;2;36m");
      expect(output).not.toContain("\u001b[2J");
      expect(output).toContain("\u001b[?25h");
      expect(output.indexOf("\u001b[?25h")).toBeLessThan(output.indexOf("fixture:tools:list"));
      expect(io.errors).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([{ flags: [] }, { flags: ["--no-graph"] }])(
    "keeps tool actions in plain logs with flags $flags",
    async ({ flags }) => {
      const { directory } = await fixture();
      const io = captureIo(directory);
      expect(
        await runWorkbenchCli(
          ["agent", "--model-module", "pipeline.mjs", "--prompt", "tools", ...flags],
          io
        )
      ).toBe(0);
      const output = io.output.join("");
      expect(output).toContain('List "."');
      expect(output).toContain('List ".": completed (1 entry)');
      expect(output).not.toContain("\u001b");
      expect(io.errors).toEqual([]);
    }
  );

  it("returns to the prompt after a failed task and drains EOF after the next task", async () => {
    const { directory } = await fixture();
    const io = { ...captureIo(directory), stdin: Readable.from(["seed\nbroken\nrecovered\n"]) };
    expect(await runWorkbenchCli(["agent", "--model-module", "pipeline.mjs"], io)).toBe(0);
    expect(io.errors.join("")).toContain("fixture failure");
    expect(io.output.join("")).toContain(":recovered:seed");
  });

  it("enforces turn limits and returns an execution exit code for a single failed prompt", async () => {
    const { directory } = await fixture();
    const io = captureIo(directory);
    expect(
      await runWorkbenchCli(
        ["agent", "--model-module", "pipeline.mjs", "--prompt", "loop", "--max-turns", "1"],
        io
      )
    ).toBe(6);
    expect(io.errors.join("")).toContain("maxTurns");
    expect(io.output.join("")).not.toContain("tool/list");
  });

  it("offers only the codemode tool with --codemode", async () => {
    const { directory } = await writeModule(
      `export default () => (_request, context) => ({ decision: { kind: "finish", result: { answer: context.capabilities.map(({ name }) => name).join(",") } }, conversation: null });`
    );
    const io = captureIo(directory);
    expect(
      await runWorkbenchCli(
        ["agent", "--model-module", "pipeline.mjs", "--prompt", "tools", "--codemode"],
        io
      )
    ).toBe(0);
    expect(io.output.join("")).toContain("codemode");
    expect(io.output.join("")).not.toContain("bash");
  });

  it("limits default tools with --tools and rejects unknown names", async () => {
    const { directory } = await writeModule(
      `export default () => (_request, context) => ({ decision: { kind: "finish", result: { answer: context.capabilities.map(({ name }) => name).join(",") } }, conversation: null });`
    );
    const io = captureIo(directory);
    expect(
      await runWorkbenchCli(
        ["agent", "--model-module", "pipeline.mjs", "--prompt", "tools", "--tools", "read, list"],
        io
      )
    ).toBe(0);
    expect(io.output.join("")).toContain("list,read");
    const rejected = captureIo(directory);
    expect(
      await runWorkbenchCli(
        ["agent", "--model-module", "pipeline.mjs", "--prompt", "tools", "--tools", "rm"],
        rejected
      )
    ).not.toBe(0);
    expect(rejected.errors.join("")).toContain("--tools accepts a comma-separated subset");
  });

  it("can hide the graph and preserve multiline answers without terminal escape sequences", async () => {
    const { directory } = await writeModule(
      `export default () => () => ({ decision: { kind: "finish", result: { answer: "hello\\n\\u001b[2Jworld" } }, conversation: null });`
    );
    const io = captureIo(directory);
    expect(
      await runWorkbenchCli(
        ["agent", "--model-module", "pipeline.mjs", "--prompt", "hello", "--no-graph"],
        io
      )
    ).toBe(0);
    expect(io.output.join("")).toContain("hello\nworld");
    expect(io.output.join("")).not.toContain("Pipeline tubeless-agent");
    expect(io.output.join("")).not.toContain("\u001b");
  });

  it.each([
    ["--model", " "],
    ["--prompt", ""],
    ["--env-file", " "],
    ["--max-turns", "0"],
    ["--max-calls", "-1"],
    ["--max-concurrency", "1.5"],
    ["--unknown"],
    ["unexpected"],
  ])("rejects invalid arguments %j before loading providers", async (...args) => {
    const io = captureIo("/tmp");
    expect(await runWorkbenchCli(["agent", "--prompt", "task", ...args], io)).toBe(1);
    expect(io.errors.join("")).toContain("Usage: tubeless agent");
  });

  it("validates the plugin export and factory return value", async () => {
    const badExport = await writeModule("export default {}; ");
    const io = captureIo(badExport.directory);
    expect(
      await runWorkbenchCli(["agent", "--prompt", "hello", "--model-module", "pipeline.mjs"], io)
    ).toBe(2);
    expect(io.errors.join("")).toContain("default-export a factory");
    const badFactory = await writeModule("export default () => ({ invalid: true });");
    const otherIo = captureIo(badFactory.directory);
    expect(
      await runWorkbenchCli(
        ["agent", "--prompt", "hello", "--model-module", "pipeline.mjs"],
        otherIo
      )
    ).toBe(6);
    expect(otherIo.errors.join("")).toContain("return an AgentModel function");
  });

  it("cancels an active task on SIGINT, then accepts another prompt and removes listeners", async () => {
    const { directory, filePath } = await fixture();
    const stdin = new PassThrough();
    const io = { ...captureIo(directory), stdin };
    const fixtureModule = (await import(pathToFileURL(filePath).href)) as {
      started: Promise<void>;
    };
    const onSpy = vi.spyOn(process, "on");
    const before = process.listenerCount("SIGINT");
    try {
      const running = runWorkbenchCli(["agent", "--model-module", "pipeline.mjs"], io);
      stdin.write("seed\nwait\n");
      await fixtureModule.started;
      const listener = onSpy.mock.calls.find(([name]) => name === "SIGINT")![1] as () => void;
      listener();
      stdin.end("after cancellation\n");
      expect(await running).toBe(0);
      expect(io.errors.join("")).toContain("Cancelled");
      expect(io.output.join("")).toContain(":after cancellation:seed");
      expect(process.listenerCount("SIGINT")).toBe(before);
    } finally {
      onSpy.mockRestore();
      stdin.destroy();
    }
  });

  it("restores the cursor on external cancellation of a live single prompt", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    vi.stubEnv("CI", "false");
    const { directory, filePath } = await fixture();
    const io = captureIo(directory);
    const controller = new AbortController();
    const fixtureModule = (await import(pathToFileURL(filePath).href)) as {
      started: Promise<void>;
    };
    const running = runWorkbenchCli(
      ["agent", "--model-module", "pipeline.mjs", "--prompt", "wait"],
      {
        ...io,
        signal: controller.signal,
        stdout: { ...io.stdout, isTTY: true, columns: 80, rows: 24 },
      }
    );
    try {
      await fixtureModule.started;
      controller.abort();
      expect(await running).toBe(7);
      expect(io.output.join("")).toContain("\u001b[?25h");
      expect(io.errors.join("")).toContain("Cancelled");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("releases an idle prompt on external abort", async () => {
    const { directory } = await fixture();
    const stdin = new PassThrough();
    const controller = new AbortController();
    const io = { ...captureIo(directory), stdin, signal: controller.signal };
    const running = runWorkbenchCli(["agent", "--model-module", "pipeline.mjs"], io);
    await vi.waitFor(() => expect(io.output.join("")).toContain("Type a task"));
    controller.abort();
    expect(await running).toBe(7);
    stdin.destroy();
  });

  it("cancels a factory that never settles and accepts the next model and prompt", async () => {
    const { directory, filePath } = await writeModule(`
      let markStarted;
      export const started = new Promise((resolve) => { markStarted = resolve; });
      export let setupSignal;
      export default ({ model, signal }) => {
        if (model === "pending") {
          setupSignal = signal;
          markStarted();
          return new Promise(() => {});
        }
        return (request) => ({ decision: { kind: "finish", result: { answer: model + ":" + request.task } }, conversation: null });
      };
    `);
    const fixtureModule = (await import(pathToFileURL(filePath).href)) as {
      started: Promise<void>;
      setupSignal: AbortSignal;
    };
    const stdin = new PassThrough();
    const io = { ...captureIo(directory), stdin };
    const onSpy = vi.spyOn(process, "on");
    const before = process.listenerCount("SIGINT");
    try {
      const running = runWorkbenchCli(
        ["agent", "--model-module", "pipeline.mjs", "--model", "pending"],
        io
      );
      stdin.write("first task\n");
      await fixtureModule.started;
      const interrupt = onSpy.mock.calls.find(([name]) => name === "SIGINT")![1] as () => void;
      interrupt();
      stdin.end("/model ready\nnext task\n");
      expect(await running).toBe(0);
      expect(fixtureModule.setupSignal.aborted).toBe(true);
      expect(io.errors.join("")).toContain("Cancelled");
      expect(io.output.join("")).toContain("ready:next task");
      expect(process.listenerCount("SIGINT")).toBe(before);
    } finally {
      onSpy.mockRestore();
      stdin.destroy();
    }
  });

  it("ends pending setup on external abort and never invokes a model returned afterward", async () => {
    const { directory, filePath } = await writeModule(`
      let markStarted;
      export const started = new Promise((resolve) => { markStarted = resolve; });
      export let setupSignal;
      export let finishSetup;
      export let entered = false;
      export default ({ signal }) => {
        setupSignal = signal;
        markStarted();
        return new Promise((resolve) => {
          finishSetup = () => resolve(() => { entered = true; throw new Error("must not invoke"); });
        });
      };
    `);
    const fixtureModule = (await import(pathToFileURL(filePath).href)) as {
      started: Promise<void>;
      setupSignal: AbortSignal;
      finishSetup(): void;
      entered: boolean;
    };
    const controller = new AbortController();
    const io = { ...captureIo(directory), signal: controller.signal };
    const running = runWorkbenchCli(
      ["agent", "--model-module", "pipeline.mjs", "--prompt", "task"],
      io
    );
    await fixtureModule.started;
    controller.abort("stop setup");
    expect(await running).toBe(7);
    expect(fixtureModule.setupSignal.aborted).toBe(true);
    expect(io.errors.join("")).toContain("Cancelled");
    expect(io.output.join("")).not.toContain("Pipeline tubeless-agent");
    fixtureModule.finishSetup();
    await Promise.resolve();
    expect(fixtureModule.entered).toBe(false);
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "stops the executable during async setup on %s",
    async (signal) => {
      const { filePath } = await writeModule(`
      export default async ({ signal }) => {
        console.error("setup-started");
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 30000);
          signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
        });
        throw new Error("cancelled setup must not complete");
      };
    `);
      const child = spawn(
        "bun",
        [
          "dist/workbench/workbench-bin.js",
          "agent",
          "--model-module",
          filePath,
          "--prompt",
          "task",
          "--no-graph",
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      child.stdout.resume();
      let stderr = "";
      let closed = false;
      const completed = new Promise<number | null>((resolve) =>
        child.on("close", (code) => {
          closed = true;
          resolve(code);
        })
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const testRun = async () => {
          await new Promise<void>((resolve, reject) => {
            child.on("error", reject);
            child.stderr.on("data", (chunk: Buffer) => {
              stderr += chunk.toString();
              if (stderr.includes("setup-started")) resolve();
            });
          });
          child.kill(signal);
          return completed;
        };
        const code = await Promise.race([
          testRun(),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Setup cancellation did not finish")),
              2000
            );
          }),
        ]);
        expect(code).toBe(7);
        expect(stderr).toContain("Cancelled");
      } finally {
        clearTimeout(timeout);
        if (!closed) child.kill("SIGKILL");
        await completed;
      }
    }
  );

  it("runs the built executable with a pluggable model and no API credentials", async () => {
    const { filePath } = await fixture();
    const { stdout } = await execFileAsync(
      "bun",
      [
        "dist/workbench/workbench-bin.js",
        "agent",
        "--model-module",
        filePath,
        "--prompt",
        "tools",
        "--model",
        "fixture",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, OPENAI_API_KEY: "" },
      }
    );
    expect(stdout).toContain("fixture:tools:list");
    expect(stdout).toContain("Pipeline tubeless-agent: starting");
    expect(stdout).toContain("status=completed");
  });
});
