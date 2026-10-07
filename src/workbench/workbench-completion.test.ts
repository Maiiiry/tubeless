import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runWorkbenchCli } from "./workbench.js";
import { captureIo } from "./workbench.test-support.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

async function writeProject(fileName = "tubeless.project.ts"): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "tubeless-completion-"));
  directories.push(directory);
  const cliModuleUrl = pathToFileURL(path.resolve("dist/cli/cli.js")).href;
  const pipelineModuleUrl = pathToFileURL(path.resolve("dist/core/pipeline.js")).href;
  const projectModuleUrl = pathToFileURL(path.resolve("dist/project/project.js")).href;
  await writeFile(
    path.join(directory, fileName),
    `
      import { definePipelineCommand } from ${JSON.stringify(cliModuleUrl)};
      import { createSteps, definePipeline } from ${JSON.stringify(pipelineModuleUrl)};
      import { defineProject } from ${JSON.stringify(projectModuleUrl)};
      const { step } = createSteps();
      const fetch = step("fetch", { run: () => { throw new Error("completion must not run steps"); } });
      const publish = step("publish", { dependsOn: [fetch], run: () => undefined });
      const imports = definePipelineCommand(
        definePipeline({ id: "import-data", steps: [fetch], targets: [fetch] }),
        {
          params: {
            text: { type: "string", description: "Text to import." },
            format: { type: "string", choices: ["json", "csv"], default: "json" },
          },
          mapOptions: () => ({}),
          reporter: false,
        }
      );
      const report = definePipeline({
        id: "report",
        name: "Report",
        description: "Build the report.",
        steps: [fetch, publish],
        targets: [publish],
      });
      export default defineProject("fixture", [imports, report]);
    `
  );
  return directory;
}

async function complete(
  cwd: string,
  ...words: string[]
): Promise<{ exitCode: number; lines: string[]; errors: string }> {
  const io = captureIo(cwd);
  const exitCode = await runWorkbenchCli(["__complete", ...words], io);
  const output = io.output.join("");
  return {
    exitCode,
    lines: output === "" ? [] : output.replace(/\n$/, "").split("\n"),
    errors: io.errors.join(""),
  };
}

async function help(...argv: string[]): Promise<string> {
  const io = captureIo(process.cwd());
  expect(await runWorkbenchCli(argv, io)).toBe(0);
  return io.output.join("");
}

