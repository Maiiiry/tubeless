# Studio

Studio is a browser interface for inspecting pipeline runs. It runs locally by default
and can be hosted behind an authenticated application gateway. It shows
step status, progress, logs, and errors from a SQLite run store or a saved NDJSON
trace. You can also load a project or register pipeline commands to preview and launch them from
the browser. Recording and Studio are optional; pipelines run without either.

## Record and inspect a run

Place `--store` before the command file to record its events in SQLite:

```sh
bunx tubeless run --store .tubeless/runs.sqlite ./scripts/import.ts -- --source rows.txt
bunx tubeless ui --store .tubeless/runs.sqlite
```

The default browser address is `http://127.0.0.1:4317`, and the default store
is `.tubeless/runs.sqlite`. Use `--host`, `--port`, or `--store` to change them.

You can inspect the same records in the terminal:

```sh
bunx tubeless history --store .tubeless/runs.sqlite
bunx tubeless history --json <run-id>
```

To inspect a finished NDJSON trace instead of a database:

```sh
bunx tubeless history --trace run.ndjson
bunx tubeless ui --trace run.ndjson
```

The NDJSON view is always read-only. It cannot launch commands or clear history,
and does not accept a project file or `--command`.

## Use the browser controls

The run list shows active runs first, followed by history. Child runs appear
beneath their parent, and caller-owned correlation IDs remain searchable and
visible separately from package-generated run IDs. History is paged in groups of
50 top-level runs; search includes nested runs across the complete history.
Open a run to inspect its steps, progress, logs, and errors. Studio loads those
details and complete definition snapshots separately from the history summaries,
and unchanged refreshes reuse the current history page. Definition run pages
refresh independently, preserving metadata search, grouping, and comparisons.
Failed definition requests offer a retry beside the affected content.

Run details lead with a one-line outcome, such as where the run failed or how
many steps it completed, followed by error diagnostics, the steps, nested runs, and
logs. The run list stays in view while you scroll the details. Structured errors
name the failed steps; select one to jump to its timeline row or graph node. They
also show validation issue paths, expandable cause chains, failed fan-out items,
and any omitted failure count. Skipped steps explain why they did not run, naming
the failed gate or unavailable required input when the recording identifies it.
Retries appear beside the step's duration. Logs can be searched by message text and
filtered by level and step; the count shows how many entries match. These
diagnostics are limited to the selected run. Open a nested run to inspect its own
errors and logs. The definition identity that produced the run is folded under
**Definition** at the end of the details.

The selected run appears in the browser URL as `?run=<run-id>`. Selecting a run,
including a nested run, adds a browser history entry, so Back and Forward restore
earlier selections. The copy icon in run details has a **Copy run link** tooltip
and copies the selected run's URL. Links work only with the same Studio mount
and run store. If the run was deleted or belongs to another store, Studio shows
an unavailable-run message and keeps the requested ID visible so you can choose
another run.

