# Agent guide for `tubeless`

Use this guide when writing or modifying Tubeless pipelines, CLI scripts, or
shared helpers. It summarizes the implementation rules; the linked guides and
examples explain each feature.

For consumer projects, install the [agent skill pack](./agent-skills.md).
Use `tubeless-make-pipeline` to convert existing code: check caller inputs and results,
choose domain step boundaries, preserve types and failure behavior, and verify
dry runs with fake I/O. The general `tubeless` skill supports ongoing authoring.

## Workflow

1. Read the [recipe index](./recipes.md) and open the smallest matching example.
2. Group application pipelines with `defineProject(id, [pipelineA, pipelineB])` from
   `tubeless/project`; retrieve one with `project.get(id)` and use its ordinary
   `plan`, `run`, `runOrThrow`, or `toMermaid` methods. Use the
   [project example](../examples/tubeless.project.ts) as the minimal reference.
   Schema-backed pipelines are directly available to the CLI from project IDs or
   files, and to Studio from projects or registered command files.
   Automatic commands require Standard JSON Schema input metadata; schema-less
   pipelines need explicit command `params`, even with no inputs. Pass custom
   adapters directly in the project's entry list for CLI inputs, mapping, or presentation.
   Use a default export to select the project for CLI and Studio.
   Without a default, exactly one distinct project may be exported.
3. Declare stable IDs and operational descriptions. Add pipeline `name` only when
   CLI or Studio needs a friendlier display name; commands inherit pipeline
   presentation unless they explicitly override it.
4. Model data dependencies before failure policy or CLI concerns.
5. Typecheck the example or consumer, then run focused tests.
6. Run `make check` from the package root after changing the package, documentation, or examples.

## Choose pipeline features

Start with steps and dependencies; the later sections are independent and can be
read when a pipeline needs them.

