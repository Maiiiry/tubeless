import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { loadPlanSourceModule, selectUniqueExport } from "./pipeline-module.js";
import { TUBELESS_WORKBENCH_EXIT_CODE, runWorkbenchCli } from "./workbench.js";
import {
  captureIo,
  writeActualPipelineCommandModule,
  writeActualPipelineModule,
  writeModule,
} from "./workbench.test-support.js";

describe("workbench module loading and help", () => {
  it("selects a named export and deduplicates aliases", async () => {
    const { directory } = await writeModule(`
      const steps = [];
      const pipeline = (id) => ({
        id,
        stepIds: [],
        targetIds: [],
        plan: () => ({ dryRun: false, errors: [], ok: true, pipelineId: id, steps }),
        run: async () => ({ status: "completed" }),
        runOrThrow: async () => undefined,
        toMermaid: () => \`flowchart TD\\n  node["\${id}"]\`,
      });
      export const FirstPipeline = pipeline("first");
      export const SecondPipeline = pipeline("second");
    `);
    const ambiguousIo = captureIo(directory);
    const io = captureIo(directory);

    const ambiguousExitCode = await runWorkbenchCli(["inspect", "pipeline.mjs"], ambiguousIo);
    const exitCode = await runWorkbenchCli(
      ["inspect", "pipeline.mjs", "--export", "SecondPipeline"],
      io
    );

    expect(ambiguousExitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.load);
    expect(ambiguousIo.errors.join("")).toContain(
      "Module exports multiple pipelines (FirstPipeline, SecondPipeline); pass --export <name>."
    );
    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(io.output.join("")).toContain("Pipeline second");

    const fixture = await writeActualPipelineModule();
    const { filePath } = await writeModule(`
      export { PlanningPipeline, PlanningPipeline as default } from ${JSON.stringify(pathToFileURL(fixture.filePath).href)};
    `);
    await expect(loadPlanSourceModule(filePath)).resolves.toMatchObject({
      kind: "pipeline",
      pipeline: { id: "planning-fixture" },
    });
  });

  it("selects a unique export with its name", () => {
    const isNumber = (value: unknown): value is number => typeof value === "number";
    expect(
      selectUniqueExport({ only: 7, alias: 7, other: "x" }, undefined, isNumber, "number")
    ).toEqual({ exportName: "only", value: 7 });
    expect(selectUniqueExport({ First: 1, Second: 2 }, "Second", isNumber, "number")).toEqual({
      exportName: "Second",
      value: 2,
    });
    expect(() =>
      selectUniqueExport({ First: 1, Second: 2 }, undefined, isNumber, "number")
    ).toThrow("Module exports multiple numbers (First, Second); pass --export <name>.");
    expect(() =>
      selectUniqueExport({ First: 1, Second: 2 }, undefined, isNumber, "number", {
        hintExport: false,
      })
    ).toThrow("Module exports multiple numbers (First, Second).");
  });

  it("prefers pipeline commands, deduplicates aliases, and supports explicit selection", async () => {
    const fixture = await writeActualPipelineCommandModule();
    const fixtureUrl = JSON.stringify(pathToFileURL(fixture.filePath).href);
    const cliUrl = JSON.stringify(pathToFileURL(path.resolve("dist/cli/cli.js")).href);
    const aliases = await writeModule(`
      export { FixtureCommand as First, FixtureCommand as default } from ${fixtureUrl};
      import { defineCommand } from ${cliUrl};
      export const Generic = defineCommand({ params: {}, run: () => "not a pipeline" });
    `);
    const multiple = await writeModule(`
      import { CommandPipeline } from ${fixtureUrl};
      import { definePipelineCommand } from ${cliUrl};
      export { FixtureCommand as First } from ${fixtureUrl};
      export const Second = definePipelineCommand(CommandPipeline, { reporter: false });
    `);

    await expect(loadPlanSourceModule(aliases.filePath)).resolves.toMatchObject({
      kind: "command",
      command: { id: "command-fixture" },
    });
    await expect(loadPlanSourceModule(multiple.filePath, "Second")).resolves.toMatchObject({
      kind: "command",
      command: { id: "command-fixture" },
    });
    await expect(loadPlanSourceModule(multiple.filePath)).rejects.toThrow(
      "Module exports multiple pipeline commands (First, Second); pass --export <name>."
    );
    const generic = await writeModule(
      `export { Generic } from ${JSON.stringify(pathToFileURL(aliases.filePath).href)};`
    );
    await expect(loadPlanSourceModule(generic.filePath)).rejects.toThrow(
      "Module does not export a tubeless pipeline or pipeline command."
    );
  });

  it("rejects a marked command that is missing structured launch methods", async () => {
    const markerUrl = pathToFileURL(path.resolve("dist/utilities/pipeline-command-marker.js")).href;
    const { filePath } = await writeModule(`
      import { markPipelineCommand } from ${JSON.stringify(markerUrl)};
      export const Incomplete = markPipelineCommand({
        id: "from-command",
        stepIds: ["work"],
        targetIds: ["work"],
        descriptor: { name: "fixture", parameters: [] },
        plan: () => ({ dryRun: false, errors: [], ok: true, pipelineId: "from-command", steps: [] }),
        parse: () => ({ kind: "values" }),
        run: async () => undefined,
        toMermaid: () => "flowchart TD",
      }, {});
    `);
    await expect(loadPlanSourceModule(filePath)).rejects.toThrow(
      "Module does not export a tubeless pipeline or pipeline command."
    );
  });

  it("runs a uniquely exported schema-backed pipeline without a command wrapper", async () => {
    const pipelineUrl = JSON.stringify(pathToFileURL(path.resolve("dist/core/pipeline.js")).href);
    const { directory } = await writeModule(`
      import { createSteps, definePipeline } from ${pipelineUrl};
      const optionsSchema = {
        "~standard": {
          version: 1,
          vendor: "fixture",
          validate: (value) => ({ value }),
          jsonSchema: { input: () => ({
            type: "object",
            properties: { source: { type: "string" } },
            required: ["source"],
          }) },
        },
      };
      const { step } = createSteps(optionsSchema);
      const work = step("work", {
        run: (_inputs, context) => context.log.log(\`direct:\${context.options.source}\`),
      });
      export const ImportPipeline = definePipeline({ id: "import", steps: [work] });
    `);
    const io = captureIo(directory);

    const exitCode = await runWorkbenchCli(
      ["run", "pipeline.mjs", "--", "--source", "rows.txt"],
      io
    );

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(io.errors).toEqual([]);
    expect(io.output.join("")).toContain("direct:rows.txt");
  });

  it("keeps pipeline ambiguity errors and lets --export select a direct pipeline", async () => {
    const pipelineUrl = JSON.stringify(pathToFileURL(path.resolve("dist/core/pipeline.js")).href);
    const { directory } = await writeModule(`
      import { createSteps, definePipeline } from ${pipelineUrl};
      const optionsSchema = {
        "~standard": {
          version: 1,
          vendor: "fixture",
          validate: (value) => ({ value }),
          jsonSchema: { input: () => ({ type: "object", properties: {} }) },
        },
      };
      const { step } = createSteps(optionsSchema);
      const first = step("first", { run: (_inputs, context) => context.log.log("ran:first") });
      const second = step("second", { run: (_inputs, context) => context.log.log("ran:second") });
      export const FirstPipeline = definePipeline({ id: "first", steps: [first] });
      export const SecondPipeline = definePipeline({ id: "second", steps: [second] });
    `);
    const ambiguousIo = captureIo(directory);
    const selectedIo = captureIo(directory);

    expect(await runWorkbenchCli(["run", "pipeline.mjs"], ambiguousIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.load
    );
    expect(ambiguousIo.errors.join("")).toContain(
      "Module exports multiple pipelines (FirstPipeline, SecondPipeline); pass --export <name>."
    );
    expect(
      await runWorkbenchCli(["run", "--export", "SecondPipeline", "pipeline.mjs"], selectedIo)
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(selectedIo.output.join("")).toContain("ran:second");
    expect(selectedIo.output.join("")).not.toContain("ran:first");
  });

  it("requires an explicit adapter for direct pipelines with unsupported inputs", async () => {
    const schemaLess = await writeActualPipelineModule();
    const schemaLessIo = captureIo(schemaLess.directory);
    expect(await runWorkbenchCli(["run", "pipeline.mjs"], schemaLessIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.load
    );
    expect(schemaLessIo.errors.join("")).toContain(
      'Cannot derive a CLI for directly loaded pipeline "planning-fixture"'
    );
    expect(schemaLessIo.errors.join("")).toContain("Standard JSON Schema input metadata");
    expect(schemaLessIo.errors.join("")).toContain(
      "export a definePipelineCommand with explicit params"
    );

    const pipelineUrl = JSON.stringify(pathToFileURL(path.resolve("dist/core/pipeline.js")).href);
    const unsupported = await writeModule(`
      import { createSteps, definePipeline } from ${pipelineUrl};
      const optionsSchema = {
        "~standard": {
          version: 1,
          vendor: "fixture",
          validate: (value) => ({ value }),
          jsonSchema: { input: () => ({
            type: "object",
            properties: { nested: { type: "object", properties: {} } },
          }) },
        },
      };
      const { step } = createSteps(optionsSchema);
      const work = step("work", { run: () => undefined });
      export const UnsupportedPipeline = definePipeline({ id: "unsupported", steps: [work] });
    `);
    const unsupportedIo = captureIo(unsupported.directory);
    expect(await runWorkbenchCli(["run", "pipeline.mjs"], unsupportedIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.load
    );
    expect(unsupportedIo.errors.join("")).toContain(
      'Cannot derive a CLI for directly loaded pipeline "unsupported"'
    );
    expect(unsupportedIo.errors.join("")).toContain("Supply explicit params");
  });

  it("uses stable usage, load, and definition exit codes", async () => {
    const usageIo = captureIo("/tmp");
    const loadIo = captureIo("/tmp");
    const definitionFixture = await writeModule(`
      const error = new Error("invalid pipeline fixture");
      error.name = "PipelineDefinitionError";
      throw error;
    `);
    const definitionIo = captureIo(definitionFixture.directory);

    expect(await runWorkbenchCli(["unknown"], usageIo)).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    expect(await runWorkbenchCli(["inspect", "missing.mjs"], loadIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.load
    );
    expect(await runWorkbenchCli(["inspect", "pipeline.mjs"], definitionIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.definition
    );
    expect(usageIo.errors.join("")).toContain("Unknown command");
    expect(loadIo.errors.join("")).toContain("missing.mjs");
    expect(definitionIo.errors.join("")).toContain("invalid pipeline fixture");
  });

  it("prints focused top-level and command help", async () => {
    const topLevelIo = captureIo("/tmp");
    const inspectIo = captureIo("/tmp");
    const planIo = captureIo("/tmp");
    const runIo = captureIo("/tmp");
    const historyIo = captureIo("/tmp");
    const uiIo = captureIo("/tmp");

    expect(await runWorkbenchCli(["--help"], topLevelIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(await runWorkbenchCli(["inspect", "--help"], inspectIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(await runWorkbenchCli(["plan", "--help"], planIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(await runWorkbenchCli(["run", "--help"], runIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(await runWorkbenchCli(["history", "--help"], historyIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(await runWorkbenchCli(["ui", "--help"], uiIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(topLevelIo.output.join("")).toContain("tubeless inspect");
    expect(topLevelIo.output.join("")).toContain("tubeless plan");
    expect(topLevelIo.output.join("")).toContain("tubeless graph");
    expect(topLevelIo.output.join("")).toContain("tubeless run");
    expect(topLevelIo.output.join("")).toContain("tubeless history");
    expect(topLevelIo.output.join("")).toContain("tubeless upgrade");
    expect(inspectIo.output.join("")).toContain("--json");
    expect(inspectIo.output.join("")).not.toContain("direction");
    expect(planIo.output.join("")).toContain("--target <id>");
    expect(planIo.output.join("")).toContain("--explain");
    expect(runIo.output.join("")).toContain("definePipelineCommand");
    expect(runIo.output.join("")).toContain("--trace");
    expect(historyIo.output.join("")).toContain("--store");
    expect(historyIo.output.join("")).toContain("--json");
    expect(historyIo.output.join("")).toContain("--events");
    expect(uiIo.output.join("")).toContain("append-only SQLite run store");
    expect(uiIo.output.join("")).toContain("--command <path>");
  });
});
