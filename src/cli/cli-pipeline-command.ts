import { createCommand } from "./cli-command.js";
import { flagName } from "./cli-parser.js";
import {
  inferCliParams,
  type InferredCliParams,
  type InferredFlagOverrides,
} from "./cli-schema.js";
import type {
  CliBooleanParam,
  CliCheckpointConfig,
  CliCommandConfig,
  CliCommandDescriptor,
  CliContext,
  CliNumberParam,
  CliParams,
  CliParamsSchema,
  CliStringParam,
} from "./cli-types.js";
import { markPipelineCommand } from "../utilities/pipeline-command-marker.js";
import { hasConflictingSelectionControls } from "../core/pipeline-plan.js";
import {
  type Pipeline,
  type PipelineHooks,
  type PipelineInput,
  type PipelineMermaidOptions,
  type StepCachePolicy,
  type PipelinePlan,
  type PipelineResult,
  type PipelineRunControls,
  type StandardSchemaV1,
} from "../core/pipeline.js";
import { createPipelineReporter, type PipelineReporterConfig } from "../reporter/reporter-entry.js";
import { TUBELESS_WORKBENCH_EXIT_CODE } from "./cli-exit.js";

export type PipelineCliBuiltins = {
  stepIds: CliStringParam & { multiple: true };
  targets: CliStringParam & { multiple: true };
  continueOnError: CliBooleanParam;
  maxConcurrency: CliNumberParam;
  cache: CliStringParam & { choices: readonly ["use", "recompute", "bypass"]; optional: true };
};

/** Validated domain parameters plus the built-in pipeline execution controls. */
export type PipelineCliValues<TSchema extends CliParamsSchema> = CliParams<TSchema> & {
  stepIds: readonly string[];
  targets: readonly string[];
  continueOnError: boolean;
  maxConcurrency: number;
  cache?: StepCachePolicy;
};

/** Parse result returned by commands created with `definePipelineCommand`. */
export type PipelineCliParseResult<TSchema extends CliParamsSchema> =
  | { kind: "values"; values: PipelineCliValues<TSchema> }
  | { kind: "help"; helpText: string }
  | { kind: "error"; errors: readonly string[]; helpText: string };

/** Typed CLI facade over a pipeline with planning and graph helpers. */
export interface PipelineCommand<
  TSchema extends CliParamsSchema,
  TResult,
  TPipeline extends Pipeline<object, unknown> = Pipeline<object, TResult>,
> {
  /** Exact pipeline adapted by this command. */
  readonly pipeline: TPipeline;
  readonly descriptor: CliCommandDescriptor;
  /** Stable identity of the wrapped pipeline. */
  readonly id: TPipeline["id"];
  /** Stable definition-order step ids for discovery surfaces such as CLI help. */
  readonly stepIds: TPipeline["stepIds"];
  /** Stable declared goal ids that support dependency-aware target execution. */
  readonly targetIds: TPipeline["targetIds"];
  /** Plan without parsing or requiring domain parameters. */
  plan(controls?: Parameters<TPipeline["plan"]>[0]): PipelinePlan;
  /** Generate a static Mermaid flowchart without running or planning the pipeline. */
  toMermaid(options?: PipelineMermaidOptions): string;
  parse(argv?: readonly string[], context?: Partial<CliContext>): PipelineCliParseResult<TSchema>;
  /** Validate structured form values without tokenizing argv. */
  parseValues(
    values: Record<string, unknown>,
    context?: Partial<CliContext>
  ): PipelineCliParseResult<TSchema>;
  /** Execute already validated form values. */
  execute(values: PipelineCliValues<TSchema>, context?: Partial<CliContext>): Promise<TResult>;
  run(argv?: readonly string[], context?: Partial<CliContext>): Promise<TResult>;
  main(argv?: readonly string[], context?: Partial<CliContext>): Promise<void>;
}

