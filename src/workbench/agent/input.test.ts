import { PassThrough, Readable } from "node:stream";
import { setImmediate as nextTick } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { safeTerminalLog } from "../../reporter/terminal-text.js";
import { AgentInput } from "./input.js";
import { captureIo } from "../workbench.test-support.js";

afterEach(() => vi.unstubAllEnvs());

function interactiveInput(onInterrupt = () => {}) {
  vi.stubEnv("TERM", "xterm-256color");
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
  const io = captureIo("/tmp");
  const input = new AgentInput(
    { ...io, stdin, stdout: { ...io.stdout, isTTY: true, columns: 80 } },
    onInterrupt
  );
  return { input, stdin, io };
}

async function typeKeys(stdin: PassThrough, keys: string): Promise<void> {
  for (const key of keys) {
    stdin.write(key);
    await nextTick();
  }
}

describe("interactive agent input", () => {
  it("mutes and discards typeahead while running, then restores input and Ctrl-C", async () => {
    const interrupt = vi.fn();
    const { input, stdin, io } = interactiveInput(interrupt);
    const prompts = input[Symbol.asyncIterator]();
    try {
      const first = prompts.next();
      stdin.write("first\n");
      expect(await first).toMatchObject({ value: "first", done: false });
      input.setRunning(true);
      const before = io.output.length;
      stdin.write("discarded\n/\t\tunfinished");
      await nextTick();
      stdin.write("\u0003");
      expect(interrupt).toHaveBeenCalledOnce();
      input.setRunning(false);
      expect(io.output.length).toBe(before);
      const next = prompts.next();
      stdin.write("second\n");
      expect(await next).toMatchObject({ value: "second", done: false });
      expect(io.output.join("")).not.toContain("discarded");
      expect(safeTerminalLog(io.output.join(""))).toContain("◯╱◯ ❯ ");
      stdin.write("\u0003");
      expect(interrupt).toHaveBeenCalledTimes(2);
    } finally {
      input.close();
      stdin.destroy();
    }
  });

  it.each([
    ["/mo\tfixture-model\n", "/model fixture-model"],
    ["/he\t\n", "/help"],
    ["/cl\t\n", "/clear"],
    ["/qu\t\n", "/quit"],
    ["/ex\t\n", "/exit"],
    ["/unknown\t\n", "/unknown"],
    ["explain /mo\t later\n", "explain /mo later"],
    ["/model fixture\t-extra\n", "/model fixture-extra"],
  ])(
    "completes command prefixes while leaving task text and arguments alone: %j",
    async (keys, expected) => {
      const { input, stdin } = interactiveInput();
      try {
        const answer = input[Symbol.asyncIterator]().next();
        await typeKeys(stdin, keys);
        expect(await answer).toMatchObject({ value: expected, done: false });
      } finally {
        input.close();
        stdin.destroy();
      }
    }
  );

  it("lists slash commands on double Tab and keeps the current question editable", async () => {
    const { input, stdin, io } = interactiveInput();
    try {
      const answer = input[Symbol.asyncIterator]().next();
      await typeKeys(stdin, "/\t\t");
      const output = safeTerminalLog(io.output.join(""));
      for (const command of ["/model", "/clear", "/help", "/quit", "/exit"])
        expect(output).toContain(command);
      expect(output).toContain("◯╱◯ ❯ /");
      await typeKeys(stdin, "he\t\n");
      expect(await answer).toMatchObject({ value: "/help", done: false });
    } finally {
      input.close();
      stdin.destroy();
    }
  });

  it("keeps the bike prompt when NO_COLOR disables its accents", async () => {
    vi.stubEnv("NO_COLOR", "1");
    vi.stubEnv("FORCE_COLOR", undefined);
    const { input, stdin, io } = interactiveInput();
    try {
      const answer = input[Symbol.asyncIterator]().next();
      expect(io.output.join("")).toContain("◯╱◯ ❯ ");
      expect(io.output.join("")).not.toContain("\u001b[36m");
      expect(io.output.join("")).not.toContain("\u001b[1;36m");
      stdin.write("hello\n");
      expect(await answer).toMatchObject({ value: "hello" });
    } finally {
      input.close();
      stdin.destroy();
    }
  });

  it("applies backpressure while a piped task is being processed", async () => {
    let produced = 0;
    const stdin = Readable.from(
      (function* () {
        for (let index = 0; index < 10_000; index++) {
          produced++;
          yield `task ${index}\n`;
        }
      })()
    );
    const input = new AgentInput({ ...captureIo("/tmp"), stdin }, () => {});
    const prompts = input[Symbol.asyncIterator]();
    try {
      expect(await prompts.next()).toMatchObject({ value: "task 0" });
      await nextTick();
      expect(produced).toBeLessThan(10_000);
      expect(await prompts.next()).toMatchObject({ value: "task 1" });
    } finally {
      input.close();
      await prompts.return?.();
      stdin.destroy();
    }
  });

  it("releases an unanswered interactive question when closed", async () => {
    const { input, stdin } = interactiveInput();
    const pending = input[Symbol.asyncIterator]().next();
    input.close();
    expect(await pending).toMatchObject({ done: true });
    stdin.destroy();
  });
});
