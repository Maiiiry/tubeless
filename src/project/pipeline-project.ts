import { pipelineForCommand } from "../utilities/pipeline-command-marker.js";
import { didYouMean } from "../utilities/suggest.js";
import type { PipelineCommand } from "../cli/cli-pipeline-command.js";
import type { Pipeline } from "../core/pipeline.js";

const PIPELINE_PROJECT_MARKER = Symbol.for("tubeless/pipeline-project/v1");

export type AnyProjectPipeline = Pipeline<object, unknown, string, string, string>;

type ProjectEntry = AnyProjectPipeline | PipelineCommand<{}, unknown>;

type EntryPipeline<TEntry extends ProjectEntry> =
  TEntry extends PipelineCommand<{}, unknown> ? TEntry["pipeline"] : TEntry;

type EntryPipelines<TEntries extends readonly ProjectEntry[]> = {
  readonly [TIndex in keyof TEntries]: EntryPipeline<TEntries[TIndex]>;
};

type PipelineId<TPipelines extends readonly AnyProjectPipeline[]> = TPipelines[number]["id"];

type PipelineIds<TPipelines extends readonly AnyProjectPipeline[]> = {
  readonly [TIndex in keyof TPipelines]: TPipelines[TIndex] extends AnyProjectPipeline
    ? TPipelines[TIndex]["id"]
    : never;
};

// Distribute over pipeline candidates and retain those whose possible ids overlap the lookup.
type PipelineById<
  TPipeline extends AnyProjectPipeline,
  TId extends string,
> = TPipeline extends AnyProjectPipeline
  ? string extends TPipeline["id"]
    ? TPipeline
    : [TPipeline["id"] & TId] extends [never]
      ? never
      : TPipeline
  : never;

/** Optional project presentation and execution directory. */
export interface ProjectOptions {
  /** Display name; defaults to the project id. */
  readonly name?: string;
  /** Human-readable purpose of the project. */
  readonly description?: string;
  /** Execution directory for CLI and Studio, relative to the project file. */
  readonly cwd?: string;
}

/** Immutable named pipeline collection, preserving each pipeline's exact type by id. */
export interface PipelineProject<
  TProjectId extends string,
  TPipelines extends readonly AnyProjectPipeline[],
> {
  readonly id: TProjectId;
  readonly name: string;
  readonly description?: string;
  readonly cwd?: string;
  /** Explicit commands from the entry list, in registration order. */
  readonly commands: readonly PipelineCommand<{}, unknown>[];
  /** Underlying pipelines from every entry, in registration order. */
  readonly pipelines: Readonly<TPipelines>;
  readonly pipelineIds: PipelineIds<TPipelines>;
  get<const TId extends PipelineId<TPipelines>>(id: TId): PipelineById<TPipelines[number], TId>;
}

/** Register each pipeline once, directly or through its explicit command. */
export function defineProject<
  const TProjectId extends string,
  const TEntries extends readonly ProjectEntry[],
>(
  id: TProjectId,
  entries: TEntries,
  options?: ProjectOptions
): PipelineProject<TProjectId, EntryPipelines<TEntries>>;
export function defineProject(
  id: string,
  entries: readonly ProjectEntry[],
  options?: ProjectOptions
): PipelineProject<string, readonly AnyProjectPipeline[]> {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error("Project id must be a non-empty string.");
  }
  if (!Array.isArray(entries)) {
    throw new TypeError("defineProject expects an array of pipelines or pipeline commands.");
  }

  if (
    options !== undefined &&
    (typeof options !== "object" || options === null || Array.isArray(options))
  ) {
    throw new TypeError("Project options must be an object.");
  }
  for (const field of ["name", "description", "cwd"] as const) {
    const value = options?.[field];
    if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
      throw new Error(`Project ${field} must be a non-empty string.`);
    }
  }
  const name = options?.name ?? id;
  const description = options?.description;
  const cwd = options?.cwd;

  const pipelines: AnyProjectPipeline[] = [];
  const commands: PipelineCommand<{}, unknown>[] = [];
  const byId = new Map<string, AnyProjectPipeline>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      throw new TypeError("Project entries must be pipelines or definePipelineCommand adapters.");
    }
    const associatedPipeline = pipelineForCommand(entry);
    let pipeline: AnyProjectPipeline;
    if (associatedPipeline) {
      if (
        !("pipeline" in entry) ||
        entry.pipeline !== associatedPipeline ||
        entry.id !== entry.pipeline.id
      ) {
        throw new TypeError("Project commands must be created with definePipelineCommand.");
      }
      pipeline = entry.pipeline;
      commands.push(entry);
    } else {
      if (!("runOrThrow" in entry) || typeof entry.runOrThrow !== "function") {
        throw new TypeError("Project entries must be pipelines or definePipelineCommand adapters.");
      }
      pipeline = entry;
    }
    if (byId.has(pipeline.id)) {
      throw new Error(
        `Project pipeline id ${JSON.stringify(pipeline.id)} is declared more than once.`
      );
    }
    byId.set(pipeline.id, pipeline);
    pipelines.push(pipeline);
  }

  const get: PipelineProject<string, readonly AnyProjectPipeline[]>["get"] = (id) => {
    const pipeline = byId.get(id);
    if (pipeline) return pipeline;
    const suggestion = didYouMean(id, byId.keys());
    throw new Error(
      `Project does not define pipeline ${JSON.stringify(id)}.${suggestion ? ` ${suggestion}` : ""}`
    );
  };

  const project: PipelineProject<string, readonly AnyProjectPipeline[]> = {
    id,
    name,
    ...(description === undefined ? {} : { description }),
    ...(cwd === undefined ? {} : { cwd }),
    commands: Object.freeze(commands),
    pipelines: Object.freeze(pipelines),
    pipelineIds: Object.freeze(pipelines.map((pipeline) => pipeline.id)),
    get,
  };
  Object.defineProperty(project, PIPELINE_PROJECT_MARKER, { value: true });
  return Object.freeze(project);
}

/** Runtime guard used by the workbench when loading a project file. */
export function isPipelineProject(
  value: unknown
): value is PipelineProject<string, readonly AnyProjectPipeline[]> {
  if (typeof value !== "object" || value === null) return false;
  if (!(PIPELINE_PROJECT_MARKER in value)) return false;
  const candidate = value as { id?: unknown; pipelines?: unknown; pipelineIds?: unknown };
  return (
    typeof candidate.id === "string" &&
    Array.isArray(candidate.pipelines) &&
    Array.isArray(candidate.pipelineIds)
  );
}