/** Parsed values and CLI services passed to a pipeline hook factory. */
export interface PipelineCommandHookContext<TSchema extends CliParamsSchema> {
  context: CliContext;
  values: PipelineCliValues<TSchema>;
}

/** One lifecycle hook set or an ordered collection of hook sets. */
type PipelineCommandHookSets<TResult> = PipelineHooks<TResult> | readonly PipelineHooks<TResult>[];

/** Static or lazily constructed lifecycle hooks for a pipeline command. */
export type PipelineCommandHookConfig<TResult, TSchema extends CliParamsSchema> =
  | PipelineCommandHookSets<TResult>
  | ((input: PipelineCommandHookContext<TSchema>) => PipelineCommandHookSets<TResult> | undefined);

type PipelineCommandMapOptions<TOptions extends object, TSchema extends CliParamsSchema> = (
  values: PipelineCliValues<TSchema>,
  context: CliContext
) => TOptions | Promise<TOptions>;

type DefaultPipelineCommandOptions<TSchema extends CliParamsSchema> = Omit<
  PipelineCliValues<TSchema>,
  "cache" | "continueOnError" | "maxConcurrency" | "dryRun" | "resume" | "stepIds" | "targets"
>;

type CanDefaultPipelineCommandOptions<TOptions extends object, TSchema extends CliParamsSchema> =
  DefaultPipelineCommandOptions<TSchema> extends TOptions
    ? Exclude<keyof TSchema, keyof TOptions> extends never
      ? true
      : false
    : false;

interface DefinePipelineCommandConfigBase<TResult, TSchema extends CliParamsSchema> {
  /** Defaults to pipeline.name, then pipeline.id. */
  name?: string;
  /** Defaults to pipeline.description. */
  description?: string;
  /** Advanced: replace inferred flags for type-only pipelines or custom CLI inputs. */
  params?: TSchema;
  /** Extra parameter keys accepted in positional order. */
  positionals?: readonly (keyof TSchema & string)[];
  checkpoint?: CliCheckpointConfig;
  /** Expose resume input for application-owned handling without managed checkpointing. */
  resume?: true;
  /** Additional lifecycle hooks, or a factory resolved from parsed values and CLI context. */
  hooks?: PipelineCommandHookConfig<TResult, TSchema>;
  /** Configure plain/interactive reporting, or disable it. Defaults to automatic mode. */
  reporter?: false | PipelineReporterConfig;
  /** Print domain-specific result lines after a successful run. */
  summarize?(
    result: TResult,
    values: PipelineCliValues<TSchema>,
    context: CliContext
  ): readonly string[] | void;
  validate?(values: PipelineCliValues<TSchema>, context: CliContext): string[] | void;
}

/** Configuration for a typed pipeline command. Mapping is optional only for compatible flags. */
export type DefinePipelineCommandConfig<
  TOptions extends object,
  TResult,
  TSchema extends CliParamsSchema,
> = DefinePipelineCommandConfigBase<TResult, TSchema> &
  (CanDefaultPipelineCommandOptions<TOptions, TSchema> extends true
    ? {
        /** Override the default same-name flag-to-option mapping. */
        mapOptions?: PipelineCommandMapOptions<TOptions, TSchema>;
      }
    : {
        /** Required when parsed flags do not already satisfy the pipeline's domain options. */
        mapOptions: PipelineCommandMapOptions<TOptions, TSchema>;
      });

const PIPELINE_COMMAND_KEYS = new Set([
  "cache",
  "continueOnError",
  "maxConcurrency",
  "stepIds",
  "targets",
]);
const PIPELINE_COMMAND_FLAGS = new Set([
  "cache",
  "continue-on-error",
  "max-concurrency",
  "step",
  "target",
]);

function assertNoPipelineCommandConflicts(params: CliParamsSchema): void {
  for (const [key, param] of Object.entries(params)) {
    if (PIPELINE_COMMAND_KEYS.has(key)) {
      throw new Error(
        `"${key}" is a reserved parameter provided automatically by pipeline commands; remove it from params.`
      );
    }
    const flag = flagName(key, param);
    if (PIPELINE_COMMAND_FLAGS.has(flag)) {
      throw new Error(
        `--${flag} is a reserved flag provided automatically by pipeline commands; remove "${key}" from params or give it a different flag name.`
      );
    }
  }
}

