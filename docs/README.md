# Tubeless documentation

Tubeless provides typed execution pipelines for data processing, application
workflows, and AI workloads. Start with a small pipeline, then choose the
controls and integrations your work needs. The guides link to examples you can
adapt in your project.

## Start here

| Document                                                                | Use it for                                            |
| ----------------------------------------------------------------------- | ----------------------------------------------------- |
| [Website](https://tubeless.io/)                                         | Guides for developers and coding agents               |
| [Package README](../README.md)                                          | What it is, a first example, then the recipe index    |
| [Getting started](./getting-started.md)                                 | Building, running, and testing a first pipeline       |
| [Recipe index](./recipes.md)                                            | Finding a working example for your task               |
| [Project](../examples/tubeless.project.ts)                              | Exposing pipelines directly to the CLI and Studio     |
| [Project with custom adapters](../examples/project/tubeless.project.ts) | Registering advanced custom command adapters          |
| [Core concepts](./concepts.md)                                          | Dependencies, skips, failures, dry runs, and contexts |
| [Agent guide](./agent-guide.md)                                         | Rules for generating and modifying pipeline code      |
| [Comparison](./comparison.md)                                           | How Tubeless fits next to other job runners           |

## How to

Install the [agent skill pack](./agent-skills.md) to author pipelines or convert existing code.

| Document                                              | Use it for                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| [CLI](./cli.md)                                       | `list`, `inspect`, `plan`, `graph`, `run`, `history`, and exit codes  |
| [Studio](./studio.md)                                 | Run history, project commands, and authenticated gateway hosting      |
| [Artifacts](./artifacts.md)                           | Typed loaders, savers, metadata, and recorded lineage                 |
| [YAML and JSON pipelines](./declarative-pipelines.md) | Compile documents with registered handlers, skips, and child adapters |

## Deeper reference

For agent or editor validation, use the [pipeline document JSON Schema](./pipeline-document.schema.json).

| Document                                                      | Use it for                                                                             |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [In-process agents](./agents.md)                              | Model defaults, dynamic tools, subagents, pipeline composition, and recorded history   |
| [Child-pipeline composition](./child-pipeline-composition.md) | Running a reusable pipeline once or for many items                                     |
| [Remote-step composition](./remote-step-composition.md)       | Calling remote services and running inside workers                                     |
| [Tubeless ↔ Airflow](./airflow.md)                            | Calling an Airflow DAG or running a pipeline inside an Airflow task                    |
| [Tubeless on Temporal](./temporal.md)                         | Hosting pipelines in Activities with retries, heartbeats, and cancellation             |
| [Tubeless on Inngest](./inngest.md)                           | Hosting pipelines in durable steps with retries, memoized results, and correlated logs |
| [Tubeless on Dagster](./dagster.md)                           | Materializing assets with Pipes, progress logs, data versions, and traces              |
| [Tubeless on AWS Step Functions](./step-functions.md)         | Hosting pipelines in Lambda Tasks with retries, deadlines, and correlated logs         |
| [Deploy to Cloudflare](./deploy-cloudflare.md)                | Hosting Studio and pipelines in your account behind Access, with run limits            |
| [Generated API inventory](./api-reference.md)                 | Entrypoints, exported symbols, and surface hashes                                      |
| [Machine-readable API report](./api-report.json)              | Automated public-surface review                                                        |
| [LLM index](./llms.txt)                                       | Documentation links for coding agents                                                  |

Use the recipe index to choose an implementation pattern. Use the generated
API inventory to check exported names and signatures.
