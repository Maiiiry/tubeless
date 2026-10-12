# `tubeless` API reference

Generated from the package's emitted declaration files. Do not edit manually; run `bun run api:generate` from the package root.

Each symbol links to its source declaration and uses the first sentence of its public doc comment.

Package: `tubeless`

## Public entrypoints

| Entrypoint                  | Declaration                               | Surface hash                                                       | Exported symbols |
| --------------------------- | ----------------------------------------- | ------------------------------------------------------------------ | ---------------: |
| `tubeless/agent/node`       | `./dist/agent/node.d.ts`                  | `a80a1618a64e39d83c098386aa7c647cd0e17ca89e7a3879a6e8b31bdc08ffdc` |                3 |
| `tubeless/agent`            | `./dist/agent/agent.d.ts`                 | `8265edece5bbe856dbfdffdcff0c98bb2bd6638d778138408bd32beb8b089999` |               28 |
| `tubeless`                  | `./dist/core/pipeline.d.ts`               | `f8ac37224f3fbc1603236e9d0e9d274c3b470b44b769610b73af460cca4e3efd` |               78 |
| `tubeless/cli`              | `./dist/cli/cli.d.ts`                     | `fa8e7bf17762ea9aa03f18dda28bb8c029da6a85bbe30254cacc9ec5bee1d048` |               31 |
| `tubeless/batch`            | `./dist/utilities/batch.d.ts`             | `a09125c6849bb91b4bbba2f76c4248452d5288cf0c70671461de5846b1d17037` |                7 |
| `tubeless/node`             | `./dist/node/node.d.ts`                   | `e4d6f11692c2b3e5d84d6f8dabc05bf20968efc62c7d7d24154ec9f8fac67486` |               14 |
| `tubeless/rate-limit`       | `./dist/utilities/rate-limit.d.ts`        | `01029b2a9f1504a66e396804ccc63a5b43dbcb63c002dd47918e315a90ac2a3a` |                1 |
| `tubeless/retry`            | `./dist/utilities/retry.d.ts`             | `52ede846e87e3601426639a7bdc2de0a440c119470dc55324deb26cb312757fd` |                6 |
| `tubeless/project`          | `./dist/project/project.d.ts`             | `fa92f6cd9a16fecfc7518034bd85f8d574be226c25b344921e352236c322ac11` |                8 |
| `tubeless/testing`          | `./dist/testing/testing.d.ts`             | `8132a51acb1dc50c2d9bc242af24e4176ebf0b8ac8515a1d5032d861fb66dc56` |               10 |
| `tubeless/tracing`          | `./dist/tracing/tracing.d.ts`             | `e378d1e798e86752560d4398a591826ba0b3e0af0417ffd2fd71e3ffb28aeffb` |                3 |
| `tubeless/agent/openai`     | `./dist/agent/openai.d.ts`                | `a069637d0c00736ef67c7ef13f3ca798672171ffb434fae52df7ecd1cc0a784a` |                2 |
| `tubeless/cloudflare`       | `./dist/cloudflare/cloudflare.d.ts`       | `4ad15d4c8feeedf6decc5490e12a7c5b495bc4abcc7fbbeebf7a3fd5a6c01867` |                9 |
| `tubeless/cloudflare/cache` | `./dist/cloudflare/cloudflare-cache.d.ts` | `1ef4f5fbc3032f0fa2f61f3985d20cb41491c3d0477ba2757e5af97bb83364c9` |                4 |

## Symbols

### `tubeless/agent/node`

