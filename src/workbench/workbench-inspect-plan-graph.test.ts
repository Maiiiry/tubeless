import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { TUBELESS_WORKBENCH_EXIT_CODE, runWorkbenchCli } from "./workbench.js";
import {
  captureIo,
  fixturePipeline,
  writeActualPipelineModule,
  writeModule,
} from "./workbench.test-support.js";

describe("workbench inspect, plan, and graph", () => {
  it("filters metadata discovery without executing handlers or rendering dangling edges", async () => {
    const entry = pathToFileURL(path.resolve("dist/core/pipeline.js")).href;
    const { directory } = await writeModule(`
      import { createSteps, definePipeline } from ${JSON.stringify(entry)};
      const { step } = createSteps();
      const a = step("source", { run() { throw new Error("must not run"); } });
      const b = step("sink", { dependsOn: [a], metadata: { tags: ["pii", "write"], owner: "data", domain: "billing" }, run() { throw new Error("must not run"); } });
      export default definePipeline({ id: "metadata", metadata: { owner: "platform" }, steps: [a, b] });
    `);
    const io = captureIo(directory);
    expect(
      await runWorkbenchCli(
        ["inspect", "--json", "--tag", "pii", "--tag", "write", "--owner", "data", "pipeline.mjs"],
        io
      )
    ).toBe(0);
    const result = JSON.parse(io.output.join(""));
    expect(result.stepIds).toEqual(["sink"]);
    expect(result.plan.steps).toHaveLength(1);
    expect(result.plan.definition.metadata.owner).toBe("platform");
    const graph = captureIo(directory);
    expect(
      await runWorkbenchCli(["graph", "--domain", "billing", "--metadata", "pipeline.mjs"], graph)
    ).toBe(0);
    expect(graph.output.join("")).toContain("pii");
    expect(graph.output.join("")).not.toContain("-->");
    expect(graph.errors).toEqual([]);
    const noMatch = captureIo(directory);
    expect(
      await runWorkbenchCli(["inspect", "--json", "--owner", "unknown", "pipeline.mjs"], noMatch)
    ).toBe(0);
    expect(JSON.parse(noMatch.output.join("")).stepIds).toEqual([]);
    const text = captureIo(directory);
    expect(
      await runWorkbenchCli(["inspect", "--tag", "pii", "--owner", "data", "pipeline.mjs"], text)
    ).toBe(0);
    expect(text.output.join("")).toBe(
      [
        "Pipeline metadata",
        "Targets: sink",
        "Owner: platform",
        "",
        "Steps matching filters (1 of 2):",
        "  sink",
        "        depends on: source",
        "        tags: pii, write; owner: data; domain: billing",
        "",
      ].join("\n")
    );
  });

  it("inspects pipeline identity, targets, and each step's dependencies without running it", async () => {
    const { directory } = await writeModule(fixturePipeline);
    const io = captureIo(directory);

    const exitCode = await runWorkbenchCli(["inspect", "pipeline.mjs"], io);

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(io.errors).toEqual([]);
    expect(io.output.join("")).toBe(
      [
        "Pipeline fixture",
        "Targets: publish",
        "",
        "Steps (2):",
        "  load     Load Rows - Read source rows.",
        "  publish  Publish output.",
        "           depends on: load, hint (optional)",
        "           failure gate: validate",
        "           dry run: skip",
        "           runtime skip: possible",
        "",
      ].join("\n")
    );
  });

  it("emits the inspection as structured JSON", async () => {
    const { directory } = await writeModule(fixturePipeline);
    const io = captureIo(directory);

    const exitCode = await runWorkbenchCli(["inspect", "--json", "pipeline.mjs"], io);

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(JSON.parse(io.output.join(""))).toMatchObject({
      pipelineId: "fixture",
      stepIds: ["load", "publish"],
      targetIds: ["publish"],
      plan: {
        dryRun: false,
        ok: true,
        pipelineId: "fixture",
        steps: [
          { dryRun: "run", id: "load", runtimeSkipPossible: false },
          {
            dependencies: ["load"],
            dryRun: "skip",
            id: "publish",
            runtimeSkipPossible: true,
          },
        ],
      },
    });
  });

  it("graphs a pipeline as raw Mermaid or Markdown", async () => {
    const { directory } = await writeModule(fixturePipeline);
    const rawIo = captureIo(directory);
    const markdownIo = captureIo(directory);

    const rawExit = await runWorkbenchCli(
      ["graph", "--direction", "LR", "--descriptions", "pipeline.mjs"],
      rawIo
    );
    const markdownExit = await runWorkbenchCli(["graph", "pipeline.mjs", "--markdown"], markdownIo);

    expect(rawExit).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(rawIo.output.join("")).toContain("flowchart LR");
    expect(rawIo.output.join("")).toContain("Load Rows — Read source rows.");
    expect(markdownExit).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(markdownIo.output.join("")).toBe(
      ["```mermaid", "flowchart TD", '  step0["Load Rows"]', "  step0 --> step1", "```", ""].join(
        "\n"
      )
    );
  });

  it("plans a target with optional human selection explanations without executing steps", async () => {
    const { directory } = await writeActualPipelineModule();
    const compactIo = captureIo(directory);
    const explainedIo = captureIo(directory);

    const compactExit = await runWorkbenchCli(
      ["plan", "pipeline.mjs", "--target", "publish"],
      compactIo
    );
    const explainedExit = await runWorkbenchCli(
      ["plan", "pipeline.mjs", "--target", "publish", "--explain"],
      explainedIo
    );

    expect(compactExit).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(compactIo.errors).toEqual([]);
    expect(compactIo.output.join("")).toContain("load: run");
    expect(compactIo.output.join("")).toContain("hint: skip: filtered");
    expect(compactIo.output.join("")).not.toContain("required by publish");
    expect(explainedExit).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(explainedIo.output.join("")).toContain(
      "load: run (required by publish for target publish)"
    );
    expect(explainedIo.output.join("")).toContain(
      "hint: skip: filtered (optional-only input to publish for target publish)"
    );
    expect(explainedIo.output.join("")).toContain("publish: run (target publish)");
  });

  it("emits a dry-run plan as complete structured JSON", async () => {
    const { directory } = await writeActualPipelineModule();
    const io = captureIo(directory);

    const exitCode = await runWorkbenchCli(
      ["plan", "--target", "publish", "--dry-run", "--json", "pipeline.mjs"],
      io
    );

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    const plan = JSON.parse(io.output.join(""));
    expect(plan).toMatchObject({
      dryRun: true,
      errors: [],
      ok: true,
      pipelineId: "planning-fixture",
    });
    expect(plan.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "load", selected: true }),
        expect.objectContaining({ id: "hint", selected: false, skipReason: "filtered" }),
        expect.objectContaining({ id: "publish", selected: true, skipReason: "dry-run" }),
      ])
    );
    expect(plan.steps.find(({ id }: { id: string }) => id === "load").selectionReasons).toEqual([
      { dependentId: "publish", kind: "required-dependency", targetId: "publish" },
    ]);
  });

  it("returns the planning exit code with structured selection diagnostics", async () => {
    const { directory } = await writeActualPipelineModule();
    const unknownIo = captureIo(directory);
    const conflictIo = captureIo(directory);

    const unknownExit = await runWorkbenchCli(
      ["plan", "pipeline.mjs", "--target", "missing", "--json"],
      unknownIo
    );
    const conflictExit = await runWorkbenchCli(
      ["plan", "pipeline.mjs", "--target", "publish", "--step", "load"],
      conflictIo
    );

    expect(unknownExit).toBe(TUBELESS_WORKBENCH_EXIT_CODE.planning);
    expect(JSON.parse(unknownIo.output.join("")).errors[0]).toMatchObject({
      code: "TUBELESS_PLANNING_TARGET_UNKNOWN",
      kind: "selection",
      phase: "planning",
    });
    expect(conflictExit).toBe(TUBELESS_WORKBENCH_EXIT_CODE.planning);
    expect(conflictIo.output.join("")).toContain("TUBELESS_PLANNING_SELECTION_CONFLICT");
  });

  it("plans a module that exports only a marked pipeline command", async () => {
    const cliModuleUrl = pathToFileURL(path.resolve("dist/cli/cli.js")).href;
    const pipelineModuleUrl = pathToFileURL(path.resolve("dist/core/pipeline.js")).href;
    const { directory } = await writeModule(`
      import { definePipelineCommand } from ${JSON.stringify(cliModuleUrl)};
      import { createSteps, definePipeline } from ${JSON.stringify(pipelineModuleUrl)};
      const { step } = createSteps();
      const work = step("work", {
        run: () => { throw new Error("plan must not execute work"); },
      });
      const pipeline = definePipeline({
        id: "command-only-fixture",
        steps: [work],
        targets: [work],
        finalize: (outputs) => outputs.work,
      });
      export const FixtureCommand = definePipelineCommand(pipeline, {
        mapOptions: () => ({}),
        reporter: false,
      });
    `);
    const io = captureIo(directory);

    const exitCode = await runWorkbenchCli(["plan", "--json", "pipeline.mjs"], io);

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(io.errors).toEqual([]);
    expect(JSON.parse(io.output.join(""))).toMatchObject({
      ok: true,
      pipelineId: "command-only-fixture",
      steps: [expect.objectContaining({ id: "work", selected: true })],
    });
  });

  it("prefers a marked command when a module exports both a pipeline and a command", async () => {
    const markerModuleUrl = pathToFileURL(
      path.resolve("dist/utilities/pipeline-command-marker.js")
    ).href;
    const { directory } = await writeModule(`
      import { markPipelineCommand } from ${JSON.stringify(markerModuleUrl)};
      export const PlanningPipeline = {
        id: "from-pipeline",
        stepIds: ["work"],
        targetIds: ["work"],
        plan: () => ({
          dryRun: false,
          errors: [],
          ok: true,
          pipelineId: "from-pipeline",
          steps: [],
        }),
        toMermaid: () => "flowchart TD",
      };
      export const FixtureCommand = markPipelineCommand({
        id: "from-command",
        stepIds: ["work"],
        targetIds: ["work"],
        descriptor: { name: "fixture", parameters: [] },
        plan: () => ({
          dryRun: false,
          errors: [],
          ok: true,
          pipelineId: "from-command",
          steps: [],
        }),
        parse: () => ({ kind: "values" }),
        parseValues: () => ({ kind: "values" }),
        execute: async () => undefined,
        run: async () => undefined,
        toMermaid: () => "flowchart TD",
      }, {});
    `);
    const io = captureIo(directory);

    const exitCode = await runWorkbenchCli(["plan", "--json", "pipeline.mjs"], io);

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(JSON.parse(io.output.join(""))).toMatchObject({ pipelineId: "from-command" });
  });

  it("inspects a module that exports only a marked pipeline command", async () => {
    const cliModuleUrl = pathToFileURL(path.resolve("dist/cli/cli.js")).href;
    const pipelineModuleUrl = pathToFileURL(path.resolve("dist/core/pipeline.js")).href;
    const { directory } = await writeModule(`
      import { definePipelineCommand } from ${JSON.stringify(cliModuleUrl)};
      import { createSteps, definePipeline } from ${JSON.stringify(pipelineModuleUrl)};
      const { step } = createSteps();
      const work = step("work", {
        run: () => { throw new Error("inspect must not execute work"); },
      });
      const pipeline = definePipeline({
        id: "command-only-fixture",
        steps: [work],
        targets: [work],
        finalize: (outputs) => outputs.work,
      });
      export const FixtureCommand = definePipelineCommand(pipeline, {
        mapOptions: () => ({}),
        reporter: false,
      });
    `);
    const io = captureIo(directory);

    const exitCode = await runWorkbenchCli(["inspect", "--json", "pipeline.mjs"], io);

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(io.errors).toEqual([]);
    expect(JSON.parse(io.output.join(""))).toMatchObject({
      pipelineId: "command-only-fixture",
      stepIds: ["work"],
      targetIds: ["work"],
      plan: {
        ok: true,
        pipelineId: "command-only-fixture",
        steps: [expect.objectContaining({ id: "work", selected: true })],
      },
    });
  });

  it("graphs a module that exports only a marked pipeline command", async () => {
    const cliModuleUrl = pathToFileURL(path.resolve("dist/cli/cli.js")).href;
    const pipelineModuleUrl = pathToFileURL(path.resolve("dist/core/pipeline.js")).href;
    const { directory } = await writeModule(`
      import { definePipelineCommand } from ${JSON.stringify(cliModuleUrl)};
      import { createSteps, definePipeline } from ${JSON.stringify(pipelineModuleUrl)};
      const { step } = createSteps();
      const work = step("work", {
        name: "Do Work",
        run: () => { throw new Error("graph must not execute work"); },
      });
      export const FixtureCommand = definePipelineCommand(
        definePipeline({
          id: "command-only-graph",
          steps: [work],
          targets: [work],
          finalize: (outputs) => outputs.work,
        }),
        { mapOptions: () => ({}), reporter: false }
      );
    `);
    const io = captureIo(directory);

    const exitCode = await runWorkbenchCli(["graph", "pipeline.mjs"], io);

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(io.errors).toEqual([]);
    expect(io.output.join("")).toBe(["flowchart TD", '  step0["Do Work"]', ""].join("\n"));
  });

  it("prefers a marked command for inspect and graph when a module exports both", async () => {
    const markerModuleUrl = pathToFileURL(
      path.resolve("dist/utilities/pipeline-command-marker.js")
    ).href;
    const { directory } = await writeModule(`
      import { markPipelineCommand } from ${JSON.stringify(markerModuleUrl)};
      export const PlanningPipeline = {
        id: "from-pipeline",
        stepIds: ["work"],
        targetIds: ["work"],
        plan: () => ({
          dryRun: false,
          errors: [],
          ok: true,
          pipelineId: "from-pipeline",
          steps: [],
        }),
        toMermaid: () => "flowchart TD\\n  from-pipeline",
      };
      export const FixtureCommand = markPipelineCommand({
        id: "from-command",
        stepIds: ["command-work"],
        targetIds: ["command-work"],
        descriptor: { name: "fixture", parameters: [] },
        plan: () => ({
          dryRun: false,
          errors: [],
          ok: true,
          pipelineId: "from-command",
          steps: [],
        }),
        parse: () => ({ kind: "values" }),
        parseValues: () => ({ kind: "values" }),
        execute: async () => undefined,
        run: async () => undefined,
        toMermaid: () => "flowchart TD\\n  from-command",
      }, {});
    `);
    const inspectIo = captureIo(directory);
    const graphIo = captureIo(directory);

    const inspectExit = await runWorkbenchCli(["inspect", "--json", "pipeline.mjs"], inspectIo);
    const graphExit = await runWorkbenchCli(["graph", "pipeline.mjs"], graphIo);

    expect(inspectExit).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(JSON.parse(inspectIo.output.join(""))).toMatchObject({
      pipelineId: "from-command",
      stepIds: ["command-work"],
      targetIds: ["command-work"],
    });
    expect(graphExit).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(graphIo.output.join("")).toBe("flowchart TD\n  from-command\n");
  });
});
