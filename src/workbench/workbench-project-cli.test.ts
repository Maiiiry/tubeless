import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TUBELESS_WORKBENCH_EXIT_CODE, runWorkbenchCli, type WorkbenchCliIo } from "./workbench.js";
import { loadPipelineProjectFile } from "./workbench-project-loader.js";

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
    stderr: { write: (chunk) => void errors.push(chunk) },
    stdout: { write: (chunk) => void output.push(chunk) },
  };
}

async function writeProjectFixture(): Promise<{
  directory: string;
  projectFile: string;
  workDirectory: string;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "tubeless-project-"));
  directories.push(directory);
  const configDirectory = path.join(directory, "config");
  const workDirectory = path.join(configDirectory, "work");
  await mkdir(workDirectory, { recursive: true });
  const cliModuleUrl = pathToFileURL(path.resolve("dist/cli/cli.js")).href;
  const projectModuleUrl = pathToFileURL(path.resolve("dist/project/project.js")).href;
  const pipelineModuleUrl = pathToFileURL(path.resolve("dist/core/pipeline.js")).href;
  await writeFile(
    path.join(directory, "pipeline.mjs"),
    `
      import { definePipelineCommand } from ${JSON.stringify(cliModuleUrl)};
      import { createSteps, definePipeline } from ${JSON.stringify(pipelineModuleUrl)};
      const { step } = createSteps();
      const work = step("work", {
        run: (_inputs, context) => {
          context.log.log(\`cwd:\${context.cwd}\`);
          return context.options.message;
        },
      });
      export const Pipeline = definePipeline({ id: "import-data", steps: [work] });
      export const FixtureCommand = definePipelineCommand(Pipeline, {
        name: "Import data",
        params: { text: { type: "string" } },
        mapOptions: ({ text }) => ({ message: text.toUpperCase() }),
        reporter: false,
        summarize: (result) => [\`completed:\${result}\`],
      });
    `
  );
  const projectFile = path.join(configDirectory, "project.mjs");
  await writeFile(
    projectFile,
    `
    import { defineProject } from ${JSON.stringify(projectModuleUrl)};
    import { FixtureCommand } from "../pipeline.mjs";
    export default defineProject("fixture", [FixtureCommand], {
      cwd: "./work",
    });
  `
  );
  await writeFile(
    path.join(directory, "tubeless.project.ts"),
    `
    import { defineProject } from ${JSON.stringify(projectModuleUrl)};
    import { FixtureCommand } from "./pipeline.mjs";
    export default defineProject("fixture", [FixtureCommand], {
      cwd: "./config/work",
    });
  `
  );
  return { directory, projectFile, workDirectory };
}

async function writeAutomaticProjectFixture(mixed = false): Promise<{
  directory: string;
  projectFile: string;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "tubeless-automatic-project-"));
  directories.push(directory);
  const pipelineModuleUrl = pathToFileURL(path.resolve("dist/core/pipeline.js")).href;
  const projectModuleUrl = pathToFileURL(path.resolve("dist/project/project.js")).href;
  const projectFile = path.join(directory, "tubeless.project.ts");
  const cliModuleUrl = pathToFileURL(path.resolve("dist/cli/cli.js")).href;
  await writeFile(
    projectFile,
    `
      import { createSteps, definePipeline } from ${JSON.stringify(pipelineModuleUrl)};
      import { defineProject } from ${JSON.stringify(projectModuleUrl)};
      import { definePipelineCommand } from ${JSON.stringify(cliModuleUrl)};
      export const UnrelatedProject = defineProject("unrelated", []);
      const optionsSchema = {
        "~standard": {
          version: 1,
          vendor: "fixture",
          validate: (value) => ({ value }),
          jsonSchema: { input: () => ({
            type: "object",
            properties: { message: { type: "string", description: "Message to print." } },
            required: ["message"],
          }) },
        },
      };
      const { step } = createSteps(optionsSchema);
      const work = step("work", {
        run: (_inputs, context) => {
          context.log.log(\`worked:\${context.options.message}\`);
          return context.options.message;
        },
      });
      const pipeline = definePipeline({ id: "automatic", steps: [work] });
      const explicit = definePipelineCommand(definePipeline({
        id: "explicit", name: "Explicit job", description: "Print mapped text.", steps: [work],
      }), {
        name: "Explicit CLI",
        params: { text: { type: "string" } },
        mapOptions: ({ text, resume }) => ({ message: text.toUpperCase() + (resume ? ":resumed" : "") }),
        validate: ({ text }) => text === "invalid" ? ["Text is invalid"] : [],
        resume: true,
        reporter: false,
        summarize: (result) => [\`summary:\${result}\`],
      });
      export default defineProject("fixture-project", [pipeline${mixed ? ", explicit" : ""}], {
        name: "Fixture jobs",
        description: "Print a message.",
      });
    `
  );
  return { directory, projectFile };
}

