import * as fs from "fs";
import * as path from "path";
import { didYouMean } from "../utilities/suggest.js";
import type {
  CliBooleanParam,
  CliCheckpointConfig,
  CliCommandConfig,
  CliCommandDescriptor,
  CliNumberParam,
  CliParam,
  CliParameterDescriptor,
  CliParamsSchema,
  CliStringParam,
} from "./cli-types.js";

/**
 * Every command gets `-h`/`--help` and `--dry-run` for free, the same way every pipeline
 * step gets `context.dryRun`. `--resume`/`--no-resume` is added only for managed
 * checkpointing or an explicit application-owned resume capability. Schemas can't
 * redeclare any of these names; `defineCommand` throws immediately if one tries, instead
 * of silently shadowing the built-in.
 */
const DRY_RUN_KEY = "dryRun";
const DRY_RUN_PARAM: CliBooleanParam = {
  type: "boolean",
  description: "Preview without making changes.",
  group: "execution",
};
const RESUME_KEY = "resume";
const RESERVED_FLAG_NAMES: ReadonlySet<string> = new Set([
  "help",
  "dry-run",
  "resume",
  "no-resume",
]);

export function buildEffectiveSchema(
  params: CliParamsSchema,
  checkpoint: CliCheckpointConfig | undefined,
  resume: true | undefined
): CliParamsSchema {
  if (Object.prototype.hasOwnProperty.call(params, DRY_RUN_KEY)) {
    throw new Error(
      `"${DRY_RUN_KEY}" is a reserved parameter provided automatically by every command; remove it from params.`
    );
  }
  if (Object.prototype.hasOwnProperty.call(params, RESUME_KEY)) {
    throw new Error(
      `"${RESUME_KEY}" is a reserved parameter; set resume: true on the command instead of declaring it in params.`
    );
  }
  const effectiveParams: CliParamsSchema = {
    [DRY_RUN_KEY]: DRY_RUN_PARAM,
  };
  if (checkpoint || resume === true) {
    effectiveParams[RESUME_KEY] = {
      type: "boolean",
      description: "Resume: skip work that's already done instead of starting fresh.",
      default: checkpoint?.defaultResume ?? false,
      group: "execution",
    };
  }
  for (const [key, param] of Object.entries(params)) {
    Object.defineProperty(effectiveParams, key, {
      value: param,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return effectiveParams;
}

function defaultCommandName(): string {
  const entry = process.argv[1];
  if (!entry) {
    return "command";
  }
  return path.basename(entry).replace(/\.[^./]+$/, "");
}

export function flagName(key: string, param: CliParam): string {
  return param.flag ?? key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** True for a string/number param declared `multiple: true` — the only types that support it. */
function isMultipleParam(
  param: CliParam
): param is (CliStringParam | CliNumberParam) & { multiple: true } {
  return (param.type === "string" || param.type === "number") && param.multiple === true;
}

export function commandDescriptor(
  config: Pick<CliCommandConfig<CliParamsSchema, unknown>, "description" | "name">,
  params: CliParamsSchema,
  positionals: readonly string[]
): CliCommandDescriptor {
  // Preserve schema order for flags while ordering positional slots as declared.
  const positionalEntries = positionals.map((key) => [key, params[key]!] as const);
  let positionalIndex = 0;
  const entries = Object.entries(params).map((entry) =>
    positionals.includes(entry[0]) ? positionalEntries[positionalIndex++]! : entry
  );
  const parameters = entries.map(([key, param]): CliParameterDescriptor => {
    const defaultValue = param.type === "boolean" ? (param.default ?? false) : param.default;
    const required =
      param.type !== "boolean" &&
      !isMultipleParam(param) &&
      !param.optional &&
      param.default === undefined &&
      param.env === undefined;
    const descriptor: MutableCliParameterDescriptor = {
      flag: flagName(key, param),
      key,
      multiple: isMultipleParam(param),
      positional: positionals.includes(key),
      required,
      type: param.type,
    };
    if (param.group !== undefined) {
      descriptor.group = param.group;
    }
    if (param.exclusive === true) {
      descriptor.exclusive = true;
    }
    if (param.type === "string" && param.choices) {
      descriptor.choices = Object.freeze([...param.choices]);
    }
    if (defaultValue !== undefined) {
      descriptor.default = defaultValue;
    }
    if (param.description !== undefined) {
      descriptor.description = param.description;
    }
    if (param.env !== undefined) {
      descriptor.environment = param.env;
    }
    if (param.type === "number" && param.integer) {
      descriptor.integer = true;
    }
    if (param.type === "number" && param.max !== undefined) {
      descriptor.max = param.max;
    }
    if (param.type === "number" && param.min !== undefined) {
      descriptor.min = param.min;
    }
    if (param.type === "path" && param.mustExist) {
      descriptor.mustExist = true;
    }
    if (param.type === "path" && param.kind) {
      descriptor.pathKind = param.kind;
    }
    if (param.short !== undefined) {
      descriptor.short = param.short;
    }
    return Object.freeze(descriptor);
  });
  const command: MutableCliCommandDescriptor = {
    name: config.name ?? defaultCommandName(),
    parameters: Object.freeze(parameters),
  };
  if (config.description !== undefined) {
    command.description = config.description;
  }
  return Object.freeze(command);
}

function usageToken(flag: string, param: CliParam): string {
  if (param.type === "boolean") return `--${flag}`;
  return isMultipleParam(param) ? `--${flag} <${param.type}...>` : `--${flag} <${param.type}>`;
}

function positionalUsageToken(key: string, param: CliParam): string {
  const name = isMultipleParam(param) ? `<${key}...>` : `<${key}>`;
  const optional =
    param.type !== "boolean" &&
    (param.optional || param.default !== undefined || isMultipleParam(param));
  return optional ? `[${name}]` : name;
}

/**
 * One help-row summary: the author's description followed by a bracketed list of
 * constraints. Implicit defaults (`false` booleans, `[]` repeatables) are omitted, and
 * `one of:` comes last so its comma-separated choices can't blur into other entries.
 */
function describeParam(param: CliParam): string {
  const metadata: string[] = [];
  if (param.type === "number") {
    if (param.integer) metadata.push("integer");
    if (param.min !== undefined) metadata.push(`min: ${param.min}`);
    if (param.max !== undefined) metadata.push(`max: ${param.max}`);
  }
  if (param.type === "path" && param.kind && param.mustExist) {
    metadata.push(`must be a ${param.kind}`);
  }
  if (isMultipleParam(param)) {
    metadata.push("repeatable");
  } else if (param.type === "boolean") {
    if (param.default === true) metadata.push("default: true");
  } else if (param.default !== undefined) {
    metadata.push(`default: ${JSON.stringify(param.default)}`);
  } else if (!param.optional) {
    metadata.push("required");
  }
  if (param.env) {
    metadata.push(`env: ${param.env}`);
  }
  if (param.type === "string" && param.choices) {
    metadata.push(`one of: ${param.choices.join(", ")}`);
  }
  const bracketed = metadata.length > 0 ? `[${metadata.join(", ")}]` : undefined;
  return [param.description, bracketed].filter(Boolean).join(" ");
}

const HELP_ROW: readonly [usage: string, summary: string] = [
  "-h, --help",
  "Show this help message.",
];

export function renderHelp(
  name: string,
  description: string | undefined,
  schema: CliParamsSchema,
  positionals: readonly string[]
): string {
  const domainRows: (readonly [string, string])[] = [];
  const executionRows: (readonly [string, string])[] = [];
  for (const [key, param] of Object.entries(schema)) {
    const longUsage = usageToken(flagName(key, param), param);
    const usage = param.short ? `-${param.short}, ${longUsage}` : longUsage;
    (param.group === "execution" ? executionRows : domainRows).push([usage, describeParam(param)]);
  }
  domainRows.push(HELP_ROW);
  const width = Math.max(10, ...[...domainRows, ...executionRows].map(([usage]) => usage.length));
  const positionalUsage = positionals
    .map((key) => positionalUsageToken(key, schema[key]!))
    .join(" ");
  const lines = [`Usage: ${name} [options]${positionalUsage ? ` ${positionalUsage}` : ""}`];
  if (description) {
    lines.push("", description);
  }
  const pushSection = (title: string, rows: readonly (readonly [string, string])[]): void => {
    lines.push("", title);
    for (const [usage, summary] of rows) {
      lines.push(summary ? `  ${usage.padEnd(width)}  ${summary}` : `  ${usage}`);
    }
  };
  pushSection("Options:", domainRows);
  if (executionRows.length > 0) {
    pushSection("Pipeline controls:", executionRows);
  }
  return lines.join("\n");
}

export interface TokenizeResult {
  values: Map<string, string | boolean | string[]>;
  errors: string[];
  help: boolean;
}

interface CliParamEntry {
  flag: string;
  key: string;
  param: CliParam;
}

function buildParamEntries(schema: CliParamsSchema): CliParamEntry[] {
  return Object.entries(schema).map(([key, param]) => ({ key, param, flag: flagName(key, param) }));
}

/** Every spelling `tokenize` accepts after `--`, for unknown-option suggestions. */
function longFlagNames(entries: readonly CliParamEntry[]): string[] {
  const names = entries.flatMap(({ flag, param }) =>
    param.type === "boolean" ? [flag, `no-${flag}`] : [flag]
  );
  names.push("help");
  return names;
}

export function tokenize(
  argv: readonly string[],
  schema: CliParamsSchema,
  positionals: readonly string[]
): TokenizeResult {
  const entries = buildParamEntries(schema);
  const paramByFlag = new Map<string, CliParamEntry>();
  const paramByShort = new Map<string, CliParamEntry>();
  const positionalEntries = positionals.map(
    // SAFETY: `assertValidPositionals` (run by callers before `tokenize`) rejects any
    // positional key absent from the schema, so every positional is present in `entries`.
    (key) => entries.find((entry) => entry.key === key) as CliParamEntry
  );
  for (const entry of entries) {
    paramByFlag.set(entry.flag, entry);
    if (entry.param.short) {
      paramByShort.set(entry.param.short, entry);
    }
  }

  const values = new Map<string, string | boolean | string[]>();
  const errors: string[] = [];
  let help = false;
  let positionalIndex = 0;
  let afterOptions = false;
  let unknownFlagValueIndex = -1;

  const assignValue = (entry: CliParamEntry, value: string | boolean): void => {
    if (isMultipleParam(entry.param)) {
      const collected = values.get(entry.key);
      const array = Array.isArray(collected) ? collected : [];
      // SAFETY: only string/number params support `multiple`, and `assignValue` is only
      // reached with boolean values for boolean params, so `value` here is always a string.
      array.push(value as string);
      values.set(entry.key, array);
      return;
    }
    values.set(entry.key, value);
  };

  const nextPositionalEntry = (): CliParamEntry | undefined => {
    while (
      positionalIndex < positionalEntries.length &&
      values.has(positionalEntries[positionalIndex]!.key) &&
      !isMultipleParam(positionalEntries[positionalIndex]!.param)
    ) {
      positionalIndex++;
    }
    return positionalEntries[positionalIndex];
  };

  const assignPositional = (token: string): void => {
    const entry = nextPositionalEntry();
    if (!entry) {
      errors.push(`Unexpected argument: ${token}`);
      return;
    }
    assignValue(entry, token);
    if (!isMultipleParam(entry.param)) {
      positionalIndex++;
    }
  };

  const nextValue = (index: number, name: string): string | undefined => {
    const next = argv[index + 1];
    // A known short option must not be consumed as a value, but negative numeric
    // values and ordinary dash-prefixed paths remain valid option values.
    if (
      next === undefined ||
      next.startsWith("--") ||
      next === "-h" ||
      (next.length === 2 && next.startsWith("-") && paramByShort.has(next[1]!))
    ) {
      errors.push(`Missing value for --${name}`);
      return undefined;
    }
    return next;
  };

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!afterOptions && token === "--") {
      afterOptions = true;
      continue;
    }
    if (!afterOptions && (token === "--help" || token === "-h")) {
      help = true;
      continue;
    }
    if (afterOptions || !token.startsWith("-")) {
      // The token right after an unknown `--flag` was almost certainly its value; calling
      // it a stray argument too would only echo the unknown-option error.
      if (index === unknownFlagValueIndex && !nextPositionalEntry()) continue;
      assignPositional(token);
      continue;
    }

    if (!token.startsWith("--")) {
      if (nextPositionalEntry()?.param.type === "number" && /^-\d/.test(token)) {
        assignPositional(token);
        continue;
      }
      if (token.length !== 2) {
        errors.push(`Unknown option: ${token}`);
        continue;
      }
      const entry = paramByShort.get(token[1]!);
      if (!entry) {
        errors.push(`Unknown option: ${token}`);
        continue;
      }
      if (entry.param.type === "boolean") {
        assignValue(entry, true);
        continue;
      }
      const value = nextValue(index, entry.flag);
      if (value !== undefined) {
        assignValue(entry, value);
        index++;
      }
      continue;
    }

    const body = token.slice(2);
    const bodyEqualsIndex = body.indexOf("=");
    const bodyName = bodyEqualsIndex === -1 ? body : body.slice(0, bodyEqualsIndex);

    // A registered flag is matched exactly first, so a real flag that happens to start
    // with "no-" (e.g. a `noCache` param, or an explicit `flag: "no-dry-run"`) is never
    // misread as a negation of some other flag; negation is only inferred as a fallback
    // when the literal name isn't registered.
    const negated = !paramByFlag.has(bodyName) && bodyName.startsWith("no-");
    const withoutNegation = negated ? body.slice(3) : body;
    const equalsIndex = withoutNegation.indexOf("=");
    const name = equalsIndex === -1 ? withoutNegation : withoutNegation.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : withoutNegation.slice(equalsIndex + 1);

    const entry = paramByFlag.get(name);
    if (!entry) {
      const suggestion = didYouMean(bodyName, longFlagNames(entries), (flag) => `--${flag}`);
      errors.push(`Unknown option: --${body}${suggestion ? `. ${suggestion}` : ""}`);
      if (bodyEqualsIndex === -1) unknownFlagValueIndex = index + 1;
      continue;
    }

    if (entry.param.type !== "boolean") {
      if (negated) {
        errors.push(`--no-${name} is only valid for boolean options`);
        continue;
      }
      let value: string;
      if (inlineValue !== undefined) {
        value = inlineValue;
      } else {
        const next = nextValue(index, name);
        if (next === undefined) continue;
        value = next;
        index++;
      }
      assignValue(entry, value);
      continue;
    }

    if (negated && inlineValue !== undefined) {
      errors.push(`--no-${name} cannot be combined with a value`);
    } else if (inlineValue === undefined) {
      values.set(entry.key, !negated);
    } else if (inlineValue === "true") {
      values.set(entry.key, true);
    } else if (inlineValue === "false") {
      values.set(entry.key, false);
    } else {
      errors.push(`--${name} must be true or false, got "${inlineValue}"`);
    }
  }

  return { values, errors, help };
}

/** A single resolved parameter value after CLI/environment/default decoding. */
export type ResolvedParamValue = string | number | boolean | (string | number)[] | undefined;

/** Mutable build-time views of the public descriptors, frozen before return. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MutableCliParameterDescriptor = Mutable<CliParameterDescriptor>;
type MutableCliCommandDescriptor = Mutable<CliCommandDescriptor>;

function isBooleanValue(value: string | boolean | string[] | undefined): value is boolean {
  return typeof value === "boolean";
}

function isStringValue(value: string | boolean | string[] | undefined): value is string {
  return typeof value === "string";
}

function isNumberValue(value: string | number): value is number {
  return typeof value === "number";
}

export function resolveParam(
  key: string,
  param: CliParam,
  raw: string | boolean | string[] | undefined,
  cwd: string,
  errors: string[],
  source: "argv" | "env" | "default" = "argv"
): ResolvedParamValue {
  const flag = flagName(key, param);
  const sourceLabel = source === "env" ? `environment variable ${param.env}` : `--${flag}`;
  const showRawValue = source !== "env";

  if (param.type === "boolean") {
    if (isBooleanValue(raw)) return raw;
    if (isStringValue(raw)) {
      if (raw === "true") return true;
      if (raw === "false") return false;
      errors.push(
        showRawValue
          ? `${sourceLabel} must be true or false, got "${raw}"`
          : `${sourceLabel} must be true or false`
      );
    }
    return param.default ?? false;
  }

  if (isMultipleParam(param)) {
    const rawValues = Array.isArray(raw) ? raw : [];
    const resolved: (string | number)[] = [];
    for (const item of rawValues) {
      if (param.type === "string") {
        if (param.choices && !param.choices.includes(item)) {
          errors.push(choiceError(sourceLabel, param.choices, item, showRawValue));
          continue;
        }
        resolved.push(item);
        continue;
      }
      const value = validateNumberValue(flag, param, item, errors, source, param.env);
      if (value !== undefined) resolved.push(value);
    }
    return resolved;
  }

  if (param.type === "string") {
    const value = isStringValue(raw) ? raw : param.default;
    if (value === undefined) {
      if (param.optional) return undefined;
      errors.push(`Missing required option --${flag}`);
      return undefined;
    }
    if (param.choices && !param.choices.includes(value)) {
      errors.push(choiceError(sourceLabel, param.choices, value, showRawValue));
    }
    return value;
  }

  if (param.type === "number") {
    const rawValue = isStringValue(raw) ? raw : param.default;
    if (rawValue === undefined) {
      if (param.optional) return undefined;
      errors.push(`Missing required option --${flag}`);
      return undefined;
    }
    return validateNumberValue(flag, param, rawValue, errors, source, param.env);
  }

  const rawString = isStringValue(raw) ? raw : param.default;
  if (rawString === undefined) {
    if (param.optional) return undefined;
    errors.push(`Missing required option --${flag}`);
    return undefined;
  }
  const resolved = path.isAbsolute(rawString) ? rawString : path.join(cwd, rawString);
  if (param.mustExist) {
    if (!fs.existsSync(resolved)) {
      errors.push(
        showRawValue
          ? `${sourceLabel} path does not exist: ${resolved}`
          : `${sourceLabel} path does not exist`
      );
      return undefined;
    }
    if (param.kind) {
      const stats = fs.statSync(resolved);
      const matches = param.kind === "directory" ? stats.isDirectory() : stats.isFile();
      if (!matches) {
        errors.push(
          showRawValue
            ? `${sourceLabel} must be a ${param.kind}: ${resolved}`
            : `${sourceLabel} must be a ${param.kind}`
        );
        return undefined;
      }
    }
  }
  return resolved;
}

// Plain decimals only. Number("") and Number(" ") are 0, and Number() also
// accepts hex and exponent forms that a flag value should not imply.
const DECIMAL_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

function decimalNumber(rawValue: string): number | undefined {
  if (!DECIMAL_NUMBER.test(rawValue)) return undefined;
  const value = Number(rawValue);
  return Number.isFinite(value) ? value : undefined;
}

function choiceError(
  sourceLabel: string,
  choices: readonly string[],
  value: string,
  showRawValue: boolean
): string {
  const expected = `${sourceLabel} must be one of: ${choices.join(", ")}`;
  if (!showRawValue) return expected;
  const suggestion = didYouMean(value, choices);
  return `${expected} (got "${value}")${suggestion ? `. ${suggestion}` : ""}`;
}

function validateNumberValue(
  flag: string,
  param: CliNumberParam,
  rawValue: string | number,
  errors: string[],
  source: "argv" | "env" | "default" = "argv",
  envName?: string
): number | undefined {
  const value = isNumberValue(rawValue) ? rawValue : decimalNumber(rawValue);
  const displayValue = String(rawValue);
  const label = source === "env" ? `environment variable ${envName}` : `--${flag}`;
  const received = source === "env" ? "" : `, got "${displayValue}"`;
  if (value === undefined || !Number.isFinite(value)) {
    errors.push(`${label} must be a number${received}`);
    return undefined;
  }
  if (param.integer && !Number.isInteger(value)) {
    errors.push(`${label} must be an integer${received}`);
    return undefined;
  }
  if (param.min !== undefined && value < param.min) {
    errors.push(
      source === "env"
        ? `${label} must be >= ${param.min}`
        : `${label} must be >= ${param.min}, got ${value}`
    );
    return undefined;
  }
  if (param.max !== undefined && value > param.max) {
    errors.push(
      source === "env"
        ? `${label} must be <= ${param.max}`
        : `${label} must be <= ${param.max}, got ${value}`
    );
    return undefined;
  }
  return value;
}

export function assertNoDuplicateFlags(schema: CliParamsSchema): void {
  const keyByFlag = new Map<string, string>();
  const keyByShort = new Map<string, string>();
  for (const [key, param] of Object.entries(schema)) {
    const flag = flagName(key, param);
    // "no-resume" is reserved alongside "resume" (see RESERVED_FLAG_NAMES): the tokenizer
    // exact-matches a registered flag before falling back to "no-" negation, so a schema
    // that claims "no-resume" for itself (derived or via an explicit `flag:` override)
    // would silently intercept it when resume support is enabled.
    const isBuiltInKey = key === DRY_RUN_KEY || key === RESUME_KEY;
    if (!isBuiltInKey && RESERVED_FLAG_NAMES.has(flag)) {
      throw new Error(
        `--${flag} is a reserved flag; remove "${key}" from params or give it a different flag name.`
      );
    }
    const existingKey = keyByFlag.get(flag);
    if (existingKey) {
      throw new Error(`Duplicate --${flag} flag: both "${existingKey}" and "${key}" resolve to it`);
    }
    keyByFlag.set(flag, key);

    if (param.short === undefined) continue;
    if (!/^[A-Za-z]$/.test(param.short) || param.short === "h") {
      throw new Error(
        `"${key}" has invalid short alias "${param.short}"; aliases must be one letter other than "h".`
      );
    }
    const existingShortKey = keyByShort.get(param.short);
    if (existingShortKey) {
      throw new Error(
        `Duplicate -${param.short} alias: both "${existingShortKey}" and "${key}" resolve to it`
      );
    }
    keyByShort.set(param.short, key);
  }
}

/**
 * `default` or `optional` on a `multiple` param would be silently ignored at runtime:
 * `resolveParam`'s `multiple` branch always resolves absent to `[]`, never consulting
 * `param.default`, and `CliParamIsOptional` always resolves `multiple` params as
 * non-optional regardless of `param.optional`. Unlike `default`+`optional` on a scalar
 * param (a harmless, merely-wider type — see the doc comment above
 * `CliParamIsOptional`), these are dead, misleading configuration on a `multiple` param,
 * so they're rejected the same way duplicate/reserved flags are.
 */
export function assertValidMultipleParams(schema: CliParamsSchema): void {
  for (const [key, param] of Object.entries(schema)) {
    if (!isMultipleParam(param)) {
      continue;
    }
    if (param.default !== undefined) {
      throw new Error(
        `"${key}" combines multiple: true with a default; multiple params always resolve to [] when absent and cannot declare a default.`
      );
    }
    if (param.optional) {
      throw new Error(
        `"${key}" combines multiple: true with optional; multiple params always resolve to [] when absent and are never undefined.`
      );
    }
  }
}

export function assertValidPositionals(
  positionals: readonly string[],
  schema: CliParamsSchema
): void {
  const seen = new Set<string>();
  let sawOptional = false;
  for (let index = 0; index < positionals.length; index++) {
    const key = positionals[index]!;
    const param = schema[key];
    if (!param) {
      throw new Error(`Unknown positional parameter "${key}"; it must be declared in params.`);
    }
    if (seen.has(key)) {
      throw new Error(`Duplicate positional parameter "${key}".`);
    }
    seen.add(key);
    if (param.type === "boolean") {
      throw new Error(`"${key}" is boolean and cannot be used as a positional parameter.`);
    }
    if (isMultipleParam(param) && index !== positionals.length - 1) {
      throw new Error(`Repeatable positional parameter "${key}" must be last.`);
    }
    const optional = param.optional || param.default !== undefined || isMultipleParam(param);
    if (sawOptional && !optional) {
      throw new Error(
        `Required positional parameter "${key}" cannot follow an optional positional parameter.`
      );
    }
    sawOptional ||= optional;
  }
}

export function assertValidEnvironmentFallbacks(schema: CliParamsSchema): void {
  for (const [key, param] of Object.entries(schema)) {
    if (param.env === undefined) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(param.env)) {
      throw new Error(`"${key}" has invalid environment variable name "${param.env}".`);
    }
    if (isMultipleParam(param)) {
      throw new Error(
        `"${key}" combines multiple: true with env; repeatable environment values are ambiguous, so pass repeated flags instead.`
      );
    }
  }
}