describe("tubeless __complete", () => {
  it("offers subcommands with descriptions at the command position", async () => {
    const all = await complete(tmpdir(), "");
    expect(all.exitCode).toBe(0);
    expect(all.lines).toContain("list\tList pipelines or commands in the project file");
    expect(all.lines).toContain("completion\tPrint a shell completion script (bash, zsh, fish)");
    expect(all.lines).toContain("help\tShow usage");
    expect(all.lines.some((line) => line.startsWith("__complete"))).toBe(false);
    expect((await complete(tmpdir(), "pl")).lines).toEqual([
      "plan\tPreview step selection without executing the pipeline",
    ]);
  });

  it("offers a subcommand's flags and fixed flag values", async () => {
    expect((await complete(tmpdir(), "graph", "--d")).lines).toEqual([
      "--direction\tFlowchart direction",
      "--domain\tMatch step domain exactly",
      "--descriptions\tInclude step descriptions in node labels",
    ]);
    const directions = ["BT", "LR", "RL", "TB", "TD"];
    expect((await complete(tmpdir(), "graph", "--direction", "")).lines).toEqual(directions);
    expect((await complete(tmpdir(), "graph", "-d", "")).lines).toEqual(directions);
    expect((await complete(tmpdir(), "completion", "")).lines).toEqual(["bash", "zsh", "fish"]);
  });

  it("offers project pipeline ids with descriptions plus file paths", async () => {
    const directory = await writeProject();
    expect((await complete(directory, "run", "")).lines).toEqual([
      "import-data",
      "report\tBuild the report.",
      ":files",
    ]);
    expect((await complete(directory, "inspect", "--json", "re")).lines).toEqual([
      "report\tBuild the report.",
      ":files",
    ]);
    expect((await complete(directory, "history", "--pipeline", "")).lines).toEqual([
      "import-data",
      "report\tBuild the report.",
    ]);
    // Only the first positional is a pipeline.
    expect((await complete(directory, "plan", "report", "")).lines).toEqual([]);
  });

  it("honors --project in every spelling", async () => {
    const directory = await writeProject("custom.project.ts");
    expect((await complete(directory, "run", "")).lines).toEqual([":files"]);
    const ids = ["import-data", "report\tBuild the report.", ":files"];
    expect((await complete(directory, "run", "--project", "custom.project.ts", "")).lines).toEqual(
      ids
    );
    expect((await complete(directory, "plan", "--project=custom.project.ts", "")).lines).toEqual(
      ids
    );
    expect((await complete(directory, "graph", "-p", "custom.project.ts", "")).lines).toEqual(ids);
    // Bash splits --project=path into three words.
    expect(
      (await complete(directory, "inspect", "--project", "=", "custom.project.ts", "")).lines
    ).toEqual(ids);
  });

  it("offers plan targets and steps for the selected pipeline", async () => {
    const directory = await writeProject();
    expect((await complete(directory, "plan", "report", "--target", "")).lines).toEqual([
      "publish",
    ]);
    expect((await complete(directory, "plan", "report", "-s", "")).lines).toEqual([
      "fetch",
      "publish",
    ]);
  });

  it("completes values written with = as one word or split by bash", async () => {
    const directory = await writeProject();
    expect((await complete(directory, "plan", "report", "--target=pu")).lines).toEqual([
      "--target=publish",
    ]);
    expect((await complete(directory, "plan", "report", "--target", "=", "")).lines).toEqual([
      "publish",
    ]);
    expect((await complete(directory, "plan", "report", "--json=x")).lines).toEqual([]);
    expect((await complete(directory, "run", "import-data", "--", "--cache=r")).lines).toEqual([
      "--cache=recompute",
    ]);
    expect(
      (await complete(directory, "run", "import-data", "--", "--cache", "=", "r")).lines
    ).toEqual(["recompute"]);
  });

  it("offers the pipeline command's own flags and choices after run <id> --", async () => {
    const directory = await writeProject();
    const flags = await complete(directory, "run", "import-data", "--", "--");
    expect(flags.lines).toContain("--text\tText to import.");
    expect(flags.lines).toContain("--format");
    expect(flags.lines).toContain("--help\tShow command help");
    for (const flag of ["--dry-run", "--target", "--step", "--cache"]) {
      expect(
        flags.lines.some((line) => line.split("\t")[0] === flag),
        flag
      ).toBe(true);
    }
    expect((await complete(directory, "run", "import-data", "--", "--format", "")).lines).toEqual([
      "json",
      "csv",
    ]);
    expect((await complete(directory, "run", "import-data", "--", "--cache", "")).lines).toEqual([
      "use",
      "recompute",
      "bypass",
    ]);
    expect((await complete(directory, "run", "import-data", "--", "--target", "")).lines).toEqual([
      "fetch",
    ]);
    expect((await complete(directory, "run", "import-data", "--", "--text", "")).lines).toEqual([]);
  });

  it("asks for file completion for file arguments and file-valued flags", async () => {
    const directory = tmpdir();
    for (const words of [
      ["validate", ""],
      ["ui", ""],
      ["run", "--store", ""],
      ["history", "--trace", "out"],
      ["list", "-p", ""],
      ["ui", "--command", ""],
    ]) {
      expect((await complete(directory, ...words)).lines, words.join(" ")).toEqual([":files"]);
    }
    expect((await complete(directory, "ui", "--host", "")).lines).toEqual([]);
    // zsh and fish keep `--flag=path` as one word; their scripts complete after the `=`.
    expect((await complete(directory, "run", "--project=./pr")).lines).toEqual([":files"]);
  });

  it("stays silent when the project cannot load", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-completion-broken-"));
    directories.push(directory);
    await writeFile(
      path.join(directory, "tubeless.project.ts"),
      `console.error("noisy"); throw new Error("broken project");`
    );
    for (const words of [
      ["run", ""],
      ["run", "missing", "--", "--"],
      ["plan", "missing", "--target", ""],
    ]) {
      const result = await complete(directory, ...words);
      expect(result.exitCode).toBe(0);
      expect(result.errors).toBe("");
      expect(result.lines.filter((line) => line !== ":files")).toEqual([]);
    }
  });

  it("mirrors every subcommand's --help options", async () => {
    const commands = [...(await help("--help")).matchAll(/^ {2}tubeless (\S+)/gm)].map(
      (match) => match[1]!
    );
    expect(commands).toContain("completion");
    for (const command of commands) {
      const rows = [
        ...(await help(command, "--help")).matchAll(/^ +(?:-(\w), +)?--([\w-]+)( <)?/gm),
      ];
      const completed = (await complete(tmpdir(), command, "-")).lines
        .map((line) => line.split("\t")[0])
        .sort();
      expect(completed, command).toEqual(rows.map((row) => `--${row[2]}`).sort());
      for (const [, short, name, takesValue] of rows) {
        // A value-taking flag completes its value, so the next word gets no flag list.
        const expectFlags = takesValue === undefined ? completed.length : 0;
        for (const spelling of short === undefined ? [`--${name}`] : [`--${name}`, `-${short}`]) {
          const after = await complete(tmpdir(), command, spelling, "--");
          expect(
            after.lines.filter((line) => line.startsWith("--")).length,
            `${command} ${spelling}`
          ).toBe(expectFlags);
        }
      }
    }
  });
});