describe("project file workbench", () => {
  it("executes inferred and explicit commands from one mixed list in CLI and Studio", async () => {
    const { directory, projectFile } = await writeAutomaticProjectFixture(true);
    const listIo = captureIo(directory);
    expect(await runWorkbenchCli(["list", "--json"], listIo)).toBe(0);
    expect(JSON.parse(listIo.output.join(""))).toMatchObject({
      pipelines: ["automatic", "explicit"],
    });
    const listTextIo = captureIo(directory);
    expect(await runWorkbenchCli(["list"], listTextIo)).toBe(0);
    expect(listTextIo.output.join("")).toBe(
      "automatic\nexplicit   Explicit CLI - Print mapped text.\n"
    );
    const inspectIo = captureIo(directory);
    expect(await runWorkbenchCli(["inspect", "explicit"], inspectIo)).toBe(0);
    expect(inspectIo.output.join("")).toContain("Explicit CLI");
    const invalidIo = captureIo(directory);
    expect(
      await runWorkbenchCli(["run", "explicit", "--", "--text", "invalid"], invalidIo)
    ).not.toBe(0);
    expect(invalidIo.errors.join("")).toContain("Text is invalid");
    const runIo = captureIo(directory);
    expect(
      await runWorkbenchCli(["run", "explicit", "--", "--text", "cli", "--resume"], runIo)
    ).toBe(0);
    expect(runIo.output.join("")).toContain("summary:CLI:resumed");

    const controller = new AbortController();
    const io = { ...captureIo(directory), signal: controller.signal };
    const running = runWorkbenchCli(
      ["ui", "--store", path.join(directory, "runs.sqlite"), "--port", "0", projectFile],
      io
    );
    try {
      await vi.waitFor(() =>
        expect(io.output.join("")).toContain("Tubeless local studio: http://")
      );
      const url = /Tubeless local studio: (http:\/\/[^\n]+)/.exec(io.output.join(""))?.[1];
      await expect(
        fetch(`${url}/api/commands`).then((response) => response.json())
      ).resolves.toMatchObject({
        commands: [
          {
            id: "automatic",
            parameters: expect.arrayContaining([expect.objectContaining({ key: "message" })]),
          },
          {
            id: "explicit",
            name: "Explicit CLI",
            description: "Print mapped text.",
            parameters: expect.arrayContaining([
              expect.objectContaining({ key: "text" }),
              expect.objectContaining({ key: "resume" }),
            ]),
          },
        ],
      });
      for (const [id, values, expected] of [
        ["automatic", { message: "studio" }, "worked:studio"],
        ["explicit", { text: "studio", resume: true }, "summary:STUDIO:resumed"],
      ] as const) {
        const response = await fetch(`${url}/api/commands/${id}/runs`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-tubeless-studio-launch": "1" },
          body: JSON.stringify({ values }),
        });
        expect(response.status).toBe(202);
        await vi.waitFor(() => expect(io.output.join("")).toContain(expected));
      }
    } finally {
      controller.abort();
      await expect(running).resolves.toBe(0);
    }
  });

  it.each(["list", "inspect", "plan", "graph", "run", "ui"])(
    "preserves definition errors during project imports for %s",
    async (operation) => {
      const directory = await mkdtemp(path.join(tmpdir(), "tubeless-invalid-project-"));
      directories.push(directory);
      const pipelineModuleUrl = pathToFileURL(path.resolve("dist/core/pipeline.js")).href;
      const projectModuleUrl = pathToFileURL(path.resolve("dist/project/project.js")).href;
      const projectFile = path.join(directory, "tubeless.project.ts");
      await writeFile(
        projectFile,
        `
          import { createSteps, definePipeline } from ${JSON.stringify(pipelineModuleUrl)};
          import { defineProject } from ${JSON.stringify(projectModuleUrl)};
          const { step } = createSteps();
          const work = step("work", { run: () => "done" });
          export default defineProject("invalid-project", [
            definePipeline({ id: "invalid", steps: [work, work] }),
          ]);
        `
      );
      const io = captureIo(directory);
      const args =
        operation === "ui"
          ? [operation, projectFile]
          : operation === "list"
            ? [operation]
            : [operation, "invalid"];

      expect(await runWorkbenchCli(args, io)).toBe(TUBELESS_WORKBENCH_EXIT_CODE.definition);
      expect(io.errors.join("")).toContain("work");
      expect(io.output).toEqual([]);
    }
  );

  it.each([
    ["export { project, project as alias };", "project"],
    ["export { project as default, otherProject };", "project"],
    ["export { project, otherProject };", "multiple"],
    ["export { project }; export default null;", 'Export "default"'],
    ["export { project }; export default undefined;", 'Export "default"'],
  ])("selects project-file roots for %s", async (exports, expected) => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-root-selection-"));
    directories.push(directory);
    const projectModuleUrl = pathToFileURL(path.resolve("dist/project/project.js")).href;
    const filePath = path.join(directory, "roots.mjs");
    await writeFile(
      filePath,
      `
      import { defineProject } from ${JSON.stringify(projectModuleUrl)};
      const project = defineProject("selected", []);
      const otherProject = defineProject("other", []);
      ${exports}
    `
    );
    const io = captureIo(directory);
    const loaded = await loadPipelineProjectFile(filePath, io);
    if (expected === "project") {
      expect(loaded).toMatchObject({ inventory: { id: "selected" } });
      expect(io.errors).toEqual([]);
    } else {
      expect(loaded).toEqual({ exitCode: TUBELESS_WORKBENCH_EXIT_CODE.load });
      expect(io.errors.join("")).toContain(expected);
      expect(io.errors.join("")).not.toContain("--export");
    }
  });

  it.each(["run", "ui"])(
    "rejects type-only project inputs before %s can execute them",
    async (command) => {
      const directory = await mkdtemp(path.join(tmpdir(), "tubeless-type-only-project-"));
      directories.push(directory);
      const pipelineModuleUrl = pathToFileURL(path.resolve("dist/core/pipeline.js")).href;
      const projectModuleUrl = pathToFileURL(path.resolve("dist/project/project.js")).href;
      const projectFile = path.join(directory, "tubeless.project.ts");
      await writeFile(
        projectFile,
        `
          import { createSteps, definePipeline } from ${JSON.stringify(pipelineModuleUrl)};
          import { defineProject } from ${JSON.stringify(projectModuleUrl)};
          type RequiredOptions = { message: string };
          const { step } = createSteps<RequiredOptions>();
          const work = step("work", {
            run: (_inputs, context) => {
              context.log.log("executed-type-only-step");
              return context.options.message;
            },
          });
          export default defineProject("type-only-project", [
            definePipeline({ id: "type-only", steps: [work] }),
          ]);
        `
      );
      const io = { ...captureIo(directory), signal: AbortSignal.timeout(1_000) };
      const args =
        command === "run"
          ? ["run", "type-only"]
          : ["ui", "--store", path.join(directory, "runs.sqlite"), "--port", "0", projectFile];

      expect(await runWorkbenchCli(args, io)).toBe(TUBELESS_WORKBENCH_EXIT_CODE.load);
      expect(io.errors.join("")).toContain('Cannot derive a CLI for project pipeline "type-only"');
      expect(io.errors.join("")).toContain("Standard JSON Schema input metadata");
      expect(io.errors.join("")).toContain("explicit params");
      expect(io.errors.join("")).toContain("project entry list");
      expect(io.output.join("")).not.toContain("executed-type-only-step");
      expect(io.output.join("")).not.toContain("Tubeless local studio:");

      for (const operation of ["list", "inspect", "plan", "graph"]) {
        const planIo = captureIo(directory);
        const planArgs = operation === "list" ? [operation] : [operation, "type-only"];
        expect(await runWorkbenchCli(planArgs, planIo)).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
        expect(planIo.errors).toEqual([]);
        expect(planIo.output.join("")).not.toContain("executed-type-only-step");
      }
    }
  );

  it("lists and runs project pipelines with automatically inferred CLI flags", async () => {
    const { directory, projectFile } = await writeAutomaticProjectFixture();

    const listIo = captureIo(directory);
    expect(await runWorkbenchCli(["list", "--json"], listIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(JSON.parse(listIo.output.join(""))).toEqual({
      id: "fixture-project",
      name: "Fixture jobs",
      description: "Print a message.",
      pipelines: ["automatic"],
      project: projectFile,
      cwd: directory,
    });

    const runIo = captureIo(directory);
    expect(await runWorkbenchCli(["run", "automatic", "--", "--message", "hello"], runIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(runIo.output.join(" ")).toContain("worked:hello");
    expect(runIo.errors).toEqual([]);

    const inspectIo = captureIo(directory);
    expect(await runWorkbenchCli(["inspect", "automatic", "--json"], inspectIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    const inspection = JSON.parse(inspectIo.output.join(""));
    expect(inspection.pipelineId).toBe("automatic");
    expect(inspection).not.toHaveProperty("commandId");

    const textIo = captureIo(directory);
    expect(await runWorkbenchCli(["inspect", "automatic"], textIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(textIo.output.join("")).toContain("Pipeline automatic");
    expect(textIo.output.join("")).not.toContain("Command automatic");
  });

  it("lists project pipelines without executing handlers or requiring command inputs", async () => {
    const { directory, workDirectory } = await writeProjectFixture();
    const io = captureIo(directory);
    expect(await runWorkbenchCli(["list", "--json"], io)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(JSON.parse(io.output.join(""))).toMatchObject({
      id: "fixture",
      pipelines: ["import-data"],
      cwd: workDirectory,
    });
    expect(io.errors).toEqual([]);
    const textIo = captureIo(directory);
    expect(await runWorkbenchCli(["list"], textIo)).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(textIo.output.join("")).toBe("import-data  Import data\n");
    expect(textIo.errors).toEqual([]);
  });

  it("rejects a pipeline registered through both a project and a direct command file", async () => {
    const { directory, projectFile } = await writeProjectFixture();
    const io = captureIo(directory);
    expect(await runWorkbenchCli(["ui", "--command", "./pipeline.mjs", projectFile], io)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.usage
    );
    expect(io.errors.join("")).toContain('Studio command id "import-data" is duplicated.');
    expect(io.output).toEqual([]);
  });

  it("inspects, plans, graphs, and runs a project pipeline with a custom adapter", async () => {
    const { directory, projectFile, workDirectory } = await writeProjectFixture();
    const projectArgs = ["--project", projectFile, "import-data"];

    const inspectIo = captureIo(directory);
    expect(await runWorkbenchCli(["inspect", ...projectArgs, "--json"], inspectIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(JSON.parse(inspectIo.output.join(""))).toMatchObject({
      pipelineId: "import-data",
      stepIds: ["work"],
    });

    const planIo = captureIo(directory);
    expect(await runWorkbenchCli(["plan", ...projectArgs, "--target", "work"], planIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(planIo.output.join(" ")).toContain("work");

    const graphIo = captureIo(directory);
    expect(await runWorkbenchCli(["graph", ...projectArgs], graphIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(graphIo.output.join(" ")).toContain("flowchart TD");

    const runIo = captureIo(directory);
    expect(
      await runWorkbenchCli(
        [
          "run",
          "--project",
          projectFile,
          "--trace",
          "run.ndjson",
          "import-data",
          "--",
          "--text",
          "hello",
        ],
        runIo
      )
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(runIo.output.join(" ")).toContain(`cwd:${workDirectory}`);
    expect(runIo.output.join(" ")).toContain("completed:HELLO");
    await expect(readFile(path.join(directory, "run.ndjson"), "utf8")).resolves.toContain(
      '"name":"pipeline.completed"'
    );
  });

  it("rejects --export combined with --project on inspect, plan, graph, and run", async () => {
    const { directory, projectFile } = await writeProjectFixture();
    const mutexArgs = [
      "--export",
      "FixtureCommand",
      "--project",
      projectFile,
      "import-data",
    ] as const;

    for (const command of ["inspect", "plan", "graph", "run"] as const) {
      const io = captureIo(directory);
      expect(await runWorkbenchCli([command, ...mutexArgs], io)).toBe(
        TUBELESS_WORKBENCH_EXIT_CODE.usage
      );
      expect(io.errors.join("")).toContain(
        "--export cannot be combined with --project; the project file owns export selection."
      );
      expect(io.errors.join("")).toContain(`Usage: tubeless ${command}`);
    }
  });

  it("uses a bare id from the current directory default projectFile", async () => {
    const { directory } = await writeProjectFixture();
    const io = captureIo(directory);

    expect(await runWorkbenchCli(["inspect", "import-data", "--json"], io)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(JSON.parse(io.output.join(""))).toMatchObject({ pipelineId: "import-data" });
  });

  it("suggests a near-miss project pipeline id and points at list", async () => {
    const { directory, projectFile } = await writeProjectFixture();
    const defaultProject = path.join(directory, "tubeless.project.ts");

    const nearIo = captureIo(directory);
    expect(await runWorkbenchCli(["inspect", "import-dat"], nearIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.load
    );
    expect(nearIo.errors.join("")).toBe(
      `Error: Project file ${defaultProject} does not define pipeline "import-dat". Did you mean "import-data"?\n` +
        'Run "tubeless list" to see its 1 pipeline.\n'
    );

    const farIo = captureIo(directory);
    expect(await runWorkbenchCli(["plan", "--project", projectFile, "export"], farIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.load
    );
    expect(farIo.errors.join("")).toBe(
      `Error: Project file ${projectFile} does not define pipeline "export".\n` +
        `Run "tubeless list --project ${projectFile}" to see its 1 pipeline.\n`
    );
  });

  it("keeps an existing file argument ahead of default-project identity lookup", async () => {
    const { directory } = await writeProjectFixture();
    const io = captureIo(directory);

    expect(await runWorkbenchCli(["inspect", "pipeline.mjs", "--json"], io)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(JSON.parse(io.output.join(""))).toMatchObject({ pipelineId: "import-data" });
    expect(JSON.parse(io.output.join(""))).not.toHaveProperty("commandId");
  });

  it("publishes project pipelines and inferred parameters to Studio", async () => {
    const { directory, projectFile } = await writeAutomaticProjectFixture();
    const controller = new AbortController();
    const io = { ...captureIo(directory), signal: controller.signal };
    const running = runWorkbenchCli(
      ["ui", "--store", path.join(directory, "runs.sqlite"), "--port", "0", projectFile],
      io
    );

    await vi.waitFor(() => expect(io.output.join(" ")).toContain("Tubeless local studio: http://"));
    const url = /Tubeless local studio: (http:\/\/[^\n]+)/.exec(io.output.join(""))?.[1];
    expect(url).toBeDefined();
    await expect(fetch(`${url}/api/commands`).then((response) => response.json())).resolves.toEqual(
      {
        commands: [
          expect.objectContaining({
            id: "automatic",
            name: "automatic",
            parameters: expect.arrayContaining([
              expect.objectContaining({ flag: "message", key: "message", required: true }),
            ]),
          }),
        ],
      }
    );

    controller.abort();
    await expect(running).resolves.toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
  });
});
