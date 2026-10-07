import { parseArgs, type ParseArgsConfig } from "node:util";
import { didYouMean } from "../utilities/suggest.js";
import {
  errorMessage,
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";

type SubcommandOptions = NonNullable<ParseArgsConfig["options"]>;

/** Select a pipeline or command export from a module. */
export const EXPORT_OPTION = { export: { type: "string", short: "e" } } as const;

/** Resolve a pipeline or command export from a project file or module. */
export const REGISTRATION_OPTIONS = {
  ...EXPORT_OPTION,
  project: { type: "string", short: "p" },
} as const;

/** Choose the SQLite store or NDJSON trace a command records to or reads from. */
export const RUN_HISTORY_OPTIONS = {
  store: { type: "string" },
  trace: { type: "string" },
} as const;

/** Filter inspected or graphed steps by graph metadata. */
export const STEP_METADATA_FILTER_OPTIONS = {
  domain: { type: "string" },
  owner: { type: "string" },
  tag: { type: "string", multiple: true },
} as const;

/** Strict subcommand parsing with positionals; every subcommand accepts `-h, --help`. */
export function parseSubcommandArgs<const T extends SubcommandOptions>(
  argv: readonly string[],
  options: T
) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { ...options, help: { type: "boolean", short: "h" } } as const,
    strict: true,
  });
}

interface ParsedSubcommand {
  values: { help?: boolean };
  positionals: readonly string[];
}

/**
 * Shared prologue for workbench subcommands. New subcommands should be written
 * against `runWorkbenchSubcommand` so usage, help, and positional checks stay
 * in one place. Extra validation after that prologue belongs in `run`.
 */
export interface WorkbenchSubcommand<TParsed extends ParsedSubcommand> {
  readonly usage: string;
  parse(argv: readonly string[]): TParsed;
  readonly positionalCountError?: { count: number; message: string };
  run(parsed: TParsed, io: WorkbenchCliIo): Promise<number>;
}

export async function runWorkbenchSubcommand<TParsed extends ParsedSubcommand>(
  command: WorkbenchSubcommand<TParsed>,
  argv: readonly string[],
  io: WorkbenchCliIo
): Promise<number> {
  let parsed: TParsed;
  try {
    parsed = command.parse(argv);
  } catch (error) {
    return writeUsageError(io, parseErrorMessage(error, command.usage), command.usage);
  }
  if (parsed.values.help === true) {
    io.stdout.write(command.usage);
    return TUBELESS_WORKBENCH_EXIT_CODE.success;
  }
  const positionalError = command.positionalCountError;
  if (positionalError && parsed.positionals.length !== positionalError.count) {
    return writeUsageError(io, positionalError.message, command.usage);
  }
  return command.run(parsed, io);
}

/**
 * `node:util` `parseArgs` rejects unknown flags with a verbose message naming the
 * offending token. Report it in the same shape as pipeline commands. The usage
 * text documents every long flag a subcommand accepts, so near-misses are
 * suggested from it without a second option list.
 */
function parseErrorMessage(error: unknown, usage: string): string {
  const message = errorMessage(error);
  if ((error as { code?: unknown } | null)?.code !== "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    return message;
  }
  const token = /^Unknown option '([^']+)'/.exec(message)?.[1];
  if (token === undefined) return message;
  const unknown = `Unknown option: ${token}.`;
  if (!token.startsWith("--")) return unknown;
  const flags = usage.match(/--[a-z][a-z0-9-]*/g) ?? [];
  const suggestion = didYouMean(token.split("=", 1)[0], flags, (candidate) => candidate);
  return suggestion === undefined ? unknown : `${unknown} ${suggestion}`;
}
