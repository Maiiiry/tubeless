import { stat } from "node:fs/promises";
import * as path from "node:path";
import {
  importModuleNamespace,
  isWorkbenchPipelineCommand,
  selectUniqueExport,
  type WorkbenchPipeline,
  type WorkbenchPipelineCommand,
} from "./pipeline-module.js";
import { commandForPipeline } from "../hosting/hosting-commands.js";
import { isPipelineProject, type AnyProjectPipeline } from "../project/pipeline-project.js";
import {
  errorMessage,
  loadPlanSource,
  loadWorkbenchModule,
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";

/** Default project file checked in the invocation directory. No parent search is performed. */
export const DEFAULT_PIPELINE_PROJECT_FILE = "tubeless.project.ts";

type LoadFailure = { exitCode: number };

/** A source normalized once for discovery, planning, execution, and Studio. */
export interface WorkbenchRegistration {
  readonly identity: string;
  readonly source: string;
  readonly cwd: string;
  /** Pipeline id when available before loading the source. */
  readonly id?: string;
  loadPlan(io: WorkbenchCliIo): Promise<{ view: WorkbenchPipeline } | LoadFailure>;
  loadCommand(
    io: WorkbenchCliIo
  ): Promise<{ command: WorkbenchPipelineCommand; commandIo: WorkbenchCliIo } | LoadFailure>;
}

interface WorkbenchProjectFile {
  filePath: string;
  /** The module export the project was selected from: "default" or its one named export. */
  exportName: string;
  registrations: readonly WorkbenchRegistration[];
  inventory: Record<string, unknown>;
}

/** Defer direct module loading until a plan or command is needed. */
export function createModuleRegistration(
  filePath: string,
  cwd: string,
  exportName?: string
): WorkbenchRegistration {
  filePath = path.resolve(cwd, filePath);
  return {
    identity: `${filePath}\0${exportName ?? ""}`,
    source: filePath,
    cwd,
    async loadPlan(io) {
      const loaded = await loadPlanSource(filePath, exportName, { ...io, cwd });
      if ("exitCode" in loaded) return loaded;
      return {
        view: loaded.source.kind === "command" ? loaded.source.command : loaded.source.pipeline,
      };
    },
    async loadCommand(io) {
      const commandIo = { ...io, cwd };
      const loaded = await loadPlanSource(filePath, exportName, commandIo);
      if ("exitCode" in loaded) return loaded;
      if (loaded.source.kind === "command") {
        return { command: loaded.source.command, commandIo };
      }
      return derivePipelineCommand(loaded.source.pipeline, commandIo, "directly loaded");
    },
  };
}

function derivePipelineCommand(
  pipeline: WorkbenchPipeline,
  io: WorkbenchCliIo,
  source: "directly loaded" | "project"
): { command: WorkbenchPipelineCommand; commandIo: WorkbenchCliIo } | LoadFailure {
  try {
    return { command: commandForPipeline(pipeline, source), commandIo: io };
  } catch (error) {
    io.stderr.write(
      `Error: Cannot derive a CLI for ${source} pipeline ${JSON.stringify(pipeline.id)}: ${errorMessage(error)}\n`
    );
    return { exitCode: TUBELESS_WORKBENCH_EXIT_CODE.load };
  }
}

function createPipelineRegistration(
  pipeline: AnyProjectPipeline,
  filePath: string,
  cwd: string,
  command?: WorkbenchPipelineCommand
): WorkbenchRegistration {
  return {
    identity: `project-pipeline\0${filePath}\0${pipeline.id}`,
    source: pipeline.id,
    cwd,
    id: pipeline.id,
    async loadPlan() {
      return { view: pipeline };
    },
    async loadCommand(io) {
      const commandIo = { ...io, cwd };
      return command
        ? { command, commandIo }
        : derivePipelineCommand(pipeline, commandIo, "project");
    },
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Select the project once and normalize its pipelines for every workbench consumer. */
export async function loadPipelineProjectFile(
  fileArgument: string,
  io: WorkbenchCliIo
): Promise<WorkbenchProjectFile | LoadFailure> {
  return loadWorkbenchModule(fileArgument, io, async (filePath) => {
    const moduleExports = await importModuleNamespace(filePath);
    const { exportName, value: root } = selectUniqueExport(
      moduleExports,
      Object.hasOwn(moduleExports, "default") ? "default" : undefined,
      isPipelineProject,
      "project",
      { hintExport: false }
    );
    const cwd = path.resolve(path.dirname(filePath), root.cwd ?? ".");
    const commands = new Map<string, WorkbenchPipelineCommand>();
    for (const command of root.commands) {
      if (!isWorkbenchPipelineCommand(command)) {
        throw new Error("Project commands must be created with definePipelineCommand.");
      }
      commands.set(command.id, command);
    }
    return {
      filePath,
      exportName,
      registrations: root.pipelines.map((pipeline) =>
        createPipelineRegistration(pipeline, filePath, cwd, commands.get(pipeline.id))
      ),
      inventory: {
        id: root.id,
        name: root.name,
        description: root.description,
        pipelines: root.pipelineIds,
        project: filePath,
        cwd,
      },
    };
  });
}

function isPathLike(target: string): boolean {
  return (
    path.isAbsolute(target) ||
    target.startsWith(".") ||
    target.includes("/") ||
    path.extname(target).length > 0
  );
}

async function projectFileForTarget(
  target: string,
  explicitProjectFile: string | undefined,
  io: WorkbenchCliIo
): Promise<string | undefined> {
  if (explicitProjectFile !== undefined) return explicitProjectFile;
  if (isPathLike(target) || (await pathExists(path.resolve(io.cwd, target)))) return undefined;
  const defaultFile = path.resolve(io.cwd, DEFAULT_PIPELINE_PROJECT_FILE);
  return (await pathExists(defaultFile)) ? defaultFile : undefined;
}

/** Resolve a direct file or registered id to the same lazy loading contract. */
export async function resolveWorkbenchRegistration(
  target: string,
  exportName: string | undefined,
  projectFile: string | undefined,
  io: WorkbenchCliIo,
  usage: string
): Promise<WorkbenchRegistration | LoadFailure> {
  if (exportName !== undefined && projectFile !== undefined) {
    return {
      exitCode: writeUsageError(
        io,
        "--export cannot be combined with --project; the project file owns export selection.",
        usage
      ),
    };
  }

  const resolvedProjectFile = await projectFileForTarget(target, projectFile, io);
  if (resolvedProjectFile === undefined) {
    return createModuleRegistration(target, io.cwd, exportName);
  }
  const loaded = await loadPipelineProjectFile(resolvedProjectFile, io);
  if ("exitCode" in loaded) return loaded;
  const registration = loaded.registrations.find(({ id }) => id === target);
  if (registration) return registration;
  io.stderr.write(
    `Error: Project file ${loaded.filePath} does not define pipeline ${JSON.stringify(target)}.\n`
  );
  return { exitCode: TUBELESS_WORKBENCH_EXIT_CODE.load };
}
