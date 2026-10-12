import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { cloudflareScaffold } from "./workbench-init-cloudflare.js";
import {
  DEFAULT_PIPELINE_PROJECT_FILE,
  loadPipelineProjectFile,
} from "./workbench-project-loader.js";
import {
  errorMessage,
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";
import { parseSubcommandArgs, runWorkbenchSubcommand } from "./workbench-subcommand.js";

export interface DeployTargetFile {
  readonly path: string;
  readonly contents: string;
}

/** One deploy target's scaffold. Runtime ports live in its public entrypoint, not here. */
export interface DeployTargetScaffold {
  readonly id: string;
  readonly description: string;
  files(context: {
    readonly cwd: string;
    readonly projectFile: string;
    /** "default" or the named export the project file exposes the project under. */
    readonly projectExport: string;
  }): readonly DeployTargetFile[];
  readonly nextSteps: readonly string[];
}

const TARGETS: ReadonlyMap<string, DeployTargetScaffold> = new Map([
  [cloudflareScaffold.id, cloudflareScaffold],
]);

const INIT_USAGE = `Usage: tubeless init <target> [options]

Scaffold deployment files for a Tubeless project. Existing files are never overwritten.

Targets:
${[...TARGETS.values()].map((target) => `  ${target.id.padEnd(12)} ${target.description}`).join("\n")}

Options:
  -p, --project <path>  Project file (default: ./tubeless.project.ts)
  -h, --help            Show this help
`;

/** Anything but a clean "not found" (for example ENOTDIR) counts as occupied, so init never writes through it. */
async function occupied(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

export async function runInit(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      usage: INIT_USAGE,
      parse: (args) => parseSubcommandArgs(args, { project: { type: "string", short: "p" } }),
      positionalCountError: { count: 1, message: "Pass exactly one deploy target." },
      async run(parsed, commandIo) {
        const targetId = parsed.positionals[0]!;
        const target = TARGETS.get(targetId);
        if (!target) {
          return writeUsageError(
            commandIo,
            `Unknown deploy target ${JSON.stringify(targetId)}. Available: ${[...TARGETS.keys()].join(", ")}.`,
            INIT_USAGE
          );
        }
        const loaded = await loadPipelineProjectFile(
          parsed.values.project ?? DEFAULT_PIPELINE_PROJECT_FILE,
          commandIo
        );
        if ("exitCode" in loaded) return loaded.exitCode;
        for (const registration of loaded.registrations) {
          const command = await registration.loadCommand(commandIo);
          if ("exitCode" in command) return command.exitCode;
        }
        let files: readonly DeployTargetFile[];
        try {
          files = target.files({
            cwd: commandIo.cwd,
            projectFile: loaded.filePath,
            projectExport: loaded.exportName,
          });
        } catch (error) {
          commandIo.stderr.write(`Error: ${errorMessage(error)}\n`);
          return TUBELESS_WORKBENCH_EXIT_CODE.usage;
        }
        const conflicts: string[] = [];
        for (const file of files)
          if (await occupied(resolve(commandIo.cwd, file.path))) conflicts.push(file.path);
        if (conflicts.length > 0) {
          commandIo.stderr.write(
            `Error: Refusing to overwrite existing files: ${conflicts.join(", ")}\n`
          );
          return TUBELESS_WORKBENCH_EXIT_CODE.usage;
        }
        const created: string[] = [];
        for (const file of files) {
          const path = resolve(commandIo.cwd, file.path);
          try {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, file.contents, { flag: "wx" });
          } catch (error) {
            commandIo.stderr.write(`Error: Could not write ${file.path}: ${errorMessage(error)}\n`);
            if (created.length > 0)
              commandIo.stderr.write(`Already created: ${created.join(", ")}\n`);
            return TUBELESS_WORKBENCH_EXIT_CODE.execution;
          }
          created.push(file.path);
          commandIo.stdout.write(`Created ${file.path}\n`);
        }
        commandIo.stdout.write(
          `\nNext steps:\n${target.nextSteps.map((step) => `  ${step}`).join("\n")}\n`
        );
        return TUBELESS_WORKBENCH_EXIT_CODE.success;
      },
    },
    argv,
    io
  );
}