function normalizePipelineCliValues<TSchema extends CliParamsSchema>(
  values: CliParams<PipelineCliBuiltins & TSchema>
): PipelineCliValues<TSchema> {
  // SAFETY: `PipelineCliValues<TSchema>` is `CliParams<TSchema>` plus the builtin
  // `stepIds`/`targets`/`continueOnError`/`maxConcurrency` keys, which `CliParams<PipelineCliBuiltins & TSchema>`
  // already provides, so the runtime shape matches the target type.
  const pipelineValues = values as PipelineCliValues<TSchema>;
  const { continueOnError, stepIds, targets } = pipelineValues;
  return {
    ...pipelineValues,
    continueOnError,
    stepIds,
    targets: targets ?? [],
  };
}

function pipelineRunControlsFromCliValues(
  values: {
    continueOnError: boolean;
    maxConcurrency: number;
    cache?: StepCachePolicy;
    dryRun: boolean;
    stepIds: readonly string[];
    targets: readonly string[];
  },
  targetFlagEnabled: boolean
): PipelineRunControls {
  const controls: PipelineRunControls = {
    dryRun: values.dryRun,
    continueOnError: values.continueOnError,
    maxConcurrency: values.maxConcurrency,
    ...(values.cache !== undefined ? { cache: values.cache } : {}),
  };
  if (values.stepIds.length > 0) controls.stepIds = values.stepIds;
  if (targetFlagEnabled && values.targets.length > 0) controls.targets = values.targets;
  return controls;
}

function normalizePipelineHookSets<TResult>(
  hooks: PipelineCommandHookSets<TResult> | undefined
): PipelineHooks<TResult>[] {
  if (!hooks) return [];
  // SAFETY: a non-array `PipelineCommandHookSets` is always a single `PipelineHooks`.
  return Array.isArray(hooks) ? [...hooks] : [hooks as PipelineHooks<TResult>];
}

function isHookConfigFunction<TResult, TSchema extends CliParamsSchema>(
  config: PipelineCommandHookConfig<TResult, TSchema> | undefined
): config is (
  input: PipelineCommandHookContext<TSchema>
) => PipelineCommandHookSets<TResult> | undefined {
  return typeof config === "function";
}

function defaultPipelineCommandOptions<TSchema extends CliParamsSchema>(
  values: PipelineCliValues<TSchema>
): DefaultPipelineCommandOptions<TSchema> {
  const {
    cache: _cache,
    continueOnError: _continueOnError,
    maxConcurrency: _maxConcurrency,
    dryRun: _dryRun,
    resume: _resume,
    stepIds: _stepIds,
    targets: _targets,
    ...domainValues
  } = values;
  return domainValues;
}

function nonBlankPipelineText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Turn a pipeline into a CLI; infer domain flags from its Standard JSON Schema input. */
export function definePipelineCommand<const TPipeline extends Pipeline<object, unknown>>(
  pipeline: TPipeline &
    (keyof PipelineInput<TPipeline> extends never
      ? unknown
      : { readonly optionsSchema: StandardSchemaV1 }),
  config?: Omit<
    DefinePipelineCommandConfigBase<
      PipelineResult<TPipeline>,
      InferredCliParams<NoInfer<PipelineInput<TPipeline>>>
    >,
    "params"
  > & {
    params?: never;
    mapOptions?: never;
    /** Advanced: customize flag spelling, aliases, help or environment fallbacks. */
    overrides?: InferredFlagOverrides<NoInfer<PipelineInput<TPipeline>>>;
  }
): PipelineCommand<
  InferredCliParams<PipelineInput<TPipeline>>,
  PipelineResult<TPipeline>,
  TPipeline
