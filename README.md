<p align="center">
  <a href="https://tubeless.io/">
    <img src="docs/assets/logo.svg" width="72" height="72" alt="Tubeless">
  </a>
</p>
<h1 align="center">Tubeless</h1>
<p align="center">
  Typed execution pipelines. Keep your workflow rolling.
</p>
<p align="center">
  <a href="https://www.npmjs.com/package/tubeless"><img alt="npm" src="https://img.shields.io/npm/v/tubeless?style=flat-square&labelColor=121212&color=c4a046"></a>
  <a href="https://github.com/chetmancini/tubeless/actions/workflows/check.yml"><img alt="check" src="https://img.shields.io/github/actions/workflow/status/chetmancini/tubeless/check.yml?style=flat-square&label=check&labelColor=121212&color=2f6f4a"></a>
  <a href="./LICENSE"><img alt="MIT" src="https://img.shields.io/npm/l/tubeless?style=flat-square&labelColor=121212&color=c4c0b4"></a>
  <a href="./docs/getting-started.md#install"><img alt="Node" src="https://img.shields.io/node/v/tubeless?style=flat-square&labelColor=121212&color=c4c0b4"></a> <a href="https://www.npmjs.com/package/tubeless"><img alt="provenance" src="https://img.shields.io/badge/provenance-npm-2f6f4a?style=flat-square&labelColor=121212"></a>
</p>

Tubeless is a TypeScript toolkit for work that unfolds in steps. It fits data
pipelines, multi-step application workflows, and AI workloads—anywhere you want
explicit dependencies, typed handoffs, and inspectable execution. The name is the
cycling kind of tubeless: no inner tube, and no extra runtime to keep the work rolling.

Pipelines run in your process with no runtime dependencies. You can preview
execution, select a target and its dependencies, compose child pipelines, and
track progress. The optional CLI and [Studio](./docs/studio.md) run locally or behind your authenticated admin gateway.
For scheduling or crash recovery, pair it with a [queue or workflow engine](./docs/comparison.md).

## Installation

```sh
npm install tubeless
```

The ESM library requires Node.js 22.6+. The CLI requires Bun 1.3.14+. Linux and macOS are supported; Windows is untested.
See [installation and runtime support](./docs/getting-started.md#install).

Tubeless is pre-1.0, so the public API may change between releases.

## Quick start

This pipeline loads and normalizes strings. `step` creates a step; dependencies give typed inputs.

```ts
import { createSteps, definePipeline } from "tubeless";

interface ImportOptions {
  lines: readonly string[];
}

const { step } = createSteps<ImportOptions>();

const load = step("load", {
  run: (_inputs, context) => context.options.lines,
});

const normalize = step("normalize", {
  dependsOn: [load],
  run: ({ load: rows }) => rows.map((row) => row.trim().toLowerCase()).filter(Boolean),
});

export const ImportPipeline = definePipeline({
  id: "import",
  steps: [load, normalize],
});

const rows = await ImportPipeline.runOrThrow({ lines: [" Alpha ", "", "Beta"] });
// ["alpha", "beta"]
```

Omitted `targets` and `finalize` use the last step in execution order: `normalize`.
Missing output returns `undefined`; use `requireOutputs` when absence should fail.

`runOrThrow` returns the result or throws on failure. Use `run` for reports, `plan`
for previews, and `toMermaid` for diagrams. See [getting started](./docs/getting-started.md).

## Use the CLI

Projects made with `defineProject(id, [pipeline, command])` register each pipeline once and are directly usable by the CLI;
schema-backed pipelines get inferred flags automatically. See the [CLI guide](./docs/cli.md)
for direct project usage and advanced custom command adapters. From this repository:

```sh
bunx tubeless list --project examples/tubeless.project.ts
bunx tubeless inspect --project examples/tubeless.project.ts validated-import
bunx tubeless run --project examples/tubeless.project.ts validated-import -- --source rows.txt
```

In your app, add `tubeless.project.ts` and omit `--project`. Pass application
flags after `--`. Record runs with `--store` or `--trace`, then inspect them with
`tubeless history` or the [local studio](./docs/studio.md).

Use `tubeless auth login` and `tubeless cloud list` to select a Cloud pipeline by name or slug; see [Cloud CLI usage](./docs/cli.md#tubeless-cloud).
To host Studio in your own Cloudflare account, see [Deploy to Cloudflare](./docs/deploy-cloudflare.md).

## Find your route

- Start with a [typed import](./examples/typed-import.ts) or add
  [dry runs and write gates](./examples/publish-with-gates.ts) to a publishing job.
- Build workflows with [child pipelines](./examples/child-pipeline.ts) and [fan-out](./examples/fan-out-progress.ts).
- Run `tubeless agent --model gpt-5.4-mini` for a [conversation loop with live pipeline reporting](./docs/cli.md#prompt-a-workspace-agent), or build [agents](./docs/agents.md) with custom tools, subagents, and durable checkpoints.
- Optional: the [peloton example](./examples/peloton.ts) is a cycling-themed kitchen sink for the live TUI.

The [recipe index](./docs/recipes.md) covers validation, retries, tracing, testing,
and more. For help authoring pipelines with a coding agent, install the
[agent skill pack](./docs/agent-skills.md) with `npx skills add chetmancini/tubeless`.

## Documentation

[Website](https://tubeless.io/) · [Getting started](./docs/getting-started.md) · [CLI](./docs/cli.md) ·
[Studio](./docs/studio.md) · [Concepts](./docs/concepts.md) ·
[Comparison](./docs/comparison.md) · [API](./docs/api-reference.md) ·
[Agent authoring guide](./docs/agent-guide.md)

## Contributing

Open an [issue](https://github.com/chetmancini/tubeless/issues) before a large change or public API change.
See [CONTRIBUTING.md](./CONTRIBUTING.md) for checks and [SECURITY.md](./SECURITY.md) to report vulnerabilities.

## License

[MIT](./LICENSE)