describe("tubeless command dispatch", () => {
  it("suggests the closest command for a typo", async () => {
    const typo = captureIo(tmpdir());
    expect(await runWorkbenchCli(["lsit"], typo)).toBe(1);
    expect(typo.errors.join("")).toMatch(
      /^Error: Unknown command "lsit"\. Did you mean "list"\?\n\nUsage: tubeless/
    );
    const far = captureIo(tmpdir());
    expect(await runWorkbenchCli(["deploy"], far)).toBe(1);
    expect(far.errors.join("")).toMatch(/^Error: Unknown command "deploy"\.\n\n/);
  });
});

describe("tubeless completion", () => {
  it("prints a script per shell and rejects unknown shells", async () => {
    for (const shell of ["bash", "zsh", "fish"]) {
      expect(await help("completion", shell)).toContain("tubeless __complete");
    }
    expect(await help("completion", "--help")).toContain("source <(tubeless completion zsh)");

    const io = captureIo(tmpdir());
    expect(await runWorkbenchCli(["completion", "zhs"], io)).toBe(1);
    expect(io.errors.join("")).toContain(
      'Error: Unsupported shell "zhs". Supported shells: bash, zsh, fish. Did you mean "zsh"?'
    );
    const missing = captureIo(tmpdir());
    expect(await runWorkbenchCli(["completion"], missing)).toBe(1);
    expect(missing.errors.join("")).toContain("Pass one shell: bash, zsh, fish.");
  });

  const syntaxChecks = [
    ["bash", ["-n"]],
    ["zsh", ["-n"]],
    ["fish", ["--no-execute"]],
  ] as const;
  for (const [shell, args] of syntaxChecks) {
    const available = spawnSync(shell, ["-c", "true"]).error === undefined;
    it.skipIf(!available)(`emits a ${shell} script that parses`, async () => {
      const result = spawnSync(shell, args, { input: await help("completion", shell) });
      expect(result.stderr.toString()).toBe("");
      expect(result.status).toBe(0);
    });
  }

  it.skipIf(spawnSync("bash", ["-c", "true"]).error !== undefined)(
    "bash strips descriptions and adds files only alongside candidates",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "tubeless-completion-bash-"));
      directories.push(directory);
      await writeFile(path.join(directory, "report.yaml"), "");
      // The script discards the binary's stderr, so the stub reports its argv on fd 3.
      const script = `${await help("completion", "bash")}
exec 3>&2
tubeless() {
  printf '%s\\n' "args:$*" >&3
  if [[ "$3" == x ]]; then printf ':files\\n'; return; fi
  printf 'report\\tBuild the report.\\nrelease\\n:files\\n'
}
COMP_WORDS=(tubeless run re); COMP_CWORD=2; _tubeless
printf '%s\\n' "\${COMPREPLY[@]}"
COMP_WORDS=(tubeless run x); COMP_CWORD=2; _tubeless
printf 'files-only:%s\\n' "\${#COMPREPLY[@]}"
complete -p tubeless
`;
      const result = spawnSync("bash", ["--norc", "-c", script], { cwd: directory });
      expect(result.stderr.toString()).toBe("args:__complete run re\nargs:__complete run x\n");
      // An empty reply lets `complete -o default` fall back to readline file names.
      expect(result.stdout.toString()).toBe(
        "report\nrelease\nreport.yaml\nfiles-only:0\ncomplete -o default -F _tubeless tubeless\n"
      );
    }
  );
});
