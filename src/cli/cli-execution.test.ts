import { afterEach, describe, expect, it, vi } from "vitest";
import { CliHelpRequested, CliValidationError, defineCommand } from "./cli.js";
import { testLog } from "./cli.test-support.js";

describe("defineCommand.run", () => {
  it("parses and calls run, returning its result", async () => {
    const command = defineCommand({
      params: { limit: { type: "number", default: 5 } },
      run: (values) => values.limit * 2,
    });
    await expect(command.run(["--limit", "10"])).resolves.toBe(20);
  });

  it("throws CliValidationError instead of calling run on bad args", async () => {
    const run = vi.fn();
    const command = defineCommand({ params: { limit: { type: "number" } }, run });
    await expect(command.run(["--limit", "abc"])).rejects.toBeInstanceOf(CliValidationError);
    expect(run).not.toHaveBeenCalled();
  });

  it("throws CliHelpRequested instead of calling run on --help", async () => {
    const run = vi.fn();
    const command = defineCommand({ params: {}, run });
    await expect(command.run(["--help"])).rejects.toBeInstanceOf(CliHelpRequested);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("defineCommand.main", () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it("runs the command and leaves the exit code untouched on success", async () => {
    process.exitCode = undefined;
    const command = defineCommand({
      params: { limit: { type: "number", default: 5 } },
      run: vi.fn(),
    });
    await command.main(["--limit", "10"]);
    expect(process.exitCode).toBeUndefined();
  });

  it("prints errors, the usage line, and a --help pointer, and sets exit code 1", async () => {
    const log = testLog();
    const command = defineCommand({
      name: "toy",
      params: { limit: { type: "number", description: "Rows to read." } },
      run: vi.fn(),
    });
    await command.main(["--limit", "abc"], { log });
    expect(process.exitCode).toBe(1);
    expect(log.lines.filter((l) => l.level === "error").map((l) => l.message)).toEqual([
      'Error: --limit must be a number, got "abc"',
      "",
      "Usage: toy [options]",
      "Run with --help to see all options.",
    ]);
  });

  it("prints help and sets exit code 0 on --help", async () => {
    const log = testLog();
    const command = defineCommand({ params: {}, run: vi.fn() });
    await command.main(["--help"], { log });
    expect(process.exitCode).toBe(0);
    expect(log.lines.some((l) => l.message.includes("Usage:"))).toBe(true);
  });

  it("catches a thrown error from run and sets exit code 1", async () => {
    const log = testLog();
    const command = defineCommand({
      params: {},
      run: () => {
        throw new Error("boom");
      },
    });
    await command.main([], { log });
    expect(process.exitCode).toBe(1);
    expect(log.lines.some((l) => l.level === "error" && l.message.includes("boom"))).toBe(true);
  });
});
