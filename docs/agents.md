# Agents and durable execution

`tubeless/agent` builds an ordinary pipeline around a bounded decision loop.
Each turn calls your `decide` callback, validates its decision, executes a batch
of registered tools, and reduces their outcomes into the next state. A finish
decision validates and returns the agent's result.

The [scripted agent recipe](../examples/agent.ts) runs without model credentials:

```sh
make run FILE=examples/agent.ts ARGS='--question "hello tubeless"'
make run FILE=examples/agent.ts ARGS='--question "missing word"'
make run FILE=examples/agent.ts ARGS='--dry-run --question "preview"'
make plan FILE=examples/agent.ts
```

It creates a variable number of calls, preserves their decision order, recovers
from a deliberate domain error, and transforms the final answer. Its `decide`
callback is scripted. Supply a custom model integration through `decide`, or use
the default model-backed factory below.

## Default model-backed agent

For a terminal prompt loop with model selection and the live pipeline reporter, use
`tubeless agent --model gpt-5.4-mini`. Enter a task, read the answer, then prompt
again; `/model <name>` changes the next task's model while retaining context.
Completed prompts share conversation state; `/clear` starts fresh.
`--prompt 'task'` runs once, and `--model-module ./model.ts`
loads a custom provider factory. See the [agent CLI](./cli.md#prompt-a-workspace-agent)
for setup, cancellation, budgets, and the plugin contract.

For general workspace tasks, supply a model and an ID:

```ts
import { defineModelAgent } from "tubeless/agent";
import { openaiModel } from "tubeless/agent/openai";

const agent = defineModelAgent({ id: "coding", model: openaiModel() });
const { answer } = await agent.runOrThrow(
  { task: "Find and fix the failing test, then verify the change." },
  undefined,
  { cwd: "/path/to/project" }
);
```

### Choose a model provider

`model` accepts any `AgentModel`. Tubeless ships two optional, dependency-free adapters
with the same option names, so switching providers changes one import and one call:

```ts
import { defineModelAgent } from "tubeless/agent";
import { anthropicModel } from "tubeless/agent/anthropic";
import { openaiModel } from "tubeless/agent/openai";

// Claude through the Anthropic Messages API (ANTHROPIC_API_KEY).
const claude = defineModelAgent({ id: "coding", model: anthropicModel() });

// OpenAI through the Responses API (OPENAI_API_KEY).
const gpt = defineModelAgent({ id: "coding", model: openaiModel() });
```

| Option              | `anthropicModel()`                                                         | `openaiModel()`                                     |
| ------------------- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| `model`             | `ANTHROPIC_MODEL`, else `claude-opus-5-5`                                  | `OPENAI_MODEL`, else `gpt-5.4-mini`                 |
| `apiKey`            | `ANTHROPIC_API_KEY` (`x-api-key`); else `ANTHROPIC_AUTH_TOKEN` as a bearer | `OPENAI_API_KEY` (bearer)                           |
| `authToken`         | Explicit bearer token, for compatible servers that expect one              | Not applicable (`apiKey` is already a bearer)       |
| `baseUrl`           | `ANTHROPIC_BASE_URL`, else `https://api.anthropic.com` (no `/v1`)          | `OPENAI_BASE_URL`, else `https://api.openai.com/v1` |
| `reasoningEffort`   | Omitted; `low` through `max` sends `output_config.effort`                  | Omitted; `none` through `max` sends `reasoning`     |
| `compactAfterBytes` | 64 KiB; `null` disables compaction                                         | 64 KiB; `null` disables compaction                  |
| `timeoutMs`         | 600000 per decision                                                        | 60000 per decision                                  |
| `maxTokens`         | 32000 output tokens per request, thinking included                         | Not applicable                                      |
| `strict`            | `true`; `false` sends tools without strict mode                            | Always strict                                       |
| `promptCaching`     | `true` sends top-level `cache_control`; `false` omits it                   | Not applicable                                      |

Every environment value is read when a decision executes, so imports, plans and dry
runs need no credentials. Options always take precedence over the environment.
The executable [Claude recipe](../examples/agent-model-anthropic.ts) is registered as
`claude-coding-agent` beside the OpenAI-backed `coding-agent`. To use another
server that implements either API, see [compatible APIs](#compatible-apis).

The factory supplies the `{ task: string }` input and `{ answer: string }` result
schemas, default tools, a short coding prompt, conversation state, and reduction.
Add `instructions` to customize its behavior, `tools` to extend or override the
defaults, and `limits` to bound execution. It remains an ordinary pipeline;
`pipelineTool`, project registration, traces, and cancellation work as before.
Use `defineAgent` with `decide` when you need custom state, decisions, or result schemas.

The prompt asks the agent to inspect before editing, preserve unrelated work,
recover from tool errors, verify changes, and distinguish verified results from
remaining limitations. At the first live decision, project context loads
`AGENTS.md` from the nearest repository root through the run's cwd, in that order.
A live model-agent run resolves cwd to its physical directory once, before any
decision or tool call. The prompt, file tools, bash, custom tools, and child
pipelines all use that directory, including when resolving `..`. This also applies
with `projectContext: false`; planning and dry runs do not resolve cwd.
Guidance comes from the project containing the files. A `.git` file also marks
a worktree root. Outside a repository it loads only cwd's
file. More specific directory instructions take precedence. Deeper directories
and files referenced by those instructions are read by the agent when needed;
there is no recursive startup scan or `@file` expansion. The prompt requires
guidance reads and the file operations or task commands they govern to run in
separate turns. Commands that only discover filenames may run before those reads.
This also applies when a command selects a directory with bash's `cwd` option or
shell `cd`. The prompt requires trying that directory's `AGENTS.md` even when
filename discovery did not list it; a missing-file result permits proceeding.
Beyond startup, discovery and ordering depend on the model; file tools do not
enforce them as access controls. Required instruction discovery and reading
precede a user's requested first task action; optional
exploration waits until after that action. Already supplied guidance need not be
reread. Set `projectContext: false`
to disable discovery. Context is loaded once per invocation; simultaneous and later
runs have independent state. Missing instruction files are allowed; unreadable,
non-text, or oversized files fail before a model request rather than silently
discarding guidance. Each file uses the read tool's 16 KiB/2,000-line bounds;
guidance paths must be nonblank and at most 4,096 characters. The complete prompt,
including paths, headers and separators, is capped at 32 KiB of UTF-8 before each
section is retained. Loading stops at the first section that exceeds the budget.
Tasks are capped at 16 KiB of UTF-8.

`AgentModel` is a provider-independent callback. It receives the task, instructions,
its previous plain-data `conversation` (initially `null`), ordered outcomes from the
latest completed batch, and the usual decision context. It returns an untrusted
`decision` plus the next plain-data `conversation`. Tubeless validates the decision
and owns a frozen copy of that state; model definitions do not hold mutable sessions.
Conversation state is accepted before dispatch and reduced after the whole tool batch settles successfully.
Expected tool failures are outcomes; fatal failure or cancellation stops the run.

The optional OpenAI subpath uses native fetch and adds no SDK dependency. It defaults
to `OPENAI_MODEL` or `gpt-5.4-mini`; `openaiModel({ model, apiKey })` supplies explicit
values. The adapter omits reasoning settings by default so models that do not accept
them remain compatible. Opt in with `reasoningEffort` for a model that supports it;
`null` also omits the setting. The coding-agent recipe and live evaluations explicitly
request `"high"`. Supported effort values depend on the selected model; higher
effort can increase latency and cost. Accepted settings are `"none"`, `"minimal"`,
`"low"`, `"medium"`, `"high"`, `"xhigh"`, and `"max"`; check the selected model's
[supported efforts](https://developers.openai.com/api/docs/guides/reasoning).
Model names are trimmed; a blank
`OPENAI_MODEL` uses the default, while an
explicit blank model is rejected locally. API keys are trimmed before use.
Environment credentials are read at execution, so imports, plans, and dry
runs need no API key. Live runs make paid API requests and execute workspace tools
with the host's existing permissions. Dry runs skip the model and have no final answer.
HTTP 401 failures distinguish known `invalid_api_key` and `ip_not_authorized`
codes and otherwise suggest checking credentials, project and organization access,
and the IP allowlist. Error-body reads are limited to 16 KiB; raw messages and
unknown codes are omitted, while validated request IDs support troubleshooting.
See [OpenAI's error guide](https://developers.openai.com/api/docs/guides/error-codes).

Custom tool descriptors must be inline and support OpenAI's strict JSON Schema
subset. The adapter wraps each argument in `{ input }`; reference keywords
(`$ref`, `$dynamicRef`, `$recursiveRef`) are rejected locally before any HTTP
request because wrapping changes their reference root. Supply an inline
`inputJsonSchema` override when the tool's schema generates references.
Every object, including nested and nullable objects, must set
`additionalProperties: false` and list every property in `required`. These
[strict object requirements](https://developers.openai.com/api/docs/guides/function-calling#strict-mode)
are checked locally with the tool name and schema path in the error. Other
model-specific restrictions on the supported schema subset still apply.

The adapter keeps the complete Responses output sequence, including encrypted
reasoning, messages, and function calls, then appends matching tool outputs.
New tool outputs share an encoded 256 KiB batch budget, reduced further when the
request being sent leaves less room. Batches that fit remain exact. Otherwise,
each result's fixed metadata is reserved first, and the remaining preview space
is shared across large results. Small complete results are kept when they cost
less than a preview marker. Large outputs carry `truncated: true`, the original
JSON byte count, and a UTF-8-safe JSON-text `preview`. Every call still receives
a matching output and retains its success/failure flag. The model is told to
retrieve narrower results and avoid repeating successful mutations. Full tool
outcomes remain available to the harness and evaluation reports. This provider
boundary keeps large batches from preventing compaction; it does not change tool
execution or the outcomes supplied to custom `decide` callbacks.
It uses `store: false` with client-owned history. Once completed history exceeds
`compactAfterBytes` (64 KiB by default), or a complete decision would exceed the
request limit, it calls the native
[`/responses/compact` endpoint](https://developers.openai.com/api/docs/guides/compaction)
and carries the entire returned context window into the next decision. The
compaction budget includes instructions and history; tool schemas are
only included when checking the subsequent decision with the compacted window.
This prevents large schemas from unnecessarily trimming results before compaction.
Instructions are sent again on each request. Compaction can lose exact historical detail; the
prompt tells the model to re-read sources when exact text matters. Select a model
that supports both Responses function calling and compaction.

One decision has a combined 60-second deadline (`timeoutMs`) and makes at most two
HTTP requests: optional compaction and the decision itself. Harness decision budgets
count callbacks, not these HTTP requests or tokens. Encoded requests are capped at
1 MiB and responses at 2 MiB; these byte limits are not model token estimates.
If prior history or schemas leave no room even for the output markers, the run
fails explicitly rather than dropping a call's result.
Compaction failure, a still-oversized request, refusal, malformed output, or an
incomplete response fails without silently dropping history or retrying. Streaming
and crash-safe resume are outside this helper's contract. `tubeless agent` owns an in-memory
REPL session around it, retaining completed conversation across user prompts.
The adapter appends each new task on the first decision of a prompt, closes its
synthetic `_finish` function call, and can compact completed history before
appending the next user message. Direct `defineModelAgent` runs remain isolated.

The executable [model agent recipe](../examples/agent-model.ts) is registered as
`coding-agent` in the example project. Run it from the workspace it should change:

```sh
export OPENAI_API_KEY=...
bun /path/to/tubeless/dist/workbench/workbench-bin.js run \
  /path/to/tubeless/examples/agent-model.ts -- --task 'Fix the failing test and verify it'
```

### Anthropic adapter

`anthropicModel()` from `tubeless/agent/anthropic` calls the
[Messages API](https://platform.claude.com/docs/en/api/messages) with native fetch and
no SDK dependency. It follows the same harness contract as the OpenAI adapter: tool
arguments are wrapped in `{ input }`, `_finish` carries `{ result }`, references are
rejected locally, requests are capped at 1 MiB and responses at 2 MiB, and large tool
batches receive the same marked previews.

The adapter keeps every returned content block, including thinking blocks and their
signatures, and appends one user message of `tool_result` blocks per batch. A later
prompt on the same conversation closes `_finish` with a `tool_result` and adds the new
task to that user message, because the Messages API cannot follow a user message with
another user message. Compaction runs on that completed history before the new task is
appended, and the task stays verbatim. Direct `defineModelAgent` runs remain isolated.
Recoverable tool failures set `is_error: true`. History is never edited except by
compaction, which keeps it valid for models that check replayed thinking. Current
Claude models reject forced tool choice, so the adapter sends `tool_choice: "auto"` and
instructs the model to respond only with tool calls. If a reply contains no tool call,
the adapter appends that reply and one reminder, then asks once more. A second text-only
reply fails the decision. Requests set top-level `cache_control` so repeated turns reuse
the cached prefix.

With `strict: true` (the default), tools use
[strict tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use).
Every object must set `additionalProperties: false`; unlike OpenAI, optional properties
are allowed. The schema the model sees keeps only what strict mode accepts: types,
`properties`, `required`, `items`, `anyOf`, `allOf` (`oneOf` becomes `anyOf`), scalar
`enum` and `const`, `default`, supported string formats, and `minItems` of 0 or 1.
A schema with scalar `enum` or `const` and no type gets one: a shared type when every
value agrees, `number` when the values are only integers and numbers, or `anyOf` of
typed enums when the values mix types. A schema with neither a type nor `anyOf`/`allOf`
is rejected locally. Every other keyword, such as length, numeric, and pattern
constraints, is recorded in that schema's `description` instead. Tubeless still
validates every argument against the full schema. Tool names longer than 64 characters
are rejected locally; the harness itself allows 128.
Strict mode allows at most 20 strict tools per request, including `_finish`, plus
limits on optional and union-typed parameters. Set `strict: false` for larger tool sets
or servers without strict support.

Once completed history exceeds `compactAfterBytes`, or a complete decision would exceed
the request limit, the adapter requests
[on-demand compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand)
with the same system prompt and tools. It replaces the history with the returned assistant
message, holding the signed summary block unchanged, followed by a short user continuation message. The `compact-2026-09-04` beta header is
sent only on that request and on later requests carrying the block. If no summary comes
back, the decision continues with the uncompacted history and the request limit still
applies. Set `compactAfterBytes: null` for servers or models without compaction.

A decision makes at most three HTTP requests: optional compaction, the decision, and
one tool-call reminder. `max_tokens`, refusal, and other unexpected stop reasons fail
explicitly; raise `maxTokens` when long thinking reaches the cap. Run the Claude recipe
the same way as the OpenAI one:

```sh
export ANTHROPIC_API_KEY=...
bun /path/to/tubeless/dist/workbench/workbench-bin.js run \
  /path/to/tubeless/examples/agent-model-anthropic.ts -- --task 'Fix the failing test and verify it'
```

### Compatible APIs

Both adapters work with any server that implements the same protocol: hosted routers,
inference platforms, self-hosted servers, and gateways. Set `baseUrl` (or
`OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`), the provider's credential, and the
provider's model ID. Then turn off features the server does not support:

- `openaiModel()` needs the **Responses API** (`POST {baseUrl}/responses`), not only
  Chat Completions. `baseUrl` includes the version path. Set `compactAfterBytes: null`
  unless the server implements `/responses/compact`. The adapter sends `store: false`
  and `include: ["reasoning.encrypted_content"]`.
- `anthropicModel()` needs the **Messages API** (`POST {baseUrl}/v1/messages`).
  `baseUrl` excludes `/v1`. Most compatible servers expect a bearer token, so pass
  `authToken` (or set `ANTHROPIC_AUTH_TOKEN`) instead of `apiKey`. Set `strict: false`,
  `promptCaching: false`, and `compactAfterBytes: null` unless the server documents
  strict tool use, `cache_control`, and on-demand compaction.

```ts
import { defineModelAgent } from "tubeless/agent";
import { anthropicModel } from "tubeless/agent/anthropic";
import { openaiModel } from "tubeless/agent/openai";

// OpenRouter through its Responses endpoint.
export const RouterAgent = defineModelAgent({
  id: "router-coding",
  model: openaiModel({
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
    model: "anthropic/claude-opus-5",
    compactAfterBytes: null,
  }),
});

// Baseten through its Messages endpoint (bearer auth; x-api-key is rejected).
export const BasetenAgent = defineModelAgent({
  id: "baseten-coding",
  model: anthropicModel({
    baseUrl: "https://inference.baseten.co",
    authToken: process.env.BASETEN_API_KEY,
    model: "deepseek-ai/DeepSeek-V4-Pro",
    strict: false,
    promptCaching: false,
    compactAfterBytes: null,
  }),
});
```

`process.env` in a module is read at import, unlike the adapters' own variables. To keep
credentials out of imports and plans, set the conventional variables instead, such as
`OPENAI_BASE_URL` and `OPENAI_API_KEY`, or `ANTHROPIC_BASE_URL` and
`ANTHROPIC_AUTH_TOKEN`. Then call `openaiModel()` or `anthropicModel()` with only the
remaining options. With `ANTHROPIC_AUTH_TOKEN`, leave `ANTHROPIC_API_KEY` unset; when
both variables are set, the API key takes precedence.

These base URLs come from each provider's documentation as of October 2026. Check the
provider's current documentation for model IDs, tool support, and limits:

| Provider          | `openaiModel({ baseUrl })`                      | `anthropicModel({ baseUrl })`                        | Notes                                                                    |
| ----------------- | ----------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| OpenRouter        | `https://openrouter.ai/api/v1`                  | `https://openrouter.ai/api`                          | Bearer auth (`authToken`); model slugs such as `anthropic/claude-opus-5` |
| Baseten           | Not available (Chat Completions only)           | `https://inference.baseten.co`                       | Messages is in beta; bearer auth (`authToken`)                           |
| Fireworks         | `https://api.fireworks.ai/inference/v1`         | `https://api.fireworks.ai/inference`                 | Bearer auth; `accounts/fireworks/models/...` model IDs                   |
| DeepSeek          | `https://api.deepseek.com`                      | `https://api.deepseek.com/anthropic`                 | Ignores `cache_control`                                                  |
| Moonshot (Kimi)   | `https://api.moonshot.ai/v1`                    | `https://api.moonshot.ai/anthropic`                  | Bearer auth (`authToken`)                                                |
| Amazon Bedrock    | `https://bedrock-mantle.{region}.api.aws/v1`    | `https://bedrock-mantle.{region}.api.aws/anthropic`  | Bedrock API key; Bedrock model IDs                                       |
| Microsoft Foundry | `https://{resource}.openai.azure.com/openai/v1` | `https://{resource}.services.ai.azure.com/anthropic` | `model` is the deployment name                                           |
| Ollama            | `http://localhost:11434/v1`                     | `http://localhost:11434`                             | Local keys can be any placeholder value                                  |
| vLLM              | `http://{host}:8000/v1`                         | `http://{host}:8000`                                 | Self-hosted                                                              |
| LiteLLM proxy     | `http://localhost:4000/v1`                      | `http://localhost:4000`                              | Supports `/responses/compact`; bridges providers without either API      |

Groq's Responses endpoint rejects `store` and `include`, which the OpenAI adapter
always sends. Google Vertex AI puts the model in the request path and uses OAuth
instead of a base URL plus key. Reach either one through a gateway such as LiteLLM.
Compatible servers vary in how closely they follow each protocol. Exercise a new
provider with a small task before relying on it.

Run the opt-in live evaluations from the package root with `bun run eval:agent`.
They create disposable workspaces and check investigation, actual edits, successful
verification, startup project instructions, nested guidance discovered before a
requested file read, recovery from a missing file, and forced compaction. They
also require existing tests and unrelated work to remain intact.
Results are written to `.context/model-agent-eval.json`; these paid evaluations
are separate from credential-free CI. Reports retain full call arguments, observed
tool outcomes, decision batches with the outcomes supplied to each decision, and
any completed answer and verification output, including when a
later assertion fails. The disposable workspaces are still removed after each task.
The recovery task must request the missing-file read alone, then choose recovery
in the next decision that receives its `ENOENT` outcome. That batch's results
must contain the current configuration or reveal its location. Speculative
recovery in the first batch and recovery deferred past the error-observing
decision both fail the evaluation.
The read-only nested-guidance task must load `src/AGENTS.md` in an earlier turn
than `src/code.txt`, apply its answer convention, and preserve every fixture file.
Passing them is evidence for these specific
tasks, not a general reliability guarantee.

## Connect a model

The [OpenAI agent recipe](../examples/agent-openai.ts) connects the same tools to
the Responses API using built-in `fetch`. Its
[decision adapter](../examples/agent-openai-decision.ts) is application code,
with no provider SDK or new Tubeless API. Replace `decide: openaiDecision` with
another provider's callback to keep the same tools, state, limits, and execution.

Set `OPENAI_API_KEY` in your environment, then run:

```sh
bun run tubeless -- run --trace logs/openai-agent.ndjson examples/agent-openai.ts -- \
  --question "Uppercase red, blue, and green in separate calls. Then count the characters in the uppercase results joined by single spaces."
```

The example defaults to `gpt-4.1-mini`; set `OPENAI_MODEL` to choose another
Responses model with function calling. This command makes paid API requests.
Its custom tools transform and count text. Like every agent, it also advertises
the default workspace tools, including `bash`, to the model. Those tools execute
with the host process's permissions and environment; there is no per-call approval
or sandbox built into the harness.

The model chooses which tools to call, their arguments, and how many calls to
request. A run can uppercase three words in one turn, consume those results in
a count call on the next turn, then finish with `RED BLUE GREEN` and a count of 14. The call sequence is model-selected; the recipe does not script those turns.
The command prints the validated final answer.

The adapter follows OpenAI's [function calling protocol](https://developers.openai.com/api/docs/guides/function-calling):

- Tool descriptors come from `context.capabilities`. Each function wraps the
  raw tool argument in `{ input }`, so even a string-valued tool has an object
  parameter schema. This recipe's schemas support OpenAI strict mode. When
  adapting other tools, check the provider's supported JSON Schema subset.
- An adapter-only `_finish` function wraps `context.resultJsonSchema` in
  `{ result }`. Calling it alone returns a Tubeless finish decision. Combining
  it with other calls fails before any tools start.
- Each request sends the current question and accumulated, validated outcomes.
  Tubeless owns the state; this example makes independent model requests with
  `store: false`, without a provider conversation or replayed reasoning items.
- Provider call IDs become turn-local Tubeless call IDs. The adapter checks the
  response envelope and parses arguments; Tubeless checks registered tools,
  call IDs, budgets, argument schemas, tool results, and the final answer.

The example allows six decisions and twelve tool calls, with up to three tools
running concurrently. Each HTTP request has a 30-second deadline and receives
the run's cancellation signal. HTTP errors, incomplete responses, refusals,
invalid JSON, and invalid decisions fail the run. There are no automatic
provider retries. Error messages omit HTTP response bodies.

The recipe also bounds model input in UTF-8 bytes. Questions may use up to
4 KiB; accumulated observations may use up to 16 KiB of serialized JSON. An
oversized question fails before the first model request. Oversized history fails
before committing the next state or requesting another decision. Accepted
observations remain complete, so later tools can use their exact text. The
adapter checks the complete encoded HTTP body against a 32 KiB limit before
every request, including instructions, schemas, and JSON escaping. These are
application byte budgets; they do not measure a selected model's token usage.

`plan`, `inspect`, and `graph` need no credentials and make no API requests. The
live example has no preview decision source: `--dry-run` skips the agent and
fails required finalization because there is no answer. Use the scripted recipe
for a credential-free executable preview. Importing the project also makes no
requests; `openai-agent` is registered in the
[example project](../examples/project/tubeless.project.ts).

CI replaces `fetch` with provider response fixtures while running real Tubeless
tools, reduction, and finalization. Run the command above separately for a live
provider check. Traces record turn/call lifecycles and summaries; prompts, state,
tool output, and credentials are not added to traces by this adapter.

The compiled turn graph stays `decide -> calls -> reduce`. Its execution history
expands with each chosen batch and turn; a model cannot rewrite dependency edges
or add tool-registry entries. The registered `bash` tool executes model-supplied commands.

## Define tools and an agent

Every `defineAgent` includes `read`, `write`, `edit`, `bash`, `list`, and `search`,
including child agents. The optional `tools` object adds custom capabilities;
a custom entry with a built-in name replaces that tool for this agent. The
decision context advertises the merged registry, and `AgentCall`, `AgentDecision`,
and `AgentOutcome` include the defaults with each custom override's exact types.
Narrow outcomes by both `ok` and `tool` before reading a tool-specific value.

Use `defineTool` for a handler with a description, `inputSchema`, `outputSchema`,
and `run(validatedInput, context)`. Both schemas follow Standard Schema V1.
The input schema must expose Standard JSON Schema input conversion for
`draft-2020-12`, or supply an explicit `inputJsonSchema` object. `defineAgent`
similarly requires a `resultSchema` with input conversion or `resultJsonSchema`.
Descriptors are owned, frozen JSON data; explicit descriptors assert agreement
with the validators, which remain authoritative. No schema or model SDK is a
runtime dependency of Tubeless.

Tool names start with a letter and contain letters, digits, underscores, or
hyphens, up to 128 characters. A call ID is a nonblank string of at most 256
characters, unique within its turn. Model data can select registered names and
supply arguments; it cannot add registry entries or change harness limits.

`defineAgent` takes `id`, `inputSchema`, `resultSchema`, `initialState`, and
`decide`, with optional `tools`, `reduce`, `dryRun`, and `limits`. It returns a
pipeline with the single step and target `agent`. Its exact raw input, schema
transformed output, and literal ID work with ordinary `fromPipeline`,
`defineProject`, and `definePipelineCommand`. Automatic CLI flags still require
JSON Schema metadata on the agent's input schema.

### Embed an agent in a pipeline

Use `fromPipeline` when ordinary work needs an agent's answer, just as for any
other child pipeline. The [composition recipe](../examples/agent-pipeline.ts)
forwards validated parent options to a delegating agent and feeds its validated
answer into a dependent report step. It uses scripted decisions so the entire
example, including child agents, can run without credentials or in preview mode:

```sh
make run FILE=examples/agent-pipeline.ts ARGS='--question "red missing"'
make run FILE=examples/agent-pipeline.ts ARGS='--dry-run --question "red missing"'
```

Both return `Summary: 3 characters; RED | 7 characters; Observed NOT_FOUND: Word unavailable`.
Recording the parent with `--trace` or `--store` exposes the same child-agent
history as recording the agent directly. A child failure or cancellation prevents
the required report step from running.

## Default workspace tools

| Tool     | Arguments                                   | Result and bounds                                                                                                                                |
| -------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `read`   | `path`, optional `startLine` and `maxLines` | UTF-8 content and line range; starts at line 1, returns up to 200 lines by default and 16 KiB. `maxLines` may be at most 2,000.                  |
| `write`  | `path`, `content`                           | Creates parent directories and creates or replaces the file; returns its path and byte count.                                                    |
| `edit`   | `path`, `oldText`, `newText`                | Replaces one exact match; missing or ambiguous matches return a recoverable error without writing.                                               |
| `bash`   | `command`, optional `cwd` and `timeoutMs`   | stdout, stderr, exit code, signal, timeout and truncation flags. Defaults to 30 seconds; maximum 5 minutes. Combined output is capped at 16 KiB. |
| `list`   | optional `path`                             | Up to 200 directory entries with file/directory/symlink kinds and a truncation flag.                                                             |
| `search` | `query`, optional `path`                    | Case-sensitive literal search with paths and line numbers; up to 50 matches and 16 KiB of path/text content.                                     |

Workspace tools publish their actions through step progress and scoped pipeline
logs. Reads, writes, and edits show file paths; bash shows a command preview;
list and search show their paths and query. Completion includes line ranges,
bytes, exit codes, or result counts after output validation succeeds; failure and cancellation receive explicit
log entries. Previews retain at most 160 input characters and escape control
characters. File contents, edit replacements, and command output stay out of these
activity summaries. This works with the standard pipeline reporter, including
the agent REPL's live tree and redirected or `--no-graph` logs.

Turns display “Plan next action”, “Tool calls”, and “Update context”; individual
calls display registered tool names. Custom handlers can add detail with
`context.reportProgress({ completed: 0, message: "Your action" })` and
`context.log`, using the same reporter.

File reads, edits and writes support regular UTF-8 files up to 1 MiB; named pipes
and devices are rejected. `read` rejects binary files. `search` skips binary and
oversized files, `.git`, `node_modules`, and nested symlinks. During directory
searches it also skips unavailable descendants, retaining other matches;
`skippedFiles` counts unsupported files and unavailable entries, counting an
unavailable directory once. Missing or inaccessible explicit roots still fail,
as do cancellation and unexpected I/O errors.

List and search sort each directory in case-sensitive filename order before
applying result limits or descending. Each visited directory's entry list is read
in full for sorting; search processes at most 2,000 entries and 32 directory levels.
Search snippets are capped at 1,024 UTF-8 bytes per line and shift to the first
match when the initial snippet omits it. A query longer than that bound can itself
be clipped; `truncated` reports omitted text or results.
Listing caps retained names at 16 KiB. Result metadata is additional to these content limits.
Nullable options select defaults. Application calls may omit these options;
model descriptors require them explicitly with `null` accepted for defaults.

Paths resolve from the invocation's `context.cwd`; absolute paths are accepted.
`bash.cwd` resolves from that same directory. These are host filesystem and shell
operations using the process's permissions and environment; `cwd` is not a sandbox.
Filesystem and command-start failures become recoverable `ToolError` observations.
A command's nonzero exit or timeout is reported in its result. Cancellation remains
fatal and waits for the owned command to close; on POSIX, timeout/cancellation
signals the command's process group, escalating to SIGKILL after 250 milliseconds.
At that deadline, remaining output pipes are closed and the output is marked
truncated. Descendants that escape the process group may survive, but cannot keep
the tool waiting on inherited output pipes; process groups are not a sandbox.

All defaults use the ordinary validated tool execution path, shared budgets,
concurrency limits, and tracing. Read, list, and search run in dry runs. Write,
edit, and bash skip live work and produce no fabricated result; an agent turn
requiring one of these skipped results fails. Put dependent filesystem changes in
successive turns; calls in a batch may run concurrently. Writes and edits to the same
file run one at a time within a process, so concurrent edits each apply to the
latest contents. Each write or edit stages
the complete contents in a sibling temporary directory, then atomically replaces
the destination. Cancellation or failure before replacement preserves the original;
cancellation racing with replacement can leave the complete new file. Existing
symlinks are followed; `write` can create a missing target and its parent directories
without replacing the link. Existing owner, group, and file permission bits are preserved.
Atomic replacement requires write and search permissions on the destination directory,
even when the file itself is writable. If staging or restoring ownership is not permitted,
the tool fails without replacing the original; it does not fall back to an in-place write.
Replacement creates a new inode: other hard links retain the old contents, and extended
file attributes are not copied.
Operations are not transactions across calls or a crash-safe durability guarantee.

The [workspace recipe](../examples/agent-workspace.ts) uses all six defaults and
one custom tool to create, inspect, edit, and verify `message.txt`. Its decisions
are scripted; its filesystem and bash operations are real:

```sh
make run FILE=examples/agent-workspace.ts ARGS='--directory .tubeless/agent-tools-demo'
```

The recipe creates or replaces that demo file. It is registered as `workspace-agent`
in the example project. The existing OpenAI recipe also advertises the defaults
automatically, alongside its custom text tools.

## Delegate to pipelines and subagents

Use `pipelineTool` to register an ordinary compiled pipeline or another agent in
the same tools registry. A schema-backed child needs only a description:

```ts
const tools = {
  research: pipelineTool(ResearchAgent, { description: "Research one question." }),
};
```

The tool uses the child's options schema for model arguments and returns its
exact finalized result. For different argument shapes or a schema-less child,
supply `inputSchema` and `mapOptions` together:

```ts
const tools = {
  count: pipelineTool(CounterPipeline, {
    description: "Count a question's characters.",
    inputSchema: questionSchema,
    mapOptions: ({ question }) => ({ text: question }),
  }),
};
```

The harness validates arguments, maps options, validates child options, and checks
child plans for the whole batch before starting any child. Each schema transform
runs once. Keep mappers free of side effects. A child owns its state and registry;
its finish returns a result to the parent, which can make further decisions.

Run the [delegation recipe](../examples/agent-delegation.ts) without credentials:

```sh
make run FILE=examples/agent-delegation.ts ARGS='--question "red blue"'
make run FILE=examples/agent-delegation.ts ARGS='--dry-run --question "red blue"'
```

The parent creates two child-agent calls, consumes their results in a later
ordinary summary-pipeline call, then finishes with
`Summary: 3 characters; RED | 4 characters; BLUE`. Each decision source is
scripted; it can be replaced with an application-owned model callback.

A failed child is recoverable only when all its failures are actual handler
`ToolError`s. Multiple expected failures become one bounded `TUBELESS_TOOL_ERRORS`
observation in pipeline order. Mixed failures, validation, finalization, model
callbacks, and cancellation remain fatal. Child pipelines inherit dry runs and
retain their own step policies; mark side effects or supply preview handlers.

## Decisions and state

`decide(state, context)` may return either of these shapes:

```ts
{ kind: "continue", calls: [{ id: "lookup-1", tool: "lookup", input: { query: "example" } }] }
{ kind: "finish", result: "The raw result schema input" }
```

The return type is intentionally `unknown`: every decision is checked, including
typed provider responses. `AgentDecision<typeof tools, RawResult>` is useful for
typed fixtures. Empty batches, duplicate call IDs, unknown names, extra envelope
or call fields, and malformed arguments fail. A decision cannot both finish and
schedule calls. A valid `undefined` final result is distinct from a missing
`result` property.

All arguments are validated before any handler in the batch starts. Input
transformations run once; each tool output and final result is validated once.
Independent calls may complete in any order, but `reduce(state, outcomes)` sees
decision order and runs once after the entire successful batch settles.
Dependencies between calls belong in a later turn.

State is owned by each invocation. Initialization and reducer commits copy and
freeze finite primitives, arrays, and plain records; undefined fields are allowed.
Cycles, class instances, functions, and resource handles are rejected. Keep
clients and file handles in application closures. Reducers return the next state;
omitting a reducer preserves state without accumulating observations.

`context.turn` starts at one. `context.stateVersion` starts at zero and advances
after each accepted batch, including when the reducer is omitted. The context
contains ordinary step services, immutable capability descriptions/input JSON
Schemas, and the raw final-result JSON Schema. It exposes no tool handlers.

## Failure, cancellation, and limits

A handler may throw `new ToolError(code, message)` for an expected domain failure.
The reducer receives `{ id, tool, ok: false, error: { code, message } }`, while the
tool's child run retains its failed lifecycle. An arbitrary error with the same
string code is fatal. Tool errors thrown by validators or reducers are fatal too.
Successful outcomes contain `{ id, tool, ok: true, value }` with validated outputs.

| Limit            | Default | Scope                                                           |
| ---------------- | ------- | --------------------------------------------------------------- |
| `maxTurns`       | 20      | Decision invocations, including finish                          |
| `maxCalls`       | 100     | Whole-batch tool/child admissions across the subtree            |
| `maxDecisions`   | 100     | Subtree decision admissions; excludes provider-internal retries |
| `maxDepth`       | 4       | Pipeline-tool delegation edges below this agent                 |
| `maxConcurrency` | 1       | Active decision callbacks and leaf step handlers in the subtree |

Limits are safe integers; `maxCalls` and `maxDepth` permit zero. A batch exceeding the
remaining call budget fails before any handler starts. Admitted calls consume
their allowance even if execution stops before dispatch. Finishing on the last
turn succeeds; continuing on that turn fails before tools run. Exhaustion fails
with `TUBELESS_AGENT_LIMIT_REACHED`, including bound, consumed count, requested
count, and scope in the error. Invalid decisions and state use
`TUBELESS_AGENT_INVALID_DECISION` and `TUBELESS_AGENT_INVALID_STATE`. Ordinary
pipeline child-error wrapping retains these source codes in the cause chain.

The root invocation owns shared counters and execution permits. Child limits can
tighten the bounds; every ancestor limit still applies. Concurrent sibling
admissions check and charge the entire batch atomically, with no refunds.
`maxTurns` remains local to each agent. A `pipelineTool` call consumes one call
and one delegation edge; calls and decisions inside that child also consume
ancestor budgets. Ordinary pipeline steps consume leaf permits, not call counts.
A depth of zero permits handler tools but rejects pipeline tools.

Decision callbacks release their permits before child dispatch. Wrappers waiting
on descendants hold no permit, so nested execution works with concurrency one.
The scope survives ordinary `fromPipeline`, `forEachPipeline`, and iteration
between agents. Use registered pipeline tools for delegation: manually calling
`run` from a handler is outside this composition contract. Schema validation,
mapping, reducers, and finalizers are not counted as leaf handlers. The outer
pipeline's DAG `maxConcurrency` remains a separate control.

Cancellation stops new calls and waits for active work to settle. Fatal failures
also stop dispatch and drain active work, without cancelling sibling handlers.
Neither case calls the reducer or starts another decision. Handlers must cooperate
with `context.signal`; Tubeless cannot terminate an uncooperative promise.

Planning never initializes state or calls models, argument validators, or tools.
A dry run skips the agent unless `dryRun(state, context)` supplies a preview
decision source. Tools skip by default and require their own preview handler.
A skipped required tool or agent output fails finalization instead of inventing
an observation or answer.

## Inspection and recordings

Plans show the bounded turn pipeline and the agent's capability inventory and
limits. Runtime call IDs are not selectable `--step` targets. Definition identity
includes capabilities, input/result descriptor fingerprints, limits, and tool
pipeline identities. Set `implementationVersion` when changing prompts,
validators, reducers, or handlers whose semantics cannot be inferred from the graph.

Execution uses ordinary `decide`, `calls`, and `reduce` steps, with a new child run
per turn and per dispatched tool. Turn iteration relations identify the owning
agent. A tool run's `parentRunId` identifies its turn, and `itemKey` retains the
call ID. Handler-tool first-attempt trace attributes record `agent.runId`, `agent.turn`,
`agent.callId`, `agent.tool`, and `agent.parentAttemptId`. Decision, admission,
and reduction attempts record bounded decision/count/state-version summaries.
Dispatch also records the selected tool name on the turn, so aliases for the same
child pipeline remain distinguishable. These trace v3 records round-trip through NDJSON and SQLite. State,
prompts, inputs, and outputs are not recorded automatically. Live progress keeps
at most 32 visible call groups and 32 recent turn groups.

Use `tubeless history <run-id>` to inspect a recorded agent or a parent pipeline
containing agents. The detail view joins descendants by run identity and shows
agent → turn → call → child agent, including decisions, state versions before and
after reduction, observed/selected call counts, cumulative local call admissions,
errors, and termination. Repeated call IDs remain separate across turns; a failed
tool can appear inside a completed turn when the agent recovered. History retains
every recorded call even when live progress rows were truncated.

```sh
bunx tubeless run --trace agent.ndjson ./examples/agent-delegation.ts -- --question "red missing"
bunx tubeless history --trace agent.ndjson
bunx tubeless history --trace agent.ndjson <agent-run-id>
bunx tubeless history --trace agent.ndjson --json <agent-run-id>
```

JSON details add `agentHistory.agents`: each agent has its run ID, declared
capabilities and limits, termination, and ordered turns with calls. Calls link to
child agents with `childAgentRunIds`; each child has a `parentCall` containing the
owning agent, turn, call ID, and call run ID. This keeps nested histories linked
without duplicating subtrees. Existing run lists and `--events` output retain
their scope. `--pipeline` selects the requested root run; its detail still includes
children with different pipeline IDs.

Older traces remain readable. Missing decisions or tool aliases are shown as
unknown; history does not guess an alias from a pipeline name. A dispatch with no
recorded child has unknown status. A run with no terminal event remains recorded
as running, which does not establish that a process is still alive. Termination
distinguishes validated finish, limit exhaustion, cancellation, failure, skipped
execution, and completion without a recorded finish decision. Detailed Studio
presentation remains a separate slice.

## Durable execution

Add `durability` and an explicit `implementationVersion` to either agent factory.
The execution key identifies one task across process restarts. Invoke the same
agent with the same key and inputs to resume it. Use a new key for new work or
after changing its definition, prompt, validators, reducers, model configuration,
or tool implementations.

```ts
import { defineModelAgent } from "tubeless/agent";
import { openSqliteAgentCheckpointStore } from "tubeless/agent/node";
import { openaiModel } from "tubeless/agent/openai";

const store = await openSqliteAgentCheckpointStore(".tubeless/agents.sqlite");
try {
  const agent = defineModelAgent({
    id: "coding",
    implementationVersion: "coding-v1",
    model: openaiModel(),
    durability: { store, key: "issue-123" },
  });
  await agent.runOrThrow({ task: "Fix issue 123 and verify the change." });
} finally {
  store.close(); // after active invocations have settled
}
```

The SQLite adapter uses Node 22.6+ built-ins, WAL and full synchronous commits;
it adds no runtime dependency. It creates database files with mode `0600` and
rejects existing files with group or other access on POSIX. Database files must
be regular files with one hard link; SQLite sidecars are checked as well. On
Windows, protect the database directory with the application's filesystem ACLs.
A private `<database>.leases` directory holds one SQLite lock file per execution
key. Different keys run concurrently; a second owner of the same key is rejected.
Closing the lease or exiting the process releases its native SQLite lock, so
PID reuse cannot prevent recovery. Keep the lock directory and its files while
any store is open; removing them can break exclusive ownership. This adapter is
intended for one host with a local filesystem. It requires Node's `node:sqlite`;
use another store for runtimes without that module or distributed ownership.

The credential-free [durable workspace recipe](../examples/agent-durable.ts)
writes and verifies a demonstration file. Run it with Node from the repository:

```sh
bun run build
node dist/workbench/workbench-bin.js run examples/agent-durable.ts -- --task "hello durable"
```

It opens storage lazily, closes it after execution, and derives a key from the
task. Repeating that task returns its saved answer without repeating tools.
A completed answer describes the committed execution; it does not recheck
external files that have since changed. Plans and dry runs open no storage.
Durable resume is driven by the key, independently of the CLI's artifact
`--resume` flag and trace/history storage.

Before external work, the harness acknowledges decision-budget reservations,
validated decisions and prepared arguments, whole-batch call reservations, and
individual call intent. It commits validated outcomes independently, then the
reduced state or final result. Child agents share this journal and ancestor
budgets, including through ordinary pipeline composition. Live children use
their parent's journal rather than opening an independent store or execution
key. Every live child joining recovery must also declare an explicit
`implementationVersion`, even without its own `durability` configuration.
Bump that version when changing its decisions, tools or other semantics; ancestor
definitions include child versions, so changed children invalidate saved ancestor
results too. Explicitly previewed children retain ephemeral state and do not
require a version. Stable fan-out keys
and deterministic mapping preserve child identities; ordinary pipelines are
not themselves checkpointed step by step. Accepted call argument transforms,
committed output transforms, and committed finish transforms are reused.
Root input validation still runs on every invocation.

| Call state at restart       | Behavior                                                           |
| --------------------------- | ------------------------------------------------------------------ |
| Completed                   | Reuse the validated outcome; do not dispatch again.                |
| Pending                     | Dispatch after the saved batch admission.                          |
| Running, `replay: "safe"`   | Rerun with the same durable call identity.                         |
| Running, `replay: "unsafe"` | Return `TUBELESS_AGENT_CALL_INTERRUPTED` as a recoverable outcome. |

Handler tools and ordinary pipeline tools default to `"unsafe"`. Read, list,
search, and directly registered agent pipelines default to `"safe"`.
Set `replay: "safe"` only for repeatable work or an operation protected by
business idempotency. A safe ordinary pipeline may repeat its intermediate
steps and option mapping; that entire invocation must be repeatable. Custom
tools and decision callbacks receive `context.execution`, containing the stable
execution ID, agent route, turn, and optional call ID. Use all applicable fields
for external idempotency keys. Trace run IDs identify individual attempts and
can change after a restart.

Checkpoints cannot make arbitrary external effects exactly once. An interrupted
unsafe mutation may have run partially or completely; the agent must inspect
its effects and choose its next action. Unacknowledged decisions may make a new
model request and consume another decision reservation. Initialization,
validators, mappers and reducers must be pure: a crash before their output is
acknowledged can repeat them. Cancellation preserves resumable state; ordinary
fatal failures are saved as terminal failures. A rejected storage write stops
the invocation even when its commit is ambiguous. Reopening reads authoritative
storage before choosing recovery behavior.

Implement `AgentCheckpointStore` for another backend. `acquire` must guarantee
exclusive ownership, and `write` must atomically replace the bytes and resolve
only after durable acknowledgement. Trace exporters are best-effort and do not
satisfy this contract. `createMemoryAgentCheckpointStore()` is useful for tests
and embedded hosts; its data is lost with the process. The default
`plainAgentCheckpointCodec` preserves finite plain data, undefined fields,
negative zero and sparse arrays. Other validated arguments or results require
a deterministic lossless codec; agent state itself remains owned plain data.
Checkpoints contain task inputs, prompts, conversation and outputs; protect
them as application data.

## Execution environments

The default local environment uses the host's filesystem and shell permissions.
Supply `environment` to either factory to place all default workspace tools and
project-guidance discovery in a different workspace:

```ts
import { defineModelAgent, type AgentEnvironment } from "tubeless/agent";
import { openaiModel } from "tubeless/agent/openai";

function agentForWorkspace(environment: AgentEnvironment) {
  return defineModelAgent({ id: "remote-coding", model: openaiModel(), environment });
}
```

An `AgentEnvironment` owns `resolveCwd`, `projectInstructions`, `read`, `write`,
`edit`, `bash`, `list`, and `search`. Implement them against your sandbox or
remote service using the declared typed results and cancellation signal.
Environment factories, workspace resolution, guidance loading and default tools
recheck cancellation before and after their work. If an operation rejects while
the signal is aborted, the run retains the signal's cancellation reason even when
the adapter throws an SDK-specific error. Without an aborted signal, adapter errors
keep their ordinary failure semantics. Active operations still settle before the
run returns.
All byte limits below count UTF-8 data and apply at the shared tool boundary:

- Limit `write.content`, `edit.oldText`, and `edit.newText` to 1 MiB each. Oversized
  arguments fail validation before any call in the batch starts.
- Return at most 16 KiB of read content or combined bash stdout/stderr.
- Return up to 200 listing entries with at most 16 KiB of retained names.
- Return up to 50 search matches with at most 1,024 bytes per snippet and 16 KiB
  of combined path/text content.

Oversized results fail validation before state commits. Apply truncation in the
backend and set `truncated` when omitting text or results. Enforce file size and
mutation semantics in the backend as well, including the completed file after
an edit. No local guidance or filesystem fallback is used for an explicit environment. Its stable `id`
identifies the workspace authority, and cwd identifies the workspace within it;
durable resume rejects changes to either. Custom tools and decision callbacks
receive `context.environment`. Composed children inherit it unless they declare
their own environment. Custom closures remain responsible for using that
authority instead of accessing the host directly.

An environment may be a capability object or an async factory. The factory is
resolved once per live invocation and is never called by planning or skipped
dry runs. Model agents and agents with an explicit environment resolve cwd once
before decisions and tools. `createNodeAgentEnvironment()` from
`tubeless/agent/node` exposes the local adapter explicitly; its default
`node:local` id names the local filesystem authority rather than the host, so
a recreated container or pod still resumes its checkpoints. Pass `{ id }` to
name a distinct authority, for example one store shared by several hosts.
Environments supply capabilities, not a sandbox guarantee: isolation and
remote-process termination belong to the backend. The optional Node adapter and
storage remain outside the provider-independent contracts.

Run the credential-free [environment recipe](../examples/agent-environment.ts)
to list a workspace through an explicit Node adapter, or supply your own
environment to its factory.