>;
/** Advanced: declare CLI inputs explicitly, mapping them only when their shape differs. */
export function definePipelineCommand<
  const TPipeline extends Pipeline<object, unknown>,
  const TSchema extends CliParamsSchema = {},
>(
  pipeline: TPipeline,
  config: DefinePipelineCommandConfig<
    NoInfer<PipelineInput<TPipeline>>,
    PipelineResult<TPipeline>,
    TSchema
  >
): PipelineCommand<TSchema, PipelineResult<TPipeline>, TPipeline>;
export function definePipelineCommand<
  const TPipeline extends Pipeline<object, unknown>,
  const TSchema extends CliParamsSchema = {},
>(
  pipeline: TPipeline,
  config: DefinePipelineCommandConfigBase<PipelineResult<TPipeline>, TSchema> & {
    mapOptions?: PipelineCommandMapOptions<PipelineInput<TPipeline>, TSchema>;
    overrides?: InferredFlagOverrides<PipelineInput<TPipeline>>;
  } = {}
): PipelineCommand<TSchema, PipelineResult<TPipeline>, TPipeline> {
  type TOptions = PipelineInput<TPipeline>;
  type TResult = PipelineResult<TPipeline>;
  // SAFETY: explicit params retain TSchema; the inferred overload derives its schema
  // from the same pipeline input type. Type-only pipelines have no runtime fields.
  const userParams = (config.params ??
    (pipeline.optionsSchema && !config.mapOptions
      ? inferCliParams(pipeline.optionsSchema, config.overrides)
      : {})) as TSchema;
  if (config.overrides && (config.params || config.mapOptions || !pipeline.optionsSchema)) {
    throw new Error(
      "Flag overrides require inferred pipeline flags; use params for an explicit CLI."
    );
  }
  assertNoPipelineCommandConflicts(userParams);

  const targetFlagEnabled = pipeline.targetIds.length > 0;
  const bridgeParams: CliParamsSchema = {
    cache: {
      type: "string",
      choices: ["use", "recompute", "bypass"],
      optional: true,
      group: "execution",
      description: "Override the cache policy for opted-in steps, including child pipelines.",
    },
    stepIds: {
      type: "string",
      multiple: true,
      flag: "step",
      group: "execution",
      exclusive: true,
      choices: pipeline.stepIds,
      description: "Run exactly this step.",
    },
    continueOnError: {
      type: "boolean",
      group: "execution",
      description: "Continue independent work after a step fails.",
    },
    maxConcurrency: {
      type: "number",
      group: "execution",
      default: 1,
      integer: true,
      min: 1,
      description: "Maximum simultaneous steps in this run.",
    },
  };
  if (targetFlagEnabled) {
    bridgeParams.targets = {
      type: "string",
      multiple: true,
      flag: "target",
      group: "execution",
      exclusive: true,
      choices: pipeline.targetIds,
      description: "Run this declared target and its prerequisites.",
    };
  }

  // SAFETY: `bridgeParams` supplies the `PipelineCliBuiltins` keys and `userParams` is
  // `TSchema`, so the merged object satisfies `PipelineCliBuiltins & TSchema`.
  const params = { ...bridgeParams, ...userParams } as PipelineCliBuiltins & TSchema;
  const inheritedName = nonBlankPipelineText(pipeline.name);
  const inheritedDescription = nonBlankPipelineText(pipeline.description);

  const commandConfig = {
    name: config.name ?? inheritedName ?? pipeline.id,
    description: config.description ?? inheritedDescription,
    params,
    positionals: config.positionals,
    checkpoint: config.checkpoint,
    resume: config.resume,
    validate: (values, context) => {
      const pipelineValues = normalizePipelineCliValues<TSchema>(values);
      const errors = config.validate?.(pipelineValues, context) ?? [];
      if (
        hasConflictingSelectionControls(
          pipelineRunControlsFromCliValues(pipelineValues, targetFlagEnabled)
        )
      ) {
        return ["--step and --target cannot be used together.", ...errors];
      }
      return errors.length > 0 ? errors : undefined;
    },
    run: async (values, cliContext) => {
      const pipelineValues = normalizePipelineCliValues<TSchema>(values);
      let mapped: TOptions;
      if (config.mapOptions) {
        mapped = await config.mapOptions(pipelineValues, cliContext);
      } else {
        // SAFETY: `defaultPipelineCommandOptions` returns exactly the domain options the
        // `CanDefaultPipelineCommandOptions` constraint guarantees map to `TOptions`.
        mapped = defaultPipelineCommandOptions(pipelineValues) as TOptions;
      }
      const controls = pipelineRunControlsFromCliValues(pipelineValues, targetFlagEnabled);

      const reporter =
        config.reporter === false
          ? undefined
          : createPipelineReporter<TResult>({
              log: cliContext.log,
              ...(config.reporter ?? {}),
              ...(cliContext.reporterOutput ? { output: cliContext.reporterOutput } : {}),
            });
      const runtimeContext = reporter ? { ...cliContext, log: reporter.log } : cliContext;
      let result: TResult;
      try {
        const configuredHooks = isHookConfigFunction(config.hooks)
          ? config.hooks({ context: runtimeContext, values: pipelineValues })
          : config.hooks;
        const hooks: PipelineHooks<TResult>[] = [
          ...normalizePipelineHookSets(cliContext.pipelineContext?.hooks),
          ...(reporter ? [reporter.hooks] : []),
          ...normalizePipelineHookSets(configuredHooks),
        ];

        // SAFETY: TResult is extracted from this exact pipeline's runOrThrow return type.
        result = (await pipeline.runOrThrow(mapped, controls, {
          ...cliContext.pipelineContext,
          cwd: runtimeContext.cwd,
          log: runtimeContext.log,
          hooks: hooks.length > 0 ? hooks : undefined,
          signal: runtimeContext.signal,
        })) as TResult;
      } finally {
        reporter?.dispose();
      }
      for (const line of config.summarize?.(result, pipelineValues, cliContext) ?? []) {
        cliContext.log.log(line);
      }
      return result;
    },
  } satisfies CliCommandConfig<PipelineCliBuiltins & TSchema, TResult>;

  const command = createCommand(commandConfig, {
    validation: TUBELESS_WORKBENCH_EXIT_CODE.validation,
  });

  function parse(
    argv: readonly string[] = process.argv.slice(2),
    contextOverrides?: Partial<CliContext>
  ): PipelineCliParseResult<TSchema> {
    const result = command.parse(argv, contextOverrides);
    return result.kind === "values"
      ? { kind: "values", values: normalizePipelineCliValues<TSchema>(result.values) }
      : result;
  }

  function plan(controls: Parameters<TPipeline["plan"]>[0] = {}): PipelinePlan {
    return pipeline.plan(controls);
  }

  function parseValues(
    values: Record<string, unknown>,
    contextOverrides?: Partial<CliContext>
  ): PipelineCliParseResult<TSchema> {
    const result = command.parseValues(values, contextOverrides);
    return result.kind === "values"
      ? { kind: "values", values: normalizePipelineCliValues<TSchema>(result.values) }
      : result;
  }

  return markPipelineCommand(
    {
      pipeline,
      descriptor: command.descriptor,
      id: pipeline.id,
      stepIds: pipeline.stepIds,
      targetIds: pipeline.targetIds,
      execute: (values, contextOverrides) =>
        // SAFETY: `execute` receives `PipelineCliValues<TSchema>` from the public interface,
        // which is a subtype of `CliParams<PipelineCliBuiltins & TSchema>`.
        command.execute(values as CliParams<PipelineCliBuiltins & TSchema>, contextOverrides),
      parse,
      parseValues,
      plan,
      toMermaid: (options) => pipeline.toMermaid(options),
      run: command.run,
      main: command.main,
    },
    pipeline
  );
}
