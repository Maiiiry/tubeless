# Release checklist

Merging to `main` does not publish. Cut a release with `make release`. CI
publishes the matching `v*` tag to npm via trusted publishing
(`.github/workflows/publish.yml`, GitHub Environment `npm`). Do not
`npm publish` from a laptop. Do not store
an `NPM_TOKEN`. Keep `"private": true` in git; the publish job deletes that
field immediately before `npm publish`.

## Public names

These names are the pre-1.0 contract. Treat a change as breaking.

| Kind               | Stable name                                                                                                                                                                                                                                                                                                          | Notes                                                                                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package and binary | `tubeless`                                                                                                                                                                                                                                                                                                           | Bin path `./dist/workbench/workbench-bin.js` is an implementation detail.                                                                                                             |
| Export paths       | `tubeless`, `tubeless/agent`, `tubeless/agent/openai`, `tubeless/agent/anthropic`, `tubeless/agent/node`, `tubeless/cli`, `tubeless/batch`, `tubeless/node`, `tubeless/rate-limit`, `tubeless/retry`, `tubeless/testing`, `tubeless/tracing`, `tubeless/project`, `tubeless/cloudflare`, `tubeless/cloudflare/cache` | Provider and Node checkpoint adapters are optional. `tubeless/cloudflare` loads only in workerd. `tubeless/cloudflare/cache` loads in Node. Studio and trace storage remain internal. |
| Error codes        | `TUBELESS_*` on `PipelineErrorCode`                                                                                                                                                                                                                                                                                  | Prefix and current spellings stay.                                                                                                                                                    |
| CLI exit behavior  | Codes `0`–`7`                                                                                                                                                                                                                                                                                                        | Success, usage, load, definition, validation, planning, execution, cancellation.                                                                                                      |
| Storage            | `.tubeless/runs.sqlite`                                                                                                                                                                                                                                                                                              | Default Studio/CLI store path.                                                                                                                                                        |
| Runtime symbols    | `Symbol.for("tubeless/pipeline-command")`                                                                                                                                                                                                                                                                            | Cross-instance marker. Consumers should not set it.                                                                                                                                   |
| Other constants    | `RUN_MODEL_VERSION` (`2`)                                                                                                                                                                                                                                                                                            | Stored-run version.                                                                                                                                                                   |

Version 2 and 3 trace events and NDJSON recordings remain a durable compatibility
boundary. Agent iteration records use version 3. Removing the concrete JSON and
OpenTelemetry exporter entrypoints does not remove support for existing saved recordings.

`TUBELESS_VERSION`, `TUBELESS_LIMIT`, `TUBELESS_NAMES`, and
`TUBELESS_CORE_PUBLIC_API_SMOKE_ENV` appear only in tests. They are not package
environment variables.

## Studio

The studio is a local process, not an authenticated network service.
`tubeless ui` defaults to `127.0.0.1`. See [SECURITY.md](./SECURITY.md) and
[docs/studio.md](./docs/studio.md).

## In-process agent acceptance

Run these gates on the release candidate before cutting a tag. Acceptance does
not publish the package. This release covers in-process execution with optional
durable checkpoints and execution environments. Richer Studio agent presentation
remains a follow-up.

```sh
make check
make website-build
```

`make check` includes the existing tests, declaration/type checks, generated API
check and packed-consumer verification. All are credential-free; mocked provider
responses exercise the HTTP protocol and evaluation runner without paid calls.

