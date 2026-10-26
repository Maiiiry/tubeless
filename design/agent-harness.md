# Structured agent harness contract

Status: stage 4 implements pipeline tools and subagent delegation on top of the
single-agent runtime and generic bounded iteration. Subtrees share call/decision
budgets, depth bounds, cancellation, and leaf execution limits. Each child owns
its state and capability registry.
Every agent now includes the standard workspace tools; custom tools extend the
registry or replace defaults by name. Stage 5 now projects typed agent history
and exposes it through CLI text and JSON details. Richer Studio presentation
remains separate from the in-process core release.
The default model-backed slice adds `defineAgent({ id, model })`, scoped
startup AGENTS.md loading, and isolated provider conversation state through the
same runtime. `tubeless/agent/openai` supplies native Responses history and
compaction with no provider imports in core or the generic agent entrypoint.
Opt-in workspace evaluations cover edits, verification, project context and
recovery; live results remain distinct from deterministic protocol tests.
The provider example was brought forward from stage 6: the
[OpenAI recipe](../examples/agent-openai.ts) now supplies an application-owned
Responses callback, accumulated outcomes, and model-selected finish. Offline
fixtures cover the adapter; live provider execution is a separate smoke check.
Stage 6 completes the learning surface with an
[agent embedded in an ordinary pipeline](../examples/agent-pipeline.ts), real
CLI history tests and installed-package execution of the recipe and its previews.
The [release acceptance checklist](../RELEASE_CHECKLIST.md#in-process-agent-acceptance)
maps each gate to existing checks and the separate paid workspace evaluations.
Agent execution remains an ordinary in-process pipeline. Optional acknowledged
checkpoints now persist decisions, call intent/outcomes, child state and ancestor
budgets. Typed execution environments supply local or remote workspace authority;
see [the recovery and environment contracts](../docs/agents.md#durable-execution).

The [type probes](./agent-harness.probes.ts) exercise the implemented public API
and are checked by `bun run typecheck` and `make check`. Declared fixture schemas
mean these probes must not be executed. `design/` is excluded from the npm artifact.

## API decisions

An agent is an ordinary compiled pipeline with one outer step and target,
`agent`. `defineAgentLoop` preserves its literal ID, raw input schema, transformed
result type, and definition metadata. It works with existing `fromPipeline`,
`defineProject`, and `definePipelineCommand`. Schema metadata remains necessary
for automatic CLI flags. There is no separate agent project or command registry.

The `tubeless/agent` entrypoint owns `defineAgentLoop`, `defineTool`, `pipelineTool`,
`ToolError`, and their contracts. It depends on core, utilities,
and trace emission. Core stays independent of the agent entrypoint, model SDKs,
storage, CLI, and Studio. Custom `decide` callbacks keep application-owned prompts
and provider mapping. The convenience factory supplies defaults, with provider
protocols isolated in optional adapter entrypoints.

`createSteps` includes the generic constructor `iteratePipeline`. The probes use
the real public factory for all core constructors. It takes a child pipeline, `initialState`,
`mapOptions`, `transition`, and a required finite `maxIterations`. It supports
required dependencies, a static set of child controls, and whole-step dry-run
skip. Other composition conveniences can follow a demonstrated need.

Each iteration runs the child and then calls `transition(result, state, context)`.
The transition returns either `{ kind: "next", state }` or
`{ kind: "finish", result }`. The finish value is the iteration step's output;
it may legitimately be `undefined`. A default pipeline finalizer or explicit
`finalize: iterationStep` retains its existing meaning.

## Agent decisions and capabilities

The `decide(state, context)` callback returns untrusted data. The harness always
validates it, even if a provider SDK advertises a typed response. Applications
can use `satisfies AgentDecision<typeof tools, RawResult>` for typed fixtures and
hand-authored decisions. Type-checking fixtures does not validate model output.

| Decision   | Required payload | Meaning                                             |
| ---------- | ---------------- | --------------------------------------------------- |
| `continue` | Nonempty `calls` | Admit a batch of independent registered calls.      |
| `finish`   | `result`         | Validate the raw result and finish this invocation. |

A decision cannot contain both calls and a final result. An empty continue
batch, unknown tool, duplicate call ID, invalid argument, extra control field,
or invalid final result fails the invocation. V1 does not automatically ask the
model to repair malformed decisions. A result such as `null` is accepted only
when the result schema accepts it; absence is distinct from a published value.

Use one merged registry: `read`, `write`, `edit`, `bash`, `list`, and `search`
are included by default, and custom `tools` add or replace names. Built-ins use
the same `defineTool` boundary and carry no invocation state on their definitions.
They resolve cwd at execution and obey the existing cancellation, budget and
dry-run contracts. Each entry is created through one of these boundaries:

| Constructor                     | Input validation                                                              | Execution                      | Result                                                           |
| ------------------------------- | ----------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------- |
| `defineTool`                    | Required `inputSchema`                                                        | `run(validatedInput, context)` | Required `outputSchema` validates/transforms the handler return. |
| `pipelineTool(child, metadata)` | Reuse the child's `optionsSchema`                                             | Ordinary child pipeline        | The child's exact final result.                                  |
| `pipelineTool(child, mapping)`  | Explicit `inputSchema`, then `mapOptions` and the child's schema when present | Ordinary child pipeline        | The child's exact final result.                                  |

The explicit mapping form handles schema-less pipelines and differently shaped
model arguments. It maps validated arguments to the child's raw accepted input.
No result mapper is added initially; a child finalizer or ordinary wrapper
pipeline already owns that operation. Registering an agent uses the same
`pipelineTool` constructor as any other child pipeline.

Tools require a description and model-facing JSON Schema for their raw input.
Use the input schema's Standard JSON Schema converter with target
`draft-2020-12`; an explicit `inputJsonSchema` is the fallback. The final-result
descriptor likewise uses the result schema's **input** conversion or
`resultJsonSchema`. A missing or invalid descriptor fails definition validation.
Explicit descriptors are application assertions of agreement with validators;
the runtime validator remains authoritative. No schema library enters core.

The decision context exposes capability descriptions/JSON Schemas and the final
result JSON Schema, alongside normal step services, `turn`, and `stateVersion`.
It does not hand the model executable handlers or authority to add capabilities.

## Validation and one turn of execution

1. Check cancellation and the per-invocation turn bound. Reserve one shared
   decision admission and invoke `decide` with the current state snapshot.
2. Validate the decision envelope. For finish, validate/transform the result
   once and publish it through the outer pipeline's finalizer. Stop here.
3. For continue, validate all names, IDs, argument schemas, child input mappings,
   child input schemas, and child plans before starting any call in the batch.
   Retain the validated values; execution must not apply transformations again.
4. Atomically reserve the complete batch against shared call budgets, then
   dispatch under the active-execution limits. Calls have no implicit sibling
   data dependencies. A dependent action goes in the next turn or an authored
   child pipeline.
5. Wait for all admitted execution to settle. Build outcomes in decision order.
   If any fatal failure occurred, preserve observations in lifecycle records and
   fail without applying the reducer or starting another turn.
6. Call `reduce(state, outcomes)` once, validate ownership of its result, and
   publish the next state version. Repeat with a fresh child turn run.

The result schema runs exactly once. The agent implementation must choose one
validation owner rather than validate finish data and then accidentally pass
its transformed output through the same schema again. The same rule applies
to tool arguments/results and prevalidated child options. Internal validated
execution entrypoints must accept only a privately prepared value, never an
unchecked public bypass flag.

## State and errors

`initialState` runs once for each invocation, after input validation. Its return
type determines the reducer's state contract. Decisions and reducers receive
deeply read-only state. Agent state consists of finite primitive values, arrays,
and plain records; optional/undefined fields are allowed in process. Functions,
class instances, cycles, and resources such as clients or file handles belong
in application closures, not agent state. Runtime initialization and each
reducer commit create and freeze owned snapshots; sharing mutable backing data
between runs is forbidden. Generic iteration does not add a persistence codec.

State version starts at zero and advances once for each accepted batch, even
when the reducer is omitted and the state is unchanged. An omitted reducer
does not accumulate observations automatically. Agents that learn from tool
outcomes supply a reducer. The decision's `turn` is one-based; finish performs
no further state reduction. These counters are run data, not mutable fields on
a reusable agent definition.

Handlers can deliberately throw `ToolError(code, message)` for a domain failure
the model may respond to. Only an actual handler-originated `ToolError` becomes
an `{ ok: false, error }` observation. Matching an arbitrary error's string code
is insufficient. A child pipeline qualifies only when its failures consist
entirely of these expected handler errors, without cancellation or other
failures; combine bounded error information deterministically.

Invalid schemas, failed output validation, reducer failures, unknown exceptions,
and cancellation are fatal. Expected failures retain failed child lifecycle
records even when the agent continues. Existing `fromPipeline` and
`forEachPipeline` continue to throw on failed children; the agent dispatcher
uses a focused internal full-report invocation boundary to classify outcomes.

Keep the core run statuses `completed`, `failed`, and `cancelled`. Agent failures
use existing step-error wrapping with stable source codes such as
`TUBELESS_AGENT_INVALID_DECISION`, `TUBELESS_AGENT_INVALID_STATE`, and
`TUBELESS_AGENT_LIMIT_REACHED`. Generic iteration uses
`TUBELESS_ITERATION_LIMIT_REACHED`. Limits include the bound, consumed count, and
scope in diagnostics. `runOrThrow` throws on all unsuccessful runs. Budget
exhaustion is never a successful final answer or a recoverable tool error.

## Limits, cancellation, and dry-run

Stage 4 implements every limit below. `maxTurns` is local to an agent; the other
bounds constrain its subtree. Delegation depth counts `pipelineTool` edges.

Limits are definition configuration in v1, separate from domain input. There
are no new agent-specific positional run arguments or overloads. Applications
can construct a definition with different limits. Existing outer pipeline
`maxConcurrency` controls its DAG; it does not override agent call concurrency.

| Limit            | Default | Accounting                                                         |
| ---------------- | ------- | ------------------------------------------------------------------ |
| `maxTurns`       | 20      | Decision invocations in one agent, including a finishing decision. |
| `maxCalls`       | 100     | Admitted tool/child calls across this agent and its descendants.   |
| `maxDecisions`   | 100     | Admitted decision callbacks across this agent and its descendants. |
| `maxDepth`       | 4       | Delegation edges below this agent; zero permits leaf tools only.   |
| `maxConcurrency` | 1       | Active decision callbacks and leaf tool handlers in the subtree.   |

All limits are safe integers. Turn/decision/concurrency limits must be positive;
call/depth limits may be zero. A child may impose a tighter local subtree bound;
all ancestor bounds continue to apply. Charge an entire batch on admission.
Calls cancelled before dispatch still consume their admission; there are no
refund races. Reject an oversized batch before any member starts. A finish on
the last allowed turn succeeds. A continue on that last turn fails before tools
start because no later decision could consume their results.

`maxDecisions` counts harness callbacks, not hidden HTTP requests or money. V1
adds no automatic retries. Provider SDK retries and internal requests within a
handler remain the application's responsibility. Any future harness retries
must consume the relevant admission budget.

Allocate the shared execution scope on the root invocation, never on the
definition. Core carries one private opaque scope slot through runtime
normalization and child contexts; the agent layer owns its counters and limiter.
Core does not interpret agent policy. This slot must survive ordinary pipelines
between parent and child agents. It is not a public extension registry, a
global run-ID map, domain input, or serialized model context.

An active parent wrapper waiting on children holds no shared execution permit.
A decision releases its permit before dispatching calls. Descendant leaf work
acquires all applicable ancestor/local permits atomically from one root queue. Tests with
concurrency one must prove nested calls cannot deadlock.

Cancellation stops new admissions and dispatch, propagates the same signal to
active work, and drains all active descendants before return. Fatal fail-fast
stops dispatch and drains without automatically cancelling siblings, preserving
existing pipeline behavior. In-process handlers must cooperate with signals;
the harness cannot forcibly terminate an uncooperative promise.

`plan()` performs no model request, state initialization, argument validation,
mapping, or tool execution. An agent dry run skips live decision callbacks by
default. The optional `dryRun` callback replaces `decide` with a preview source.
Handler tools default to dry-run skip and may supply a typed preview handler.
Child pipelines keep their existing dry-run policies and always inherit the
parent's dry-run flag. A parent child pipeline with unmarked side effects still
needs correct dry-run authoring. A skipped required output produces no invented
observation or answer and fails required finalization through existing behavior.

## Identity, plans, and saved recordings

Definitions and executions have different identities. Definition snapshots
describe iteration structure, registered capabilities and child identities,
validation boundaries, dry-run behavior, limits, and an author/build-supplied
`implementationVersion`. Prompts, validators, mappings, and handler semantics
are covered by that implementation version, not inferred by hashing closures.
JSON Schema descriptors can be recorded as bounded metadata with canonical
hashes; bounded/truncated snapshots cannot pretend to be complete definitions.

| Identity                      | Scope                                                               |
| ----------------------------- | ------------------------------------------------------------------- |
| Pipeline ID and definition ID | Stable definition, independent of model choices and batch size.     |
| Run ID                        | One actual root, turn, tool pipeline, or child pipeline execution.  |
| Turn index and state version  | One agent invocation.                                               |
| Logical call ID               | Agent run + turn index + decision call ID.                          |
| Attempt ID                    | One execution attempt; distinct from the logical call ID.           |
| Provider call ID              | Optional provider correlation; never the global execution identity. |

Future retries keep logical call identity and create a new attempt. Provider
IDs may repeat across turns, but decision IDs must be unique within a turn.
Use structured parent/run/turn/call fields for joins; readable paths are display
values. Retain the parent wrapper step/attempt relationship so history can
distinguish two calls to the same child in one turn.

Static plans expose an iteration region, child template, bound, and capability
inventory. They do not invent future steps or accept future call IDs as static
`--step` targets. Runtime traces describe actual expansions and outcomes.
Bounded progress rows are presentation; they are not the complete history.

Stage 2 preserves identity v1 hashing and its old test vectors, and adds identity
v2 for iteration semantics and parents that contain them. Ordinary unchanged
definitions retain their v1 identity. New writes use trace v3 with typed iteration
relations; readers continue accepting trace v2. Stage 3 records tool calls using ordinary parent run links, `itemKey`, and
first-attempt attributes for agent run, turn, call, tool, and parent attempt.
Decision, admission, and state-version summaries use first-attempt attributes too;
no new event kind or SQLite column is needed. The tuple (agent run, turn, call ID)
is the logical identity. Stage 5 retains typed decision/state/count summaries and
joins call and child-agent identities for CLI history. Dispatch records the tool
alias for pipeline tools using the existing attempted-event attributes; older
records with missing aliases remain unknown. Agent definition metadata adds capability identities and descriptor
fingerprints to v2 snapshots without changing hashes for existing definitions.
The run report stays at its existing version unless its shape changes. Do not
silently widen the v2 wire enum for nested modes or reinterpret old hashes.

Stage 2 updates plan metadata, definition compilation, schemas/codecs,
decoders, and storage projections together before emitting the new records.
Stages 3–4 fill agent-specific records; stage 5 supplies typed history and CLI
presentation, with richer Studio views still pending. Old records may lack relationships and remain inspectable with
unknown metadata. State, prompts, and tool bodies are not traced by default.

Trace export remains best-effort. Recovery uses an independent acknowledged
subtree journal with exclusive ownership and explicit lossless codecs. Default
SQLite storage fences each key to a live process on one host and reclaims a dead
owner. Stable agent/call routes survive ordinary child composition; budgets and
accepted schema receipts are restored before dispatch. A running unsafe call
becomes an interruption observation, while an explicitly safe call may repeat.
External effects still require reconciliation or business idempotency; reducers
and mappers must be pure. Checkpoint storage does not serialize arbitrary
schema outputs without a suitable codec.

## Evidence and next implementation boundary

The probes check immediate finish, two tools followed by finish, parent pipeline
composition, pipeline/subagent delegation, and expected-error recovery. They
also reject invalid tool names, mismatched inputs/outputs, mixed or empty
decisions, invalid state reduction, missing child mappings, mistyped project
lookups, and dynamic IDs used as static targets. Iteration probes preserve
transformed dependency outputs, raw parent inputs, schema-backed CLI inference,
schema-less explicit CLI parameters, and a precise `undefined` finish result.

The probes use public exports, including pipeline tools. Stage 3
adds runtime coverage for decision validation, schema counts, error classification,
isolation, limits, concurrency, cancellation, and saved history. The public
[scripted agent](../examples/agent.ts) exercises heterogeneous dynamic calls and
recovery without credentials; [agent usage](../docs/agents.md) documents this slice. Core iteration now uses ordinary child
execution, with deterministic tests for transitions, limits, run isolation,
selection, cancellation, dry-run, and saved-record compatibility. The public
[pagination example](../examples/iteration.ts) runs without a model or credentials.
Stage 4 adds the executable [delegation recipe](../examples/agent-delegation.ts)
and tests schema counts, nested concurrency one, ancestor/local budgets, depth,
cancellation/draining, child failure classification, previews, and simultaneous
root isolation. Pipeline tools require compiled Tubeless children so private
prevalidation and scope transport cannot be lost through external wrappers.
