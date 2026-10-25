import { PIPELINE_MERMAID_DIRECTIONS } from "../core/pipeline-types.js";
import { didYouMean } from "../utilities/suggest.js";
import {
  DEFAULT_PIPELINE_PROJECT_FILE,
  loadPipelineProjectFile,
  resolveWorkbenchRegistration,
} from "./workbench-project-loader.js";
import {
  terminalSafeText,
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";
import { parseSubcommandArgs, runWorkbenchSubcommand } from "./workbench-subcommand.js";

/**
 * Hidden shell protocol: NUL-delimited triples of kind, value, and description.
 * `v` records carry candidates; `f` records request files and have two empty fields.
 * Shell arguments cannot contain NUL, so those values are omitted. Failures exit 0.
 */
const FILES_DIRECTIVE = "f";

const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;
type CompletionShell = (typeof COMPLETION_SHELLS)[number];

/** A top-level command offered at the command position. */
interface WorkbenchCommandSummary {
  readonly name: string;
  readonly description: string;
  run(argv: readonly string[], io: WorkbenchCliIo): Promise<number>;
}

interface Candidate {
  readonly value: string;
  readonly description?: string;
}

interface Completion {
  readonly candidates: readonly Candidate[];
  readonly files: boolean;
}

/** `text` values are free-form; `target`/`step` come from the plan. */
type FlagValue = "file" | "text" | "target" | "step" | readonly string[];

interface CompletionFlag {
  readonly name: string;
  readonly short?: string;
  readonly description?: string;
  readonly value?: FlagValue;
  readonly positional?: boolean;
  readonly multiple?: boolean;
}

interface SubcommandCompletion {
  readonly flags: readonly CompletionFlag[];
  readonly positional?: "pipeline" | "file" | readonly string[];
}

const POSITIONAL_COMPLETIONS: Readonly<Record<string, SubcommandCompletion["positional"]>> = {
  inspect: "pipeline",
  plan: "pipeline",
  graph: "pipeline",
  run: "pipeline",
  validate: "file",
  ui: "file",
  init: ["cloudflare"],
  auth: ["login", "status", "logout"],
  cloud: ["list", "run", "logs"],
  completion: COMPLETION_SHELLS,
};

/** Built-in commands have no descriptor. Read their own help instead of duplicating flag catalogs. */
async function subcommandSpec(
  command: WorkbenchCommandSummary,
  io: WorkbenchCliIo
): Promise<SubcommandCompletion> {
  let help = "";
  await command.run(["--help"], {
    ...io,
    stdout: {
      write: (chunk) => {
        help += chunk;
      },
    },
  });
  const flags = new Map<string, CompletionFlag>();
  for (const [, short, name, placeholder] of help.matchAll(
    /(?:-(\w), +)?--([\w-]+)(?: <([^>]+)>)?/g
  )) {
    const previous = flags.get(name!);
    const value: FlagValue | undefined =
      placeholder === undefined
        ? undefined
        : name === "direction"
          ? PIPELINE_MERMAID_DIRECTIONS
          : name === "target"
            ? "target"
            : name === "step"
              ? "step"
              : /^(path|file)/.test(placeholder)
                ? "file"
                : "text";
    flags.set(name!, {
      name: name!,
      short: short ?? previous?.short,
      value: value ?? previous?.value,
    });
  }
  return { flags: [...flags.values()], positional: POSITIONAL_COMPLETIONS[command.name] };
}

const NO_COMPLETION: Completion = { candidates: [], files: false };
const FILE_COMPLETION: Completion = { candidates: [], files: true };

function valuesOf(values: readonly string[]): Completion {
  return { candidates: values.map((value) => ({ value })), files: false };
}

async function pipelineIdCandidates(
  projectFile: string | undefined,
  io: WorkbenchCliIo
): Promise<Candidate[]> {
  const loaded = await loadPipelineProjectFile(projectFile ?? DEFAULT_PIPELINE_PROJECT_FILE, io);
  return "exitCode" in loaded
    ? []
    : loaded.registrations.flatMap(({ id }) => (id === undefined ? [] : [{ value: id }]));
}

interface ScannedWords {
  readonly flagValues: ReadonlyMap<string, string>;
  readonly positionals: readonly string[];
  /** Words after a `--` separator, excluding the current word. */
  readonly passthrough?: readonly string[];
  /** Value-taking flag that the current word completes. */
  readonly pendingFlag?: CompletionFlag;
  readonly optionsEnded?: boolean;
}

/** Walk the subcommand's words before the cursor the way its option parser would. */
function scanWords(
  words: readonly string[],
  spec: SubcommandCompletion,
  mode: "workbench" | "run" | "pipeline" = "workbench"
): ScannedWords {
  const flagValues = new Map<string, string>();
  const positionals: string[] = [];
  let pendingFlag: CompletionFlag | undefined;
  let optionsEnded = false;
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (pendingFlag) {
      // Bash splits `--flag=value` into `--flag`, `=`, `value`.
      if (word === "=") continue;
      flagValues.set(pendingFlag.name, word);
      pendingFlag = undefined;
      continue;
    }
    if (word === "--" && !optionsEnded) {
      if (mode === "run") return { flagValues, positionals, passthrough: words.slice(index + 1) };
      optionsEnded = true;
      continue;
    }
    let flag: CompletionFlag | undefined;
    let inlineValue: string | undefined;
    if (!optionsEnded && word.startsWith("--")) {
      const separator = word.indexOf("=");
      const name = separator === -1 ? word.slice(2) : word.slice(2, separator);
      flag = spec.flags.find((candidate) => candidate.name === name);
      if (separator !== -1) inlineValue = word.slice(separator + 1);
    } else if (!optionsEnded && word.startsWith("-") && word.length > 1) {
      // Pipeline commands require a single short letter; parseArgs also accepts attached values.
      if (mode === "pipeline" && word.length !== 2) continue;
      flag = spec.flags.find((candidate) => candidate.short === word[1]);
      if (word.length > 2) inlineValue = word.slice(2);
    } else {
      positionals.push(word);
      const positional = spec.flags.find(
        (flag) => flag.positional && (flag.multiple || !flagValues.has(flag.name))
      );
      if (positional) flagValues.set(positional.name, word);
      continue;
    }
    if (flag?.value === undefined) continue;
    if (inlineValue === undefined) pendingFlag = flag;
    else flagValues.set(flag.name, inlineValue);
  }
  return { flagValues, positionals, pendingFlag, optionsEnded };
}

