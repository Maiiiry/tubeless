import * as path from "path";
import { openCheckpoint, type CheckpointStore } from "../node/checkpoint.js";
import {
  assertNoDuplicateFlags,
  assertValidEnvironmentFallbacks,
  assertValidMultipleParams,
  assertValidPositionals,
  buildEffectiveSchema,
  commandDescriptor,
  renderHelp,
  resolveParam,
  tokenize,
  type ResolvedParamValue,
} from "./cli-parser.js";
import {
  CliHelpRequested,
  CliValidationError,
  type CliCommand,
  type CliCommandConfig,
  type CliContext,
  type CliParams,
  type CliParamsSchema,
  type CliParseResult,
} from "./cli-types.js";
import {
  cliValidationReportLines,
  isCliValidationError,
  isPipelineExecutionError,
  toExitCode,
} from "./cli-exit.js";

function resolveContext(overrides?: Partial<CliContext>): CliContext {
  return {
    cwd: overrides?.cwd ?? process.cwd(),
    env: overrides?.env ?? process.env,
    log: overrides?.log ?? console,
    reporterOutput: overrides?.reporterOutput,
    pipelineContext: overrides?.pipelineContext,
    signal: overrides?.signal,
    checkpoint: overrides?.checkpoint,
  };
}

interface ManagedMainSignal {
  context: CliContext;
  wasInterrupted(): boolean;
  cleanup(): void;
}

const SIGINT_EXIT_CODE = 130;

/**
 * Give real CLI entrypoints graceful cancellation without making `run()` or
 * `parse()` mutate process-global signal handlers. Embedded callers can pass
 * their own signal through the context instead.
 */
function manageMainSignal(context: CliContext): ManagedMainSignal {
  if (context.signal) {
    return { context, wasInterrupted: () => false, cleanup: () => {} };
  }

  const controller = new AbortController();
  let interrupted = false;
  const onSigint = (): void => {
    interrupted = true;
    context.log.warn("SIGINT received; cancelling pipeline work.");
    controller.abort();
  };
  process.once("SIGINT", onSigint);

  return {
    context: { ...context, signal: controller.signal },
    wasInterrupted: () => interrupted,
    cleanup: () => process.removeListener("SIGINT", onSigint),
  };
}

/**
 * An in-memory-only `CheckpointStore` seeded from `seed`: reads and `record()` behave
 * exactly like a real store for the rest of this run, but `flush()`/`clear()` never touch
 * disk. Every dry-run path hands `run` one of these instead of the real store — the
 * managed-checkpoint contract is that a dry run never writes to the checkpoint file, no
 * matter what `run` does with `context.checkpoint` (`record`/`flush`/`clear`, directly or
 * via `withCheckpointedBatch`).
 */
function inMemoryCheckpointView(seed: ReadonlyMap<string, unknown>): CheckpointStore {
  const entries = new Map(seed);
  return {
    has: (key) => entries.has(key),
    record: (key, meta) => {
      entries.set(key, meta);
    },
    entries: () => entries,
    flush: () => {},
    clear: () => {
      entries.clear();
    },
  };
}

