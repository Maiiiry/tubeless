import { pathToFileURL } from "node:url";
import type { CliCommandDescriptor, CliContext } from "../cli/cli.js";
import { pipelineForCommand } from "../utilities/pipeline-command-marker.js";
import type {
  PipelineMermaidOptions,
  PipelinePlan,
  PipelineRunControls,
} from "../core/pipeline.js";

/** Runtime surface required by the workbench's non-executing pipeline commands. */
export interface WorkbenchPipeline {
  readonly id: string;
  readonly stepIds: readonly string[];
  readonly targetIds: readonly string[];
  plan(controls?: PipelineRunControls): PipelinePlan;
  toMermaid(options?: PipelineMermaidOptions): string;
}

/** Runtime surface exposed only by commands created with definePipelineCommand. */
export type WorkbenchPipelineCommandParseResult =
  | { kind: "values"; values: Record<string, unknown> }
  | { kind: "help"; helpText: string }
  | { kind: "error"; errors: readonly string[]; helpText: string };

export interface WorkbenchPipelineCommand {
  readonly descriptor: CliCommandDescriptor;
  readonly id: string;
  readonly stepIds: readonly string[];
  readonly targetIds: readonly string[];
  parse(
    argv?: readonly string[],
    context?: Partial<CliContext>
  ): WorkbenchPipelineCommandParseResult;
  parseValues(
    values: Record<string, unknown>,
    context?: Partial<CliContext>
  ): WorkbenchPipelineCommandParseResult;
  execute(values: Record<string, unknown>, context?: Partial<CliContext>): Promise<unknown>;
  plan(controls?: PipelineRunControls): PipelinePlan;
  run(argv?: readonly string[], context?: Partial<CliContext>): Promise<unknown>;
  toMermaid(options?: PipelineMermaidOptions): string;
}

/** Runtime surface accepted by `tubeless plan`, `inspect`, and `graph`. */
export type WorkbenchPlanSource =
  | { kind: "command"; command: WorkbenchPipelineCommand }
  | { kind: "pipeline"; pipeline: WorkbenchPipeline };

export type SelectUniqueExportOptions = {
  hintExport?: boolean;
};

function isWorkbenchPipeline(value: unknown): value is WorkbenchPipeline {
  if (pipelineForCommand(value)) return false;
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "stepIds" in value &&
    Array.isArray(value.stepIds) &&
    "targetIds" in value &&
    Array.isArray(value.targetIds) &&
    "plan" in value &&
    typeof value.plan === "function" &&
    "toMermaid" in value &&
    typeof value.toMermaid === "function"
  );
}

export function isWorkbenchPipelineCommand(value: unknown): value is WorkbenchPipelineCommand {
  if (!pipelineForCommand(value)) return false;
  // SAFETY: pipelineForCommand established value is a non-null object or
  // function, so this single cast only widens to a shape we probe with `in`.
  const candidate = value as object;
  return (
    "descriptor" in candidate &&
    typeof candidate.descriptor === "object" &&
    candidate.descriptor !== null &&
    "id" in candidate &&
    typeof candidate.id === "string" &&
    "stepIds" in candidate &&
    Array.isArray(candidate.stepIds) &&
    "targetIds" in candidate &&
    Array.isArray(candidate.targetIds) &&
    "plan" in candidate &&
    typeof candidate.plan === "function" &&
    "parse" in candidate &&
    typeof candidate.parse === "function" &&
    "parseValues" in candidate &&
    typeof candidate.parseValues === "function" &&
    "execute" in candidate &&
    typeof candidate.execute === "function" &&
    "run" in candidate &&
    typeof candidate.run === "function" &&
    "toMermaid" in candidate &&
    typeof candidate.toMermaid === "function"
  );
}

function uniqueNamedExports<T>(
  moduleExports: Record<string, unknown>,
  predicate: (value: unknown) => value is T
): [string, T][] {
  const candidates = Object.entries(moduleExports).filter((entry): entry is [string, T] =>
    predicate(entry[1])
  );
  return candidates.filter(
    ([, value], index) => candidates.findIndex(([, other]) => other === value) === index
  );
}

/** Select one matching export and its name, deduplicating aliases. */
export function selectUniqueExport<T>(
  moduleExports: Record<string, unknown>,
  exportName: string | undefined,
  predicate: (value: unknown) => value is T,
  label: string,
  options?: SelectUniqueExportOptions
) {
  if (exportName !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(moduleExports, exportName)) {
      throw new Error(`Module does not export ${JSON.stringify(exportName)}.`);
    }
    const selected = moduleExports[exportName];
    if (!predicate(selected)) {
      throw new Error(`Export ${JSON.stringify(exportName)} is not a tubeless ${label}.`);
    }
    return { exportName, value: selected };
  }

  const unique = uniqueNamedExports(moduleExports, predicate);
  if (unique.length === 0) {
    throw new Error(`Module does not export a tubeless ${label}.`);
  }
  if (unique.length > 1) {
    const names = unique.map(([name]) => name).join(", ");
    const hint = options?.hintExport === false ? "" : "; pass --export <name>";
    throw new Error(`Module exports multiple ${label}s (${names})${hint}.`);
  }
  const [name, value] = unique[0]!;
  return { exportName: name, value };
}

/**
 * Select a plan source. A marked command wins when the module also exports a
 * pipeline. Named exports still have to be a pipeline or a marked command.
 */
function selectPlanSourceExport(
  moduleExports: Record<string, unknown>,
  exportName?: string
): WorkbenchPlanSource {
  if (exportName !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(moduleExports, exportName)) {
      throw new Error(`Module does not export ${JSON.stringify(exportName)}.`);
    }
    const selected = moduleExports[exportName];
    if (isWorkbenchPipelineCommand(selected)) {
      return { kind: "command", command: selected };
    }
    if (isWorkbenchPipeline(selected)) {
      return { kind: "pipeline", pipeline: selected };
    }
    throw new Error(
      `Export ${JSON.stringify(exportName)} is not a tubeless pipeline or pipeline command.`
    );
  }

  const commands = uniqueNamedExports(moduleExports, isWorkbenchPipelineCommand);
  if (commands.length === 1) {
    return { kind: "command", command: commands[0]![1] };
  }
  if (commands.length > 1) {
    throw new Error(
      `Module exports multiple pipeline commands (${commands.map(([name]) => name).join(", ")}); pass --export <name>.`
    );
  }

  const pipelines = uniqueNamedExports(moduleExports, isWorkbenchPipeline);
  if (pipelines.length === 1) {
    return { kind: "pipeline", pipeline: pipelines[0]![1] };
  }
  if (pipelines.length > 1) {
    throw new Error(
      `Module exports multiple pipelines (${pipelines.map(([name]) => name).join(", ")}); pass --export <name>.`
    );
  }
  throw new Error("Module does not export a tubeless pipeline or pipeline command.");
}

/** Import a JS/TS module as a string-keyed export namespace. */
export async function importModuleNamespace(filePath: string): Promise<Record<string, unknown>> {
  // SAFETY: a dynamic import of a JS/TS module always yields a module namespace
  // object whose exports are string-keyed values, so the cast to
  // Record<string, unknown> documents the import result's shape; selectors
  // validate each export at runtime before use.
  return (await import(pathToFileURL(filePath).href)) as Record<string, unknown>;
}

/** Load a marked command when present, otherwise a pipeline, for inspect/plan/graph. */
export async function loadPlanSourceModule(
  filePath: string,
  exportName?: string
): Promise<WorkbenchPlanSource> {
  return selectPlanSourceExport(await importModuleNamespace(filePath), exportName);
}