async function flagValueCompletion(
  flag: CompletionFlag,
  scanned: ScannedWords,
  io: WorkbenchCliIo
): Promise<Completion> {
  const value = flag.value!;
  if (typeof value !== "string") return valuesOf(value);
  if (value === "file") return FILE_COMPLETION;
  if (value === "text") return NO_COMPLETION;
  const target = scanned.positionals[0];
  if (target === undefined) return NO_COMPLETION;
  const registration = await resolveWorkbenchRegistration(
    target,
    scanned.flagValues.get("export"),
    scanned.flagValues.get("project"),
    io,
    ""
  );
  if ("exitCode" in registration) return NO_COMPLETION;
  const plan = await registration.loadPlan(io);
  if ("exitCode" in plan) return NO_COMPLETION;
  return valuesOf(value === "target" ? plan.view.targetIds : plan.view.stepIds);
}

/** Complete a pipeline command's own arguments after `run <id> --`. */
async function commandArgumentCompletion(
  scanned: ScannedWords & { readonly passthrough: readonly string[] },
  current: string,
  io: WorkbenchCliIo
): Promise<Completion> {
  const target = scanned.positionals[0];
  if (target === undefined) return NO_COMPLETION;
  const registration = await resolveWorkbenchRegistration(
    target,
    scanned.flagValues.get("export"),
    scanned.flagValues.get("project"),
    io,
    ""
  );
  if ("exitCode" in registration) return NO_COMPLETION;
  const loaded = await registration.loadCommand(io);
  if ("exitCode" in loaded) return NO_COMPLETION;
  const { parameters } = loaded.command.descriptor;

  const flags: CompletionFlag[] = parameters.map((parameter) => ({
    name: parameter.flag,
    short: parameter.short,
    description: parameter.description,
    positional: parameter.positional,
    multiple: parameter.multiple,
    value:
      parameter.type === "boolean"
        ? undefined
        : (parameter.choices ?? (parameter.type === "path" ? "file" : "text")),
  }));
  const args = scanWords(scanned.passthrough, { flags }, "pipeline");
  const parameter =
    args.pendingFlag ??
    flags.find((flag) => flag.positional && (flag.multiple || !args.flagValues.has(flag.name)));
  if (args.pendingFlag || args.optionsEnded || !current.startsWith("-")) {
    if (parameter?.value === "file") return FILE_COMPLETION;
    return Array.isArray(parameter?.value) ? valuesOf(parameter.value) : NO_COMPLETION;
  }
  if (current.startsWith("-")) {
    const names = new Set(parameters.map(({ flag }) => flag));
    return {
      candidates: [
        ...parameters.flatMap(({ flag, type, description }) => [
          description === undefined ? { value: `--${flag}` } : { value: `--${flag}`, description },
          ...(type === "boolean" && !names.has(`no-${flag}`) ? [{ value: `--no-${flag}` }] : []),
        ]),
        { value: "--help", description: "Show command help" },
      ],
      files: false,
    };
  }
  return NO_COMPLETION;
}

