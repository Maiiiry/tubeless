import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqlitePipelineRunStore } from "../run-store/run-store-sqlite.js";
import { decodePipelineTraceEvent } from "../tracing/tracing-codec.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import { runHistory } from "./workbench-history.js";
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

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "tubeless-history-"));
  directories.push(directory);
  return directory;
}

function event(
  name: PipelineTraceEvent["name"],
  overrides: Record<string, unknown> = {}
): PipelineTraceEvent {
  const { payload: payloadOverrides, ...fields } = overrides;
  const payloads: Partial<Record<PipelineTraceEvent["name"], Record<string, unknown>>> = {
    "pipeline.completed": {
      dryRun: false,
      errorCount: 0,
      finalized: false,
      status: "completed",
      stepCount: 0,
    },
    "pipeline.log": { level: "log", message: "" },
    "pipeline.started": { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
    "step.failed": { status: "failed" },
    "step.planned": {
      dependencies: [],
      dryRun: "run",
      optionalDependencies: [],
      runtimeSkipPossible: false,
      selected: true,
      selectionReasons: [],
      skipAfterFailureOf: [],
    },
    "step.running": {},
  };
  return decodePipelineTraceEvent({
    name,
    payload: { ...payloads[name], ...(payloadOverrides as object | undefined) },
    pipelineId: "import",
    runId: "run-failed",
    timestampMs: 1_700_000_000_000,
    version: 2,
    ...fields,
  });
}

async function seedStore(filename: string, events: readonly PipelineTraceEvent[]): Promise<void> {
  const store = await openSqlitePipelineRunStore(filename);
  for (const next of events) {
    await store.export(next);
  }
  await store.flush?.();
  await store.close();
}

const failedRunEvents: PipelineTraceEvent[] = [
  event("pipeline.started", {
    timestampMs: 1_700_000_000_000,
  }),
  event("step.planned", {
    payload: {
      description: "Load source rows.",
      name: "Load rows",
    },
    stepId: "load",
    timestampMs: 1_700_000_000_001,
  }),
  event("step.running", {
    attemptId: "attempt-1",
    stepId: "load",
    timestampMs: 1_700_000_000_002,
  }),
  event("pipeline.log", {
    attemptId: "attempt-1",
    payload: { level: "warn", message: "source slowed" },
    stepId: "load",
    timestampMs: 1_700_000_000_003,
  }),
  event("step.failed", {
    attemptId: "attempt-1",
    durationMs: 4,
    error: {
      code: "TUBELESS_STEP_FAILED",
      kind: "step",
      message: "source unavailable",
      phase: "execution",
    },
    stepId: "load",
    timestampMs: 1_700_000_000_004,
  }),
  event("pipeline.completed", {
    payload: { errorCount: 1, status: "failed" },
    durationMs: 7,
    error: {
      code: "TUBELESS_STEP_FAILED",
      kind: "step",
      message: "source unavailable",
      phase: "execution",
    },
    timestampMs: 1_700_000_000_007,
  }),
];

const secondRunEvents: PipelineTraceEvent[] = [
  event("pipeline.started", {
    pipelineId: "publish",
    runId: "run-ok",
    timestampMs: 1_700_000_000_100,
  }),
  event("pipeline.completed", {
    durationMs: 3,
    pipelineId: "publish",
    runId: "run-ok",
    timestampMs: 1_700_000_000_103,
  }),
];

describe("runHistory", () => {
  it.each(["--store", "--trace"])("filters recorded pipeline IDs with %s", async (source) => {
    const directory = await tempDir();
    const filename = path.join(directory, source === "--store" ? "runs.sqlite" : "runs.ndjson");
    const events = [...failedRunEvents, ...secondRunEvents];
    if (source === "--store") await seedStore(filename, events);
    else await writeFile(filename, `${events.map((next) => JSON.stringify(next)).join("\n")}\n`);
    // A project must not resolve pipeline IDs or load modules during history reads.
    await writeFile(path.join(directory, "tubeless.project.ts"), 'throw new Error("do not load");');

    for (const mode of [[], ["--json"], ["--events"]]) {
      const args = [source, filename, "--pipeline", "import", ...mode];
      const listIo = captureIo(directory);
      expect(await runHistory(args, listIo)).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
      expect(listIo.errors).toEqual([]);
      expect(listIo.output.join("")).toContain("run-failed");
      expect(listIo.output.join("")).not.toContain("run-ok");
      if (mode.includes("--events")) {
        const recorded = listIo.output
          .join("")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(recorded).toHaveLength(failedRunEvents.length);
        expect(recorded.every((next) => next.pipelineId === "import")).toBe(true);
      }

      const detailIo = captureIo(directory);
      expect(await runHistory([...args, "run-failed"], detailIo)).toBe(
        TUBELESS_WORKBENCH_EXIT_CODE.success
      );
      expect(detailIo.output.join("")).toContain("source slowed");
      const mismatchIo = captureIo(directory);
      expect(await runHistory([...args, "run-ok"], mismatchIo)).toBe(
        TUBELESS_WORKBENCH_EXIT_CODE.usage
      );
      expect(mismatchIo.output).toEqual([]);
      expect(mismatchIo.errors.join("")).toContain('Unknown run "run-ok".');

      for (const pipelineId of ["missing", "import-rows"]) {
        const emptyIo = captureIo(directory);
        expect(
          await runHistory([source, filename, "--pipeline", pipelineId, ...mode], emptyIo)
        ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
        expect(emptyIo.errors).toEqual([]);
        if (mode.includes("--json"))
          expect(JSON.parse(emptyIo.output.join(""))).toEqual({ runs: [] });
        else expect(emptyIo.output).toEqual([]);
      }
    }
  });

  it("requires a pipeline selector value and documents its identity", async () => {
    const io = captureIo(await tempDir());
    expect(await runHistory(["--pipeline"], io)).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    const helpIo = captureIo(io.cwd);
    expect(await runHistory(["--help"], helpIo)).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(helpIo.output.join("")).toContain("--pipeline <id>");
    expect(helpIo.output.join("")).toContain("Filter by recorded pipeline ID");
  });

  it("lists one aligned line per recorded run", async () => {
    const directory = await tempDir();
    const storePath = path.join(directory, "runs.sqlite");
    await seedStore(storePath, [...failedRunEvents, ...secondRunEvents]);
    const io = captureIo(directory);

    const exitCode = await runHistory(["--store", storePath], io);

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(io.errors).toEqual([]);
    expect(io.output.join("")).toBe(
      [
        "run-ok      publish  completed  started 2023-11-14T22:13:20.100Z  3ms",
        "run-failed  import   failed     started 2023-11-14T22:13:20.000Z  7ms",
        "",
      ].join("\n")
    );
  });

  it("shows artifact identity and preview status in terminal and JSON history", async () => {
    const cwd = await tempDir();
    const filename = path.join(cwd, "artifacts.ndjson");
    const artifactEvent = event("step.artifact", {
      stepId: "load",
      attemptId: "attempt-1",
      payload: {
        operation: "read",
        preview: true,
        artifact: { id: "dataset", uri: "app:source", version: "revision-1" },
      },
    });
    await writeFile(
      filename,
      [...failedRunEvents, artifactEvent].map((entry) => JSON.stringify(entry)).join("\n")
    );
    const io = captureIo(cwd);
    expect(await runHistory(["--trace", filename, "run-failed"], io)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(io.output.join("")).toContain('preview read  {"');
    expect(io.output.join("")).toContain('"id":"dataset"');
    const json = captureIo(cwd);
    expect(await runHistory(["--trace", filename, "--json", "run-failed"], json)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(JSON.parse(json.output.join("")).steps[0].artifacts).toMatchObject([
      {
        operation: "read",
        preview: true,
        artifact: { id: "dataset", version: "revision-1" },
        attemptId: "attempt-1",
      },
    ]);
  });

  it("labels cache artifact operations in history", async () => {
    const cwd = await tempDir();
    const filename = path.join(cwd, "cache.ndjson");
    await writeFile(
      filename,
      [
        ...failedRunEvents,
        event("step.artifact", {
          stepId: "load",
          attemptId: "attempt-1",
          payload: {
            operation: "reuse",
            preview: false,
            artifact: {
              id: "cache-entry",
              metadata: {
                tubelessCache: { implementationVersion: "v1", createdAtMs: 1000, ageMs: 500 },
              },
            },
          },
        }),
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n")
    );
    const io = captureIo(cwd);
    expect(await runHistory(["--trace", filename, "run-failed"], io)).toBe(0);
    expect(io.output.join("")).toContain("Cached output reuse");
  });

  it("shows steps, logs, and error sections for a run id", async () => {
    const directory = await tempDir();
    const storePath = path.join(directory, "runs.sqlite");
    await seedStore(storePath, failedRunEvents);
    const io = captureIo(directory);

    const exitCode = await runHistory(["--store", storePath, "run-failed"], io);

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    const rendered = io.output.join("");
    expect(rendered).toContain("Run run-failed");
    expect(rendered).toContain("Pipeline import");
    expect(rendered).toContain("Status failed");
    expect(rendered).toContain("Steps:");
    expect(rendered).toContain("  load  failed  4ms");
    expect(rendered).toContain("Logs:");
    expect(rendered).toContain("  [warn] source slowed");
    expect(rendered).toContain("Error:");
    expect(rendered).toContain("  TUBELESS_STEP_FAILED  source unavailable");
  });

  it("projects a finished NDJSON trace without importing it", async () => {
    const directory = await tempDir();
    const tracePath = path.join(directory, "run.ndjson");
    const portableEvents = failedRunEvents.map((next) =>
      next.name === "pipeline.log"
        ? { ...next, payload: { ...next.payload, message: "source\u001b[31m slowed" } }
        : next
    );
    await writeFile(
      tracePath,
      `${portableEvents.map((next) => JSON.stringify(next)).join("\n")}\n`
    );
    const io = captureIo(directory);

    const exitCode = await runHistory(["--trace", tracePath, "run-failed"], io);

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(io.errors).toEqual([]);
    expect(io.output.join("")).toContain("Run run-failed");
    expect(io.output.join("")).toContain("source unavailable");
    expect(io.output.join("")).not.toContain("\u001b");
  });

  it("requires --yes before clearing recorded history", async () => {
    const directory = await tempDir();
    const storePath = path.join(directory, "runs.sqlite");
    await seedStore(storePath, failedRunEvents);
    const io = captureIo(directory);

    expect(await runHistory(["--clear", "--store", storePath], io)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.usage
    );
    expect(io.errors.join("")).toContain("--clear requires --yes");

    const listIo = captureIo(directory);
    expect(await runHistory(["--store", storePath], listIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(listIo.output.join("")).toContain("failed");
  });

  it("rejects --clear combined with --trace, --json, --events, or a run id", async () => {
    const directory = await tempDir();
    const storePath = path.join(directory, "runs.sqlite");
    await seedStore(storePath, failedRunEvents);
    const tracePath = path.join(directory, "run.ndjson");
    await writeFile(tracePath, "");

    const traceIo = captureIo(directory);
    expect(await runHistory(["--clear", "--yes", "--trace", tracePath], traceIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.usage
    );
    expect(traceIo.errors.join("")).toContain("--clear requires --store, not --trace.");

    const jsonIo = captureIo(directory);
    expect(await runHistory(["--clear", "--yes", "--store", storePath, "--json"], jsonIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.usage
    );
    expect(jsonIo.errors.join("")).toContain("--clear cannot combine with --json or --events.");

    const runIdIo = captureIo(directory);
    expect(
      await runHistory(["--clear", "--yes", "--store", storePath, "run-failed"], runIdIo)
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    expect(runIdIo.errors.join("")).toContain("--clear does not take a run id.");
  });

  it("clears all recorded history from a SQLite store with --yes", async () => {
    const directory = await tempDir();
    const storePath = path.join(directory, "runs.sqlite");
    await seedStore(storePath, failedRunEvents);
    const clearIo = captureIo(directory);

    expect(await runHistory(["--clear", "--yes", "--store", storePath], clearIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(clearIo.output.join("")).toContain("Cleared all recorded history");

    const listIo = captureIo(directory);
    expect(await runHistory(["--store", storePath], listIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(listIo.output.join("")).toBe("");
  });

  it("rejects conflicting artifact sources and malformed traces", async () => {
    const directory = await tempDir();
    const tracePath = path.join(directory, "run.ndjson");
    await writeFile(tracePath, '{"secret":"not-an-event"}\n');
    const conflictIo = captureIo(directory);
    const malformedIo = captureIo(directory);

    expect(await runHistory(["--store", "runs.sqlite", "--trace", tracePath], conflictIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.usage
    );
    expect(conflictIo.errors.join("")).toContain("Use --store or --trace, not both.");
    expect(await runHistory(["--trace", tracePath], malformedIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.load
    );
    expect(malformedIo.errors.join("")).toContain("line 1 is invalid");
    expect(malformedIo.errors.join("")).not.toContain("not-an-event");
  });

  it("emits parseable JSON without ANSI", async () => {
    const directory = await tempDir();
    const storePath = path.join(directory, "runs.sqlite");
    await seedStore(storePath, [...failedRunEvents, ...secondRunEvents]);
    const listIo = captureIo(directory);
    const showIo = captureIo(directory);

    expect(await runHistory(["--store", storePath, "--json"], listIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(await runHistory(["--store", storePath, "--json", "run-failed"], showIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );

    const listText = listIo.output.join("");
    const showText = showIo.output.join("");
    expect(listText).not.toMatch(/\u001B\[/);
    expect(showText).not.toMatch(/\u001B\[/);
    expect(JSON.parse(listText)).toEqual({
      runs: [
        {
          durationMs: 3,
          pipelineId: "publish",
          runId: "run-ok",
          startedAtMs: 1_700_000_000_100,
          status: "completed",
        },
        {
          durationMs: 7,
          pipelineId: "import",
          runId: "run-failed",
          startedAtMs: 1_700_000_000_000,
          status: "failed",
        },
      ],
    });
    expect(JSON.parse(showText)).toMatchObject({
      error: {
        code: "TUBELESS_STEP_FAILED",
        message: "source unavailable",
      },
      logs: [expect.objectContaining({ level: "warn", message: "source slowed" })],
      pipelineId: "import",
      runId: "run-failed",
      status: "failed",
      steps: [expect.objectContaining({ id: "load", status: "failed" })],
    });
  });

  it("reports a missing store path as a load error", async () => {
    const directory = await tempDir();
    const storePath = path.join(directory, "missing.sqlite");
    const io = captureIo(directory);

    const exitCode = await runHistory(["--store", storePath], io);

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.load);
    expect(io.errors.join("")).toBe(`Error: Run store not found at ${storePath}\n`);
  });

  it("explains how to record runs when the default store is missing", async () => {
    const directory = await tempDir();
    const io = captureIo(directory);

    expect(await runHistory([], io)).toBe(TUBELESS_WORKBENCH_EXIT_CODE.load);
    expect(io.errors.join("")).toBe(
      `Error: Run store not found at ${path.join(directory, ".tubeless", "runs.sqlite")}\n` +
        "Record runs with: tubeless run --store .tubeless/runs.sqlite <pipeline> [-- <args>]\n"
    );
  });

  it("reports an unknown run id with a listing hint instead of usage", async () => {
    const directory = await tempDir();
    const storePath = path.join(directory, "runs.sqlite");
    await seedStore(storePath, failedRunEvents);
    const io = captureIo(directory);

    const exitCode = await runHistory(["--store", storePath, "missing-run"], io);

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    expect(io.errors.join("")).toBe(
      'Error: Unknown run "missing-run".\n' +
        `Run "tubeless history --store ${storePath}" to list recorded runs.\n`
    );
  });

  it("omits the Logs section when a run recorded no logs", async () => {
    const directory = await tempDir();
    const storePath = path.join(directory, "runs.sqlite");
    await seedStore(storePath, secondRunEvents);
    const io = captureIo(directory);

    expect(await runHistory(["--store", storePath, "run-ok"], io)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(io.output.join("")).toContain("Run run-ok");
    expect(io.output.join("")).not.toContain("Logs:");
  });

  describe("run id prefixes", () => {
    const firstImport = "import:2dc3469d-9e02-4448-bb36-c42d7f59562d";
    const secondImport = "import:2dc3f00d-1111-4222-8333-944444444444";
    const publish = "publish:9f1e0c2a-5555-4666-8777-988888888888";

    function completedRun(pipelineId: string, runId: string, timestampMs: number) {
      return [
        event("pipeline.started", { pipelineId, runId, timestampMs }),
        event("pipeline.completed", {
          durationMs: 1,
          pipelineId,
          runId,
          timestampMs: timestampMs + 1,
        }),
      ];
    }

    async function prefixStore(): Promise<{ directory: string; storePath: string }> {
      const directory = await tempDir();
      const storePath = path.join(directory, "runs.sqlite");
      await seedStore(storePath, [
        ...completedRun("import", firstImport, 1_700_000_000_000),
        ...completedRun("import", secondImport, 1_700_000_000_100),
        ...completedRun("publish", publish, 1_700_000_000_200),
      ]);
      return { directory, storePath };
    }

    it("resolves a unique UUID or full-id prefix in text, JSON, and events modes", async () => {
      const { directory, storePath } = await prefixStore();
      for (const [input, runId] of [
        ["2dc34", firstImport],
        ["import:2dc3f", secondImport],
        ["9f1e", publish],
      ] as const) {
        const textIo = captureIo(directory);
        expect(await runHistory(["--store", storePath, input], textIo)).toBe(
          TUBELESS_WORKBENCH_EXIT_CODE.success
        );
        expect(textIo.errors).toEqual([]);
        expect(textIo.output.join("")).toContain(`Run ${runId}\n`);

        const jsonIo = captureIo(directory);
        expect(await runHistory(["--store", storePath, "--json", input], jsonIo)).toBe(
          TUBELESS_WORKBENCH_EXIT_CODE.success
        );
        expect(JSON.parse(jsonIo.output.join(""))).toMatchObject({ runId });

        const eventsIo = captureIo(directory);
        expect(await runHistory(["--store", storePath, "--events", input], eventsIo)).toBe(
          TUBELESS_WORKBENCH_EXIT_CODE.success
        );
        const events = eventsIo.output
          .join("")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(events).toHaveLength(2);
        expect(events.every((next) => next.runId === runId)).toBe(true);
      }
    });

    it("lists candidates for an ambiguous prefix in every mode", async () => {
      const { directory, storePath } = await prefixStore();
      for (const mode of [[], ["--json"], ["--events"]]) {
        const io = captureIo(directory);
        expect(await runHistory(["--store", storePath, ...mode, "2dc3"], io)).toBe(
          TUBELESS_WORKBENCH_EXIT_CODE.usage
        );
        expect(io.output).toEqual([]);
        expect(io.errors.join("")).toBe(
          'Error: Run id "2dc3" is ambiguous; it matches 2 runs:\n' +
            `  ${secondImport}\n  ${firstImport}\n`
        );
      }
    });

    it("caps ambiguous candidates at five", async () => {
      const directory = await tempDir();
      const storePath = path.join(directory, "runs.sqlite");
      await seedStore(
        storePath,
        Array.from({ length: 7 }, (_, index) =>
          completedRun(
            "batch",
            `batch:${index}0000000-0000-4000-8000-000000000000`,
            1_700_000_000_000 + index * 10
          )
        ).flat()
      );
      const io = captureIo(directory);

      expect(await runHistory(["--store", storePath, "batch"], io)).toBe(
        TUBELESS_WORKBENCH_EXIT_CODE.usage
      );
      const lines = io.errors.join("").trimEnd().split("\n");
      expect(lines[0]).toBe('Error: Run id "batch" is ambiguous; it matches 7 runs:');
      expect(lines.slice(1, -1)).toHaveLength(5);
      expect(lines.at(-1)).toBe("  …and 2 more");
    });

    it("matches prefixes only within the --pipeline filter", async () => {
      const { directory, storePath } = await prefixStore();
      const scopedIo = captureIo(directory);
      expect(
        await runHistory(["--store", storePath, "--pipeline", "import", "2dc3f"], scopedIo)
      ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
      expect(scopedIo.output.join("")).toContain(`Run ${secondImport}\n`);

      const filteredIo = captureIo(directory);
      expect(
        await runHistory(["--store", storePath, "--pipeline", "publish", "2dc34"], filteredIo)
      ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
      expect(filteredIo.errors.join("")).toBe(
        'Error: Unknown run "2dc34".\n' +
          `Run "tubeless history --store ${storePath} --pipeline publish" to list recorded runs.\n`
      );
    });

    it("suggests close run ids but never resolves fragments under four characters", async () => {
      const { directory, storePath } = await prefixStore();
      const shortIo = captureIo(directory);
      expect(await runHistory(["--store", storePath, "9f1"], shortIo)).toBe(
        TUBELESS_WORKBENCH_EXIT_CODE.usage
      );
      expect(shortIo.errors.join("")).toContain(
        `Error: Unknown run "9f1". Did you mean ${JSON.stringify(publish)}?\n`
      );

      const typoIo = captureIo(directory);
      const typo = publish.replace("publish", "pubilsh");
      expect(await runHistory(["--store", storePath, typo], typoIo)).toBe(
        TUBELESS_WORKBENCH_EXIT_CODE.usage
      );
      expect(typoIo.errors.join("")).toContain(`Did you mean ${JSON.stringify(publish)}?`);

      const farIo = captureIo(directory);
      expect(await runHistory(["--store", storePath, "zzzzzzzz"], farIo)).toBe(
        TUBELESS_WORKBENCH_EXIT_CODE.usage
      );
      expect(farIo.errors.join("")).not.toContain("Did you mean");
      expect(farIo.errors.join("")).not.toContain("Usage:");
    });
  });
});