| Required behavior                                                                       | Repeatable evidence in the ordinary check suite                                               |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Dynamic tool batches, expected failure recovery, owned state, validated finish          | `src/agent/agent.test.ts`, `src/testing/agent.example.test.ts`                                |
| Subagents, shared budgets, depth and concurrency, cancellation and draining             | `src/agent/subagents.test.ts`, `src/agent/pipeline-tool.test.ts`                              |
| Limits, invalid model decisions, dry-run previews and skipped live work                 | `src/agent/agent.test.ts`, `src/agent/model-agent.test.ts`                                    |
| Prompt/project context, conversation ownership and compaction protocol                  | `src/agent/model-prompt.test.ts`, `src/agent/model-agent.test.ts`, `src/agent/openai.test.ts` |
| Normal CLI execution, ordinary parent pipeline, SQLite/NDJSON turn/call history         | `src/workbench/agent/history.test.ts`                                                         |
| Installed public imports and CLI, agent composition and previews                        | `scripts/verify-packed-artifact.mjs`                                                          |
| Restarted decisions, validated call receipts, ordered outcomes and ancestor budgets     | `src/agent/durability.test.ts`                                                                |
| Actual process death, SQLite owner reclaim and uncertain mutation recovery              | `src/agent/durability-process.test.ts`                                                        |
| Exclusive store leases, acknowledged writes, reopen and lossless serialization          | `src/agent/checkpoint-store.test.ts`, `src/agent/checkpoint-codec.test.ts`                    |
| Remote guidance/tools, no local cwd dependency, inherited authority and bounded results | `src/agent/environment.test.ts`                                                               |

Inspect a recording manually with the credential-free composition recipe:

```sh
bun run tubeless -- run --trace .context/agent-release.ndjson examples/agent-pipeline.ts -- --question "red missing"
bun run tubeless -- history --trace .context/agent-release.ndjson
# Copy the agent-pipeline run ID from the list, then inspect it:
bun run tubeless -- history --trace .context/agent-release.ndjson <run-id>
```

The result must be `Summary: 3 characters; RED | 7 characters; Observed NOT_FOUND: Word unavailable`.
History must show three agents, the recovered `NOT_FOUND` call, state advancement
and validated finish. The same recipe with `--dry-run` must return the same answer.

With an authorized OpenAI credential, run the opt-in paid acceptance separately:

```sh
bun run eval:agent
bun run eval:agent -- --codemode
```

The evaluator reads `OPENAI_API_KEY` from the process environment. To use an
ignored local credential file without putting it in a command argument, run
`bun run build` followed by
`env -u OPENAI_API_KEY node --env-file=.env.local scripts/eval-agent.mjs .context/agent-release-live-eval.json`.
The `env -u` prevents a stale inherited key from overriding the workspace file.
Do not add this command or live credentials to CI.

Require all four tasks to pass: investigation/edit/check, startup project
instructions, nested guidance read in a separate turn before the requested file
read, and the requested missing-file read followed by recovery through
conversation compaction.
The startup-instructions task must receive root and cwd guidance in its first
model request. It may access only `greet.mjs` and run `node ../check.mjs`, which
must pass on every attempt. Rereading guidance or tests, searching for their
contents, and learning the required greeting from failed checks do not count.
The nested-guidance task must follow the scoped answer convention, preserve all
fixture files, and call only `read`, `list`, or `search`.
Both reads must return the expected contents in successful outcomes matched to
their call IDs in the following turn; empty or failed reads do not count.
The evaluator rejects mutating capabilities even if the agent restores the original contents.
The first recovery batch must contain
only that read;
recovery must be chosen in the next decision that receives its failure outcome.
That batch must read the current configuration or expose its location through a
read, listing, search, or shell result. Successful recovery in a later batch
does not satisfy this check.
Preserve the JSON report (model, reasoning effort, timestamp, captured source hashes, calls, outcomes,
decision batches with
their incoming outcomes, answer and independent checks) with the candidate's acceptance evidence,
including failed attempts. These small tasks establish observed behavior, not a
general reliability guarantee. A failed task is an acceptance finding even when
the final edited file is correct.

## Remaining public work

- [x] Explain why the project is called Tubeless, what problem it solves,
      its maturity, and how it compares with task runners and workflow
      engines (plan 002).
- [x] Make the README/CLI/getting-started on-ramp work from a clone and a
      fresh app (plan 003).
- [x] Make examples copy-paste teachers, not compile probes (plan 004).
- [x] Add issue templates and CONTRIBUTING prerequisites (plan 004).
- [x] Add API compatibility review so `docs/api-report.json` diffs are
      explicit on pull requests.
- [x] Add dependency and workflow maintenance (Dependabot or Renovate) for
      SHA-pinned Actions and pinned devDependencies.
- [x] Add npm provenance and runtime badges now that CI and npm exist.
