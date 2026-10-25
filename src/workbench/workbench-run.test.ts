import { getEventListeners } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "./workbench-run.js";
import { TUBELESS_WORKBENCH_EXIT_CODE, type WorkbenchCliIo } from "./workbench-shared.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

function captureIo(cwd: string): WorkbenchCliIo & { errors: string[]; output: string[] } {
  const errors: string[] = [];
  const output: string[] = [];
  return {
    cwd,
    errors,
    output,
    stderr: {
      write: (chunk) => {
        errors.push(chunk);
      },
    },
    stdout: {
      write: (chunk) => {
        output.push(chunk);
      },
    },
  };
}

async function writeCommandFixture(
  reporterSource = "false"
): Promise<{ directory: string; filePath: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-"));
  directories.push(directory);
  const filePath = path.join(directory, "pipeline.mjs");
  const cliModuleUrl = pathToFileURL(path.resolve("dist/cli/cli.js")).href;
  const pipelineModuleUrl = pathToFileURL(path.resolve("dist/core/pipeline.js")).href;
  await writeFile(
    filePath,
    `
      import { definePipelineCommand } from ${JSON.stringify(cliModuleUrl)};
      import { createSteps, definePipeline, requireOutputs } from ${JSON.stringify(pipelineModuleUrl)};
      const { step } = createSteps();
      const work = step("work", {
        run: (_inputs, context) => {
          context.log.log(\`worked:\${context.options.message}\`);
          if (context.options.fail) throw new Error("intentional command failure");
          return context.options.message;
        },
      });
      export const FixtureCommand = definePipelineCommand(
        definePipeline({
          id: "command-fixture",
          steps: [work],
          targets: [work],
          finalize: requireOutputs([work], ({ work }) => work),
        }),
        {
          params: {
            message: { type: "string", description: "Message to process." },
            fail: { type: "boolean", default: false },
          },
          reporter: ${reporterSource},
          summarize: (result) => [\`completed:\${result}\`],
        }
      );
    `
  );
  return { directory, filePath };
}

function parseNdjson(text: string): { name?: string }[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { name?: string });
}

describe("runCommand", () => {
  it("suggests workbench flag typos while preserving the application-argument guidance", async () => {
    for (const token of ["--projet", "--projet=project.mjs"]) {
      const io = captureIo(tmpdir());
      expect(await runCommand([token, "pipeline.mjs"], io)).toBe(
        TUBELESS_WORKBENCH_EXIT_CODE.usage
      );
      const error = io.errors.join("");
      expect(error.split("\n")[0]).toBe("Error: Unknown option: --projet. Did you mean --project?");
      expect(error).toContain("Pass application flags after --");
      expect(io.output).toEqual([]);
    }
  });

  it("rejects --store and --trace pointing at the same path", async () => {
    const { directory } = await writeCommandFixture();
    const io = captureIo(directory);
    const sharedPath = path.join(directory, "shared.sqlite");

    const exitCode = await runCommand(
      ["--store", sharedPath, "--trace", sharedPath, "pipeline.mjs", "--", "--message", "hello"],
      io
    );

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    expect(io.errors.join("")).toContain(
      "Error: --store and --trace cannot write to the same path."
    );
    expect(io.errors.join("")).toContain("Usage: tubeless run [options] <pipeline-id-or-file>");
  });

  it("writes NDJSON to stdout for --trace - and moves command output to stderr", async () => {
    const { directory } = await writeCommandFixture();
    const io = captureIo(directory);

    const exitCode = await runCommand(
      ["--trace", "-", "pipeline.mjs", "--", "--message", "hello"],
      io
    );

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(io.errors.join("")).toContain("worked:hello");
    expect(io.errors.join("")).toContain("completed:hello");
    const stdout = io.output.join("");
    expect(stdout).not.toContain("completed:hello");
    const lines = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(lines.every((line) => line.startsWith("{"))).toBe(true);
    const events = parseNdjson(stdout);
    expect(events).toHaveLength(lines.length);
    expect(events.map(({ name }) => name)).toContain("pipeline.started");
    expect(events.map(({ name }) => name)).toContain("pipeline.completed");
  });

  it("keeps an interactive reporter off stdout for --trace -", async () => {
    const { directory } = await writeCommandFixture(
      '{ mode: "interactive", color: "never", symbols: "ascii" }'
    );
    const io = captureIo(directory);
    const processStdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);

    try {
      const exitCode = await runCommand(
        ["--trace", "-", "pipeline.mjs", "--", "--message", "hello"],
        io
      );

      expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
      expect(processStdoutWrite).not.toHaveBeenCalled();
      const stdout = io.output.join("");
      expect(() => parseNdjson(stdout)).not.toThrow();
      expect(parseNdjson(stdout).at(-1)?.name).toBe("pipeline.completed");
      expect(stdout).not.toContain("\u001B[");
      expect(io.errors.join("")).toContain("Pipeline command-fixture");
      expect(io.errors.join("")).toContain("completed:hello");
    } finally {
      processStdoutWrite.mockRestore();
    }
  });

  it("maps validation and pipeline failures to workbench exit codes", async () => {
    const { directory } = await writeCommandFixture();
    const validationIo = captureIo(directory);
    const executionIo = captureIo(directory);

    const validationExit = await runCommand(["pipeline.mjs"], validationIo);
    const executionExit = await runCommand(
      ["pipeline.mjs", "--", "--message", "hello", "--fail"],
      executionIo
    );

    expect(validationExit).toBe(TUBELESS_WORKBENCH_EXIT_CODE.validation);
    expect(validationIo.errors.join("")).toContain("Missing required option --message");
    expect(executionExit).toBe(TUBELESS_WORKBENCH_EXIT_CODE.execution);
    expect(executionIo.errors.join("")).toContain("intentional command failure");
  });

  it("closes the --trace file on a complete final NDJSON line", async () => {
    const { directory } = await writeCommandFixture();
    const io = captureIo(directory);
    const tracePath = path.join(directory, "traces", "run.ndjson");

    const exitCode = await runCommand(
      ["--trace", tracePath, "pipeline.mjs", "--", "--message", "hello"],
      io
    );

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    const text = await readFile(tracePath, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const events = parseNdjson(text);
    expect(events.at(-1)?.name).toBe("pipeline.completed");
    expect(events.every((event) => typeof event.name === "string")).toBe(true);
  });

  it("leaves no abort listeners on a signal shared across runs", async () => {
    const { directory } = await writeCommandFixture();
    const controller = new AbortController();
    for (let run = 0; run < 2; run += 1) {
      const io = { ...captureIo(directory), signal: controller.signal };
      const tracePath = path.join(directory, `run-${run}.ndjson`);

      const exitCode = await runCommand(
        ["--trace", tracePath, "pipeline.mjs", "--", "--message", "hello"],
        io
      );

      expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      const events = parseNdjson(await readFile(tracePath, "utf8"));
      expect(events.at(-1)?.name).toBe("pipeline.completed");
    }
  });
});