export function createCommand<const TSchema extends CliParamsSchema, TResult = void>(
  config: CliCommandConfig<TSchema, TResult>,
  mainExits?: { validation?: number }
): CliCommand<TSchema, TResult> {
  const effectiveParams = buildEffectiveSchema(config.params, config.checkpoint, config.resume);
  assertNoDuplicateFlags(effectiveParams);
  assertValidMultipleParams(effectiveParams);
  assertValidEnvironmentFallbacks(effectiveParams);
  const positionals = [...(config.positionals ?? [])];
  assertValidPositionals(positionals, effectiveParams);
  const descriptor = commandDescriptor(config, effectiveParams, positionals);

  function resolveValues(
    readValue: (
      key: string,
      param: CliParamsSchema[string]
    ) => string | boolean | string[] | undefined,
    context: CliContext,
    errors: string[],
    helpText: string
  ): CliParseResult<TSchema> {
    const values: Record<string, ResolvedParamValue> = { resume: false };
    for (const [key, param] of Object.entries(effectiveParams)) {
      const errorCount = errors.length;
      const raw = readValue(key, param);
      if (errors.length > errorCount) continue;
      const envValue = raw === undefined && param.env ? context.env?.[param.env] : undefined;
      Object.defineProperty(values, key, {
        value: resolveParam(
          key,
          param,
          raw ?? envValue,
          context.cwd,
          errors,
          raw !== undefined ? "argv" : envValue !== undefined ? "env" : "default"
        ),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    if (errors.length > 0) return { kind: "error", errors, helpText };
    // SAFETY: resolveParam populated every effective schema key and all input checks passed.
    const typedValues = values as CliParams<TSchema>;
    const validationErrors = config.validate?.(typedValues, context) ?? [];
    return validationErrors.length > 0
      ? { kind: "error", errors: validationErrors, helpText }
      : { kind: "values", values: typedValues };
  }

  function parseWithContext(argv: readonly string[], context: CliContext): CliParseResult<TSchema> {
    const helpText = renderHelp(
      descriptor.name,
      descriptor.description,
      effectiveParams,
      positionals
    );
    const tokenized = tokenize(argv, effectiveParams, positionals);
    if (tokenized.help) return { kind: "help", helpText };
    return resolveValues(
      (key) => tokenized.values.get(key),
      context,
      [...tokenized.errors],
      helpText
    );
  }

  function parse(
    argv: readonly string[] = process.argv.slice(2),
    contextOverrides?: Partial<CliContext>
  ): CliParseResult<TSchema> {
    return parseWithContext(argv, resolveContext(contextOverrides));
  }

  function parseStructuredWithContext(
    structuredValues: Record<string, unknown>,
    context: CliContext
  ): CliParseResult<TSchema> {
    const helpText = renderHelp(
      descriptor.name,
      descriptor.description,
      effectiveParams,
      positionals
    );
    const errors: string[] = [];
    for (const key of Object.keys(structuredValues)) {
      if (!Object.prototype.hasOwnProperty.call(effectiveParams, key)) {
        errors.push(`Unknown parameter: ${key}`);
      }
    }
    return resolveValues(
      (key, param) => normalizeStructuredValue(key, param, structuredValues[key], errors),
      context,
      errors,
      helpText
    );
  }

  /**
   * No-op unless `config.checkpoint` is set. Respects a caller-provided `context.checkpoint`
   * override (e.g. a stub in tests) instead of opening the real file. Otherwise opens (or
   * clears, if not resuming) the checkpoint before `run` is called — never on the `--help`/
   * error paths, since those return before this is reached.
   */
  function attachCheckpoint(context: CliContext, values: CliParams<TSchema>): CliContext {
    const checkpointConfig = config.checkpoint;
    if (!checkpointConfig) {
      return context;
    }
    const resolvedPath = path.isAbsolute(checkpointConfig.path)
      ? checkpointConfig.path
      : path.join(context.cwd, checkpointConfig.path);
    // A caller-provided context.checkpoint (e.g. a stub in tests) is used as the
    // underlying store instead of opening the real file, but every rule below — fresh
    // clearing, dry-run wrapping, resume detection/logging — still applies to it; only
    // the "where does the store come from" step is skipped.
    const store = context.checkpoint ?? openCheckpoint(resolvedPath);
    const hadExisting = store.entries().size > 0;

    if (values.resume) {
      if (hadExisting) {
        context.log.log(
          `Resuming from checkpoint: ${store.entries().size} item(s) already recorded.`
        );
      } else {
        // Without this, --resume against a missing/wrong-path/already-cleared checkpoint
        // silently starts fresh — the exact failure mode that's dangerous for
        // clearOnSuccess: false workflows, where "fresh" quietly means "reprocess
        // everything already done".
        context.log.warn(
          `--resume was passed, but no checkpoint was found at ${resolvedPath}; starting fresh.`
        );
      }
      // A dry run must never write to the checkpoint file, even while resuming — an
      // in-memory view seeded with the real entries previews it accurately without risk.
      return {
        ...context,
        checkpoint: values.dryRun ? inMemoryCheckpointView(store.entries()) : store,
      };
    }

    if (!hadExisting) {
      return {
        ...context,
        checkpoint: values.dryRun ? inMemoryCheckpointView(store.entries()) : store,
      };
    }

    if (values.dryRun) {
      // Dry run must not touch the file — neither clearing it nor writing new progress —
      // but the preview should still reflect what a real fresh run would see: an empty
      // "done" set, not the stale entries a --resume invocation would use.
      context.log.log("Dry run: leaving existing checkpoint untouched (would start fresh).");
      return { ...context, checkpoint: inMemoryCheckpointView(new Map()) };
    }

    store.clear();
    context.log.log("Starting fresh — cleared existing checkpoint.");
    return { ...context, checkpoint: store };
  }

  /**
   * No-op unless `config.checkpoint` is set, a store is attached, and the run completed
   * without a dry run or caller cancellation.
   */
  function finalizeCheckpoint(context: CliContext, values: CliParams<TSchema>): void {
    const checkpointConfig = config.checkpoint;
    if (!checkpointConfig || !context.checkpoint || values.dryRun || context.signal?.aborted) {
      return;
    }
    if (checkpointConfig.clearOnSuccess === false) {
      return;
    }
    context.checkpoint.clear();
  }

  async function executeValues(values: CliParams<TSchema>, context: CliContext): Promise<TResult> {
    const runContext = attachCheckpoint(context, values);
    const value = await config.run(values, runContext);
    finalizeCheckpoint(runContext, values);
    return value;
  }

  function parseValues(
    values: Record<string, unknown>,
    contextOverrides?: Partial<CliContext>
  ): CliParseResult<TSchema> {
    const context = resolveContext(contextOverrides);
    return parseStructuredWithContext(values, context);
  }

  async function execute(
    values: CliParams<TSchema>,
    contextOverrides?: Partial<CliContext>
  ): Promise<TResult> {
    return executeValues(values, resolveContext(contextOverrides));
  }

  async function run(
    argv: readonly string[] = process.argv.slice(2),
    contextOverrides?: Partial<CliContext>
  ): Promise<TResult> {
    const context = resolveContext(contextOverrides);
    const result = parseWithContext(argv, context);
    if (result.kind === "help") throw new CliHelpRequested(result.helpText);
    if (result.kind === "error") throw new CliValidationError(result.errors, result.helpText);
    return executeValues(result.values, context);
  }

  async function main(
    argv: readonly string[] = process.argv.slice(2),
    contextOverrides?: Partial<CliContext>
  ): Promise<void> {
    const context = resolveContext(contextOverrides);
    let result: CliParseResult<TSchema>;
    try {
      result = parseWithContext(argv, context);
    } catch (error) {
      context.log.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exitCode =
        mainExits || isCliValidationError(error) || isPipelineExecutionError(error)
          ? toExitCode(error)
          : 1;
      return;
    }
    if (result.kind === "help") {
      context.log.log(result.helpText);
      process.exitCode = 0;
      return;
    }
    if (result.kind === "error") {
      for (const line of cliValidationReportLines(result.errors, result.helpText)) {
        context.log.error(line);
      }
      process.exitCode = mainExits?.validation ?? 1;
      return;
    }
    const managedSignal = manageMainSignal(context);
    try {
      const runContext = attachCheckpoint(managedSignal.context, result.values);
      await config.run(result.values, runContext);
      if (!managedSignal.wasInterrupted()) {
        finalizeCheckpoint(runContext, result.values);
      }
    } catch (error) {
      context.log.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exitCode = managedSignal.wasInterrupted()
        ? SIGINT_EXIT_CODE
        : mainExits || isCliValidationError(error) || isPipelineExecutionError(error)
          ? toExitCode(error)
          : 1;
    } finally {
      if (managedSignal.wasInterrupted()) {
        process.exitCode = SIGINT_EXIT_CODE;
      }
      managedSignal.cleanup();
    }
  }

  return { descriptor, execute, parse, parseValues, run, main };
}

function normalizeStructuredValue(
  key: string,
  param: CliParamsSchema[string],
  value: unknown,
  errors: string[]
): string | boolean | string[] | undefined {
  if (value === undefined) return undefined;
  const label = `--${param.flag ?? key}`;
  if (param.type === "boolean") {
    if (typeof value === "boolean") return value;
    errors.push(`${label} must be a boolean value.`);
    return undefined;
  }
  if ((param.type === "number" || param.type === "string") && param.multiple === true) {
    if (!Array.isArray(value)) {
      errors.push(`${label} must be an array.`);
      return undefined;
    }
    if (param.type === "number") {
      if (!value.every((item) => typeof item === "number" && Number.isFinite(item))) {
        errors.push(`${label} must contain only finite numbers.`);
        return undefined;
      }
      return value.map(String);
    }
    if (!value.every((item) => typeof item === "string")) {
      errors.push(`${label} must contain only strings.`);
      return undefined;
    }
    return [...value];
  }
  if (param.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(`${label} must be a finite number.`);
      return undefined;
    }
    return String(value);
  }
  if (typeof value !== "string") {
    errors.push(`${label} must be a string value.`);
    return undefined;
  }
  return value;
}

/** Create a typed command from a declarative parameter schema and run handler. */
export function defineCommand<const TSchema extends CliParamsSchema, TResult = void>(
  config: CliCommandConfig<TSchema, TResult>
): CliCommand<TSchema, TResult> {
  return createCommand(config);
}
