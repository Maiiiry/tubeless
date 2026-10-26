# CLI

Use the `tubeless` CLI to list project commands, inspect a pipeline, preview
which steps will run, execute a command, and inspect recorded results. It
requires Bun 1.3.14 or later and loads TypeScript files directly.

```sh
bunx tubeless --help
npx tubeless --help # Also uses the executable's Bun runtime
```

The executable uses `#!/usr/bin/env bun`, so Bun must be installed and available
on `PATH` even when npm or `npx` installs the package. The library itself can run
on Node.js 22.6 or later without Bun.

## Commands

### Prompt a workspace agent

Export `OPENAI_API_KEY` to child processes, then start the terminal prompt loop:

```sh
export OPENAI_API_KEY # If the key is already set in your shell.
tubeless agent --model gpt-5.4-mini
# From this checkout: bun run tubeless -- agent --model gpt-5.4-mini
```

Seeing a value with `echo $OPENAI_API_KEY` does not prove it is exported. Without
`export`, child processes cannot see a shell variable. The built-in provider
checks that credentials are present before opening the REPL and explains how to
fix a missing key. OpenAI validates the key when the model makes a request.

Alternatively, keep credentials in a local dotenv file and select it explicitly:

```dotenv
# .env.agent (keep this file out of version control)
OPENAI_API_KEY="your-api-key"
OPENAI_MODEL=gpt-5.4-mini
```

```sh
tubeless agent --env-file .env.agent
# From this checkout: bun run tubeless -- agent --env-file .env.agent
```

`--env-file` resolves relative to the workspace directory. Tubeless uses Node's
built-in dotenv parser, supporting quotes, comments, whitespace, and an optional
`export` prefix. It treats values as literal text, without shell execution or
variable expansion. Existing process environment values take precedence over the
file, including empty values; `--model` overrides `OPENAI_MODEL`. Runtime-loaded
environment values, such as Bun's automatic dotenv loading, count as existing
values too. File values are passed to the model factory without changing
`process.env`. The built-in provider trims the key and rejects internal whitespace
or control characters. Credential and file-loading diagnostics omit secret values.
This checkout ignores `.env` and `.env.*` except `.env.example`.