async function subcommandCompletion(
  command: WorkbenchCommandSummary,
  words: readonly string[],
  current: string,
  io: WorkbenchCliIo
): Promise<Completion> {
  const spec = await subcommandSpec(command, io);
  // zsh and fish keep `--flag=partial` as one word: complete the value, then restore the prefix.
  const mode = command.name === "run" ? "run" : "workbench";
  let scanned = scanWords(words, spec, mode);
  const inline = !scanned.optionsEnded && /^(--[^=]+)=(.*)$/s.exec(current);
  if (inline) scanned = scanWords([...words, inline[1]!], spec, mode);
  let completion: Completion;
  if (scanned.passthrough !== undefined) {
    if (command.name !== "run") return NO_COMPLETION;
    completion = await commandArgumentCompletion(
      { ...scanned, passthrough: scanned.passthrough },
      inline ? inline[2]! : current,
      io
    );
  } else if (scanned.pendingFlag) {
    completion = await flagValueCompletion(scanned.pendingFlag, scanned, io);
  } else if (inline) {
    return NO_COMPLETION;
  } else {
    return optionOrPositionalCompletion(spec, scanned, current, io);
  }
  if (!inline) return completion;
  // Shell scripts complete file paths after the "--flag=" prefix themselves.
  return {
    candidates: completion.candidates.map((candidate) => ({
      ...candidate,
      value: `${inline[1]}=${candidate.value}`,
    })),
    files: completion.files,
  };
}

async function optionOrPositionalCompletion(
  spec: SubcommandCompletion,
  scanned: ScannedWords,
  current: string,
  io: WorkbenchCliIo
): Promise<Completion> {
  if (!scanned.optionsEnded && current.startsWith("-")) {
    return {
      candidates: spec.flags.map(({ name, description }) => ({ value: `--${name}`, description })),
      files: false,
    };
  }
  const { positional } = spec;
  if (positional === undefined || scanned.positionals.length > 0) return NO_COMPLETION;
  if (positional === "file") return FILE_COMPLETION;
  if (positional === "pipeline") {
    return {
      candidates: await pipelineIdCandidates(scanned.flagValues.get("project"), io),
      files: true,
    };
  }
  return valuesOf(positional);
}

/** Hidden `tubeless __complete <words...>`; see {@link FILES_DIRECTIVE} for the protocol. */
export async function runComplete(
  words: readonly string[],
  io: WorkbenchCliIo,
  commands: readonly WorkbenchCommandSummary[]
): Promise<number> {
  const [command, ...rest] = words.length === 0 ? [""] : words;
  const current = rest.at(-1) ?? command!;
  let completion: Completion;
  if (rest.length === 0) {
    completion = current.startsWith("-")
      ? valuesOf(["--help"])
      : {
          candidates: [
            ...commands.map(({ name, description }) => ({ value: name, description })),
            { value: "help", description: "Show usage" },
          ],
          files: false,
        };
  } else {
    // Loading evaluates project modules; keep their diagnostics off the terminal.
    const discard = { write: () => true };
    try {
      const entry = commands.find(({ name }) => name === command);
      completion =
        entry === undefined
          ? NO_COMPLETION
          : await subcommandCompletion(entry, rest.slice(0, -1), current, {
              cwd: io.cwd,
              stderr: discard,
              stdout: discard,
            });
    } catch {
      completion = NO_COMPLETION;
    }
  }

  const records = completion.candidates
    .filter(({ value }) => value.startsWith(current) && !value.includes("\0"))
    .map(
      ({ value, description }) =>
        `v\0${value}\0${terminalSafeText(description ?? "")
          .replace(/\s+/g, " ")
          .trim()}\0`
    );
  if (completion.files) records.push(`${FILES_DIRECTIVE}\0\0\0`);
  if (records.length > 0) io.stdout.write(records.join(""));
  return TUBELESS_WORKBENCH_EXIT_CODE.success;
}