Test-runtime recordings retain ordinary step statuses and annotate supplied
outputs as `completed (overridden)`, `failed (overridden)`, or `cancelled (overridden)`. The supplied values are not recorded. Studio launch forms
do not accept overrides; see [testing overrides](./concepts.md#supplying-step-outputs).
The Cache execution control overrides policy with `use`, `recompute`, or `bypass`
for opted-in steps, including children.
Cache hits retain ordinary statuses with a `(cached)` annotation, including
failed or cancelled cache validation. Keys and values are not recorded. See
[step output caching](./step-output-cache.md).
Nested steps show the child pipeline and its declared steps. Recorded progress
includes the most recent per-item details; when details are truncated, Studio
shows how many were omitted. Artifact steps show recorded reads, writes, verified reuse, and
explicit dry-run previews. Completed I/O records remain visible when a later batch
or step fails; their presence does not imply the whole run succeeded. Expand an artifact to see its identifier, location,
version, and application metadata. These records belong to the displayed run,
step, and execution attempt; see [artifact lineage](./artifacts.md).

When several steps in a run are active, the run list shows a count such as
“3 steps running” and the first three names, with a remaining count for larger groups.
A single active step keeps its progress message.

The **Graph** toggle beside the step timeline draws the selected run as a
top-to-bottom graph and stays selected while you move between runs. Each circle is
a step; arrows lead from a dependency to the step that consumes it. Running steps
spin, and steps that finish while you watch pulse once: green with a check when
completed, red with a cross when failed, and amber when cancelled. Skipped steps are
gray and planned steps have a dashed outline. Solid arrows are required inputs and
finer arrows are optional inputs. A dashed arrow is a candidate input whose consumer
has not started; it turns solid while the consumer runs and once it has used the
output. Dotted arrows are failure gates (`skipAfterFailureOf`) and turn red when
the gate trips.

Steps that start nested runs carry a count badge. A running step with nested runs
expands in place and stays open after it finishes; select the badge to expand or
collapse any step. Fan-out items,
iterations, agent turns, and agent tool calls appear inside the expansion, and tool
calls are labeled by tool. Nested runs can expand again to show their own steps, up
to six levels deep and sixteen items per step. The nested run list opens the rest
sixteen per step at a time.
Select a step, arrow, or nested run to inspect its inputs and outputs, progress,
attempt, artifacts, and nested runs, or to open a nested run. Recordings made before
dependencies were recorded show steps without arrows. Animations respect the
reduced-motion setting.

| Control       | What it does                                                                                                                                   | When available                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Preview plan  | Shows the selected steps and dry-run behavior without starting or recording a run                                                              | A pipeline command is registered                                                     |
| Run pipeline  | Validates the form values and starts the command                                                                                               | A command is registered locally or in gateway mode                                   |
| Cancel run    | Aborts the selected live run without stopping Studio or sibling runs                                                                           | This Studio process owns the top-level launch                                        |
| Clear history | Deletes all recorded SQLite events and attempts database compaction after confirmation; the action sits in the sidebar footer beside the store | Local SQLite mode with the maintenance capability enabled and no known active writer |

Preview uses the form's dry-run and step/target controls. It does not validate
business inputs; those are checked when you run the command. A preview is
optional. The preview identifies whether the selection runs all steps, exact
steps, or targets with recursively included required inputs and failure gates.
Each step lists why it was selected or omitted, its required and optional
inputs, its failure gates, and any planned skip. Optional inputs alone do not
bring a step into a target plan; exact step selection does not add prerequisites.
Runtime skip policies and failures can still change what executes.

Cancellation affects only a live launch owned by the current Studio
process; it cannot resume or cancel work from an earlier crashed process.
Studio renders `Resume` only when the command descriptor declares it through
managed `checkpoint` support or explicit application-owned `resume: true`
handling.

## Launch project pipelines

Pass a checked-in project file to expose its schema-backed pipelines in Studio:

```ts
// tubeless.project.ts
import { defineProject } from "tubeless/project";
import { ImportPipeline, PublishPipeline } from "./pipelines.js";

export default defineProject("data-jobs", [ImportPipeline, PublishPipeline]);
```

```sh
bunx tubeless ui --store .tubeless/runs.sqlite ./tubeless.project.ts
```

Studio derives the same form fields that the CLI derives as flags. No command
wrapper is needed. Automatic registration requires Standard JSON Schema input
metadata. Register explicit adapters in the project entry list for schema-less
pipelines or custom CLI inputs.

The project file's default export selects the project for Studio. Without a
default, exactly one distinct project must be exported; multiple projects are ambiguous. An invalid default is a load error.

## Register custom commands for browser execution

Provide command files explicitly:

```sh
bunx tubeless ui \
  --store .tubeless/runs.sqlite \
  --command ./scripts/import.ts \
  --command ./scripts/publish.ts
```

Each file may export a command created with `definePipelineCommand`, or one unique
schema-backed pipeline from which Studio can infer a command. An explicit command
wins when present. Use `--export` when registering one file with multiple matching
exports; schema-less or unsupported inputs require an explicit command adapter.
Studio does not infer executable files from recorded runs.

The command's parameter definitions determine the form controls: checkboxes
for booleans, selects for constrained strings, bounded numeric fields, and text
fields for paths and other values. Submitted values go through the command's
normal validation and option mapping. Studio does not construct a shell command.

Pipeline inputs come first. Execution controls (dry run, step and target
selection, cache, failure handling, and **Max Concurrency**) are folded beneath
them because their defaults run every step once; expand the section to change
them. Max Concurrency is a positive integer defaulting to `1` and has the same
behavior as the CLI's `--max-concurrency` flag.

## Custom adapters in a project

Use the same project for typed lookup, CLI, and Studio. Add explicit command
adapters when pipelines need custom parameters, option mapping, or display names:

```ts
// tubeless.project.ts
import { defineProject } from "tubeless/project";
import { ImportCommand } from "./scripts/import.ts";

export default defineProject("data-jobs", [ImportCommand]);
```

```sh
bunx tubeless list
bunx tubeless inspect import
bunx tubeless run import -- --source rows.txt
bunx tubeless ui --store .tubeless/runs.sqlite ./tubeless.project.ts
```

CLI and Studio use the pipeline's ID. Set `name` on `definePipelineCommand` for
a display label. The optional project `cwd` is relative to the project file and
defaults to its directory. Each command registers its underlying pipeline;
duplicate pipeline IDs fail regardless of entry form. See the
[complete project example](../examples/project/tubeless.project.ts).

## Storage behavior

SQLite stores an append-only stream of events. Studio builds run summaries,
step states, logs, and graphs from those events. Normal event updates and
deletes are blocked by database triggers. `clearHistory()` is a separate
maintenance operation that clears the complete history and restores the triggers
in one transaction. Compaction follows as best-effort maintenance. Once deletion
commits, clearing succeeds even if compaction fails, so Studio discards the deleted
history. A deletion failure rolls back and retains the history.

New SQLite stores use schema version 4. `tubeless run --store`, `tubeless ui`,
and `tubeless history --clear` refuse an older file instead of rewriting it.
Run `tubeless upgrade --yes --store <path>` first, before an unattended job
opens that file. The command requires `--yes` because the rewrite cannot be
undone; there is no interactive prompt. Versions 1 and 2 still store scalar
attributes in `attributes_json`. The upgrade copies each event into the current
payload column, keeps its id and the saved autoincrement counter, and rewrites
a retired `PIPES_` error code to the `TUBELESS_` prefix. Version 3 adds the
iteration column. The upgrade commits once, so a failure leaves the previous
schema and its append-only triggers in place. Read-only opens of versions 1
through 3 decode those rows without writing. Any other schema version is
refused. The next schema version needs a new step in
`src/run-store/run-store-migrate.ts` in the same change as
`RUN_EVENT_STORE_VERSION`. Creating or upgrading a store fails until that step
exists.

The SQLite writer buffers events in batches of 64. `export()` can return before
an event reaches disk. Pending events become visible to other connections after
a batch fills, `flush()` runs, the writer calls its own `listEvents` or
`clearHistory`, or the store closes. A crash can lose up to 63 unflushed events.
`tubeless run --store` flushes at completion.

Read-only history and Studio inspect committed events. They refuse databases
with a pending SQLite write-ahead log (`-wal`) or rollback journal (`-journal`),
and files with multiple hard links. A single buffered `export()` does not
create those sidecar files. Finish or close the writer before opening a database
that cannot be read safely.

The local CLI disables clearing while it knows a browser-launched run is active.
Runs left active in history after a process interruption can be cleared after
confirmation. Gateway mode always disables clearing, including on loopback.

NDJSON readers validate a finished file, assign event IDs in file order, and
close the file. They do not modify the artifact or copy it into SQLite. The
[CLI guide](./cli.md#history) lists file-size, event-size, and event-count limits.
New trace files contain version 3 events with unique execution IDs and separate
reusable correlation IDs. Readers also accept version 2 recordings. Repeated
children retain an `iteration` relation with the owning run, wrapper step and
attempt, and one-based index. Live progress retains up to 32 iteration groups;
the child-run history retains every recorded iteration. Children started by
`fromPipeline`, `forEachPipeline`, or an agent pipeline tool record the parent
step in `pipeline.started` `payload.parentStepId`, so Studio places them under
the right step even when sibling steps share one child pipeline and one
millisecond. Older recordings fall back to matching step execution windows.

## Definition history and comparison

Every compiled pipeline exposes `pipeline.definition`: an immutable snapshot
with a structural fingerprint and a combined definition ID. Both use SHA-256.
Ordinary definitions retain identity version 1 and their existing hashes.
Iteration definitions and their ancestors use identity version 2. Stable pipeline
and step IDs remain the human-facing identity.

Set `implementationVersion` on `definePipeline` to identify handlers, schemas,
mappings, predicates, and the finalizer. Supply a release tag, source revision,
or a digest generated by your build tooling; Tubeless does not inspect function
source or infer code identity. See [the tracing example](../examples/tracing.ts).
An omitted implementation version means **unknown**, even when fingerprints match.

The structural fingerprint includes compiled execution order, step IDs, required
and optional edges, failure gates, targets, dry-run and skip policies, schema
presence, cache opt-in/age/policy, required finalizer steps, child composition and concurrency, and remote
engine/target metadata. Dependency, target, and required-finalizer sets are sorted. Names, descriptions,
progress presentation, inputs, per-run controls, and handler code are excluded.
Iteration bounds and declared static child controls are included in identity
version 2; selector sets are sorted.
Changing the implementation version changes the combined definition ID without
changing the structural fingerprint. Effective step cache versions likewise bind
the combined definition ID, including versions inherited from the pipeline. Child structural identities propagate into
the parent's fingerprint; child implementation identities propagate only into its
combined ID. The combined ID binds every recorded child identity field, including
its implementation version; changing that metadata while keeping the child's ID
unchanged invalidates the parent snapshot. Child internals still require the child's
own snapshot to inspect. Dynamic policies are represented by their presence, not their code
or runtime return values. Remote handler versions belong in the application-supplied
implementation version. External pipeline implementations without definition metadata
contribute only their declared child IDs and composition metadata.

Studio's **Definitions** view, in the sidebar once a run records its definition,
groups recordings by pipeline ID and definition ID. Select a definition to see its runs. **Compare from** shows
changes from another observed version of the same pipeline to the selected version:
added/removed steps, execution order, edges, targets, policies, validation boundaries,
child/remote metadata, and implementation versions. Child steps stay opaque wrappers;
compare the child's own recorded definitions for its internal graph changes.
Run details show the identity that actually produced that run.

The `pipeline.started` payload includes optional `definitionIdentity` and
`definitionSnapshot` fields. The identity is retained even when selection or input
validation fails before step events. A snapshot is limited to 256 KiB of UTF-8 JSON,
4,096 steps or entries per list, 4,096 code units per identifier, and the existing
remote metadata limits. Implementation versions are nonblank strings of at most
256 code units. Snapshots exceeding these limits are omitted in full; their identity
still fingerprints the complete graph. Studio declines comparisons when either
snapshot is unavailable. These limits affect recording, not pipeline execution.

Existing version 2 recordings remain readable. Runs without these optional fields
are labeled legacy, with no invented identity. Their latest planned-step graph is
still retained per pipeline using the start timestamp and store-local event ID.
Trace version 3 admits iteration metadata and both identity versions. Version 2
recordings remain restricted to their original metadata and identity version 1.
The definition identity's own version fixes fingerprint semantics. Unsupported
trace or identity versions are rejected. Older readers and external strict schema
validators must update before consuming new version 3 recordings.

NDJSON and SQLite readers recompute both hashes from each complete definition
snapshot and reject mismatches before projecting history. SQLite also checks writes.
Hash checks establish consistency with the recorded snapshot, not authenticity of
handler code or the recording's source. Identity-only records cannot be checked
without their omitted snapshots.

Definitions are projected from the same append-only events as runs, without loading
application modules. They remain available for as long as their run events remain;
there is no separate orphan-definition retention period. Clear history removes both
runs and observed definitions. Nested metadata retains `stepCount`, and truncated
progress retains its original `detailCount`.

## Network access

Studio binds to `127.0.0.1` by default. Without gateway mode, browser execution
requires `127.0.0.1`, `::1`, or `localhost`. A non-loopback `--host` without
commands is read-only; anyone who can reach that port can read its history.
Logs, errors, and event payloads are displayed without redaction.

Studio's server and JSON payloads remain internal, version-coupled workbench
details. Use the CLI hosting contract below, rather than importing server
internals or building a client against its routes.

## Host Studio behind an application gateway

Use one long-lived Studio process behind your application's authenticated admin
route. Tubeless owns the mount, gateway authentication, recorded history, and
registered command execution. Your application owns login, sessions, admin
permission checks, TLS, private networking, and which commands are registered.
Every admitted user can access the entire store and command catalog. This is one
admin trust domain, with no per-user isolation or user audit trail.
To host Studio on Cloudflare without running your own gateway, see
[Deploy to Cloudflare](./deploy-cloudflare.md).

Provision `TUBELESS_STUDIO_GATEWAY_TOKEN` through your host's secret management:
32 cryptographically random bytes encoded as 64 hexadecimal characters. Share it
only with the application gateway and Studio process. Never pass it in argv,
browser code, URLs, logs, or cookies. Studio reads the token once at startup and
removes it from its environment, so launched commands and their child processes
do not inherit it. Then start Studio:

```sh
tubeless ui --host 0.0.0.0 --port 4317 \
  --public-url https://script.bible/admin/pipelines \
  --store /data/tubeless/runs.sqlite ./pipes.studio.ts
```

`--public-url` enables gateway mode; the environment variable alone is an error.
Missing or malformed configuration fails before user modules load or stores open.
The URL must be absolute HTTPS. HTTP is allowed only for literal loopback
`127.0.0.1`, `[::1]`, or `localhost` development URLs. Paths contain unreserved
ASCII segments, without dot segments, encoded characters, or empty internal
segments. Credentials, query strings, fragments, and backslashes are rejected.
An optional trailing slash normalizes to the canonical page URL. Root mounts work.

The gateway **preserves the complete mount prefix**: `/admin/pipelines/` serves the
page, and `/admin/pipelines/api/...` serves browser requests. There is no
prefix-stripping mode. Only GET/HEAD navigation to the mount without its trailing
slash redirects; it preserves `?run=...`. Run links, reload, and Back/Forward retain
the mount. Link to the complete Studio page from your admin navigation;
`frame-ancestors 'none'` intentionally prevents iframe embedding.

### Gateway request contract

For every page and API request, before contacting Studio:

1. Verify the application session and pipeline-admin permission in the request
   handler. Protecting an admin page or layout alone is insufficient.
2. Forward only to a fixed configured private upstream, never a browser-selected
   URL. Replace incoming `Authorization` with `Bearer <backend-token>`; never
   forward browser credentials or cookies to Studio.
3. Set `Host` explicitly to the configured public authority, including a
   nondefault port. For a private upstream such as `http://studio.private:4317`,
   the TCP destination stays private while `Host` is `script.bible`. Studio
   accepts that authority plus its existing bind-derived host policy. Forwarded
   host, identity, and protocol headers cannot grant access.
4. For POST/DELETE, independently verify the original browser `Origin` equals
   the configured public origin, and preserve it when forwarding. Do not
   manufacture an allowed Origin for an untrusted request. Missing, null,
   malformed, duplicate, or foreign Origin is rejected by Studio. Preserve the
   UI's JSON content type and `x-tubeless-studio-*` guards. There is no cross-origin
   CORS mode. GET/HEAD navigation may omit Origin.
5. Preserve response status, content type, CSP, and `Cache-Control: no-store`.
   Exclude the entire mount from service-worker/PWA and shared-cache handling.
   Do not retry launches or other mutations: an uncertain response may already
   have produced side effects, and there is no idempotency/replay contract.

Studio checks the backend credential on **all** routes, including pages, redirects,
unknown paths, and readiness, before body parsing, store reads, or command effects.
It uses a fixed-length timing-safe token comparison and rejects duplicate or
malformed credentials. Host/Origin checks supplement authentication.

Only the gateway should be publicly routed. In the same container, bind Studio to
loopback. A separate private service may bind `0.0.0.0` with a private network rule
allowing the gateway. Use appropriate authenticated/encrypted transport across
that network; a bearer token does not encrypt HTTP. There is no disable-host-check
option and private networking does not remove the token requirement.

### Access expiry and failures

The application gateway may redirect page navigation to its login flow. API
requests must return JSON **401** when login is needed or **403** when permission
is denied, never a 200 login HTML page. Studio clears displayed data and forms,
suspends polling and retries, and disables actions after either status from any
API call. **Open Studio again** performs a full navigation through the same gateway
URL; your application handles login and return navigation. A full page reload
starts a new access attempt.

A backend credential denial is an integration failure: the gateway should map it
to a generic **502**, rather than logging the user out. Network errors and 5xx
responses show a connection/error state. They do not grant access or automatically
retry a mutation.

### Process, persistence, and readiness

Use a persistent volume for the SQLite store and one active Studio writer process
per store. The application owns supervision, backups, resource limits, and rollout
coordination. NDJSON remains read-only in gateway mode. Clear history is always
disabled in gateway mode, even with a loopback bind.

Authenticated `GET <mount>/api/health` returns `200 {"ready":true}` after startup.
Readiness turns false synchronously at the start of server close: requests still
served during shutdown return `503 {"ready":false}`; a closed connection is also
expected once the listener closes. The response exposes no store path or history.
An exec probe must supply the backend credential, or the application can own a
minimal health facade. There is no unauthenticated Studio health bypass.

Launch acknowledgement follows persistence of the start event. It is not a durable
job queue or a promise of completion after a crash. Browser disconnect does not
cancel the run. Cancellation is cooperative and process-local; a restarted process
can inspect older runs but cannot cancel or resume their previous execution.

On shutdown, the CLI stops admission, settles pending launch responses, aborts
active launches, closes the listener, drains executions, then flushes/closes storage.
Handlers should observe the cancellation signal and finish cleanup. An
uncooperative handler can prevent draining; the external supervisor owns the grace
period and eventual forced termination. Forced termination can lose buffered events
and leave incomplete history. Horizontal execution, shared multiwriter SQLite,
scheduling, crash recovery, and per-user stores are outside this hosting contract.

### Application handoff

For Bible Search or another host application: upgrade to a tested Tubeless release
containing this contract, implement session and admin permission checks in every
forwarding handler, configure a fixed upstream and backend token, and register an
explicit deployment-specific pipeline catalog. Provision persistent storage and a
supervised process; coordinate sleeping/restarts with ongoing work. The local
catalog may contain seeding or filesystem commands unsuitable for deployment.
Keep framework, authentication-provider, and hosting-vendor configuration in the
application. The repository proxy integration tests exercise the contract; they do
not prove a consuming application's gateway is configured correctly.

See [SECURITY.md](https://github.com/chetmancini/tubeless/blob/main/SECURITY.md).
Studio previews and observed definitions also expose [graph metadata](./graph-metadata.md).
Expand **Explore steps** to search metadata and group by owner or domain.