If a model request fails with HTTP 401, the credential reached OpenAI and
authentication was rejected. `[invalid_api_key]` means OpenAI rejected the key;
replace it with an active key for the correct project.
`[ip_not_authorized]` means the request's network address is outside the project
or organization IP allowlist. Other 401 responses advise checking the key,
project and organization access, and allowed network. See the
[official OpenAI error guide](https://developers.openai.com/api/docs/guides/error-codes).
Tubeless reads at most 16 KiB of an authentication error body and emits only
known codes and safe advice, with a validated request ID when available; raw
provider messages and unknown codes are omitted because they can contain keys.
Restart the agent after updating credentials. If you use `--env-file`, remove a
stale exported `OPENAI_API_KEY` that would override the new file value.

Type a task and press Enter. Tubeless runs its model-backed workspace agent,
prints the answer, and returns to the bike-inspired `◯╱◯ ❯` prompt. The prompt
and welcome line use cyan accents in interactive terminals and honor `NO_COLOR`.
Use `/model <name>` to select the model for the next task, `/model` to show it,
`/clear` to start a fresh conversation, `/help` for commands, and `/quit` or `/exit` to exit.
Press Tab to complete a slash command, such as `/mo` → `/model `; press Tab twice
after `/` to list `/model`, `/clear`, `/help`, `/quit`, and `/exit`. Completion applies only
to the command name, leaving model names and task text alone. Pipes have no
interactive prompt or completion.
Ctrl-C cancels active work and returns to the prompt after tools drain; at an
idle prompt it exits. EOF ends the session. Interactive input typed during a run
is discarded. Prompts share a session: completed answers, tool history, and provider
conversation carry into the next prompt, including after `/model` changes. Finishing
an answer returns control to the user; `/quit`, EOF, or an idle Ctrl-C ends the session.
Each prompt has fresh execution budgets. A failed or cancelled prompt keeps the last
completed conversation; file changes remain in the workspace. `/clear` resets context
while keeping the selected model. Session context is held in memory for this CLI process.
`--prompt` starts a fresh, single-shot invocation. V1 accepts one line per REPL prompt.

Agent runs use the same pipeline reporter as `tubeless run`. In a capable terminal,
the live execution tree shows numbered turns, “Plan next action”, “Tool calls”,
and “Update context”. Calls display their tool names and concrete workspace
activity: file paths for reads, writes, and edits; command previews for bash;
directory paths and query previews for listing and searching. Completed activity
includes line ranges, byte counts, command exit codes, or result counts. The same
activity appears in scoped tool logs, including failures and cancellations. For example:

```text
Read "src/app.ts": completed (lines 1-80 of 80)
Write "src/new.ts": completed (128 bytes)
Run bash "bun test": completed (exit 0)
```

Previews retain at most 160 input characters, escape controls, and omit file
contents and command output. Running work shimmers with the
usual colors, spinners, elapsed time, and progress counts. Wide terminals show
recent logs beside the tree; smaller terminals keep active work visible and write
logs above it. The reporter honors `NO_COLOR`, `FORCE_COLOR`, `TERM`, and `CI`.
Redirected output uses ordinary append-only pipeline logs without cursor controls.
Use `--no-graph` to hide pipeline reporting while keeping model/tool logs and answers.

For one task, including a multiline task, use `--prompt`:

```sh
tubeless agent --model gpt-5.4-mini --prompt 'Find and fix the failing test, then verify it'
```

Piped input runs one task per line serially. A failed task reports its error and
allows another prompt. The command returns the last task's exit code: 0 for
success, 6 for execution failure, or 7 for cancellation. An external abort or
SIGTERM ends the session with 7. `--max-turns`, `--max-calls`, and
`--max-concurrency` override the ordinary agent budgets; `--instructions` appends
instructions to the default prompt. `--tools read,list,search` limits the default tools the agent may use.
`--codemode` offers one `codemode` tool whose
JavaScript scripts call the workspace tools; see [code mode](./agents.md#code-mode). Model selection defaults to `OPENAI_MODEL`
or the OpenAI adapter's default. The agent reads project guidance and has the
standard `read`, `write`, `edit`, `bash`, `list`, and `search` tools with the host's
permissions. See [agents](./agents.md#default-model-backed-agent) for their contracts.

To plug in another provider, pass `--model-module ./model.ts`. The trusted local
module must default-export a factory accepting `{ model: string, signal: AbortSignal, env: Readonly<NodeJS.ProcessEnv> }` and returning
an `AgentModel`, synchronously or asynchronously. Tubeless calls the factory for
each task with the currently selected model, that task's cancellation signal,
and the resolved environment. Custom factories use `env` for provider credentials
and need no OpenAI key unless they use that provider.
Async setup must pass the signal into its I/O and release setup resources on abort.
Cancellation stops waiting for setup and never invokes a model returned afterward.
The callback receives the usual
instructions, task, conversation, tool outcomes, and decision context. On
`context.turn === 1`, append the new user task even when conversation is already
present or the user repeats the same text. Later decisions consume tool outcomes
without appending the task again. Return a complete, plain-data conversation,
including the final answer, to retain it for the next prompt. Supported models
within one factory share that provider's conversation format.
The agent validates decisions and owns frozen conversation snapshots. For example:

```ts
import type { AgentModel } from "tubeless/agent";
import { openaiModel } from "tubeless/agent/openai";

export default function createModel({
  model,
  signal,
  env,
}: {
  readonly model: string;
  readonly signal: AbortSignal;
  readonly env: Readonly<NodeJS.ProcessEnv>;
}): AgentModel {
  signal.throwIfAborted();
  return openaiModel({ model, apiKey: env.OPENAI_API_KEY }); // Replace with your own transport.
}
```

The [compiled plugin example](../examples/agent-repl-model.ts) uses public imports.
This command needs no project file, UI server, storage adapter, or TUI dependency.
Its prompt source uses native async iteration over readline input. Other pipelines
can use [input steps](./concepts.md#wait-for-user-or-application-input) with their own UI adapters.

### Turn a pipeline into a CLI

Start with one import and one call:

```ts
import { definePipelineCommand } from "tubeless/cli";
import { pipeline } from "./pipeline.js";

export const command = definePipelineCommand(pipeline);

if (import.meta.main) void command.main();
```

The pipeline's options schema is the source of truth. When the schema passed to
`createSteps(schema)` exposes [Standard JSON Schema](https://standardschema.dev/json-schema)
input metadata, the command derives domain flags automatically. No CLI parameter
schema, option mapper, reporter setup, or type imports are needed. See the
[executable example](../examples/automatic-cli.ts) and its
[pipeline schema](../examples/validated-boundaries.ts).

Put `defineProject(id, pipelines)` from `tubeless/project` in `tubeless.project.ts`.
The CLI and Studio discover those pipelines by ID and call `definePipelineCommand`
for you, so a schema-backed pipeline needs no command wrapper:

```ts
import { defineProject } from "tubeless/project";
import { ImportPipeline, PublishPipeline } from "./pipelines.js";

export default defineProject("data-jobs", [ImportPipeline, PublishPipeline], {
  name: "Data jobs",
  description: "Import source data and publish normalized datasets.",
});
```

The optional third argument supplies project presentation. `project.name` defaults
to `project.id`; `project.description` is optional. Both fields must be non-empty
strings when supplied and are immutable on the returned project. `list --json`
includes these fields alongside the stable project ID and pipeline IDs. Project
metadata does not rename individual pipelines or their command labels. Put optional
`name` and `description` on each `definePipeline` definition for that presentation.

For custom parameters, option mapping, or command presentation, pass ordinary
`definePipelineCommand` adapters directly in the project's entry list:

```ts
import { definePipelineCommand } from "tubeless/cli";
import { defineProject } from "tubeless/project";
import { ImportPipeline } from "./pipelines.js";

const ImportCommand = definePipelineCommand(ImportPipeline, {
  params: { lines: { type: "string", multiple: true } },
  name: "Import rows",
});

export default defineProject("data-jobs", [ImportCommand]);
```

Register each pipeline exactly once, either directly or through its command.
Mixed lists such as `[SchemaBackedPipeline, ImportCommand]` preserve entry order.
Duplicate pipeline IDs fail in every combination, including a pipeline and its
own command. Child pipelines are not registered recursively. `project.pipelines`,
`pipelineIds`, and `commands` are derived read-only snapshots, not separate inputs.
For [compiled documents](./declarative-pipelines.md), build commands from
`compiled.get(id)` and register those commands directly in the list.
Pipeline IDs are also the CLI and Studio IDs; `name` only changes a
display label. `ProjectOptions` names the optional configuration contract. Its
`cwd` sets the CLI and Studio execution directory relative to the project file;
omitting it uses the project's directory. Application calls to `project.get(id)`
still return the original pipeline and use its ordinary execution context.

Automatic project commands require Standard JSON Schema input metadata, even
for pipelines with no domain inputs: erased TypeScript types cannot prove that
inputs are optional. Schema-less project pipelines remain available to application
code and `list`, `inspect`, `plan`, and `graph`. For CLI execution and Studio,
supply an options schema or register an explicit command (`params: {}` is
sufficient when there are no domain inputs).

| Pipeline input                | Generated CLI                                   |
| ----------------------------- | ----------------------------------------------- |
| `displayName: string`         | Required `--display-name <value>`               |
| Optional string or number     | Optional flag                                   |
| String enum                   | Flag with checked choices and help text         |
| Number or integer             | Plain decimal, with minimum/maximum checks      |
| Boolean                       | `--enabled` / `--no-enabled`; defaults to false |
| String or number array        | Repeatable flag; defaults to `[]`               |
| Scalar default or description | Default value or help text                      |

| Layer   | Public entry       | Responsibility                                                       |
| ------- | ------------------ | -------------------------------------------------------------------- |
| Core    | `tubeless`         | Typed graphs, planning, execution, hooks and run reports             |
| CLI     | `tubeless/cli`     | Standalone and pipeline commands, typed flags and terminal execution |
| Project | `tubeless/project` | Typed pipeline collections and parsed YAML/JSON projects             |
| Studio  | `tubeless ui`      | Optional browser interface for recorded runs and registered commands |

The command also supplies `--help`, `--dry-run`, `--step`, `--target` (when the
pipeline declares targets), `--continue-on-error`, `--max-concurrency`, automatic
terminal reporting, cancellation, and exit codes. Its name defaults to the pipeline
name, then its ID; its description defaults to the pipeline description. Explicit
command `name` and `description` values override those defaults when CLI-specific
help differs. `command.main()` owns a script entrypoint; `command.run(argv)` returns
the result to application code. Use `command.plan()` for a selection-only preview.
The same resolved descriptor drives Studio forms.

Inference reads the schema's **input**, so transformations run exactly once during
pipeline execution. Parsing checks flag types, choices and numeric bounds;
the pipeline still performs full domain validation, including async refinements,
before running steps. Help and planning never validate domain input or run steps.
Boolean and array flags use CLI defaults (`false` and `[]`); scalar schema defaults
take precedence. JSON Schema conversion uses the `draft-2020-12` target.

TypeScript types alone have no runtime fields to inspect. A pipeline created with
`createSteps<MyOptions>()` needs explicit `params` for its domain inputs. Pipelines
with no domain inputs work with the one-argument call. Validation-only schemas,
nested objects, nullable/union inputs, tuples, array defaults, and numeric or boolean
`enum`/`const` constraints require explicit
parameters; unsupported schema shapes fail at command creation with guidance.
Local JSON Schema references are resolved automatically.

### Advanced: override a flag's presentation

Use `overrides` only when a derived flag needs a different name, short alias,
environment fallback, or help text. The type and validation still come from the
pipeline schema:

```ts
const command = definePipelineCommand(pipeline, {
  overrides: {
    source: { short: "s", env: "IMPORT_SOURCE", description: "Input source." },
  },
});
```

Explicit arguments take precedence over environment fallbacks. Other optional
settings include `name`, `description`, `positionals`, `summarize`, `hooks`,
`checkpoint`, `resume`, and `reporter`. Most commands need none of these; reporting already
chooses interactive or plain output automatically.

`--resume` is capability-gated. Configuring `checkpoint` exposes the flag and
supplies the managed checkpoint store. Set `resume: true` only when application
code owns the resume state and interprets `values.resume` itself. Commands with
neither setting reject `--resume`, and their descriptors omit it so Studio does
not render a resume control.

### Advanced: custom CLI inputs

Use `params` for a type-only pipeline or when command inputs intentionally differ
from pipeline options. It replaces inference completely. Add `mapOptions` only
when those inputs need renaming, conversion, I/O, or derived values:

```ts
const command = definePipelineCommand(pipeline, {
  params: { source: { type: "path", mustExist: true, kind: "file" } },
  mapOptions: (values) => ({ lines: readFileSync(values.source, "utf8").split("\n") }),
});
```

See [`cli-job.ts`](../examples/cli-job.ts) for the complete file-to-rows mapping.
For same-name compatible parameters, omit `mapOptions`. Path resolution and
existence checks are explicit overrides, never guesses based on an option's name.
Do not combine `params` with `overrides`.

`defineCommand` is the lower-level alternative for standalone scripts that do
not have a pipeline. A single script does not need a project.

The exported CLI configuration, parameter, parse-result, hook, and reporter types
are reference tools for shared configuration and adapter authors. Ordinary command
wrappers rely on inference and do not need to import them. `DefinePipelineCommandConfig`
describes the advanced explicit-parameter form. `descriptor`, `parseValues`, and
`execute` support UI adapters; neither CLI declarations nor projects load storage
or Studio. Optional Node helpers live in `tubeless/node`.

### Executable commands

| Command               | Accepts                          | Does                                                                |
| --------------------- | -------------------------------- | ------------------------------------------------------------------- |
| `tubeless list`       | A project file                   | Lists project pipeline IDs with their names and descriptions        |
| `tubeless validate`   | A YAML or JSON pipeline document | Checks document structure and metadata without loading handlers     |
| `tubeless inspect`    | A pipeline or command export     | Shows identity, targets, and the default structural plan            |
| `tubeless plan`       | A pipeline or command export     | Previews selection without executing or requiring domain options    |
| `tubeless graph`      | A pipeline or command export     | Writes Mermaid flowchart source                                     |
| `tubeless run`        | A pipeline ID or command export  | Infers or validates command arguments and runs the pipeline         |
| `tubeless history`    | An optional run id               | Lists or shows recorded runs from SQLite or a finished NDJSON trace |
| `tubeless upgrade`    | An optional `--store` path       | Rewrites an older SQLite run store after `--yes`                    |
| `tubeless ui`         | An optional project file         | Serves the local run studio; see [studio](./studio.md)              |
| `tubeless completion` | `bash`, `zsh`, or `fish`         | Prints a shell completion script                                    |
| `tubeless init`       | A deploy target                  | Scaffolds deployment files; see [init](#init)                       |

Use `tubeless validate [--json] pipelines.yaml` for a fast document-only check.
It supports `.yaml`, `.yml`, and `.json`; it does not resolve handlers, check the
graph, or run domain schemas. See [declarative pipelines](./declarative-pipelines.md)
for the downloadable JSON Schema and validation levels.

Use a checked-in `tubeless.project.ts` to address pipelines by stable ID:

```sh
bunx tubeless list
bunx tubeless inspect import
bunx tubeless plan import --target normalized-import --explain
bunx tubeless graph import --markdown
bunx tubeless run import -- --source ../rows.txt --target normalized-import
```

By default, Tubeless looks for `tubeless.project.ts` in the current directory.
It does not search parent directories. Pass `--project <path>` when the project file
has another name or location.

In a project file, the default export is authoritative and must be a
`defineProject` result. Other named exports do not
change selection. Without a default export, the file must expose exactly one
distinct project; aliases of the same object are allowed. Multiple projects
fail as ambiguous. Add a default
export to select one explicitly. An invalid default fails instead of falling back
to a named export. These rules apply to every CLI operation and Studio.

Without `--project`, an argument naming an existing file is treated as a file.
Otherwise, a bare name can match a pipeline ID in the default
project file. Arguments containing `/`, starting with `.`, or having an extension
are always treated as paths. `--export` applies only when loading a file
directly; a project selection already identifies the pipeline.

For a directly loaded pipeline or command file, the CLI selects its only matching export automatically. Pass
`--export Name` when the file exports more than one. Every operation prefers a
marked command when a module exports both a pipeline and a command. Otherwise,
`run` derives a command from one uniquely selected schema-backed pipeline.

`inspect` reports the pipeline identity, whether it is loaded from a project or
a standalone module.

```sh
bunx tubeless inspect ./scripts/import.ts
bunx tubeless plan ./scripts/import.ts --target normalize --explain
bunx tubeless graph ./scripts/import.ts --markdown
bunx tubeless run ./scripts/import.ts -- --source rows.txt --target normalize
```

For `run`, flags that choose the file or recording destination go before `--`.
Flags passed to the pipeline command go after it, including `--target`,
`--step`, and `--dry-run`. Schema-backed pipelines are wrapped automatically
whether selected from `defineProject` or exported directly from a file. Export
a `definePipelineCommand` when inputs need explicit parameters or mapping.

```sh
tubeless run --export ImportCommand ./scripts/import.ts -- --source rows.txt --target normalize
```

For command help:

```sh
tubeless run ./scripts/import.ts -- --help
```

Help lists the command's own options first, then the shared `Pipeline controls:`
(`--dry-run`, `--target`, `--step`, `--cache`, and similar). Each option shows its
description followed by bracketed details such as `[required]`,
`[integer, min: 1, default: 1]`, or `[repeatable, one of: load]`. Invalid arguments
print each error, the usage line, and a pointer to `--help` instead of the full help.

### Typos and suggestions

Near-miss input gets a `Did you mean …?` hint without changing exit codes: unknown
commands, subcommand flags, command flags after `--`, choice values, project
pipeline IDs, plan targets and steps, and history run IDs. An unknown project
pipeline ID also points to `tubeless list`. A requested target that is a step
rather than a declared target says so and lists the declared targets.

```text
$ tubeless run import -- --sourc rows.txt
Error: Unknown option: --sourc. Did you mean --source?
```

### Shell completion

```sh
eval "$(tubeless completion bash)"     # ~/.bashrc
source <(tubeless completion zsh)      # ~/.zshrc, after compinit
tubeless completion fish | source      # ~/.config/fish/config.fish
```

Completion covers commands, flags, project pipeline IDs from the selected project
file, `graph --direction` values, `plan --target` and `--step` IDs, and the flags
and choice values of the pipeline command after `tubeless run <id> --`. Project
files are loaded to read IDs, but no handlers run. Fish omits candidates containing
tabs because its native completion interface reserves tabs for descriptions.

## List

```
tubeless list [options]
```

- `-p, --project <path>` selects the project file (default `./tubeless.project.ts`)
- `--json` emits project metadata, pipeline IDs, and resolved project and `cwd` paths

Text output prints one pipeline per line: its ID, then its display name and
description, aligned. `list` evaluates the selected project file and its imports,
but never executes pipeline handlers. It never scans the filesystem or run history
for executables.

## Inspect

```
tubeless inspect [options] <pipeline-id-or-file>
```

- `-e, --export <name>` selects a pipeline or command export
- `-p, --project <path>` looks up the pipeline ID in the selected project file
- `--json` emits identity and the default plan as JSON
- `--tag <tag>` requires a step tag; repeat it to require several
- `--owner <owner>` and `--domain <domain>` match step metadata exactly

Text output shows the pipeline name, description, targets, metadata, and the default
structural plan. Use `tubeless plan` for selection previews.

## Plan

```
tubeless plan [options] <pipeline-id-or-file>
```

- `-e, --export <name>` selects a pipeline or command export
- `-p, --project <path>` looks up the pipeline ID in the selected project file
- `-t, --target <id>` selects a declared target and its prerequisites (repeatable)
- `-s, --step <id>` selects exact internal steps (repeatable)
- `--dry-run` shows whether each step would run, skip, or use a preview handler
- `--explain` explains why each step is selected or omitted
- `--json` emits the structured plan

`--target` includes prerequisites; `--step` selects only the IDs you supply.
They cannot be combined. Planning neither validates business inputs nor runs
step handlers. Use `command.plan()` or `tubeless plan`; there is no command
`--plan` flag.

## Graph

```
tubeless graph [options] <pipeline-id-or-file>
```

- `-e, --export <name>` selects a pipeline or command export
- `-p, --project <path>` looks up the pipeline ID in the selected project file
- `-d, --direction <value>` is `BT`, `LR`, `RL`, `TB`, or `TD` (default `TD`)
- `--descriptions` includes step descriptions in node labels
- `--markdown` wraps the result in a fenced Mermaid block
- `--tag <tag>`, `--owner <owner>`, and `--domain <domain>` filter steps as in `inspect`
- `--metadata` includes step metadata in node labels

The same graph is available in process as `pipeline.toMermaid()` or
`command.toMermaid()`.

## Run

```
tubeless run [options] <pipeline-id-or-file> [-- <command-args...>]
```

- `-e, --export <name>` selects a pipeline or command export
- `-p, --project <path>` looks up the pipeline ID in the selected project file
- `--store <path>` appends run events to a local SQLite database
- `--trace <path>` writes NDJSON traces to a file, or `-` for stdout

`--store` and `--trace` can be combined. Traces stay off stdout unless `--trace -`
is set. When `--trace -` is set, the TTY reporter and command result go to
stderr so stdout stays valid NDJSON. To send events to OpenTelemetry or another service, implement a
`PipelineTraceExporter` in your application; the [tracing recipe](../examples/tracing.ts)
shows JSON and OpenTelemetry adapters. Use `composeTraceExporters` from `tubeless/tracing` for multiple
destinations; a failed exporter does not stop the others or fail the pipeline.

`run` accepts a pipeline ID from `defineProject` or a file exporting a pipeline
or `definePipelineCommand`. An explicit command wins when present. Otherwise, one
uniquely selected pipeline is wrapped automatically using Standard JSON Schema
input metadata. Direct and project pipelines use the same derivation rules; custom
or unsupported input shapes require an explicit command adapter. In each case, the command adapter owns parsing, validation, option
mapping, reporting, and the result summary. For custom commands, omit `mapOptions`
when validated flags already satisfy same-name pipeline options; keep it when
names, types, defaults, or derived values differ. `--step` and `--target` stay
the flag names; the parsed keys are `stepIds` and `targets`.
`--max-concurrency` becomes the numeric `maxConcurrency` control, available to
`mapOptions` and hooks but excluded from the default domain-option mapping.

Start with [`automatic-cli.ts`](../examples/automatic-cli.ts). Use
[`cli-job.ts`](../examples/cli-job.ts) only when inputs need a custom mapping.

### Pipeline controls

Pass these flags after `--`, alongside the command's own arguments:

| Flag                         | Effect                                                                   |
| ---------------------------- | ------------------------------------------------------------------------ |
| `--dry-run`                  | Uses each step's dry-run policy; unmarked steps still execute            |
| `--target <id>`              | Runs a declared target and its required dependencies and failure gates   |
| `--step <id>`                | Runs only the specified step IDs; it does not add prerequisites          |
| `--max-concurrency <number>` | Limits simultaneous steps in this run; positive integer, defaults to `1` |
| `--continue-on-error`        | Continues independent work after failure; the run still fails            |

For example, `bunx tubeless run import -- --source rows.txt --max-concurrency 4`
allows up to four ready steps at once. Async skip predicates and output validation
occupy the step's slot. Fail-fast stops new dispatch and waits for active work;
`--continue-on-error` keeps eligible branches running. Child runs have separate
limits: set `maxConcurrency` in child `controls` to opt them in. Parent and fan-out
limits multiply; see [child pipeline composition](./child-pipeline-composition.md).

Repeat `--target` or `--step` to select multiple IDs, but do not combine them.
Check command help for any additional controls and application parameters:

```sh
bunx tubeless run import -- --help
bunx tubeless run import -- --source rows.txt --dry-run
```

A dry run executes safe handlers and custom previews. To inspect selection
without executing any handlers, use `tubeless plan` instead.

## Live progress

Interactive terminals show a progress tree that is redrawn in place. The header
counts finished steps and shows elapsed time, such as
`Pipeline check · 6/10 done · 12.4s`. Steps that haven't started list the
dependencies they are still waiting on (`waiting on lint, test`). Failed steps
show their duration and error. Steps skipped because of a dependency name it,
such as `gate (not run: format failed)`. At completion the header becomes a
summary, such as `Pipeline check failed in 15.2s · 10 steps, 1 failed, 1 skipped`.
Steps left out by `--step` or `--target` are not counted.

When a run fails, the workbench prints each causal error once. A `requireOutputs`
failure is left out when every step without an output failed, was cancelled, or
was skipped because of a failure, since it only repeats that failure. It is
printed when any step was filtered out or skipped by a dry run, even if another
step also failed, because that step may be the missing output.

## Live log pane

Interactive terminals at least 120 columns wide and 8 rows tall show a small
Logs pane to the right of the progress tree. It follows the latest eight lines
from `context.log`, including warnings and errors, with fewer lines in short
terminals. While the pane is visible, logs appear only there; long lines are
clipped. The pane adapts to terminal resizing and disappears at completion.
When a step fails, the last 50 lines it logged while the pane was visible are
printed below the final progress tree. When the pane is hidden, new logs print
above progress. Use `--trace` or `--store` when you need a complete recording.
Narrow terminals, redirected output, and plain reporting keep their usual layout.

Interactive output starts each step's log line with the step name, such as
`[lint] $ oxlint .`, so lines from concurrent steps stay distinguishable. Lines
from a nested pipeline are labeled with the parent step that invoked it.

The pane is enabled automatically. Configure it per command:

```ts
const command = definePipelineCommand(pipeline, {
  reporter: { logPane: "off" }, // Default: "auto"
});
```

Use `context.log` inside steps, and forward subprocess output to that logger if
you want it in the pane. Direct `console` calls and inherited subprocess output
are not captured. Try `bun examples/live-tui.ts` in a wide terminal.

## Nested progress

In an interactive terminal, child pipelines appear as indented steps:

```text
  ⠋ build-database
    ✓ prepare-artifacts
    ⠋ build-database [████░░░░] 50% 2/4
    · validate-and-promote
```

`fromPipeline` shows child steps; `forEachPipeline` adds an item-key row above
each child's steps. Deeper composition stays nested. Completed rows remain after
parents finish, and failed, cancelled, and skipped work retain distinct states.
Inner progress bars require the child to call `context.reportProgress`; lifecycle
rows work without instrumentation. Tall trees use a live window with omitted-row
counts and print the full retained tree at completion. Fan-out progress snapshots
show at most 32 live item groups by default, prioritizing active items and failures;
the complete tree is emitted once at completion. `progress.detailLimit` overrides
the live cap and caps the final snapshot too. When output is redirected or the terminal is not interactive, the CLI prints
progress summaries.

See [child composition](./child-pipeline-composition.md) for item-group display
limits and [fan-out progress](../examples/fan-out-progress.ts) for an example.

## History

```
tubeless history [options] [run-id]
```

- `--store <path>` selects the SQLite database (default `.tubeless/runs.sqlite`)
- `--trace <path>` selects a finished NDJSON trace artifact
- `--pipeline <id>` filters by the exact recorded pipeline ID
- `--json` emits the projected run list, or one projected run when `run-id` is set
- `--events` emits raw store events as NDJSON (run-scoped when `run-id` is set)
- `--clear` deletes all recorded events from a SQLite store and compacts it; requires `--yes` and cannot combine with `--trace`, `--json`, `--events`, or a run id
- `--yes` confirms `--clear`; there is no interactive prompt

`--store` and `--trace` cannot be combined. `--json` and `--events` cannot be
combined. `--pipeline` applies to every output mode and both artifact sources.
With `run-id`, both selectors must match the requested root; a mismatch is an unknown run (exit `1`).
A run ID may be abbreviated to a unique prefix of at least four characters, matched
against the full ID or the UUID after its `:`. An ambiguous prefix lists the
matching runs and exits `1`.
A pipeline with no recorded runs returns an empty list or event stream (exit `0`).
History reads recorded IDs directly without loading a project file or command module.
By default, history prints a run list. Supply a run ID to see that run's steps,
logs, and error details. Agent runs and parents containing agents also show their
recorded turn/call/child structure, state versions, call counts, and termination.
JSON details add the linked `agentHistory.agents` projection. Descendants are
included regardless of their pipeline IDs; `--events` remains scoped to the
requested run only. Missing observations stay unknown, and missing terminal
events stay recorded as running. See [agent history](./agents.md#inspection-and-recordings).
A missing store exits `2`. A store also exits `2` with an error if it has a pending SQLite `-wal` or
`-journal` file, has multiple hard links, or is not a supported run store. Schema versions 1 through 4
can be read. History reads an older store without writing. `tubeless run --store`, `tubeless ui`, and
`tubeless history --clear` refuse to write until [`tubeless upgrade`](#upgrade) has moved the file to the
current schema. An unknown run id exits `1`. `tubeless run --store` flushes pending events at completion. A process crash
before a flush can lose up to 63 buffered events. See [storage behavior](./studio.md#storage-behavior)
for programmatic writers and read-only access.
NDJSON files are opened read-only and validated before their events are
displayed. Event IDs start at zero and follow file order. By default, artifacts over 64 MiB, individual event
lines over 1 MiB, and traces over 100,000 events are refused. Diagnostics name
the line and invalid field without echoing its contents. Trace artifacts may
contain sensitive logs, errors, and event payloads; inspect only files you trust and
avoid exposing Studio beyond the intended host.

```sh
bunx tubeless run --store .tubeless/runs.sqlite --trace run.ndjson ./scripts/import.ts -- --source rows.txt
bunx tubeless history
bunx tubeless history --pipeline import
bunx tubeless history --json <run-id>
bunx tubeless history --events <run-id>
bunx tubeless history --trace run.ndjson
bunx tubeless history --clear --yes --store .tubeless/runs.sqlite
```

## Upgrade

```
tubeless upgrade [options]
```

Rewrite `.tubeless/runs.sqlite`, or the file passed to `--store`, to the current schema.
`--yes` confirms the rewrite. There is no interactive prompt. Without `--yes` the command
exits `1` and leaves the file unchanged. Versions 1 and 2 rebuild the event table in place,
keep event ids and the saved autoincrement counter, and rename retired `PIPES_` error codes
to `TUBELESS_`. Version 3 adds a column. The change commits once and cannot be undone.

Run this before an unattended `tubeless run --store` or `tubeless ui`. Those commands refuse
an older store instead of upgrading it while the job is running. A missing store exits `2`.
A store that is already current exits `0` and does not rewrite it.

```sh
bunx tubeless upgrade --yes --store .tubeless/runs.sqlite
```

## Studio

`tubeless ui --public-url https://example.com/admin/pipelines` enables gateway mode
and requires `TUBELESS_STUDIO_GATEWAY_TOKEN` from host secrets (64 hex characters
representing 32 random bytes). It permits registered commands on a private
non-loopback bind and disables history clearing. Preserve the mount prefix, set
the upstream Host to the public authority, and replace browser credentials with
the gateway credential after checking session/admin permission for every request.
See the complete [hosting contract](./studio.md#host-studio-behind-an-application-gateway)
for Origin, login expiry, readiness, persistence, and shutdown behavior.

## Init

```sh
tubeless init <target> [-p, --project <path>]
```

Scaffold deployment files for a project. The one target today is `cloudflare`,
which writes `cloudflare/worker.ts`, `cloudflare.config.ts` and `vite.config.ts`, and
prints an install step that pins `cf`, `vite` and `@cloudflare/vite-plugin`; the
[Cloudflare guide](./deploy-cloudflare.md) covers deploying them.
`--project` selects the project file (default `./tubeless.project.ts`).

`init` loads the project and derives every command before it writes anything, so
a broken project fails with the usual load error. It never overwrites: if any
target file already exists (for `cloudflare`, also any other Vite config file), it
names the conflicts and writes nothing. It warns when Node is older than the target's
deploy tooling needs (22.12 for `cloudflare`). After
creating the files it prints the next steps for the target. An unknown target or a
missing target argument is a usage error.

## Exit codes

| Code | Meaning      |
| ---- | ------------ |
| `0`  | Success      |
| `1`  | Usage        |
| `2`  | Load         |
| `3`  | Definition   |
| `4`  | Validation   |
| `5`  | Planning     |
| `6`  | Execution    |
| `7`  | Cancellation |

SIGINT is forwarded through the command context. Help (`--help` or a command's
own help) exits `0`.

Use `inspect --tag <tag> --owner <owner> --domain <domain>` for metadata discovery.
The same filters work with `graph`; add `--metadata` to include annotations in
node labels. Filters combine with AND and never change execution selection.
See [graph metadata](./graph-metadata.md) for complete semantics.

## Cache policy

Pipeline commands expose `--cache use|recompute|bypass` as an optional execution
control, also available in Studio. It affects only steps explicitly opted into
caching and propagates to child pipelines. Omission respects step policies;
`recompute` refreshes entries and `bypass` avoids all cache I/O. Dry runs always
bypass caching. The control is separate from domain options and does not change
default keys. See [step output caching](./step-output-cache.md).

## Tubeless Cloud

The same Bun executable supplies first-party `auth` and `cloud` commands. Create
or join a workspace, install the GitHub App, and connect its repository in the
[Cloud dashboard](https://cloud.tubeless.io) first. Workspace creation, repository
connections, pipeline loading, secrets, schedules and billing remain dashboard operations.

```sh
tubeless auth login
tubeless auth status
tubeless cloud list
tubeless cloud run orders-sync --input-file input.json
tubeless cloud run orders-sync --detach --json
tubeless cloud logs <run-id> --follow
tubeless auth logout
```

All Cloud commands accept `--workspace <id>` and `--host <origin>`. Without
`--workspace`, the session's single workspace is selected automatically. If you
have several, the command lists their names and IDs and asks for `--workspace`;
with none, create or join a workspace in the dashboard. An explicit workspace
is checked by the service on each request.

The default host is `https://cloud.tubeless.io`; `--host` selects another origin.
Origins require HTTPS except explicit localhost or loopback development.
Credentials are isolated by full origin. Commands work from any directory and
never read Git, project files or `.tubeless/cloud.json`, or write project context.

`auth login --no-browser` prints the approval URL and code. Confirm the code and
approve the device in the browser. Sessions expire after seven days and are
revocable. Tokens are stored through Bun's experimental native `Bun.secrets`
API in the OS credential store; the command needs a supported, unlocked native
credential service. It reports storage failure and does not use plaintext files.
The executable requires Bun 1.3.14 or later; Windows credential support has not
been validated on a Windows host. Older Bun releases use the native Windows
persistence default; Bun 1.4.2+ requests local machine persistence. For headless clients, inject an existing
expiring session as `TUBELESS_TOKEN`. It overrides stored credentials and is
never saved or printed. Dedicated scoped or long-lived CI tokens are not part of
this flow. `auth logout` revokes a stored session and removes the local entry;
when the environment token is active, remove it from the environment yourself.

`cloud list` shows each loaded pipeline's slug, name, Cloud ID, availability and
deployed commit. Run accepts an exact name or a listed slug: both
`cloud run "Orders sync"` and `cloud run orders-sync` select the same pipeline.
Slugs use lowercase words separated by hyphens and are derived from the current
name, so renaming changes the slug. Accents are normalized; Unicode letters and
numbers are retained. A name with no letters or numbers uses its Cloud ID as the
slug. A name ending in `.ts` is still a name. Unknown selectors suggest listing
or loading in the dashboard. Any collision between names or slugs requires
`cloud run --id <cloud-pipeline-id>`; ID selection cannot be combined with a name
or slug. Owners, admins and members can run; viewers can list and read logs.

A run executes its **deployed revision**. The accepted run's SHA is authoritative
and printed with its ID and dashboard URL. Local files and changes are never
loaded, uploaded or synchronized. Deployment and version management remain a
separate workflow.

Inputs are JSON objects up to 64 KB, with no local schema inference. Omitted input
is `{}`. Use `--input-file -` for stdin, or a regular JSON file. An explicitly
empty file path is a usage error. Arrays, null,
scalars, malformed JSON and numbers that overflow to infinity fail before admission.
Input supports at most 128 levels of objects and arrays, counting the root object.
Input must fit the limit after
JSON normalization as well as in the original file. A run invocation uses one
idempotency key for its bounded transport retry; local validation errors are not
retried. If admission remains uncertain,
the diagnostic prints that key and workspace so the request can be investigated.
Do not start a fresh run to retry an uncertain admission.

Foreground runs follow status and retained logs every two seconds. `--detach`
prints the run ID and returns after confirmed admission; use `--detach --json`
to read `.id` in a script. Ctrl-C stops following and prints the run ID;
it does not cancel the remote run. Cancel from the dashboard. Run logs retain a
bounded prefix of at most 400 entries, rather than an unlimited stream. Run
retention follows the workspace plan (7/30/90 days for Free/Team/Scale).

`cloud list --json`, `auth status --json`, `cloud run --json`, and
`cloud logs --json` write one complete JSON value to stdout and diagnostics to
stderr. Foreground run JSON is the final run; detached JSON is its admission
snapshot. `logs --follow --json` waits and returns its terminal retained snapshot.
Human output neutralizes terminal and bidirectional controls in remote text;
JSON output preserves the original fields.
Run response input and result fields must contain finite JSON values within the
same nesting limit. Invalid service payloads or out-of-range timestamps fail
response validation before output.

Cloud exit codes use the existing CLI codes: 0 success or detached admission,
1 usage, 2 credentials/workspace selection/transport, 4 invalid JSON or request
validation, 6 rejected admission or failed execution, and 7 cancelled execution
or local interruption.