- [Steps and dependencies](#steps-and-dependencies)
- [Concurrency](#concurrency)
- [Caching and artifacts](#caching-and-artifacts)
- [Child pipelines and iteration](#child-pipelines-and-iteration)
- [Remote work and worker threads](#remote-work-and-worker-threads)
- [Run inside a host engine](#run-inside-a-host-engine)
- [Deploy to Cloudflare](#deploy-to-cloudflare)
- [Projects and typed wrappers](#projects-and-typed-wrappers)
- [Commands and the workbench CLI](#commands-and-the-workbench-cli)
- [Declarative documents](#declarative-documents)
- [Graph metadata](#graph-metadata)
- [Agents](#agents)

### Steps and dependencies

- Use `createSteps<TDomainOptions>()` once per pipeline and destructure every
  constructor that pipeline uses: `step`, `fromPipeline`, `fromRemote`, `iteratePipeline`, and/or
  `forEachPipeline`. Use `definePipeline` once after declaring the steps. Domain
  option types contain domain input only;
  callers pass those options and optional built-in controls to
  `run(options, controls?)`, while `plan(controls)` accepts controls alone.
  Omit options with `run()` or `runOrThrow()` when no input fields are required;
  each call supplies a fresh `{}` to schema validation. Pass `undefined` as the
  first argument when supplying controls without input.
- Use `dependsOn` when the output is required, `optionalDependsOn` when absence
  is expected, and `skipAfterFailureOf` for a failure gate that supplies no data.
- Use `createSteps(optionsSchema)` when external domain options need Standard
  Schema validation or transformation. Add `outputSchema` only at step
  boundaries that receive untrusted or independently checked values, and
  `resultSchema` when the finalized public result must be checked. Core imports
  no schema library.
- Set `dryRun: "skip"` on filesystem writes, database mutations, publication,
  email, and other steps whose normal `run` must not execute in a dry run. Use a
  typed `dryRun` handler when the step should produce a preview value instead.
- Add `skip` to a step definition only for an intentional successful outcome.
  A string or `{ reason }` result makes its output `T | undefined`; handle that
  absence explicitly. If every skip branch returns `{ reason, value }`, the
  output remains `T`.
- For a static family sharing one implementation, adapt the recipe-local tuple
  helper in [parameterized steps](../examples/parameterized-steps.ts). Keep IDs,
  constants, and source step references explicit; expand synchronously before
  `definePipeline`. Preserve literal IDs and the factory's output type. The recipe
  uses one common output type, not an arbitrary heterogeneous callback. Use
  `forEachPipeline` for runtime items. See [static step families](./recipes.md#static-step-families).
- Treat a `PipelineDefinitionError` during module loading as an authoring bug;
  static graph mistakes are rejected when `definePipeline` is called.

### Concurrency

- Opt in to parallel independent steps with `run(options, { maxConcurrency: 4 })`.
  `plan(controls)` validates this and all other static controls before execution;
  it still does not invoke domain schemas.
  Pipeline commands expose the same control as `--max-concurrency 4`, including
  Studio forms. The default is `1` to preserve side-effect order. Required inputs, optional inputs,
  and failure gates all wait for terminal prerequisites. Skip predicates and output
  validation occupy slots; fail-fast stops dispatch and drains in-flight steps
  without cancelling them. `continueOnError` keeps eligible branches running;
  external cancellation stops dispatch in either mode and cancels unstarted selected
  steps after active work settles. Final step reports and step errors follow plan
  order; live hooks and traces follow event order. Every concurrent failure is kept.
  Child runs have separate limits, supplied through the child `controls` field. Parent and
  fan-out limits multiply: four fan-out steps at eight children each allow 32 active
  children. Do not share a semaphore between waiting parents and their children. See [the parallel DAG recipe](../examples/parallel-dag.ts).
  `maxConcurrency` and fan-out `concurrency` are the same kind of bound (an
  admission cap, not a guaranteed level) on different axes — DAG steps at run
  time vs. one step's children at authoring time. Both must be positive finite
  integers; an invalid fan-out bound is rejected when the step is created, or
  fails the step before any child starts when a callback supplies it. See
  [the full mapping](./child-pipeline-composition.md#planning-and-execution-controls).
- Use `runConcurrent` for bounded lightweight functions that do not need child
  lifecycle events. Use `runConcurrentPartial` when the caller needs completed
  results and the first failure instead of a throw. Both stop scheduling after
  failure or cancellation and drain active workers without cancelling siblings.
  Branch on `ok`: success has a dense input-order result array; failure has sparse
  results and the original first rejection or observed abort error, which may be
  `undefined`. Use `completedIndexes` to distinguish successful `undefined`
  outputs from holes. Invalid concurrency still throws as an authoring error.
  Use `runBatched` or `runBatchedPartial` for the same throw-or-partial split
  over fixed-size batches instead of individual items.

### Caching and artifacts

- Opt ordinary deterministic steps into caching with `cache: { version: "v1" }`,
  or `cache: true` to inherit the pipeline's `implementationVersion`. Defaults hash
  dependency inputs and validated options and store results under the run cwd's
  `.cache/<pipeline-id>/<step-id>/`. Set pipeline `cache.maxAge: "30 days"` with
  optional step overrides; numeric ages use milliseconds. Custom keys, stores, and
  codecs are overrides. Run `{ cache: "recompute" }` or `{ cache: "bypass" }` applies
  to child runs too; CLI/Studio supply the built-in `--cache` control. Keep it out
  of domain options. Dry runs, policy skips, and test overrides bypass caching.
  Hits validate raw results through `outputSchema` and carry `outputSource: "cache"`.
  Cache writes and validated hits automatically record write/reuse artifacts; history
  and Studio label these Cached output. Hits never replay application artifact records.
  The default codec rejects lossy round trips, including class instances; supply
  a reconstructing codec or return plain data. Artifact helpers reject cache options.
  Cache errors fail the step. See [cache contracts](./step-output-cache.md) and the
  [cache recipe](../examples/step-output-cache.ts).
- Record explicit I/O with `context.recordArtifact({ operation, artifact })` inside
  ordinary steps; use `read`, `write`, or `reuse` according to what actually happened.
  Domain results stay separate from trace metadata. Report each successful batch
  after persistence; prior records survive later failure or cancellation. Keep
  checkpoint advancement and atomic promotion application-owned.
  `loadArtifact` and `saveArtifact` from `createSteps` are conveniences for one read
  or unconditional write. Both return `{ value, artifact }` and publish the typed
  value. Savers default to `dryRun: "skip"`; custom handlers produce previews.
  Loaders that populate caches also need dry-run safety. Forward cancellation into
  adapters. Read [artifact contracts](./artifacts.md) and adapt
  [artifact lineage](../examples/artifact-lineage.ts). Keep manifests in artifacts,
  omit secrets from metadata, and preserve domain validation outside tracing.

### Child pipelines and iteration

- Use `fromPipeline` for one independently useful child workflow and
  `forEachPipeline` for runtime fan-out with stable keys and bounded concurrency.
  Omit `fromPipeline.mapOptions` when the parent's validated domain options satisfy
  the child's input type; those options are forwarded unchanged and validated by
  the child. Otherwise provide a mapper. Fan-out still requires per-item mapping.
  Keep `mapOptions` exclusively about child domain inputs. Put child `targets`,
  `stepIds`, concurrency, failure policy, and optional dry-run opt-in in the separate
  `controls` value or callback. A child cannot disable its parent's dry run.
  Add `skip` only when the whole fan-out may be intentionally omitted. A skip
  without a value produces `readonly T[] | undefined`; value-bearing skip paths
  preserve `readonly T[]`.
  Async `fromPipeline` result mappings publish resolved values; use that resolved
  shape for dependent inputs and policy-skip values.
  Parent plans show one wrapper step and expose `nestedPipeline` with the child
  pipeline id, declared step ids, and single/fan-out mode for presentation.
  The interactive CLI automatically expands selected child steps and fan-out
  items into nested progress rows and retains completed states. Inner progress
  counts and details propagate through both adapters; do not forward raw child
  hooks or duplicate this bookkeeping in consumers. Fan-out progress displays up to
  32 live item groups by default and emit the full retained tree once at completion.
  Set `progress.detailLimit` to override that live cap and cap the final snapshot.
- Use `iteratePipeline` to repeat a child with per-invocation state and a required
  positive `maxIterations`. Return `{ kind: "next", state }` or
  `{ kind: "finish", result }` from `transition`; use `IterationDecision<State, Result>`
  for an explicit contract. Finishing at the bound succeeds; continuing at the
  bound fails without another child. Keep state read-only and initialize it fresh
  for each run. Child controls are static; parent dry-run and cancellation propagate.
  Plans show the bounded region, while traces identify each actual child run.
  Set the child pipeline's `name` for numbered progress labels such as `Page 1`;
  unnamed children use `Iteration 1`.
  See [pagination](../examples/iteration.ts) and [iteration semantics](./child-pipeline-composition.md#repeat-a-child-with-bounded-state-transitions).

### Remote work and worker threads

- Use `fromRemote` for a unit of work that lives on another engine. Required
  fields are `adapter`, `mapInput`, and `outputSchema`. Omitting `dryRun`
  contacts the engine during a pipeline dry run; the adapter and remote
  worker must honor `context.dryRun` and include that flag in the
  request built by `mapInput`. Call `pipeline.runOrThrow` from a worker or activity handler and pass
  `correlationId` when an external system owns job delivery and retries. Pass
  `parentRunId` only when linking to a known Tubeless execution. Parent
  plans expose `remote` with `engine` and optional `target`. Adapters may
  forward remote lines through `context.log` and must rethrow remote
  failures as `Error` with `cause` / `code`. Follow the native-fetch example in
  [`remote-steps.ts`](../examples/remote-steps.ts), including validation of
  unknown JSON and forwarding the signal. Use
  [`host-embedding.ts`](../examples/host-embedding.ts) for host-owned invocation;
  correlation IDs do not provide persistence or checkpoint/resume.
- For actual CPU parallelism, use `createWorkerThreadAdapter` from `tubeless/node`
  through `fromRemote`; never serialize arbitrary handler closures. Supply an explicit
  module URL/export and cloneable payload, keep `outputSchema` on the parent step,
  and close the adapter when all callers are done. `poolSize` limits threads shared
  by that adapter; `maxConcurrency` limits admitted DAG steps. Worker cancellation
  allows cooperative cleanup then terminates unresponsive threads. Read the
  [worker protocol and lifecycle](./remote-step-composition.md#cpu-work-in-node-worker-threads)
  and the [executable recipe](../examples/worker-threads.ts).

### Run inside a host engine

- For Airflow 3, adapt [the paired Airflow examples](./airflow.md): use the public
  REST API at the application edge, keep submission out of dry runs, verify inputs
  before reattaching to a stable DAG run ID, and validate XCom results. Airflow owns
  retries of hosted pipelines; a cancelled HTTP wait does not cancel a remote DAG.
- For Temporal, follow [the Activity example](./temporal.md): invoke Tubeless inside
  an Activity, keep Workflow imports type-only for the Activity implementation,
  heartbeat during long waits, forward cancellation, and preserve Temporal's
  cancellation failure when Tubeless wraps an abort. Activity retries replay the
  whole pipeline; heartbeat progress alone does not resume its steps.
- For Inngest, follow [the durable step example](./inngest.md): call `runOrThrow`
  inside `step.run`, validate events before Tubeless can wrap a `NonRetriableError`,
  and return JSON-safe values. Failed attempts repeat the whole pipeline; completed
  durable steps reuse their saved result. Keep Inngest step tools outside Tubeless
  handlers. Host cancellation does not abort an already executing step.
- For Dagster, follow [the Pipes example](./dagster.md): keep the pipeline free
  of host imports, report materializations only after successful publication,
  require explicit Pipes materializations, and preview locally. Forward termination to
  Tubeless, correlate retries by host run and asset, and retain raw trace events
  for Studio. Dagster retries the entire asset invocation.
- For AWS Step Functions, follow [the Lambda example](./step-functions.md):
  invoke Tubeless within a synchronous Lambda Task, validate the incoming job,
  correlate by execution and state, and let thrown failures reach Step Functions.
  Clear deadline timers after each invocation. Host retries repeat the whole
  pipeline; stopping a workflow does not cancel an already-running Lambda.

### Deploy to Cloudflare

- To host Studio and a project on Cloudflare, run `tubeless init cloudflare` and follow
  [the deploy guide](./deploy-cloudflare.md); do not hand-write the Worker or its
  configuration. The scaffold never overwrites files and loads the project first.
  Keep its `vite.config.ts` and install the exact `cf`, `vite` and
  `@cloudflare/vite-plugin` versions it prints; `cf deploy` builds through that plugin.
  Keep the fixed binding names `TUBELESS_STUDIO`, `TUBELESS_RUN`, `TUBELESS_BUCKET`,
  `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`.
- Keep handlers Workers-compatible: no durable filesystem writes, no `v8` serialization.
  Read bindings through `import { env } from "cloudflare:workers"`.
- Give every cached step an explicit store and codec from `tubeless/cloudflare/cache`,
  never from `tubeless/cloudflare`, which loads only in workerd while step definitions
  also load in Node. Follow the guide's pattern: a small module passes a bucket getter
  to `createR2CacheStore`, exports `bindCacheBucket` and `r2Cache`, and
  `cloudflare/worker.ts` calls `bindCacheBucket(env.TUBELESS_BUCKET)`. Steps use
  `cache: { version, ...r2Cache }`. Those steps fail in local Node runs unless another
  bucket or store is supplied. The default file store and V8 codec fail on Workers, and
  `jsonCacheCodec` accepts only plain JSON data.
- Respect the run limit: one run executes in one Durable Object alarm and is aborted at
  14 minutes (`limits.maxRunDurationMs` cannot raise it). Keep single steps short, put
  long ones behind `fromRemote`, and use a host engine for multi-hour workflows.
- Never put secrets in `cloudflare.config.ts` text bindings. Every user Cloudflare Access
  admits sees all history and every command, so deploy a catalog meant for that audience.

### Projects and typed wrappers

- Use `defineProject` from `tubeless/project` to collect typed pipelines. Pipeline IDs
  stay literal, duplicate IDs fail during project definition, and `get(id)` returns the
  exact pipeline type. Union or widened IDs retain all matching candidate pipeline
  types. Give the project itself a stable ID; it remains literal on
  `project.id`. The project adds no execution layer.
  Let `definePipeline` infer its type arguments. Annotate the finalizer's return
  type for an explicit result contract; partial explicit type arguments default
  the pipeline ID to `string` and lose literal-ID lookup checks.
  Pass optional `{ name, description }` as the third argument. For documents,
  reuse `compiled.metadata?.name` and `compiled.metadata?.description`, or spread
  `compiled.metadata` before explicit overrides. Metadata and its authors are immutable
  snapshots; authors/date stay descriptive. Project ID and cwd belong to registration.
  The immutable `project.name` defaults to its ID.
  `ProjectOptions` names the configuration type. Register each pipeline exactly once,
  directly or through a `definePipelineCommand` entry: `[pipelineA, commandB]`.
  Duplicate pipeline IDs fail regardless of entry form; children are not registered
  recursively. `pipelines`, `pipelineIds`, and `commands` are derived read-only views.
  `cwd` controls CLI/Studio execution relative to the project file. For compiled
  documents, build adapters from `compiled.get(id)` and register them in the list. Pipeline IDs remain
  the single selection identity.
  Import `PipelineProject<TProjectId, TPipelines>` from `tubeless/project` when
  annotating a shared project factory or a function that accepts a project.
- Use `PipelineInput<typeof pipeline>` and `PipelineResult<typeof pipeline>` when
  typing wrappers around an inferred pipeline. `PipelineInput` is the value accepted
  by `run` before options-schema transformation. A command created with
  `definePipelineCommand` exposes that same exact inferred type as `command.pipeline`.

### Commands and the workbench CLI

- Use `definePipelineCommand(pipeline)` from `tubeless/cli` for scripts centered on
  a pipeline. Flags are inferred from the Standard JSON Schema input metadata of
  the schema passed to `createSteps(schema)`; see [automatic CLI](../examples/automatic-cli.ts).
  Use `overrides` only for aliases, flag names, descriptions or environment fallbacks.
  Type-only or validation-only schemas need explicit `params`; this replaces inference.
  Nested/union inputs, array defaults, and non-string `enum`/`const` constraints
  need explicit parameters and, when shapes
  differ, `mapOptions`. Keep these advanced escape hatches out of ordinary wrappers. Do not parse `process.argv` manually or redeclare built-in dry-run,
  `--step`, or `--target` flags. `mapOptions`, validation, and hooks receive `stepIds` and `targets`,
  not `step` or `target`. Omit `mapOptions` when validated flags already satisfy
  same-name pipeline options; provide it when names, types, defaults, or derived
  values differ.
  `--resume` is exposed only when `checkpoint` is configured or the command
  explicitly sets `resume: true` and handles `values.resume` itself. Otherwise
  the CLI rejects the flag and the descriptor omits the Studio control.
  The returned command exposes an immutable `descriptor`; UI adapters should
  render those parameter definitions instead of parsing help text.
  Command `name` and `description` default to their pipeline values; the name falls
  back to the pipeline ID. Supply command-level values only for CLI-specific wording.
  Use `command.plan()` or `tubeless plan` for a selection-only preview. Do not
  simulate planning with `--plan`.
- Use `defineCommand` from `tubeless/cli` for standalone scripts. A
  `defineProject` export is the normal shared CLI and Studio inventory. Pass
  explicit adapters in the project's entry list when pipelines need custom
  parameters, option mapping, or presentation. Each adapter uses its pipeline's ID. Keep application-specific prompts
  in the consumer.
- Use `pipeline.toMermaid()` or `command.toMermaid()` when documentation needs
  the static graph; do not duplicate dependency edges by hand.
- Use `tubeless list` for the project pipeline inventory. Use
  `tubeless inspect <pipeline-id>` for a project pipeline inventory,
  `tubeless plan` to preview selection without domain options or execution, and
  `tubeless graph` when generating documentation. `inspect`, `plan`, and `graph`
  accept a pipeline or a marked command and prefer the command when both are
  exported. Let the workbench discover the sole matching export or pass
  `--export`.
- Use `tubeless run <pipeline-id> -- <command-args>` for project pipelines, or
  `tubeless run <pipeline-file> -- <command-args>` for a uniquely selected
  schema-backed pipeline. A marked `definePipelineCommand` export wins when present;
  schema-less or unsupported inputs require one explicitly. Keep application flags after `--`; the command must
  continue to own domain validation and option mapping. Pass `--trace <path>` for
  NDJSON traces (`-` writes NDJSON to stdout and moves command output to stderr)
  and `--store` for SQLite; they compose. Use `tubeless history` to list or show
  recorded runs from SQLite, or pass `--trace` to inspect a finished NDJSON
  artifact without importing it.
  Filter shared history with `--pipeline <recorded-pipeline-id>` in any output
  mode. Use the pipeline definition’s ID. Agent run details include typed turn and
  call history, nested agents, state versions, errors, and termination; `--json`
  exposes `agentHistory.agents`. The pipeline filter selects the root while its
  detail includes descendants with other pipeline IDs. Raw `--events` remains
  run-scoped. Treat missing observations as unknown, not successful execution.

### Declarative documents

- For YAML or JSON authoring, read [declarative pipelines](./declarative-pipelines.md)
  and adapt [the YAML recipe](../examples/yaml-pipelines.ts). Parse at the
  application edge, then use `compilePipelineDocument(document, registry)` from
  `tubeless/project` with explicitly registered handlers, adapters, predicates, and schemas. A
  step declares exactly one of `run`, `fromPipeline`, or `forEachPipeline`;
  child pipeline IDs resolve within the document, while application code owns
  option, item, and result mapping through the matching adapter registry. Select a
  pipeline with `compiled.get(id)`, or pass `compiled.pipelines` to `defineProject`.
  Register only the pipelines you want to expose; compiled children need no separate
  project entry. Export the project for CLI and Studio: Standard JSON Schema input metadata enables
  automatic commands; custom or schema-less inputs need explicit adapters in the
  project's entry list. Unknown fields and references fail compilation;
  plans still do not validate domain inputs. Dynamic wiring does not infer
  TypeScript output types, so validate or narrow unknown values in handlers.
  Use [YAML Peloton](../examples/yaml-peloton.ts) for a larger example with
  progress, retrying concurrent handlers, dry-run policies, and failure gates.
  Its per-rider progress is ordinary step detail by choice; the smaller YAML
  recipe demonstrates child-pipeline fan-out.
  Use `tubeless validate --json <document.yaml>` for a handler-free structure
  check, and the [document JSON Schema](./pipeline-document.schema.json) for
  editor or agent validation. Optional document metadata is descriptive only.
  `inspect` or `plan` on a compiled command still checks graph semantics.
- For user choices, boolean confirmation, or open text in a declarative pipeline,
  register `waitForInput(...).run` as an ordinary handler. Declare dependencies,
  output schemas, and `dryRun: skip` in the document; helper configuration does
  not transfer with the callback. The application supplies question rendering
  and normalization. Use a skip predicate for a declined confirmation. See
  [input questions](./declarative-pipelines.md#user-decisions-confirmations-and-text)
  and the [YAML input recipe](../examples/yaml-user-input.ts).

### Graph metadata

- Add inert `metadata` (`tags`, `owner`, `domain`, `annotations`) for discovery.
  Use `querySteps(plan, query)`, `inspect --tag/--owner/--domain`, or
  `toMermaid({ query })` to find steps; queries never select execution.
  Metadata is bounded, copied, frozen, and isolated across child pipelines.
  Definitions carrying metadata use identity version 3. Document v1 rejects
  step/pipeline metadata. Read [graph metadata](./graph-metadata.md) and adapt
  [the recipe](../examples/graph-metadata.ts).

### Agents

- Use `waitForInput` from `createSteps` for a pluggable user/application input
  boundary in any pipeline. It uses ordinary lifecycle and output validation,
  remains pending until input arrives, honors cancellation, and skips dry runs
  unless given a preview callback. Input steps reject caching and policy skips;
  gate dependent actions with ordinary steps. See [input steps](./concepts.md#wait-for-user-or-application-input).

- Use `tubeless agent --model <name>` for a workspace prompt loop using the same
  pipeline reporter as `tubeless run`, including nested turn/tool progress,
  shimmer, colors, timing, and logs. Tool activity includes paths, command previews,
  and completion summaries in both the DAG and scoped logs. Custom handlers use
  `context.reportProgress` and `context.log` for their own activity detail.
  Completed prompts share conversation state;
  each prompt has fresh budgets. `/model` changes the next run's model while
  retaining context; `/clear` starts a fresh conversation. `--prompt` runs once,
  and `--no-graph` hides pipeline reporting. The interactive bike-inspired prompt
  supports Tab completion of `/model`, `/clear`,
  `/help`, `/quit`, and `/exit`; double Tab lists matching commands.
  `--model-module` loads a trusted factory returning the public `AgentModel`
  callback. Export `OPENAI_API_KEY` for the built-in provider or select a dotenv
  file with `--env-file`; existing process environment values take precedence.
  Missing-key checks are local; OpenAI authenticates model requests. HTTP 401
  diagnostics expose known rejection codes and safe recovery advice without raw
  provider messages. Restart the CLI after replacing credentials.
  Factories receive `{ model, signal, env }` with the resolved environment;
  asynchronous setup must honor cancellation and release its resources.
  Adapters append the new task on `context.turn === 1` and return the full final
  conversation. Failed/cancelled prompts retain the previous completed context.
  Ordinary `defineModelAgent` pipeline invocations remain isolated per run.
  See [agent CLI usage](./cli.md#prompt-a-workspace-agent) and the
  [provider plugin example](../examples/agent-repl-model.ts).

- For a general workspace agent, use `defineModelAgent({ id, model })` from
  `tubeless/agent` with `openaiModel()` from `tubeless/agent/openai` or
  `anthropicModel()` from `tubeless/agent/anthropic`. Both adapters share option
  names; set `baseUrl` (or `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`) for compatible
  servers such as OpenRouter or a gateway, and `compactAfterBytes: null` when the
  server lacks compaction. See [providers](./agents.md#choose-a-model-provider) and
  [compatible APIs](./agents.md#compatible-apis). It supplies
  task/answer schemas, a customizable coding prompt, startup AGENTS.md discovery
  from the physical workspace directory, shared by the model and all tool calls,
  and per-run conversation ownership. The optional provider adapter retains native
  history and compacts it before subsequent decisions. The prompt requires project-guidance
  reads in a separate turn before file operations or task commands in their scope;
  filename discovery may precede them, while optional exploration follows them.
  Add `instructions`, custom
  `tools`, or tighter `limits` as needed; the OpenAI adapter requires inline tool
  descriptors with strict object constraints, validated before HTTP. Large batches
  get explicitly marked model-visible previews; the harness retains full outcomes.
  Read [the model-agent contract](./agents.md#default-model-backed-agent)
  and adapt [the minimal recipe](../examples/agent-model.ts). The OpenAI adapter omits
  reasoning settings by default; the coding recipe and live evaluations explicitly
  request `reasoningEffort: "high"`, which requires a model that supports that setting.
  Use `bun run eval:agent`
  for opt-in paid workspace evaluations; routine CI stays credential-free.

- Use `defineAgent`, `defineTool`, and `pipelineTool` from `tubeless/agent` for an in-process
  decision loop over registered handlers, pipelines, and child agents. Read [agents](./agents.md) and
  adapt the credential-free [scripted recipe](../examples/agent.ts) or the
  [OpenAI recipe](../examples/agent-openai.ts) for a real provider callback. Keep model
  requests and prompts in `decide`; validate every tool input/output and the final
  result. Return `continue` with a nonempty batch or `finish` with a raw result.
  Every agent includes `read`, `write`, `edit`, `bash`, `list`, and `search`.
  `tools` adds capabilities or replaces defaults by name; narrow reducer outcomes
  by `ok` and `tool`. Paths resolve from the run cwd. Follow the
  [workspace recipe](../examples/agent-workspace.ts) for real file edits and shell checks.
  Writes and edits stage complete files before atomic replacement, requiring a writable
  destination directory and permission to preserve the original owner/group. These
  permission failures leave the original intact; there is no in-place fallback. Writes follow symlinks even
  when the target must be created. Bash bounds
  pipe draining during cancellation; escaped descendants may outlive the tool.
  List and search order entries by filename before applying caps. Directory
  searches retain matches when descendants become unavailable and count skipped entries.
  State is copied and frozen per initialization/reduction. Register children with
  `pipelineTool`; reuse their options schema or supply `inputSchema` and
  `mapOptions` together. Follow the [delegation recipe](../examples/agent-delegation.ts).
- Calls, decisions, depth, and leaf concurrency obey every ancestor limit; turns
  are local. Child options are prevalidated once for the whole batch. Add
  `durability: { store, key }` and an explicit `implementationVersion` for checkpointed
  decisions, outcomes, child state and budgets. Live children that inherit recovery
  also require an explicit `implementationVersion`; bump it when their semantics
  change. Reuse the key and inputs to resume;
  use a new key for changed semantics. See [durable execution](./agents.md#durable-execution)
  and the [SQLite recipe](../examples/agent-durable.ts). Running unsafe calls become
  recoverable interruption outcomes; mark only repeatable or idempotent tools
  `replay: "safe"`.
- Supply an `AgentEnvironment` for remote guidance, files
  and commands; children inherit it. The local adapter's `node:local` authority
  id is host-independent, so a recreated container or pod resumes; pass `id` to
  name another authority. Custom tools receive `context.environment`.
  Environment operations preserve signal cancellation across SDK-specific errors
  and late results, while still draining active work.
  Guidance paths are nonblank and limited to 4,096 characters; guidance is checked
  against the 32 KiB UTF-8 prompt budget before each section is retained.
  Remote tools obey the same UTF-8 byte limits as local tools. Oversized write/edit
  arguments fail before batch dispatch; oversized read, bash, listing and search
  results fail before state commits. See [the environment contract](./agents.md#execution-environments).
  Use the [environment recipe](../examples/agent-environment.ts) and the optional
  local and SQLite adapters from `tubeless/agent/node`. Dry runs skip decisions and handler tools unless both provide
  preview handlers. Agents remain ordinary pipelines for projects and CLI use.
- Use `fromPipeline` to feed a validated answer into ordinary dependent work;
  the [composition recipe](../examples/agent-pipeline.ts) includes credential-free previews.
  Resolve provider credentials only during execution, pass cancellation to the
  HTTP request, and keep provider response parsing in application code. The
  OpenAI recipe has no live dry-run callback; use the scripted recipe for previews.
  Bound questions, accumulated observations, and encoded provider requests before
  sending them. Reject oversized text without silently changing tool results.

## Runtime rules

- Library entrypoints are ESM-only and require Node.js 22.6 or later. The
  `tubeless` CLI uses a `#!/usr/bin/env bun` entrypoint and requires Bun 1.3.14
  or later on `PATH`.
- Use `context.log`, never direct `console` calls inside steps. Wide interactive
  terminals show recent logs beside progress automatically (120 columns by
  8 rows minimum). Set command `reporter.logPane` to `"off"` to disable the pane;
  logs appear only in the pane while it is visible. Use `--trace` or `--store`
  for complete recordings. Forward subprocess output through `context.log`
  when it should appear there. See [the live TUI recipe](../examples/live-tui.ts).
- Pass `context.signal` into network calls, batching, retry, rate limiting, and
  long waits. Use `context.sleep` for retry-aware or testable delays.
- Call `context.reportProgress` for long loops and `context.reportAttempt` for
  retries that operators should see.
- Resolve relative files from `context.cwd` with `node:path`.
- Import optional Node helpers from `tubeless/node`: `definePaths` resolves named
  paths against each run's `context.cwd`; `writeJson` creates parents and atomically
  replaces JSON files, rejecting unserializable top-level values before touching
  disk; `readJson<T>` parses trusted JSON without schema validation;
  `resetDir` deletes and recreates generated output directories; `requireEnv`
  checks required environment values when called. Mark writes and resets with
  `dryRun: "skip"`; these helpers do not inspect pipeline controls themselves.
- Use `runOrThrow` when every step must succeed and the caller expects a value.
  It always throws for an unsuccessful run, including `continueOnError` runs.
  Use `run` when the caller must inspect failures, skips, timings, or best-effort
  output. Branch on `run.finalized` before consuming `run.value`; the true branch
  narrows the value to the exact pipeline result type, including when that type
  contains `undefined`. Finalization is independent of success, so a failed
  best-effort run can still carry a finalized value. Its versioned `PipelineRun`
  exposes its unique `runId`, optional
  reusable `correlationId`, terminal status and
  timestamps, errors, and timestamped step reports with correlated attempt IDs;
  structural skips have no attempt ID or start timestamp. Use hooks or tracing
  for streaming logs and progress. Exporter failures warn once per emitter and
  do not fail the run; pass `onExporterError` to observe the first drop. Use
  `plan` when nothing may run.
- Declare supported downstream goals with `targets: [step]` on
  `definePipeline`, then explicitly select their literal IDs through run controls.
  Without selection controls, run every step; no target is selected automatically.
  Omitted definition `targets` exposes the last step in execution order as a
  selectable goal; `targets: []` exposes none. An explicit run target selects its
  required inputs and failure gates recursively. Use `stepIds` only when
  exact low-level filtering of any step is intentional. `PipelineRunControls`
  rejects both selections together at compile time; dynamic inputs retain the
  runtime planning check. Omitted or `undefined` selectors remain valid.
- Read `PipelinePlanStep.selectionReasons` when explaining selection. It already
  includes originating targets and immediate dependents; do not reconstruct
  selection reasons by walking dependency arrays in application code. The
  workbench owns terminal plan formatting and reporting.
- Use focused hooks for ordinary observation: `onStepStart`,
  `onStepProgress`, `onStepComplete`, `onStepSkip`, `onStepCancel`, and
  `onStepFail`. Their event metadata is already narrowed. Use additive
  `onStepStatus` only when one consumer genuinely needs the whole discriminated
  lifecycle, such as a status-aware renderer or event store.
  Hook metadata is copied separately for each callback; mutations cannot change
  execution, tracing, or other callbacks. Finalized domain values retain their
  identity and must be treated as read-only by hooks.
- Use `createPipelineTestRuntime` from `tubeless/testing` for deterministic
  pipeline tests. Inspect its structured logs, statuses, and latest progress;
  keep test-framework matchers outside the package. Supply typed intermediate values
  with `overrideStep(step, value)` and test-run `{ overrides: [...] }` controls.
  Values use the handler output type before `outputSchema` validation/transformation;
  successful substitution reports `completed` and emits `onStepComplete` with
  `outputSource: "override"`. This provenance also survives failed or cancelled
  validation attempts. Overrides apply only to selected steps, bypassing their handlers,
  skip predicates, dependency gates, and dry-run policies. Use exact `stepIds` to
  exclude upstream I/O; overrides do not prune the graph or propagate into children.
  Ordinary pipeline, CLI, and Studio launch controls do not accept overrides. See
  [the override recipe](../examples/step-output-overrides.ts).
- Branch on `PipelineError.code`, `phase`, and `kind`, never message prose.
  Underlying thrown codes live in `sourceCode`. Failed and cancelled reports
  expose the structured error under `error`; skipped reports expose `reason`,
  optional `message`, and optional `dependencyId`. `PipelineError.cause` is a
  bounded JSON-safe snapshot; a thrown `PipelineExecutionError` retains the
  original value through native `Error.cause`.
- Inspect `error.fanOut` in reports or recorded trace history for bounded keyed failures from `forEachPipeline`. Check
  `omittedFailureCount` and `keyTruncated` before selecting rerun inputs; unstarted
  items are not failures. The caller starts a new run for any retry.
- Standard Schema failures use `kind: "validation"`, retain normalized `issues`,
  and have separate codes for options, step outputs, and final results.
  Async schemas run during `run`; synchronous `plan()` previews graph and
  selection only and never invokes schemas.
- A single-goal pipeline can be `{ id, steps }`. Omit `finalize` to return the
  output of the last step in execution order, or `undefined` if absent. Defaults use
  the full graph's topological order and do not limit an unfiltered run. `resultSchema` still
  validates the value, including absent output. See the
  [minimal recipe](../examples/minimal-pipeline.ts).
- Use `finalize: step` to require and return a declared step's exact output type.
  It preserves output-schema transformations and valid `undefined` values;
  missing outputs fail finalization. It does not change targets or selection.
  Add `resultSchema` to validate or transform that output. See the
  [precise result recipe](../examples/precise-result.ts).
- Wrap explicit finalizers in `requireOutputs` when a valid result requires
  specific step outputs. Use a plain finalizer only when partial output is a
  valid domain result.
- Preserve the dependency-free runtime. Implement concrete JSON or telemetry SDK
  adapters at the application edge against `PipelineTraceExporter`; see the
  [tracing recipe](../examples/tracing.ts). Use `composeTraceExporters` from `tubeless/tracing` when
  one run must fan out to multiple destinations; `onExporterError` reports the
  first partial drop, the failed destination is retired, and healthy exporters
  keep receiving events.
- Keep durable local observation opt-in. Use `tubeless run --store` for SQLite
  history and `tubeless run --trace` for portable NDJSON traces. Inspect them
  with `tubeless history` or `tubeless ui`. An older SQLite store is not upgraded
  on open. Run `tubeless upgrade --yes --store <path>` before an unattended job
  writes to it. Treat trace files as sensitive: logs,
  errors, and event payloads are displayed as recorded, and malformed or oversized
  artifacts are rejected. `tubeless history` inspects a finished artifact and
  refuses a store with a live writer or multiple hard links. A crash can lose
  buffered events from a live writer; `tubeless run --store` flushes at
  completion so finished runs are durable. Do not make pipeline
  definitions depend on storage or the studio. Version 3 trace events are a
  discriminated union keyed by `name`; use their typed `payload` rather than
  parsing scalar attributes. Recorded history keeps the last `reportProgress` `details`
  plus `detailCount`, and child wrapper steps keep `nestedPipeline` with the
  original `stepCount`. Studio renders those
  snapshots; it does not flatten child DAGs into the parent step.
  Compiled pipelines expose immutable `definition` metadata. Set `implementationVersion`
  on `definePipeline` to a release/source/build identity for handlers, schemas, mappings,
  and finalizers; a structural fingerprint alone never proves code equality.
  `pipeline.started` records carry a definition identity and a bounded snapshot.
  Ordinary definitions retain identity version 1; iteration and its ancestors use
  version 2, including the bound and static child controls in their fingerprints.
  Repeated child runs carry an `iteration` relation to the owning run, step,
  attempt, and one-based index; each child still has a fresh execution ID.
  Children started by pipeline steps or agent tools record `payload.parentStepId`
  on `pipeline.started`; runs linked by a hand-passed `parentRunId` do not.
  Studio retains versions, groups their runs, and compares complete snapshots. Legacy
  recordings have unknown identity; oversized snapshots retain identity but cannot be
  compared. Storage rejects complete snapshots whose contents, including recorded child
  implementation identities, do not match their hashes.
  Definitions live as long as their run events. See [definition history](./studio.md#definition-history-and-comparison).
  Legacy observed definitions pick the latest `pipeline.started` by `timestampMs`, then
  store-local id. Storage readers, projections, and Studio embedding are
  workbench internals rather than application extension points.
  Readers accept saved version 2 recordings as well as new version 3 events;
  concrete exporter entrypoints are not part of that durability contract.
- Pass caller-owned `correlationId` through `PipelineContext` when joining an
  external job or workflow. `runId` is package-generated for every execution;
  pass a known execution `runId` as `parentRunId` only to link that parent.
- Use `tubeless ui` to inspect local recordings and launch pipelines from a
  checked-in `defineProject`. Supply explicit `definePipelineCommand` adapters in
  its entry list; never infer executable modules from observed history.
  Keep the default loopback binding for local use. For deployed Studio, follow the
  [gateway hosting contract](./studio.md#host-studio-behind-an-application-gateway):
  use `--public-url` with a server-only `TUBELESS_STUDIO_GATEWAY_TOKEN`, preserve the
  mount, and require application session/admin checks on every forwarded request.
  Studio owns gateway authentication and process-local execution; the application
  owns identity, the explicit deployed catalog, private transport, supervision,
  and persistent SQLite. Never retry uncertain launch requests. The internal JSON
  protocol is version-coupled and is not a public application API. History pages
  contain summaries; selected-run and definition details load separately. Definition
  run pages refresh independently of metadata and comparisons. Search
  includes descendants across the complete history, and clearing succeeds once
  deletion commits even if subsequent compaction fails. Cancel a live top-level launch from the running detail pane;
  that abort is process-local, leaves sibling launches running, and is not
  crash-resume.

## Cloud command use

Use `tubeless auth login`, then `cloud list` to select an already-loaded pipeline
by exact name or listed slug. Use `cloud run --id <id>` when selectors collide.
A single session workspace is automatic; multiple workspaces require
`--workspace <id>`. Load and synchronize pipelines in the dashboard.
`cloud run` executes only the existing deployment and never reads Git, project
configuration or local modules. Pass JSON object input via `--input-file`, use
`--json` for automation and `--detach` for admission only. Preserve an uncertain
admission key rather than launching a fresh run. Ctrl-C stops following;
cancellation remains explicit in the dashboard.
Read [the Cloud CLI contract](./cli.md#tubeless-cloud) for credentials, roles,
workspace selection, retention and exit codes.

## Failure and safety rules

- Do not use `skip` to swallow an exception.
- Do not treat dry run as rollback; external side effects require
  `dryRun: "skip"` or a side-effect-free custom `dryRun` handler.
- Do not publish after a failed or cancelled validation step. Make validation
  required, or use `skipAfterFailureOf` when its output is intentionally optional;
  the gate blocks both unsuccessful terminal statuses.
- Do not hide absent required finalizer outputs behind defaults. Declare them
  with `requireOutputs`; handle optional outputs explicitly.
- Keep step IDs stable because reports, hooks, traces, and CLI selection use them.
- Treat `name` as presentation only. Dependencies, outputs, traces, and CLI
  selection continue to use the stable step ID.

## Required references

- Read [core concepts](./concepts.md) for skip, failure, or selection changes.
- Read [the CLI](./cli.md) for list, inspect, plan, graph, run, history, and exit codes.
- Read [the studio](./studio.md) before changing `tubeless ui` or
  project command adapters.
- Read [child composition](./child-pipeline-composition.md) before changing child
  propagation, progress, or parent/child selection.
- Read the relevant executable example linked from the
  [recipe index](./recipes.md) before writing new usage.
- Adapt advanced custom command adapters from the
  [project with custom adapters](../examples/project/tubeless.project.ts).
- Use the [generated API inventory](./api-reference.md) only to verify exports;
  it is not implementation guidance.

## Validation

For package changes:

```sh
make check
```

For a consumer-only change, run its focused tests and the repository typecheck.
If public declarations change intentionally, regenerate the checked API artifacts
with `bun run api:generate` from the package root.
