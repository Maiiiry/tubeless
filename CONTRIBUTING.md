# Contributing

Pull requests are accepted for now. Tubeless will stay a small-maintainer
project: a merged PR does not come with commit access, and I am not looking
for a large set of regular contributors.

If a change is large or touches the public API, open an issue first.

## Prerequisites

- Bun 1.3.14 or later
- Node.js 22.6 or later
- GNU Make

## Working on the package

```sh
make install
make check
```

`make check` is the same gate CI runs. It bootstraps the package, then uses the
[`scripts/check-pipeline.ts`](./scripts/check-pipeline.ts) command to run the
remaining checks as a concurrent Tubeless pipeline and record `logs/check.ndjson`.
`make help` lists the rest. `make install` runs `bun ci`.

### Fast loops

`make lint` never rebuilds; linting is syntactic. Tests and type checks resolve
`tubeless` from `dist/`, so they need a build after source changes — `make test`
and `make typecheck` run one for you. With `dist/` current, `make test-run` runs
only the vitest suite and `make typecheck-run` only the type checks.

`make watch` builds once, then recompiles `src/` on change, regenerates the
Studio client when a bundled source changes, and re-runs the vitest suite; stop
it with Ctrl-C. `tsc` still does not emit the browser bundle. The watch loop
runs `scripts/generate-studio-client.mjs`. `make studio-check` fails when the
served bundle does not match the sources.

Before changing usage or public behavior, read
[`docs/agent-guide.md`](./docs/agent-guide.md) and the repository-local
[`tubeless` skill](./skills/tubeless/SKILL.md). Do not edit
`docs/api-reference.md` or `docs/api-report.json` by hand; after an intentional
public-surface change, run `bun run api:generate`. Keep examples on public
package imports. Pull requests that change the report get a job summary of
added and removed entrypoints and symbols; `api:check` only proves the report
was regenerated.

### Website

The public site lives in [`website/`](./website/) and is not part of the npm
package. Local development:

```sh
cd website && bun ci && bun run dev
```

See [`website/README.md`](./website/README.md). `make check` does not build the
site; use `make website` or `make website-build` for that.

## Support

- Bug reports and documentation fixes: open a GitHub issue.
- Large or public-API changes: open an issue first.
- Vulnerabilities: report privately via [`SECURITY.md`](./SECURITY.md).
- No SLA; this is a small-maintainer project.

## Security

Report vulnerabilities privately. See [`SECURITY.md`](./SECURITY.md).

## License

Contributions are accepted under the MIT License in [`LICENSE`](./LICENSE).
