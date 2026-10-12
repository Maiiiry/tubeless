# Recipe index

Choose the example closest to your task, then adapt its inputs, step IDs, and
outputs. Each linked TypeScript example uses public package imports and is
compiled and checked against the packaged library.

For an existing script or workflow, use `tubeless-make-pipeline` from the
[agent skill pack](./agent-skills.md) to choose step boundaries before adapting
one of these recipes.

| Intent                                                  | Executable recipe                                                                                                                                       | Main primitives                                                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run all steps with a default result                     | [`minimal-pipeline.ts`](../examples/minimal-pipeline.ts)                                                                                                | `definePipeline({ id, steps })`                                                                                                                                                 |
| Reuse deterministic step outputs across runs            | [`step-output-cache.ts`](../examples/step-output-cache.ts)                                                                                              | Versioned opt-in, checked codec, readable ages, cache controls and artifact receipts                                                                                            |
| Return one step's exact result type                     | [`precise-result.ts`](../examples/precise-result.ts)                                                                                                    | `finalize: step`, required output, inferred result type                                                                                                                         |
| Omit empty inputs and identity child mapping            | [`inherited-inputs.ts`](../examples/inherited-inputs.ts)                                                                                                | `runOrThrow()`, compatible parent inputs through `fromPipeline`                                                                                                                 |
| Run independent DAG branches concurrently               | [`parallel-dag.ts`](../examples/parallel-dag.ts)                                                                                                        | `maxConcurrency`, `plan()` checks controls, dependency joins, stable final reports                                                                                              |
| Declare a static family of checks                       | [`parameterized-steps.ts`](../examples/parameterized-steps.ts)                                                                                          | Recipe-local tuple helper, literal IDs, explicit dependencies                                                                                                                   |
| CPU parallelism on Node worker threads                  | [`worker-threads.ts`](../examples/worker-threads.ts)                                                                                                    | `createWorkerThreadAdapter`, `fromRemote`, structured clone, pool ownership                                                                                                     |
| Sequential import or ETL                                | [`typed-import.ts`](../examples/typed-import.ts)                                                                                                        | `createSteps`, `dependsOn`, `requireOutputs`, `targets`                                                                                                                         |
| Define and compose pipelines in YAML or JSON            | [`yaml-pipelines.ts`](../examples/yaml-pipelines.ts)                                                                                                    | `compilePipelineDocument(document, registry)`, adapters, skips, child fan-out                                                                                                   |
| Validate options, outputs, and results                  | [`validated-boundaries.ts`](../examples/validated-boundaries.ts)                                                                                        | Standard Schema, `outputSchema`, `resultSchema`                                                                                                                                 |
| Inspect, plan, or graph a pipeline or command           | [`typed-import.ts`](../examples/typed-import.ts)                                                                                                        | `tubeless inspect`, `tubeless plan`, `tubeless graph`, `toMermaid`                                                                                                              |
| Safe write/publish preview                              | [`publish-with-gates.ts`](../examples/publish-with-gates.ts)                                                                                            | `dryRun`, `optionalDependsOn`, `skipAfterFailureOf`                                                                                                                             |
| Deliberately omit unnecessary work                      | [`conditional-step.ts`](../examples/conditional-step.ts)                                                                                                | `step` with `skip`, valued skip, skip-aware output typing                                                                                                                       |
| Preserve independent work after failure                 | [`best-effort.ts`](../examples/best-effort.ts)                                                                                                          | `continueOnError`, `finalized` result narrowing                                                                                                                                 |
| Compose one reusable workflow                           | [`child-pipeline.ts`](../examples/child-pipeline.ts)                                                                                                    | `fromPipeline`, domain `mapOptions`, child `controls`, async `mapResult`                                                                                                        |
| Repeat a child until a bounded finish decision          | [`iteration.ts`](../examples/iteration.ts)                                                                                                              | `iteratePipeline`, fresh state, `next` / `finish`, static controls                                                                                                              |
| Run a bounded in-process agent                          | [`agent.ts`](../examples/agent.ts)                                                                                                                      | `defineAgent`, `defineTool`, ordered outcomes, immutable state; [guide](./agents.md)                                                                                            |
| Resume a workspace agent after a restart                | [`agent-durable.ts`](../examples/agent-durable.ts)                                                                                                      | SQLite checkpoints, stable execution keys, saved conversation and outcomes; [contract](./agents.md#durable-execution)                                                           |
| Run a model-backed workspace agent                      | [`agent-model.ts`](../examples/agent-model.ts)                                                                                                          | Default prompt, project instructions, native conversation and compaction; [setup](./agents.md#default-model-backed-agent)                                                       |
| Prompt an agent repeatedly with live pipeline reporting | [`agent-repl-model.ts`](../examples/agent-repl-model.ts)                                                                                                | `tubeless agent`, retained conversation, `/clear`, shared reporter, Tab completion, model selection, `--env-file`, pluggable provider; [CLI](./cli.md#prompt-a-workspace-agent) |
| Wait for user review before continuing                  | [`user-input.ts`](../examples/user-input.ts)                                                                                                            | `waitForInput`, typed pluggable input, cancellation, dry-run preview; [contract](./concepts.md#wait-for-user-or-application-input)                                              |
| Ask for choices, confirmation, or text in YAML          | [`yaml-user-input.ts`](../examples/yaml-user-input.ts)                                                                                                  | Registered `waitForInput(...).run`, output schemas, declined confirmation skip; [guide](./declarative-pipelines.md#user-decisions-confirmations-and-text)                       |
| Let a real LLM choose tools and finish                  | [`agent-openai.ts`](../examples/agent-openai.ts)                                                                                                        | Application-owned Responses callback, accumulated outcomes, validated finish; [setup](./agents.md#connect-a-model)                                                              |
| Delegate to subagents and ordinary pipelines            | [`agent-delegation.ts`](../examples/agent-delegation.ts)                                                                                                | `pipelineTool`, private child state, shared call/decision/depth/concurrency limits                                                                                              |
| Embed an agent in an ordinary pipeline                  | [`agent-pipeline.ts`](../examples/agent-pipeline.ts)                                                                                                    | `fromPipeline`, validated child answers, dependent work, credential-free previews                                                                                               |
| Supply local or remote workspace capabilities           | [`agent-environment.ts`](../examples/agent-environment.ts)                                                                                              | `AgentEnvironment`, inherited capabilities, optional Node adapter                                                                                                               |
| Read, edit and check a workspace with default tools     | [`agent-workspace.ts`](../examples/agent-workspace.ts)                                                                                                  | Default read/write/edit/bash/list/search tools, custom additions, real filesystem and shell execution                                                                           |
| Call a real HTTP service                                | [`remote-steps.ts`](../examples/remote-steps.ts)                                                                                                        | `fromRemote`, fetch cancellation, validated HTTP output                                                                                                                         |
| Host a pipeline in a durable engine                     | [`host-embedding.ts`](../examples/host-embedding.ts)                                                                                                    | `runOrThrow`, pass `correlationId` / `parentRunId`                                                                                                                              |
| Invoke an Airflow DAG and validate its result           | [`airflow/remote.ts`](../examples/airflow/remote.ts)                                                                                                    | `fromRemote`, stable run identity, polling, XCom validation; [setup](./airflow.md)                                                                                              |
| Run a pipeline inside an Airflow task                   | [`airflow/hosted.ts`](../examples/airflow/hosted.ts), [Python DAG](../examples/airflow/tubeless_example.py)                                             | `runOrThrow`, host-owned retries, correlation, structured task logs                                                                                                             |
| Run a pipeline inside a Temporal Activity               | [`temporal/activities.ts`](../examples/temporal/activities.ts)                                                                                          | `runOrThrow`, Activity retries, heartbeats, cancellation; [setup](./temporal.md)                                                                                                |
| Run a pipeline inside an Inngest durable step           | [`inngest/functions.ts`](../examples/inngest/functions.ts)                                                                                              | `step.run`, retries, JSON results, local preview; [setup](./inngest.md)                                                                                                         |
| Materialize a Dagster asset with a pipeline             | [`dagster/hosted.ts`](../examples/dagster/hosted.ts), [Python asset](../examples/dagster/definitions.py)                                                | Dagster Pipes, materialization metadata, data versions, traces; [setup](./dagster.md)                                                                                           |
| Run a pipeline on AWS Step Functions                    | [`step-functions/handler.ts`](../examples/step-functions/handler.ts), [SAM template](../examples/step-functions/template.json)                          | Lambda hosting, retries, deadlines, correlated logs; [setup](./step-functions.md)                                                                                               |
| Deploy to your Cloudflare account                       | [`cloudflare/cloudflare.config.ts`](../examples/cloudflare/cloudflare.config.ts), [`cloudflare/worker.ts`](../examples/cloudflare/cloudflare/worker.ts) | `tubeless init cloudflare`, `createCloudflareApp`, Access, R2 cache store; [setup](./deploy-cloudflare.md)                                                                      |
| Fan out over runtime items                              | [`fan-out-progress.ts`](../examples/fan-out-progress.ts)                                                                                                | `forEachPipeline` with `skip`, stable keys, concurrency, progress                                                                                                               |
| Inspect keyed fan-out failures                          | [`fan-out-progress.ts`](../examples/fan-out-progress.ts)                                                                                                | `error.fanOut`, bounded diagnostics, caller-directed reruns                                                                                                                     |
| Show determinate progress                               | [`fan-out-progress.ts`](../examples/fan-out-progress.ts)                                                                                                | `reportProgress`, bounded live CLI rows, complete final trees                                                                                                                   |
| Watch the live TTY reporter                             | [`live-tui.ts`](../examples/live-tui.ts)                                                                                                                | named steps, nested `details`, pane-only logs; `reporter.logPane`                                                                                                               |
| Retry and rate-limit remote calls                       | [`resumable-enrichment.ts`](../examples/resumable-enrichment.ts)                                                                                        | `withRetry`, `RateLimiter`, injected sleep and signal                                                                                                                           |
| Resume durable long-running work                        | [`resumable-enrichment.ts`](../examples/resumable-enrichment.ts)                                                                                        | `dryRun`, `openCheckpoint`, `withCheckpointedBatch`                                                                                                                             |
| Record typed artifact reads and writes                  | [`artifact-lineage.ts`](../examples/artifact-lineage.ts)                                                                                                | `recordArtifact`, loaders/savers, reuse; [guide](./artifacts.md)                                                                                                                |
| Write local pipeline artifacts                          | [`node-artifacts.ts`](../examples/node-artifacts.ts)                                                                                                    | `definePaths`, atomic `writeJson`, `context.cwd`, `dryRun`                                                                                                                      |
| Turn a schema-backed pipeline into a CLI                | [`automatic-cli.ts`](../examples/automatic-cli.ts)                                                                                                      | `definePipelineCommand(pipeline)`, inferred flags, automatic reporting                                                                                                          |
| Map custom command inputs to pipeline options           | [`cli-job.ts`](../examples/cli-job.ts)                                                                                                                  | `definePipelineCommand`, conditional `mapOptions`, `tubeless run`                                                                                                               |
| Handle cancellation and deterministic testing           | [`cancellation-and-testing.ts`](../examples/cancellation-and-testing.ts)                                                                                | `createPipelineTestRuntime`, captured status/progress                                                                                                                           |
| Supply intermediate outputs in tests                    | [`step-output-overrides.ts`](../examples/step-output-overrides.ts)                                                                                      | `overrideStep`, validated outputs, override provenance                                                                                                                          |
| Export lifecycle events                                 | [`tracing.ts`](../examples/tracing.ts)                                                                                                                  | app-owned JSON / OTel adapters, composition, `onExporterError`                                                                                                                  |
| Observe lifecycle without changing execution            | [Lifecycle hooks](./concepts.md#step-statuses-and-structured-errors)                                                                                    | per-callback metadata snapshots; treat domain result values as read-only                                                                                                        |
| Watch many primitives in one run                        | [`peloton.ts`](../examples/peloton.ts)                                                                                                                  | delays, logs, children, fan-out, retry, gates, test runtime                                                                                                                     |
| Watch an advanced YAML pipeline                         | [`yaml-peloton.ts`](../examples/yaml-peloton.ts)                                                                                                        | declarative graph, concurrent handlers, retries, progress, dry runs, gates                                                                                                      |
| Expose a project to CLI and Studio                      | [`tubeless.project.ts`](../examples/tubeless.project.ts)                                                                                                | `defineProject`, inferred flags, `tubeless list`                                                                                                                                |
| Register custom command adapters                        | [`project/tubeless.project.ts`](../examples/project/tubeless.project.ts)                                                                                | `defineProject`, explicit command adapters, custom mappings                                                                                                                     |
| Host Studio beneath a private admin URL                 | [Gateway hosting](./studio.md#host-studio-behind-an-application-gateway)                                                                                | `--public-url`, server-only gateway token, application-owned authorization                                                                                                      |

The [model-agent recipe](../examples/agent-model.ts) explicitly requests high reasoning;
omit that option when selecting a model that does not support it. The recipe loads guidance from the physical
workspace path and uses that same cwd for all tool calls. The prompt requires nested guidance
before file operations or task commands in its scope. Custom OpenAI tools need inline strict schemas; oversized result
batches use explicit previews while the harness keeps complete outcomes. See the
[model-agent contract](./agents.md#default-model-backed-agent).
Record the [delegation recipe](../examples/agent-delegation.ts) with `--trace` or
`--store`, then use `tubeless history <run-id>` for typed agent/turn/call history
and child-agent links; add `--json` for the same structured projection.

For ownership and governance discovery, adapt [graph-metadata.ts](../examples/graph-metadata.ts).
Use `metadata`, `querySteps`, and `toMermaid({ query })`; read [graph metadata](./graph-metadata.md)
for bounds, trace identity, and document compatibility.

## Static step families

Use [`parameterized-steps.ts`](../examples/parameterized-steps.ts) when several
statically known steps share an implementation. Its `defineRangeChecks` helper
accepts a readonly tuple of specifications and returns an ordered tuple of ordinary
steps. Each specification names a stable ID, description, source step, and bounds.
The example checks positive quantities, fulfillment limits, and catalog prices.

The helper expands the whole family synchronously at module load. Spread it into
`steps` and, when each check should be selectable, `targets`. Pass the tuple to
`dependsOn` to join all checks, or use an individual tuple member to depend on one.
Plans, traces, Mermaid diagrams, and Studio show each check as an ordinary step.
`definePipeline` still validates duplicate IDs and missing dependencies.

This is a recipe-local pattern, not a new package export. Adapt the concrete
factory and specification type to your domain. Every check in this example
returns a number; sources must publish numeric arrays. The mapped tuple type
preserves each position's literal ID. Its one assertion accounts for `Array.map`
losing tuple positions, and is justified by the factory always using the supplied
ID and returning the same output type. Do not reuse that assertion for a factory
whose output type varies by specification. Prefer explicit declarations for
heterogeneous steps unless you can prove their mapping separately.

Pass an inline tuple as shown, or retain literal IDs with `as const` on a separate
specification list. An already widened array cannot recover exact positions or
literal IDs. The tuple is enough for ordered expansion and destructuring; no
second ID-keyed container is needed. Use `forEachPipeline` for items discovered
during execution. Step families only describe a graph known before a run starts.

The example has no side effects, so its checks also execute during dry runs. If
you adapt the factory to write data, declare its ordinary `dryRun` policy there.

Run the registered recipe:

```sh
bun run tubeless -- run --project examples/project/tubeless.project.ts order-checks -- --quantities 2 --quantities 3 --prices 10 --prices 5
bun run tubeless -- plan --project examples/project/tubeless.project.ts order-checks --target valid-prices
```

## Node helpers

`tubeless/node` provides optional helpers for pipelines that use the local
filesystem, environment, and worker threads. It uses Node built-ins and adds no runtime package
dependencies. Importing core does not load these helpers.

| Helper                                    | Behavior                                                                                                                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `definePaths({ name: "relative/path" })`  | Returns a factory; pass `context.cwd` on each run. Keys are preserved and resolved values have type `string`.                                                                       |
| `readJson<T>(path)`                       | Synchronously parses JSON; missing files and malformed JSON throw. The type parameter does not validate data.                                                                       |
| `writeJson(path, value)`                  | Writes pretty JSON with a trailing newline, creates parent directories, and replaces the file by renaming a sibling temporary file. Serialization must succeed before disk changes. |
| `resetDir(path)`                          | Recursively deletes the directory and recreates it empty. Use for generated output only.                                                                                            |
| `requireEnv(name, usedBy)`                | Reads the environment when called and throws a descriptive error for missing or empty values.                                                                                       |
| `createWorkerThreadAdapter`               | Reuses a bounded Node worker pool for explicit module exports; validates results through `fromRemote`. The caller owns `close()`.                                                   |
| `openCheckpoint`, `withCheckpointedBatch` | Track completed work for resumable pipelines.                                                                                                                                       |

`writeJson` throws when the value has no JSON representation, including top-level
`undefined`, functions, symbols, and values whose `toJSON` returns `undefined`.
Serialization failures leave existing files and directories untouched.
Each write uses its own temporary file, including across worker threads. Concurrent
writes replace complete files; the last rename wins. This does not merge checkpoint
updates or provide a lock for read-modify-write operations.

Filesystem helpers do not know whether a pipeline is in dry-run mode. Put writes and
directory resets in steps marked `dryRun: "skip"`, as in
[`node-artifacts.ts`](../examples/node-artifacts.ts). Validate untrusted JSON at
the boundary with a schema; `readJson<T>` alone is not validation. Read required
environment values during execution so importing, inspecting and planning a
pipeline does not require credentials.

## Choose a pattern

1. Use an ordinary step for one unit of domain work.
2. Set `dryRun: "skip"` or provide a side-effect-free `dryRun` handler before
   exposing side-effecting work through CLI dry-run support.
3. Add `skip` only for a successful policy decision, never to hide an error.
4. Use a child pipeline when the child has value independently; use a normal
   helper function when it does not.
5. Use `forEachPipeline` when every item needs child-pipeline lifecycle and
   reporting. Add `skip` to `forEachPipeline` when policy may omit the whole
   fan-out and a skip should appear in reports. Use `runConcurrent`
   for lightweight worker functions that should
   throw on the first failure. Use `runConcurrentPartial` when the caller needs
   completed results plus that failure without throwing. Both stop admitting work
   after the first observed failure or cancellation, then drain active workers
   without cancelling siblings. `runConcurrentPartial` returns
   `ConcurrentPartialResult<R>`: branch on `ok`, never on `failure`. Success has
   dense input-order `readonly R[]` results; failure has sparse results and the
   first rejection or observed abort error. `completedIndexes` identifies
   successful outputs, including `undefined`; a rejection can also be `undefined`.
   Invalid concurrency still throws, including for empty input. `runBatched` and
   `runBatchedPartial` apply that same throw-or-partial split to fixed-size
   batches instead of individual items.

6. Group application pipelines with `defineProject(id, [pipelineA, pipelineB])` from
   `tubeless/project`. Use `project.get(id)` to retain the selected pipeline's exact
   option and result types; call its existing methods directly.
   Let `definePipeline` infer its generics to preserve literal IDs; annotate the
   finalizer's return type when an explicit result contract is needed.
   Use `PipelineInput<typeof pipeline>` and `PipelineResult<typeof pipeline>` for
   wrapper contracts instead of restating the pipeline generics. The input type is
   the value accepted by `run` before schema transformation. Pipeline commands retain
   the exact wrapped pipeline as `command.pipeline`.
   Put optional `name` and `description` on a pipeline when CLI and Studio need
   friendlier presentation. `definePipelineCommand` inherits both; command-level
   values override them without changing the pipeline ID.
   Add optional `{ name, description }` as the third argument for presentation;
   the project name defaults to its ID. Compile parsed documents with
   `compilePipelineDocument(document, registry)`, then register selected pipelines.
   Reuse `compiled.metadata` through ordinary object construction, adding explicit
   name/description overrides as needed. A child need not be a project entry to run.
   A checked-in `defineProject` exposes its pipelines to the CLI and Studio directly;
   they infer flags from the options schema's Standard JSON Schema input metadata.
   Without that metadata, supply explicit command `params` using adapters in the
   project's entry list, even for pipelines with no domain inputs. Register each
   pipeline exactly once, directly or through its command. Mixed lists preserve
   exact lookup types; duplicate pipeline IDs fail regardless of entry form.
   Default-export the project to select it for CLI and Studio; without a default,
   multiple distinct projects are rejected.
   Run a uniquely exported schema-backed pipeline file directly when inferred flags
   are sufficient. Start customized scripts with `definePipelineCommand(pipeline)`;
   an explicit command wins when both it and its pipeline are exported. Use
   `--export` to resolve multiple commands or pipelines.
   Use `overrides` for presentation only; explicit `params` and `mapOptions` are
   advanced options for type-only pipelines or custom input shapes.
   Non-string `enum`/`const` constraints also require explicit parameters.
   Use `defineCommand` from the same entrypoint for standalone scripts. Projects
   share their explicit adapters between terminal commands and Studio.
   Preview selection with
   `command.plan()` or `tubeless plan`; do not simulate planning with `--plan`.
   `--step` and `--target` are argv flags; `mapOptions` and hooks read `stepIds`
   and `targets`.
   Commands expose `--resume` only when an explicit adapter configures managed
   `checkpoint` support or sets `resume: true` and handles the value itself.
   Automatic project commands omit the flag.
7. Declare public goals with `targets: [step]` on the pipeline, select their IDs
   for goal-oriented execution, and use `stepIds` only for an exact filter. The
   control type rejects using both selections together. Without
   run selection controls, every step is selected. Omitted definition `targets`
   exposes the last step in execution order as a selectable goal; `targets: []`
   exposes none. These declarations do not select work for a run. Omitted
   `finalize` returns that step's output or `undefined` if absent. Use
   `requireOutputs` when the final domain result is not meaningful without
   specific step outputs. Read plan `selectionReasons` instead of recreating
   target-closure logic in a CLI or application.
8. Use the file layout and export conventions in the
   [project with custom adapters](../examples/project/tubeless.project.ts) only when
   custom adapters are needed. Do not infer executable modules from run history
   or the filesystem.
   Cancel only a live launch owned by the current studio process; it is not
   crash-resume and does not abort sibling launches. Studio pages top-level history;
   search includes nested runs across all pages, and run links open recorded details
   directly. Run details can switch to a live step graph that expands nested runs,
   agent turns, and tool calls. See the [Studio controls](./studio.md#use-the-browser-controls).

Use `fromRemote` when a step calls another execution system. If a dry run
contacts that system, both the adapter and remote worker must honor
`context.dryRun`. A worker or durable host can invoke the whole pipeline when
it needs to own job delivery and retries; see [remote steps](./remote-step-composition.md).

For dependency, failure, and selection behavior, read [core concepts](./concepts.md).
For workbench commands, read [the CLI](./cli.md). For hosted execution, follow
[Cloud authentication and deployed runs](./cli.md#tubeless-cloud); list loaded
pipelines, then run one by exact name or listed slug with JSON input. For the local run UI, read
[the studio](./studio.md). To connect historical runs to a compiled graph and handler
release, set `implementationVersion` as shown in [tracing](../examples/tracing.ts).
Studio's [definition history](./studio.md#definition-history-and-comparison) groups
runs by definition and compares observed versions. Definition metadata remains visible
while its run pages refresh. Complete recorded snapshots must
match their hashes, including recorded child implementation identities, to be accepted
by NDJSON or SQLite history.

## Host Studio privately

Use the [Studio gateway recipe](./studio.md#host-studio-behind-an-application-gateway)
to mount a long-lived CLI process beneath an application's admin URL. Tubeless
supplies prefix-aware pages/APIs and backend authentication; your application
checks login and admin permission for every request and owns deployment/storage.
Use an explicit deployed catalog, keep the backend token server-only, and never
retry an uncertain launch. No framework adapter or server-internal imports are needed.