| Symbol                                                                                                                         | Description                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| [`createNodeAgentEnvironment`](https://github.com/chetmancini/tubeless/blob/main/src/agent/node-environment.ts#L58)            | Local workspace capabilities with bounded reads, atomic writes and cancellable bash.      |
| [`openSqliteAgentCheckpointStore`](https://github.com/chetmancini/tubeless/blob/main/src/agent/sqlite-checkpoint-store.ts#L37) | Open durable SQLite checkpoints; process exit automatically releases execution ownership. |
| [`SqliteAgentCheckpointStore`](https://github.com/chetmancini/tubeless/blob/main/src/agent/sqlite-checkpoint-store.ts#L9)      | File-backed checkpoint storage using Node's built-in SQLite and per-key file locks.       |

### `tubeless/agent`

| Symbol                                                                                                                          | Description                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [`AgentCall`](https://github.com/chetmancini/tubeless/blob/main/src/agent/agent-types.ts#L30)                                   | One built-in or custom call with raw model arguments; custom names replace defaults.                 |
| [`AgentCheckpointCodec`](https://github.com/chetmancini/tubeless/blob/main/src/agent/checkpoint-types.ts#L16)                   | Lossless serialization for persisted state, validated arguments and outcomes.                        |
| [`AgentCheckpointLease`](https://github.com/chetmancini/tubeless/blob/main/src/agent/checkpoint-types.ts#L2)                    | Exclusive ownership of one execution's acknowledged checkpoint bytes.                                |
| [`AgentCheckpointStore`](https://github.com/chetmancini/tubeless/blob/main/src/agent/checkpoint-types.ts#L11)                   | Pluggable checkpoint persistence.                                                                    |
| [`AgentDecision`](https://github.com/chetmancini/tubeless/blob/main/src/agent/agent-types.ts#L49)                               | A nonempty batch of independent calls, or the raw input to the final-result schema.                  |
| [`AgentDecisionContext`](https://github.com/chetmancini/tubeless/blob/main/src/agent/agent-types.ts#L78)                        | Model-facing descriptors and ordinary step services, without executable tools.                       |
| [`AgentDurability`](https://github.com/chetmancini/tubeless/blob/main/src/agent/checkpoint-types.ts#L22)                        | Resume the same execution key on subsequent invocations with the same definition and inputs.         |
| [`AgentEnvironment`](https://github.com/chetmancini/tubeless/blob/main/src/agent/environment.ts#L15)                            | Filesystem and command capabilities supplied by a local or remote workspace.                         |
| [`AgentEnvironmentContext`](https://github.com/chetmancini/tubeless/blob/main/src/agent/environment.ts#L6)                      | Workspace and cancellation shared by an agent's environment operations.                              |
| [`AgentEnvironmentProvider`](https://github.com/chetmancini/tubeless/blob/main/src/agent/environment.ts#L79)                    | A workspace capability or a factory resolved once per live agent invocation.                         |
| [`AgentExecutionIdentity`](https://github.com/chetmancini/tubeless/blob/main/src/agent/checkpoint-types.ts#L30)                 | Stable durable identities for business idempotency and cross-attempt correlation.                    |
| [`AgentLimits`](https://github.com/chetmancini/tubeless/blob/main/src/agent/agent-types.ts#L58)                                 | Finite limits for this agent and its descendants; child limits may only tighten them.                |
| [`AgentModel`](https://github.com/chetmancini/tubeless/blob/main/src/agent/model-types.ts#L19)                                  | Pluggable model transport; the harness owns and isolates its returned conversation per run.          |
| [`AgentModelRequest`](https://github.com/chetmancini/tubeless/blob/main/src/agent/model-types.ts#L4)                            | Per-run provider context and the latest ordered tool outcomes, never executable handlers.            |
| [`AgentModelResponse`](https://github.com/chetmancini/tubeless/blob/main/src/agent/model-types.ts#L13)                          | An untrusted decision and complete plain-data conversation, including any final answer.              |
| [`AgentOutcome`](https://github.com/chetmancini/tubeless/blob/main/src/agent/agent-types.ts#L46)                                | Input-order result or deliberately recoverable handler failure, including default tools.             |
| [`AgentProjectInstruction`](https://github.com/chetmancini/tubeless/blob/main/src/agent/environment.ts#L9)                      | One scoped guidance file, loaded by the workspace that owns it.                                      |
| [`AgentState`](https://github.com/chetmancini/tubeless/blob/main/src/agent/agent-types.ts#L10)                                  | Deeply read-only view of the owned plain-data state supplied to agent callbacks.                     |
| [`AgentTool`](https://github.com/chetmancini/tubeless/blob/main/src/agent/agent-types.ts#L14)                                   | Opaque capability created by defineTool or pipelineTool; model decisions contain data only.          |
| [`AgentToolContext`](https://github.com/chetmancini/tubeless/blob/main/src/agent/agent-types.ts#L72)                            | Step services and the workspace capability available to a registered tool.                           |
| [`createMemoryAgentCheckpointStore`](https://github.com/chetmancini/tubeless/blob/main/src/agent/memory-checkpoint-store.ts#L6) | In-memory checkpoint store with exclusive leases, useful for tests and embedded hosts.               |
| [`DefaultAgentTools`](https://github.com/chetmancini/tubeless/blob/main/src/agent/default-tools.ts#L207)                        | The read, write, edit, bash, list and search tools included in every agent.                          |
| [`defineAgent`](https://github.com/chetmancini/tubeless/blob/main/src/agent/agent.ts#L41)                                       | Build a bounded in-process agent as an ordinary pipeline with one target, agent.                     |
| [`defineModelAgent`](https://github.com/chetmancini/tubeless/blob/main/src/agent/model-agent.ts#L24)                            | Build a task-to-answer agent with default tools, prompting, project context, and owned conversation. |
| [`defineTool`](https://github.com/chetmancini/tubeless/blob/main/src/agent/tools.ts#L46)                                        | Declare a validated handler capability; tools skip live work in dry runs by default.                 |
| [`pipelineTool`](https://github.com/chetmancini/tubeless/blob/main/src/agent/pipeline-tool.ts#L25)                              | Reuse a compiled child's options schema and exact final result.                                      |
| [`plainAgentCheckpointCodec`](https://github.com/chetmancini/tubeless/blob/main/src/agent/checkpoint-codec.ts#L101)             | Lossless, tagged JSON codec for finite plain data; preserves undefined and sparse arrays.            |
| [`ToolError`](https://github.com/chetmancini/tubeless/blob/main/src/agent/tools.ts#L10)                                         | A handler may throw this error to return a recoverable observation to its agent.                     |

### `tubeless`

| Symbol                                                                                                                  | Description                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [`ArtifactJsonValue`](https://github.com/chetmancini/tubeless/blob/main/src/tracing/artifact-metadata.ts#L12)           | JSON values accepted in persisted artifact metadata.                                                 |
| [`ArtifactLoader`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-artifacts.ts#L11)                | Application-owned read boundary.                                                                     |
| [`ArtifactMetadata`](https://github.com/chetmancini/tubeless/blob/main/src/tracing/artifact-metadata.ts#L21)            | Identifies an artifact without recording its contents.                                               |
| [`ArtifactRecord`](https://github.com/chetmancini/tubeless/blob/main/src/tracing/artifact-metadata.ts#L140)             | A completed artifact operation recorded by a step; reuse does not claim a new write.                 |
| [`ArtifactResult`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-artifacts.ts#L5)                 | Adapter result: the value flows to dependents; only artifact metadata is recorded.                   |
| [`ArtifactSaver`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-artifacts.ts#L17)                 | Application-owned write boundary returning a typed receipt and separate trace metadata.              |
| [`createSteps`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-steps.ts#L67)                       | Create typed step constructors for one pipeline definition.                                          |
| [`definePipeline`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline.ts#L153)                         | Compile a typed step graph into a validated, executable pipeline.                                    |
| [`isPipelineErrorCode`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L193)              | Return whether an unknown value is a stable package-owned pipeline error code.                       |
| [`IterationDecision`](https://github.com/chetmancini/tubeless/blob/main/src/core/iteration.ts#L17)                      | Continue with a new state or publish the iteration step's final output.                              |
| [`IterationState`](https://github.com/chetmancini/tubeless/blob/main/src/core/iteration.ts#L14)                         | Read-only state supplied to an iteration's mapping and transition callbacks.                         |
| [`MappedChildProgressOptions`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-step-types.ts#L187)  | Presentation options for opaque `forEachPipeline` progress.                                          |
| [`Pipeline`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L571)                         | Compiled pipeline that can be planned, executed, and rendered as a graph.                            |
| [`PIPELINE_ERROR_CODES`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L185)             | Ordered catalog of every stable package-owned pipeline error code.                                   |
| [`PipelineCacheOptions`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-cache.ts#L57)              | Defaults for opted-in steps; configuring defaults does not make other steps cacheable.               |
| [`PipelineContext`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L39)                   | Caller-supplied services and metadata shared by one pipeline execution.                              |
| [`PipelineDefinition`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-definition.ts#L87)           | Declarative configuration for compiling a typed pipeline.                                            |
| [`PipelineDefinitionError`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-errors.ts#L21)          | Programmer error raised immediately when a pipeline graph is invalid.                                |
| [`PipelineDefinitionIdentity`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L11)        | Versioned graph identity, separate from the optional handler implementation version.                 |
| [`PipelineDefinitionSnapshot`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L17)        | Immutable snapshot of the compiled pipeline definition recorded for inspection and tracing.          |
| [`PipelineError`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L226)                    | Structured, machine-readable error stored in plans, runs, and traces.                                |
| [`PipelineErrorCause`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L285)               | Bounded JSON-safe snapshot of a thrown value and its cause chain.                                    |
| [`PipelineErrorCode`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L188)                | Stable package-owned code for a pipeline error.                                                      |
| [`PipelineErrorKind`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L182)                | Broad category of a structured pipeline error.                                                       |
| [`PipelineErrorPhase`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L179)               | Pipeline lifecycle phase in which an error occurred.                                                 |
| [`PipelineExecutionContext`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L95)          | Resolved execution context provided to pipeline handlers.                                            |
| [`PipelineExecutionError`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-execution-error.ts#L119) | Error thrown by `runOrThrow` when a pipeline run does not complete successfully.                     |
| [`PipelineFanOutDiagnostics`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L215)        | Bounded diagnostics collected from a failed or cancelled fan-out step.                               |
| [`PipelineFanOutFailure`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L204)            | Bounded diagnostics for a failed or cancelled runtime fan-out.                                       |
| [`PipelineHooks`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L459)                    | Optional lifecycle callbacks, each receiving its own metadata snapshot.                              |
| [`PipelineInput`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L611)                    | Input accepted by a pipeline run before any options schema transformation.                           |
| [`PipelineLogger`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L32)                    | Minimal logger used by pipeline execution, reporters, and CLI adapters.                              |
| [`PipelineMermaidDirection`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L540)         | Supported Mermaid flowchart direction.                                                               |
| [`PipelineMermaidOptions`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L543)           | Rendering options for a pipeline Mermaid flowchart.                                                  |
| [`PipelineMetadata`](https://github.com/chetmancini/tubeless/blob/main/src/tracing/graph-metadata.ts#L8)                | Descriptive only.                                                                                    |
| [`PipelineMetadataValue`](https://github.com/chetmancini/tubeless/blob/main/src/tracing/graph-metadata.ts#L5)           | Bounded JSON values for descriptive pipeline and step annotations.                                   |
| [`PipelinePlan`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L528)                     | Side-effect-free validation and selection result for a pipeline run.                                 |
| [`PipelinePlanStep`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L487)                 | Planned representation of one declared step and its selection state.                                 |
| [`PipelineResult`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L617)                   | Successful result produced by a pipeline run.                                                        |
| [`PipelineRun`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L371)                      | Versioned public record returned for one pipeline execution.                                         |
| [`PipelineRunControls`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L57)               | Built-in run controls.                                                                               |
| [`PipelineRunStatus`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L350)                | Terminal disposition of a completed run record.                                                      |
| [`PipelineStepCancelledEvent`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L447)       | Lifecycle event emitted when a step is cancelled.                                                    |
| [`PipelineStepCancelledReport`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L326)      | Terminal report for a cancelled step.                                                                |
| [`PipelineStepCompleteEvent`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L453)        | Lifecycle event emitted when a step completes successfully.                                          |
| [`PipelineStepCompleteReport`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L309)       | Terminal report for a successfully completed step.                                                   |
| [`PipelineStepContext`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L156)              | Step execution context with attempt identity and progress reporting helpers.                         |
| [`PipelineStepFailedEvent`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L449)          | Lifecycle event emitted when a step fails.                                                           |
| [`PipelineStepFailedReport`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L332)         | Terminal report for a failed step.                                                                   |
| [`PipelineStepLifecycleStatus`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L433)      | Any planned, running, or terminal step lifecycle status.                                             |
| [`PipelineStepPlannedEvent`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L436)         | Lifecycle event emitted when a step is planned.                                                      |
| [`PipelineStepProgress`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L140)             | Latest progress snapshot reported by a running step.                                                 |
| [`PipelineStepProgressDetail`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L121)       | One optional nested row in a step progress snapshot.                                                 |
| [`PipelineStepProgressDetailStatus`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L112) | Lifecycle status displayed for an optional nested progress row.                                      |
| [`PipelineStepProgressEvent`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L443)        | Lifecycle event emitted when a running step reports progress.                                        |
| [`PipelineStepQuery`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-query.ts#L5)                  | Discovery filters combine with AND; tags require every exact, case-sensitive tag.                    |
| [`PipelineStepReport`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L340)               | Terminal state recorded for one step after a run.                                                    |
| [`PipelineStepReportStatus`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L347)         | Terminal status recorded in a step report.                                                           |
| [`PipelineStepSelectionReason`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L476)      | Machine-readable explanation of why a planned step was included or omitted.                          |
| [`PipelineStepSkippedEvent`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L451)         | Lifecycle event emitted when a step is skipped.                                                      |
| [`PipelineStepSkippedReport`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L316)        | Terminal report for a structurally or intentionally skipped step.                                    |
| [`PipelineStepSkipReason`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L387)           | Why a step did not run.                                                                              |
| [`PipelineStepStartEvent`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L439)           | Lifecycle event emitted when a step begins running.                                                  |
| [`PipelineStepStatus`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L416)               | One observable status in a step's planned → running → terminal lifecycle.                            |
| [`PipelineValidationIssue`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L198)          | One dependency-free Standard Schema issue normalized for reports and traces.                         |
| [`querySteps`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-query.ts#L23)                        | Return matching plan steps in execution order without changing selection or including prerequisites. |
| [`RemoteStepAdapter`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L170)                | Adapter that invokes one step on an external execution engine.                                       |
| [`requireOutputs`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-finalizer.ts#L38)                | Build a finalizer that only runs when every listed step published an output.                         |
| [`RUN_MODEL_VERSION`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-ids.ts#L2)                    | Current persisted run-record schema version.                                                         |
| [`StandardSchemaV1`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L244)                 | Dependency-free subset of the Standard Schema V1 protocol.                                           |
| [`Step`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-step-types.ts#L82)                         | Typed pipeline step carrying its stable ID, output, and option types.                                |
| [`StepCache`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-cache.ts#L70)                         | Opt a deterministic ordinary step into caching, with optional overrides of pipeline defaults.        |
| [`StepCacheCodec`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-cache.ts#L41)                    | Encode a detached snapshot; decode must produce a fresh handler-result value.                        |
| [`StepCacheContext`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-cache.ts#L14)                  | Cache I/O is cancellable and independent of pipeline scheduling.                                     |
| [`StepCacheEntry`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-cache.ts#L19)                    | Encoded raw handler result and its creation time; expiration is enforced by core.                    |
| [`StepCachePolicy`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-cache.ts#L47)                   | Use reads and writes, recompute replaces entries, bypass performs no cache work.                     |
| [`StepCacheStore`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-cache.ts#L27)                    | Store timestamped encoded handler results; only undefined means a cache miss.                        |
| [`StepSkipDecision`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L408)                 | Decision from an optional `skip` predicate.                                                          |

### `tubeless/cli`

| Symbol                                                                                                                  | Description                                                                         |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`CliBooleanParam`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L57)                         | Declarative configuration for a boolean command parameter.                          |
| [`CliCheckpointConfig`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L213)                    | Checkpoint persistence settings for resumable commands.                             |
| [`CliCommand`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L263)                             | Typed command that can parse, validate, execute, or own a CLI entry point.          |
| [`CliCommandConfig`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L232)                       | Declarative configuration consumed by `defineCommand`.                              |
| [`CliCommandDescriptor`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L104)                   | Immutable, presentation-neutral command contract shared by CLI and UI adapters.     |
| [`CliContext`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L170)                             | Runtime services and environment passed to a command.                               |
| [`CliHelpRequested`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L204)                       | Control-flow error thrown when command help was requested.                          |
| [`CliNumberParam`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L45)                          | Declarative configuration for a numeric command parameter.                          |
| [`CliParam`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L76)                                | Any supported declarative command parameter configuration.                          |
| [`CliParameterDescriptor`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L82)                  | JSON-safe description of one validated command parameter for non-terminal clients.  |
| [`CliParams`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L163)                              | Validated values returned from a command's parameter schema.                        |
| [`CliParamsSchema`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L79)                         | Named parameter schema accepted by `defineCommand`.                                 |
| [`CliParamType`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L14)                            | Supported value kinds for declarative command parameters.                           |
| [`CliParseResult`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L186)                         | Successful values, help text, or validation errors returned by command parsing.     |
| [`CliPathParam`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L64)                            | Declarative configuration for a filesystem path command parameter.                  |
| [`CliStringParam`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L35)                          | Declarative configuration for a string command parameter.                           |
| [`CliValidationError`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L192)                     | Error thrown when command-line arguments fail schema validation.                    |
| [`defineCommand`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-command.ts#L406)                        | Create a typed command from a declarative parameter schema and run handler.         |
| [`definePipelineCommand`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-pipeline-command.ts#L267)       | Turn a pipeline into a CLI; infer domain flags from its Standard JSON Schema input. |
| [`DefinePipelineCommandConfig`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-pipeline-command.ts#L146) | Configuration for a typed pipeline command.                                         |
| [`PipelineCliParseResult`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-pipeline-command.ts#L53)       | Parse result returned by commands created with `definePipelineCommand`.             |
| [`PipelineCliValues`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-pipeline-command.ts#L44)            | Validated domain parameters plus the built-in pipeline execution controls.          |
| [`PipelineCommand`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-pipeline-command.ts#L59)              | Typed CLI facade over a pipeline with planning and graph helpers.                   |
| [`PipelineCommandHookConfig`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-pipeline-command.ts#L99)    | Static or lazily constructed lifecycle hooks for a pipeline command.                |
| [`PipelineCommandHookContext`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-pipeline-command.ts#L90)   | Parsed values and CLI services passed to a pipeline hook factory.                   |
| [`PipelineReporterConfig`](https://github.com/chetmancini/tubeless/blob/main/src/reporter/interactive-reporter.ts#L51)  | Rendering and output settings for automatic, plain, or interactive reporting.       |
| [`PipelineReporterMode`](https://github.com/chetmancini/tubeless/blob/main/src/reporter/interactive-reporter.ts#L33)    | Rendering mode selected for pipeline lifecycle reporting.                           |
| [`ReporterColorMode`](https://github.com/chetmancini/tubeless/blob/main/src/reporter/reporter.ts#L6)                    | Policy for ANSI color in terminal reporter output.                                  |
| [`ReporterOutput`](https://github.com/chetmancini/tubeless/blob/main/src/reporter/interactive-reporter.ts#L37)          | Writable terminal-like destination used by the interactive reporter.                |
| [`ReporterSymbolMode`](https://github.com/chetmancini/tubeless/blob/main/src/reporter/reporter.ts#L8)                   | Symbol set used for step lifecycle markers in reporter output.                      |
| [`ReporterTerminalCapabilities`](https://github.com/chetmancini/tubeless/blob/main/src/reporter/reporter.ts#L11)        | Detected or caller-overridden terminal rendering capabilities.                      |

### `tubeless/batch`

| Symbol                                                                                                    | Description                                                                                                                             |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [`ConcurrentPartialResult`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/batch.ts#L34) | Execution outcome returned by `runConcurrentPartial`, discriminated by `ok`.                                                            |
| [`ConcurrentWorker`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/batch.ts#L12)        | Asynchronous worker invoked for one input item by the concurrency helpers.                                                              |
| [`runBatched`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/batch.ts#L147)             | Run fixed-size input batches with bounded concurrency and input-order results.                                                          |
| [`runBatchedPartial`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/batch.ts#L167)      | Run fixed-size input batches with bounded concurrency, returning complete or partial results discriminated by `ok` instead of throwing. |
| [`runConcurrent`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/batch.ts#L58)           | Run individual items with bounded, lazy scheduling and input-order results.                                                             |
| [`RunConcurrentOptions`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/batch.ts#L4)     | Scheduling and cancellation settings for bounded concurrent work.                                                                       |
| [`runConcurrentPartial`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/batch.ts#L72)    | Return complete or partial results, discriminated by `ok`.                                                                              |

### `tubeless/node`

| Symbol                                                                                                                  | Description                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [`CheckpointStore`](https://github.com/chetmancini/tubeless/blob/main/src/node/checkpoint.ts#L5)                        | Mutable set of completed item keys backed by an explicit JSON flush.                                                          |
| [`createFileStepCache`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/cache-storage.ts#L22)           | Persist timestamped cache entries with atomic replacement in a dedicated directory.                                           |
| [`createWorkerThreadAdapter`](https://github.com/chetmancini/tubeless/blob/main/src/node/worker-thread-adapter.ts#L64)  | Run an explicit module export in a lazily created, reusable Node worker pool.                                                 |
| [`definePaths`](https://github.com/chetmancini/tubeless/blob/main/src/node/paths.ts#L11)                                | Create a factory that resolves a named set of workspace-relative paths.                                                       |
| [`openCheckpoint`](https://github.com/chetmancini/tubeless/blob/main/src/node/checkpoint.ts#L66)                        | Open a JSON checkpoint file, falling back to an empty store when it is absent.                                                |
| [`readJson`](https://github.com/chetmancini/tubeless/blob/main/src/node/file-utils.ts#L14)                              | Read and parse trusted JSON without runtime schema validation.                                                                |
| [`requireEnv`](https://github.com/chetmancini/tubeless/blob/main/src/node/env.ts#L2)                                    | Read a required non-empty environment variable or throw a contextual error.                                                   |
| [`resetDir`](https://github.com/chetmancini/tubeless/blob/main/src/node/file-utils.ts#L23)                              | Remove and recreate a directory for generated output.                                                                         |
| [`v8StepCacheCodec`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/cache-storage.ts#L10)              | Node's structured serialization, including undefined, Maps, Dates, and BigInts.                                               |
| [`withCheckpointedBatch`](https://github.com/chetmancini/tubeless/blob/main/src/node/checkpoint.ts#L113)                | Runs `persist()`, and only once it resolves without throwing, records every item in `batch` into `checkpoint` and flushes it. |
| [`WorkerThreadAdapter`](https://github.com/chetmancini/tubeless/blob/main/src/node/worker-thread-adapter.ts#L24)        | Invoke cloneable payloads through a reusable pool of Node worker threads.                                                     |
| [`WorkerThreadAdapterOptions`](https://github.com/chetmancini/tubeless/blob/main/src/node/worker-thread-adapter.ts#L12) | Configure the module export and worker-pool limits for a thread adapter.                                                      |
| [`WorkerThreadContext`](https://github.com/chetmancini/tubeless/blob/main/src/node/worker-thread-protocol.ts#L14)       | Provide cancellation, logging, progress, and run metadata to a worker export.                                                 |
| [`writeJson`](https://github.com/chetmancini/tubeless/blob/main/src/node/file-utils.ts#L5)                              | Serialize JSON and atomically replace the destination file.                                                                   |

### `tubeless/rate-limit`

| Symbol                                                                                            | Description                                                                   |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [`RateLimiter`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/rate-limit.ts#L4) | Serialize reservations at a fixed minimum interval with cancellation support. |

### `tubeless/retry`

| Symbol                                                                                                  | Description                                                                     |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [`DEFAULT_BASE_DELAY_MS`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/retry.ts#L10) | Default `RetryOptions.baseDelayMs` when omitted.                                |
| [`DEFAULT_MAX_ATTEMPTS`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/retry.ts#L8)   | Default `RetryOptions.maxAttempts` when omitted.                                |
| [`RetryAttemptContext`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/retry.ts#L37)   | Metadata supplied to each retry operation attempt.                              |
| [`RetryOperation`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/retry.ts#L47)        | Operation invoked once per retry attempt until it succeeds or the policy stops. |
| [`RetryOptions`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/retry.ts#L13)          | Backoff, cancellation, and retry policy settings for `withRetry`.               |
| [`withRetry`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/retry.ts#L77)             | Retry an asynchronous operation with exponential backoff and optional jitter.   |

### `tubeless/project`

| Symbol                                                                                                              | Description                                                                       |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [`CompiledPipelineDocument`](https://github.com/chetmancini/tubeless/blob/main/src/project/project-compiler.ts#L14) | Immutable compiled pipelines and descriptive metadata from a parsed document.     |
| [`compilePipelineDocument`](https://github.com/chetmancini/tubeless/blob/main/src/project/project-compiler.ts#L25)  | Compile parsed YAML or JSON into ordinary pipelines.                              |
| [`defineProject`](https://github.com/chetmancini/tubeless/blob/main/src/project/pipeline-project.ts#L66)            | Register each pipeline once, directly or through its explicit command.            |
| [`PipelineDocumentError`](https://github.com/chetmancini/tubeless/blob/main/src/project/project-document.ts#L72)    | A document shape or reference error; graph errors remain PipelineDefinitionError. |
| [`PipelineDocumentMetadata`](https://github.com/chetmancini/tubeless/blob/main/src/project/project-document.ts#L11) | Optional human-facing document information, never execution policy.               |
| [`PipelineProject`](https://github.com/chetmancini/tubeless/blob/main/src/project/pipeline-project.ts#L49)          | Immutable named pipeline collection, preserving each pipeline's exact type by id. |
| [`ProjectOptions`](https://github.com/chetmancini/tubeless/blob/main/src/project/pipeline-project.ts#L39)           | Optional project presentation and execution directory.                            |
| [`ProjectRegistry`](https://github.com/chetmancini/tubeless/blob/main/src/project/project-registry.ts#L79)          | Only explicitly registered functions and schemas can be referenced by a document. |

### `tubeless/testing`

| Symbol                                                                                                        | Description                                                                                 |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [`createPipelineTestRuntime`](https://github.com/chetmancini/tubeless/blob/main/src/testing/testing.ts#L165)  | Create a deterministic runtime without installing a test framework or fake-timer package.   |
| [`overrideStep`](https://github.com/chetmancini/tubeless/blob/main/src/testing/testing.ts#L26)                | Supply a resolved handler output, before the step's outputSchema validation/transformation. |
| [`PipelineTestClock`](https://github.com/chetmancini/tubeless/blob/main/src/testing/testing.ts#L94)           | Monotonic caller-controlled clock used by a pipeline test runtime.                          |
| [`PipelineTestLogEntry`](https://github.com/chetmancini/tubeless/blob/main/src/testing/testing.ts#L87)        | One silent logger call captured by a pipeline test runtime.                                 |
| [`PipelineTestLogLevel`](https://github.com/chetmancini/tubeless/blob/main/src/testing/testing.ts#L84)        | Log levels captured by a pipeline test runtime.                                             |
| [`PipelineTestOverride`](https://github.com/chetmancini/tubeless/blob/main/src/testing/testing.ts#L21)        | A typed step/value pair created by overrideStep; only accepted by test runs.                |
| [`PipelineTestRunControls`](https://github.com/chetmancini/tubeless/blob/main/src/testing/testing.ts#L34)     | Test-only controls.                                                                         |
| [`PipelineTestRuntime`](https://github.com/chetmancini/tubeless/blob/main/src/testing/testing.ts#L118)        | Framework-neutral runtime, observations, and typed execution helpers for pipeline tests.    |
| [`PipelineTestRuntimeOptions`](https://github.com/chetmancini/tubeless/blob/main/src/testing/testing.ts#L108) | Clock, directory, and sleep overrides for a pipeline test runtime.                          |
| [`PipelineTestSleep`](https://github.com/chetmancini/tubeless/blob/main/src/testing/testing.ts#L101)          | Optional replacement for the default immediate, clock-advancing test sleep.                 |

### `tubeless/tracing`

| Symbol                                                                                                           | Description                                                              |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [`composeTraceExporters`](https://github.com/chetmancini/tubeless/blob/main/src/tracing/tracing.ts#L12)          | Fan one trace stream out to multiple exporters.                          |
| [`PipelineTraceEvent`](https://github.com/chetmancini/tubeless/blob/main/src/tracing/tracing-contracts.ts#L4)    | A versioned lifecycle record with an event-specific, structured payload. |
| [`PipelineTraceExporter`](https://github.com/chetmancini/tubeless/blob/main/src/tracing/tracing-contracts.ts#L7) | Asynchronous boundary for trace destinations.                            |

### `tubeless/agent/openai`

| Symbol                                                                                           | Description                                                                                   |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| [`openaiModel`](https://github.com/chetmancini/tubeless/blob/main/src/agent/openai.ts#L30)       | Create a dependency-free OpenAI Responses model with native history and automatic compaction. |
| [`OpenAIModelOptions`](https://github.com/chetmancini/tubeless/blob/main/src/agent/openai.ts#L8) | Responses transport settings; credentials are resolved only when a decision executes.         |

### `tubeless/cloudflare`

| Symbol                                                                                                               | Description                                                                               |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [`CloudflareApp`](https://github.com/chetmancini/tubeless/blob/main/src/cloudflare/cloudflare.ts#L41)                | Worker handler and Durable Object classes that a Worker entry exports.                    |
| [`CloudflareAppOptions`](https://github.com/chetmancini/tubeless/blob/main/src/cloudflare/cloudflare.ts#L25)         | Options for createCloudflareApp.                                                          |
| [`CloudflareDurableObjectClass`](https://github.com/chetmancini/tubeless/blob/main/src/cloudflare/cloudflare.ts#L38) | Durable Object class to export from the Worker entry under its binding's export name.     |
| [`CloudflareWorker`](https://github.com/chetmancini/tubeless/blob/main/src/cloudflare/cloudflare.ts#L33)             | Worker module handler to use as the Worker entry's default export.                        |
| [`createCloudflareApp`](https://github.com/chetmancini/tubeless/blob/main/src/cloudflare/cloudflare.ts#L96)          | Compose a single-tenant Tubeless deployment for a Worker with two SQLite Durable Objects. |
| [`createR2CacheStore`](https://github.com/chetmancini/tubeless/blob/main/src/cloudflare/cloudflare-cache.ts#L24)     | Step cache entries in R2.                                                                 |
| [`jsonCacheCodec`](https://github.com/chetmancini/tubeless/blob/main/src/cloudflare/cloudflare-cache.ts#L132)        | Lossless JSON codec for Workers, where the default V8 codec is unavailable.               |
| [`R2BucketLike`](https://github.com/chetmancini/tubeless/blob/main/src/cloudflare/cloudflare-cache.ts#L11)           | Structural subset of an R2 bucket binding that the cache store uses.                      |
| [`R2ObjectLike`](https://github.com/chetmancini/tubeless/blob/main/src/cloudflare/cloudflare-cache.ts#L4)            | Structural subset of an R2 object body that the cache store reads.                        |

### `tubeless/cloudflare/cache`

| Symbol                                                                                                           | Description                                                                 |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [`createR2CacheStore`](https://github.com/chetmancini/tubeless/blob/main/src/cloudflare/cloudflare-cache.ts#L24) | Step cache entries in R2.                                                   |
| [`jsonCacheCodec`](https://github.com/chetmancini/tubeless/blob/main/src/cloudflare/cloudflare-cache.ts#L132)    | Lossless JSON codec for Workers, where the default V8 codec is unavailable. |
| [`R2BucketLike`](https://github.com/chetmancini/tubeless/blob/main/src/cloudflare/cloudflare-cache.ts#L11)       | Structural subset of an R2 bucket binding that the cache store uses.        |
| [`R2ObjectLike`](https://github.com/chetmancini/tubeless/blob/main/src/cloudflare/cloudflare-cache.ts#L4)        | Structural subset of an R2 object body that the cache store reads.          |