const BASH_COMPLETION_SCRIPT = `# bash completion for tubeless
# Install: eval "$(tubeless completion bash)"
_tubeless() {
  local current="\${COMP_WORDS[COMP_CWORD]}" kind value description line files=0
  local -a candidates=()
  COMPREPLY=()
  while IFS= read -r -d '' kind && IFS= read -r -d '' value && IFS= read -r -d '' description; do
    if [[ "$kind" == "${FILES_DIRECTIVE}" ]]; then
      files=1
    elif [[ "$kind" == v ]]; then
      candidates+=("$value")
    fi
  done < <(tubeless __complete "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null)
  COMPREPLY=("\${candidates[@]}")
  if ((files)); then
    compopt -o filenames 2>/dev/null
    while IFS= read -r line; do
      COMPREPLY+=("$line")
    done < <(compgen -f -- "$current")
  fi
}
complete -F _tubeless tubeless
`;

const ZSH_COMPLETION_SCRIPT = `#compdef tubeless
# zsh completion for tubeless
# Install: source <(tubeless completion zsh)
_tubeless() {
  local kind value description files=0 ret=1
  local -a candidates
  while IFS= read -r -d '' kind && IFS= read -r -d '' value && IFS= read -r -d '' description; do
    if [[ "$kind" == "${FILES_DIRECTIVE}" ]]; then
      files=1
    elif [[ "$kind" == v ]]; then
      candidates+=("$value")
    fi
  done < <(tubeless __complete "\${(@)words[2,CURRENT]}" 2>/dev/null)
  (( \${#candidates} )) && compadd -- "\${candidates[@]}" && ret=0
  if (( files )); then
    [[ "$PREFIX" == --*=* ]] && compset -P '*='
    _files && ret=0
  fi
  return ret
}
if [[ "$funcstack[1]" == "_tubeless" ]]; then
  _tubeless "$@"
else
  compdef _tubeless tubeless
fi
`;

const FISH_COMPLETION_SCRIPT = `# fish completion for tubeless
# Install: tubeless completion fish | source
function __tubeless_complete
    set -l tokens (commandline -opc)
    set -e tokens[1]
    set -l current (commandline -ct)
    set -l files 0
    tubeless __complete $tokens "$current" 2>/dev/null | while read -lz kind; and read -lz value; and read -lz description
        if test "$kind" = "${FILES_DIRECTIVE}"
            set files 1
        else if test "$kind" = v
            # Fish reserves tabs for descriptions even in NUL-delimited completions.
            if not string match -rq '\\t' -- "$value"
                printf '%s\\t%s\\0' "$value" "$description"
            end
        end
    end
    if test $files = 1
        set -l prefix (string match -r -- '^--[^=]+=' "$current")
        set -l path (string replace -r -- '^--[^=]+=' '' "$current")
        for candidate in (__fish_complete_path "$path")
            printf '%s%s\\0' "$prefix" "$candidate"
        end
    end
end
complete -c tubeless -f -a '(__tubeless_complete | string split0)'
`;

const COMPLETION_SCRIPTS: Readonly<Record<CompletionShell, string>> = {
  bash: BASH_COMPLETION_SCRIPT,
  zsh: ZSH_COMPLETION_SCRIPT,
  fish: FISH_COMPLETION_SCRIPT,
};

const COMPLETION_USAGE = `Usage: tubeless completion <bash|zsh|fish>

Print a shell completion script. It completes commands, flags, project
pipeline IDs, plan targets and steps, and pipeline command flags after
"tubeless run <id> --".

Enable it in the current shell:
  bash  eval "$(tubeless completion bash)"
  zsh   source <(tubeless completion zsh)
  fish  tubeless completion fish | source

Add the same line to ~/.bashrc, ~/.zshrc (after compinit), or
~/.config/fish/config.fish to keep it.

Options:
  -h, --help   Show this help
`;

function isCompletionShell(value: string): value is CompletionShell {
  return (COMPLETION_SHELLS as readonly string[]).includes(value);
}

/** `tubeless completion <shell>`: print the completion script for one shell. */
export async function runCompletion(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      usage: COMPLETION_USAGE,
      parse: (args) => parseSubcommandArgs(args, {}),
      positionalCountError: {
        count: 1,
        message: `Pass one shell: ${COMPLETION_SHELLS.join(", ")}.`,
      },
      async run(parsed, commandIo) {
        const shell = parsed.positionals[0]!;
        if (!isCompletionShell(shell)) {
          const suggestion = didYouMean(shell, COMPLETION_SHELLS);
          return writeUsageError(
            commandIo,
            [
              `Unsupported shell ${JSON.stringify(shell)}. Supported shells: ${COMPLETION_SHELLS.join(", ")}.`,
              suggestion,
            ]
              .filter((sentence) => sentence !== undefined)
              .join(" "),
            COMPLETION_USAGE
          );
        }
        commandIo.stdout.write(COMPLETION_SCRIPTS[shell]);
        return TUBELESS_WORKBENCH_EXIT_CODE.success;
      },
    },
    argv,
    io
  );
}
