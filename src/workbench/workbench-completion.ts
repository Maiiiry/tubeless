import { parseArgs } from "node:util";
import type { CliParameterDescriptor } from "../cli/cli.js";
import { PIPELINE_MERMAID_DIRECTIONS } from "../core/pipeline-types.js";
import { didYouMean } from "../utilities/suggest.js";
import {
  DEFAULT_PIPELINE_PROJECT_FILE,
  loadPipelineProjectFile,
  resolveWorkbenchRegistration,
} from "./workbench-project-loader.js";
import {
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";
import { runWorkbenchSubcommand } from "./workbench-subcommand.js";

/**
 * Protocol for the hidden `tubeless __complete <words...>` command used by the
 * generated shell scripts. The words are everything after `tubeless` up to and
 * including the word under the cursor (empty when the cursor follows a space).
 * Stdout carries one candidate per line as `value` or `value<TAB>description`,
 * already filtered by the current word's prefix. A final `:files` line asks the
 * shell to also complete file paths. Failures print nothing and still exit 0.
 */
const FILES_DIRECTIVE = ":files";

const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;
type CompletionShell = (typeof COMPLETION_SHELLS)[number];

/** A top-level command offered at the command position. */
interface WorkbenchCommandSummary {
  readonly name: string;
  readonly description: string;
}

interface Candidate {
  readonly value: string;
  readonly description?: string;
}

interface Completion {
  readonly candidates: readonly Candidate[];
  readonly files: boolean;
}

/** `text` values are free-form; `pipeline`/`target`/`step` come from the project or plan. */
type FlagValue = "file" | "text" | "pipeline" | "target" | "step" | readonly string[];

interface CompletionFlag {
  readonly name: string;
  readonly short?: string;
  readonly description: string;
  readonly value?: FlagValue;
}

interface SubcommandCompletion {
  readonly flags: readonly CompletionFlag[];
  readonly positional?: "pipeline" | "file" | readonly string[];
}

const HELP_FLAG: CompletionFlag = { name: "help", short: "h", description: "Show this help" };
const EXPORT_FLAG: CompletionFlag = {
  name: "export",
  short: "e",
  value: "text",
  description: "Select a pipeline or command export",
};
const PROJECT_FLAG: CompletionFlag = {
  name: "project",
  short: "p",
  value: "file",
  description: "Project file",
};
const STORE_FLAG: CompletionFlag = {
  name: "store",
  value: "file",
  description: "SQLite run store",
};
const TRACE_FLAG: CompletionFlag = {
  name: "trace",
  value: "file",
  description: "NDJSON trace file",
};
const STEP_FILTER_FLAGS: readonly CompletionFlag[] = [
  { name: "tag", value: "text", description: "Require a step tag (repeatable)" },
  { name: "owner", value: "text", description: "Match step owner exactly" },
  { name: "domain", value: "text", description: "Match step domain exactly" },
];

/**
 * Workbench flags per subcommand. Mirrors each subcommand's option parser; the
 * completion tests compare this table against every subcommand's `--help`.
 */
const SUBCOMMAND_COMPLETIONS: Readonly<Record<string, SubcommandCompletion>> = {
  list: {
    flags: [
      PROJECT_FLAG,
      { name: "json", description: "Emit the project inventory as JSON" },
      HELP_FLAG,
    ],
  },
  validate: {
    flags: [{ name: "json", description: "Emit a structured validation result" }, HELP_FLAG],
    positional: "file",
  },
  inspect: {
    flags: [
      EXPORT_FLAG,
      PROJECT_FLAG,
      ...STEP_FILTER_FLAGS,
      { name: "json", description: "Emit identity and the default plan as JSON" },
      HELP_FLAG,
    ],
    positional: "pipeline",
  },
  plan: {
    flags: [
      EXPORT_FLAG,
      PROJECT_FLAG,
      { name: "target", short: "t", value: "target", description: "Select a declared target" },
      { name: "step", short: "s", value: "step", description: "Select exact internal steps" },
      { name: "dry-run", description: "Show each step's dry-run disposition" },
      { name: "explain", description: "Include target/dependency selection provenance" },
      { name: "json", description: "Emit the complete structured plan as JSON" },
      HELP_FLAG,
    ],
    positional: "pipeline",
  },
  graph: {
    flags: [
      EXPORT_FLAG,
      PROJECT_FLAG,
      {
        name: "direction",
        short: "d",
        value: PIPELINE_MERMAID_DIRECTIONS,
        description: "Flowchart direction",
      },
      ...STEP_FILTER_FLAGS,
      { name: "metadata", description: "Include step metadata in labels" },
      { name: "descriptions", description: "Include step descriptions in node labels" },
      { name: "markdown", description: "Wrap the result in a fenced Mermaid Markdown block" },
      HELP_FLAG,
    ],
    positional: "pipeline",
  },
  run: {
    flags: [EXPORT_FLAG, PROJECT_FLAG, STORE_FLAG, TRACE_FLAG, HELP_FLAG],
    positional: "pipeline",
  },
  history: {
    flags: [
      STORE_FLAG,
      TRACE_FLAG,
      { name: "pipeline", value: "pipeline", description: "Filter by recorded pipeline ID" },
      { name: "json", description: "Emit the projected run list or run as JSON" },
      { name: "events", description: "Emit raw store events as NDJSON" },
      { name: "clear", description: "Delete all recorded history (requires --yes)" },
      { name: "yes", description: "Confirm --clear" },
      HELP_FLAG,
    ],
  },
  ui: {
    flags: [
      { name: "command", value: "file", description: "Register a launchable pipeline or command" },
      EXPORT_FLAG,
      STORE_FLAG,
      TRACE_FLAG,
      { name: "host", value: "text", description: "Bind address" },
      { name: "port", value: "text", description: "HTTP port" },
      { name: "public-url", value: "text", description: "Host behind an authenticated gateway" },
      HELP_FLAG,
    ],
    positional: "file",
  },
  completion: { flags: [HELP_FLAG], positional: COMPLETION_SHELLS },
};

const NO_COMPLETION: Completion = { candidates: [], files: false };
const FILE_COMPLETION: Completion = { candidates: [], files: true };

function valuesOf(values: readonly string[]): Completion {
  return { candidates: values.map((value) => ({ value })), files: false };
}

function describedPipeline(view: object): string | undefined {
  if ("description" in view && typeof view.description === "string" && view.description) {
    return view.description;
  }
  if ("name" in view && typeof view.name === "string" && view.name) return view.name;
  return undefined;
}

async function pipelineIdCandidates(
  projectFile: string | undefined,
  io: WorkbenchCliIo
): Promise<Candidate[]> {
  const loaded = await loadPipelineProjectFile(projectFile ?? DEFAULT_PIPELINE_PROJECT_FILE, io);
  if ("exitCode" in loaded) return [];
  const candidates = await Promise.all(
    loaded.registrations.map(async (registration): Promise<Candidate | undefined> => {
      if (registration.id === undefined) return undefined;
      const plan = await registration.loadPlan(io);
      const description = "exitCode" in plan ? undefined : describedPipeline(plan.view);
      return description === undefined
        ? { value: registration.id }
        : { value: registration.id, description };
    })
  );
  return candidates.filter((candidate) => candidate !== undefined);
}

interface ScannedWords {
  readonly flagValues: ReadonlyMap<string, string>;
  readonly positionals: readonly string[];
  /** Words after a `--` separator, excluding the current word. */
  readonly passthrough?: readonly string[];
  /** Value-taking flag that the current word completes. */
  readonly pendingFlag?: CompletionFlag;
}

/** Walk the subcommand's words before the cursor the way its option parser would. */
function scanWords(words: readonly string[], spec: SubcommandCompletion): ScannedWords {
  const flagValues = new Map<string, string>();
  const positionals: string[] = [];
  let pendingFlag: CompletionFlag | undefined;
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (pendingFlag) {
      // Bash splits `--flag=value` into `--flag`, `=`, `value`.
      if (word === "=") continue;
      flagValues.set(pendingFlag.name, word);
      pendingFlag = undefined;
      continue;
    }
    if (word === "--") {
      return { flagValues, positionals, passthrough: words.slice(index + 1) };
    }
    let flag: CompletionFlag | undefined;
    let inlineValue: string | undefined;
    if (word.startsWith("--")) {
      const separator = word.indexOf("=");
      const name = separator === -1 ? word.slice(2) : word.slice(2, separator);
      flag = spec.flags.find((candidate) => candidate.name === name);
      if (separator !== -1) inlineValue = word.slice(separator + 1);
    } else if (word.startsWith("-") && word.length > 1) {
      flag = spec.flags.find((candidate) => candidate.short === word[1]);
      if (word.length > 2) inlineValue = word.slice(2);
    } else {
      positionals.push(word);
      continue;
    }
    if (flag?.value === undefined) continue;
    if (inlineValue === undefined) pendingFlag = flag;
    else flagValues.set(flag.name, inlineValue);
  }
  return pendingFlag ? { flagValues, positionals, pendingFlag } : { flagValues, positionals };
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
  if (value === "pipeline") {
    return { candidates: await pipelineIdCandidates(undefined, io), files: false };
  }
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

function findParameter(
  parameters: readonly CliParameterDescriptor[],
  word: string
): CliParameterDescriptor | undefined {
  if (word.startsWith("--")) return parameters.find(({ flag }) => word === `--${flag}`);
  if (word.length === 2 && word.startsWith("-")) {
    return parameters.find(({ short }) => short === word[1]);
  }
  return undefined;
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

  // Bash splits `--flag=value` into `--flag`, `=`, `value`.
  const previous = scanned.passthrough.at(scanned.passthrough.at(-1) === "=" ? -2 : -1);
  const valueParameter = previous === undefined ? undefined : findParameter(parameters, previous);
  if (valueParameter !== undefined && valueParameter.type !== "boolean") {
    if (valueParameter.choices) return valuesOf(valueParameter.choices);
    return valueParameter.type === "path" ? FILE_COMPLETION : NO_COMPLETION;
  }
  if (current.startsWith("-")) {
    return {
      candidates: [
        ...parameters.map(({ flag, description }) =>
          description === undefined ? { value: `--${flag}` } : { value: `--${flag}`, description }
        ),
        { value: "--help", description: "Show command help" },
      ],
      files: false,
    };
  }
  const acceptsPath = parameters.some(({ positional, type }) => positional && type === "path");
  return acceptsPath ? FILE_COMPLETION : NO_COMPLETION;
}

async function subcommandCompletion(
  command: string,
  words: readonly string[],
  current: string,
  io: WorkbenchCliIo
): Promise<Completion> {
  const spec = SUBCOMMAND_COMPLETIONS[command];
  if (spec === undefined) return NO_COMPLETION;
  // zsh and fish keep `--flag=partial` as one word: complete the value, then restore the prefix.
  const inline = /^(--[^=]+)=(.*)$/s.exec(current);
  const scanned = scanWords(inline ? [...words, inline[1]!] : words, spec);
  let completion: Completion;
  if (scanned.passthrough !== undefined) {
    if (command !== "run") return NO_COMPLETION;
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
  return {
    candidates: completion.candidates.map((candidate) => ({
      ...candidate,
      value: `${inline[1]}=${candidate.value}`,
    })),
    files: false,
  };
}

async function optionOrPositionalCompletion(
  spec: SubcommandCompletion,
  scanned: ScannedWords,
  current: string,
  io: WorkbenchCliIo
): Promise<Completion> {
  if (current.startsWith("-")) {
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
      completion = await subcommandCompletion(command!, rest.slice(0, -1), current, {
        cwd: io.cwd,
        stderr: discard,
        stdout: discard,
      });
    } catch {
      completion = NO_COMPLETION;
    }
  }

  const lines = completion.candidates
    .filter(({ value }) => value.startsWith(current))
    .map(({ value, description }) =>
      description ? `${value}\t${description.replace(/\s+/g, " ").trim()}` : value
    );
  if (completion.files) lines.push(FILES_DIRECTIVE);
  if (lines.length > 0) io.stdout.write(`${lines.join("\n")}\n`);
  return TUBELESS_WORKBENCH_EXIT_CODE.success;
}

const BASH_COMPLETION_SCRIPT = `# bash completion for tubeless
# Install: eval "$(tubeless completion bash)"
_tubeless() {
  local current="\${COMP_WORDS[COMP_CWORD]}" line files=0
  local -a candidates=()
  COMPREPLY=()
  while IFS= read -r line; do
    if [[ "$line" == "${FILES_DIRECTIVE}" ]]; then
      files=1
    elif [[ -n "$line" ]]; then
      candidates+=("\${line%%$'\\t'*}")
    fi
  done < <(tubeless __complete "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null)
  # With no candidates, "complete -o default" falls back to file names.
  ((\${#candidates[@]})) || return 0
  COMPREPLY=("\${candidates[@]}")
  if ((files)); then
    compopt -o filenames 2>/dev/null
    while IFS= read -r line; do
      COMPREPLY+=("$line")
    done < <(compgen -f -- "$current")
  fi
}
complete -o default -F _tubeless tubeless
`;

const ZSH_COMPLETION_SCRIPT = `#compdef tubeless
# zsh completion for tubeless
# Install: source <(tubeless completion zsh)
_tubeless() {
  local line value files=0 ret=1
  local -a candidates
  for line in "\${(@f)$(tubeless __complete "\${(@)words[2,CURRENT]}" 2>/dev/null)}"; do
    if [[ "$line" == "${FILES_DIRECTIVE}" ]]; then
      files=1
    elif [[ -n "$line" ]]; then
      value="\${line%%$'\\t'*}"
      value="\${value//:/\\\\:}"
      if [[ "$line" == *$'\\t'* ]]; then
        candidates+=("$value:\${line#*$'\\t'}")
      else
        candidates+=("$value")
      fi
    fi
  done
  (( \${#candidates} )) && _describe -t tubeless-values 'tubeless' candidates && ret=0
  (( files )) && _files && ret=0
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
    for line in (tubeless __complete $tokens "$current" 2>/dev/null)
        if test "$line" = "${FILES_DIRECTIVE}"
            set files 1
        else if test -n "$line"
            printf '%s\\n' $line
        end
    end
    if test $files = 1
        __fish_complete_path "$current"
    end
end
complete -c tubeless -f -a '(__tubeless_complete)'
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
      parse: (args) =>
        parseArgs({
          args: [...args],
          allowPositionals: true,
          options: { help: { type: "boolean", short: "h" } },
          strict: true,
        }),
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
