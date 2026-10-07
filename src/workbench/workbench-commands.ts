import { querySteps } from "../core/pipeline.js";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type {
  PipelineMetadata,
  PipelinePlan,
  PipelinePlanStep,
  PipelineRunControls,
} from "../core/pipeline.js";
import {
  PIPELINE_MERMAID_DIRECTIONS,
  type PipelineMermaidDirection,
} from "../core/pipeline-types.js";
import { PipelineDocumentError, validatePipelineDocument } from "../project/project-document.js";
import { renderPipelineError, renderPipelinePlan } from "../render/render.js";
import { isWorkbenchPipelineCommand, type WorkbenchPipeline } from "./pipeline-module.js";
import { terminalSafeText } from "./workbench-agent-history.js";
import {
  DEFAULT_PIPELINE_PROJECT_FILE,
  loadPipelineProjectFile,
  resolveWorkbenchRegistration,
} from "./workbench-project-loader.js";
import {
  errorMessage,
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";
import {
  parseSubcommandArgs,
  REGISTRATION_OPTIONS,
  runWorkbenchSubcommand,
  STEP_METADATA_FILTER_OPTIONS,
} from "./workbench-subcommand.js";

const PIPELINE_FILE_POSITIONAL = {
  count: 1,
  message: "Pass exactly one pipeline or command file.",
} as const;

async function loadParsedPlanSource(
  parsed: {
    positionals: readonly string[];
    values: { export?: string; project?: string };
  },
  io: WorkbenchCliIo,
  usage: string
) {
  const registration = await resolveWorkbenchRegistration(
    parsed.positionals[0]!,
    parsed.values.export,
    parsed.values.project,
    io,
    usage
  );
  if ("exitCode" in registration) return registration;
  return registration.loadPlan(io);
}

/** One terminal-safe line: control characters removed and whitespace collapsed. */
function inlineText(value: string): string {
  return terminalSafeText(value).replace(/\s+/g, " ").trim();
}

function optionalInlineText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = inlineText(value);
  return text === "" ? undefined : text;
}

/** Display name (only when it differs from the id) and description of a pipeline or command. */
function pipelineIdentityText(view: WorkbenchPipeline): { name?: string; description?: string } {
  const source = isWorkbenchPipelineCommand(view) ? view.descriptor : view;
  const name = "name" in source ? optionalInlineText(source.name) : undefined;
  const description = "description" in source ? optionalInlineText(source.description) : undefined;
  return {
    ...(name !== undefined && name !== inlineText(view.id) ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

/** `Name - description`, either part alone, or undefined when neither is present. */
function joinNameAndDescription(name?: string, description?: string): string | undefined {
  if (name !== undefined && description !== undefined) return `${name} - ${description}`;
  return name ?? description;
}

/** Rows of `<key>  <summary>` with summaries aligned and no trailing spaces. */
function alignedRows(
  rows: readonly { key: string; summary: string | undefined }[],
  indent = ""
): string[] {
  const width = Math.max(0, ...rows.map(({ key }) => key.length));
  return rows.map(({ key, summary }) =>
    summary === undefined ? `${indent}${key}` : `${indent}${key.padEnd(width)}  ${summary}`
  );
}

const LIST_USAGE = `Usage: tubeless list [options]

List the pipelines and commands registered in a Tubeless project file, one per line
with its display name and description.

Options:
  -p, --project <path>  Project file (default: ./tubeless.project.ts)
      --json            Emit the project inventory as JSON
  -h, --help            Show this help
`;

function parseListArgs(argv: readonly string[]) {
  return parseSubcommandArgs(argv, {
    json: { type: "boolean" },
    project: { type: "string", short: "p" },
  });
}

export async function runList(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      usage: LIST_USAGE,
      parse: parseListArgs,
      positionalCountError: { count: 0, message: "List does not accept a positional argument." },
      async run(parsed, commandIo) {
        const loaded = await loadPipelineProjectFile(
          parsed.values.project ?? DEFAULT_PIPELINE_PROJECT_FILE,
          commandIo
        );
        if ("exitCode" in loaded) return loaded.exitCode;

        if (parsed.values.json) {
          commandIo.stdout.write(`${JSON.stringify(loaded.inventory, null, 2)}\n`);
          return TUBELESS_WORKBENCH_EXIT_CODE.success;
        }

        const rows: { key: string; summary: string | undefined }[] = [];
        for (const registration of loaded.registrations) {
          const plan = await registration.loadPlan(commandIo);
          if ("exitCode" in plan) return plan.exitCode;
          const { name, description } = pipelineIdentityText(plan.view);
          rows.push({
            key: inlineText(plan.view.id),
            summary: joinNameAndDescription(name, description),
          });
        }
        if (rows.length > 0) commandIo.stdout.write(`${alignedRows(rows).join("\n")}\n`);
        return TUBELESS_WORKBENCH_EXIT_CODE.success;
      },
    },
    argv,
    io
  );
}

const VALIDATE_USAGE = `Usage: tubeless validate [--json] <document.yaml|document.yml|document.json>

Check pipeline document structure and metadata without importing handlers.
Does not check graph semantics, registered names, or domain values. Use inspect
or plan on the compiled command module for engine validation.
YAML uses Bun's parser; duplicate mapping keys may be overwritten during parsing.

Options:
      --json   Emit a structured validation result
  -h, --help   Show this help
`;

function parseValidateArgs(argv: readonly string[]) {
  return parseSubcommandArgs(argv, {
    json: { type: "boolean" },
  });
}

export async function runValidate(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      usage: VALIDATE_USAGE,
      parse: parseValidateArgs,
      positionalCountError: { count: 1, message: "Pass exactly one YAML or JSON document." },
      async run(parsed, commandIo) {
        const file = resolve(commandIo.cwd, parsed.positionals[0]!);
        try {
          const extension = extname(file).toLowerCase();
          if (![".yaml", ".yml", ".json"].includes(extension)) {
            throw new Error("Expected a .yaml, .yml, or .json document");
          }
          const source = await readFile(file, "utf8");
          let value: unknown;
          if (extension === ".json") value = JSON.parse(source);
          else {
            // The executable runs under Bun; keep its parser out of library entrypoints.
            const specifier = "bun";
            // SAFETY: Bun's documented YAML.parse API returns parsed, untrusted data.
            const { YAML } = (await import(specifier)) as {
              YAML: { parse(text: string): unknown };
            };
            value = YAML.parse(source);
          }
          const document = validatePipelineDocument(value);
          const pipelines = Object.keys(document.pipelines);
          commandIo.stdout.write(
            parsed.values.json
              ? `${JSON.stringify({ ok: true, file, version: document.version, metadata: document.metadata, pipelines })}\n`
              : `Valid pipeline document: ${file} (${pipelines.length} pipeline(s))\n`
          );
          return TUBELESS_WORKBENCH_EXIT_CODE.success;
        } catch (error) {
          if (parsed.values.json) {
            commandIo.stdout.write(
              `${JSON.stringify({
                ok: false,
                file,
                error: {
                  message: errorMessage(error),
                  ...(error instanceof PipelineDocumentError
                    ? { code: error.code, path: error.path }
                    : {}),
                },
              })}\n`
            );
          } else commandIo.stderr.write(`${errorMessage(error)}\n`);
          return TUBELESS_WORKBENCH_EXIT_CODE.validation;
        }
      },
    },
    argv,
    io
  );
}

const INSPECT_USAGE = `Usage: tubeless inspect [options] <pipeline-or-command-file>

Show a pipeline's identity, targets, and steps with their dependencies, child pipelines,
remote engines, and metadata. Nothing is executed.

Step details:
  depends on      Required inputs; "(optional)" marks optional inputs
  failure gate    Steps whose failure skips this step

Options:
  -e, --export <name>    Select a pipeline or command export when the file has more than one
  -p, --project <path>   Resolve a pipeline or command id from this project file
      --tag <tag>        Require a step tag (repeatable; all must match)
      --owner <owner>    Match step owner exactly
      --domain <domain>  Match step domain exactly
      --json             Emit identity and the default plan as JSON
  -h, --help             Show this help
`;

function formatIdList(values: readonly string[]): string {
  return values.length > 0 ? values.map(inlineText).join(", ") : "none";
}

function metadataFields(metadata: PipelineMetadata): [label: string, value: string][] {
  const fields: [label: string, value: string][] = [];
  if (metadata.tags?.length) fields.push(["tags", formatIdList(metadata.tags)]);
  if (metadata.owner) fields.push(["owner", inlineText(metadata.owner)]);
  if (metadata.domain) fields.push(["domain", inlineText(metadata.domain)]);
  if (metadata.annotations && Object.keys(metadata.annotations).length > 0) {
    fields.push(["annotations", inlineText(JSON.stringify(metadata.annotations))]);
  }
  return fields;
}

function describeNestedPipeline(nested: NonNullable<PipelinePlanStep["nestedPipeline"]>): string {
  const stepCount = nested.stepIds.length;
  const details = [`${stepCount} ${stepCount === 1 ? "step" : "steps"}`];
  if (nested.mode === "iterate" && nested.maxIterations !== undefined) {
    details.push(`at most ${nested.maxIterations} ${nested.maxIterations === 1 ? "run" : "runs"}`);
  }
  if (nested.mode === "for-each" && nested.concurrency !== undefined) {
    details.push(`concurrency ${nested.concurrency}`);
  }
  const kind =
    nested.mode === "for-each" ? "fan-out" : nested.mode === "iterate" ? "iteration" : "child";
  return `${kind} pipeline: ${inlineText(nested.pipelineId)} (${details.join(", ")})`;
}

/** Structural detail lines for one step, without its id or description. */
function stepDetails(step: PipelinePlanStep): string[] {
  const dependencies = [
    ...step.dependencies.map(inlineText),
    ...step.optionalDependencies.map((id) => `${inlineText(id)} (optional)`),
  ];
  const details: string[] = [];
  if (dependencies.length > 0) details.push(`depends on: ${dependencies.join(", ")}`);
  if (step.skipAfterFailureOf.length > 0) {
    details.push(`failure gate: ${formatIdList(step.skipAfterFailureOf)}`);
  }
  if (step.nestedPipeline) details.push(describeNestedPipeline(step.nestedPipeline));
  if (step.remote) {
    const target = step.remote.target ? ` (${inlineText(step.remote.target)})` : "";
    details.push(`remote: ${inlineText(step.remote.engine)}${target}`);
  }
  if (step.agent) {
    details.push(
      `agent capabilities: ${formatIdList(step.agent.capabilities.map(({ name }) => name))}`
    );
  }
  if (step.dryRun !== "run") details.push(`dry run: ${step.dryRun}`);
  if (step.runtimeSkipPossible) details.push("runtime skip: possible");
  if (step.metadata) {
    const fields = metadataFields(step.metadata);
    if (fields.length > 0) {
      details.push(fields.map(([label, value]) => `${label}: ${value}`).join("; "));
    }
  }
  return details;
}

/** One aligned `<id>  <name - description>` row per step, followed by indented details. */
function renderStepTable(steps: readonly PipelinePlanStep[]): string[] {
  const rows = steps.map((step) => {
    const key = inlineText(step.id);
    const name = optionalInlineText(step.name);
    return {
      key,
      summary: joinNameAndDescription(
        name === key ? undefined : name,
        optionalInlineText(step.description)
      ),
    };
  });
  const detailIndent = " ".repeat(2 + Math.max(0, ...rows.map(({ key }) => key.length)) + 2);
  const heads = alignedRows(rows, "  ");
  return steps.flatMap((step, index) => [
    heads[index]!,
    ...stepDetails(step).map((detail) => `${detailIndent}${detail}`),
  ]);
}

function renderInspection(
  view: WorkbenchPipeline,
  plan: PipelinePlan,
  totalSteps: number,
  filtered: boolean
): string {
  const { name, description } = pipelineIdentityText(view);
  const metadata = plan.definition?.metadata;
  const stepsHeading = filtered
    ? `Steps matching filters (${plan.steps.length} of ${totalSteps}):`
    : `Steps (${plan.steps.length}):`;
  return [
    `Pipeline ${inlineText(view.id)}`,
    ...(name !== undefined ? [`Name: ${name}`] : []),
    ...(description !== undefined ? [`Description: ${description}`] : []),
    `Targets: ${formatIdList(view.targetIds)}`,
    ...(metadata
      ? metadataFields(metadata).map(
          ([label, value]) => `${label[0]!.toUpperCase()}${label.slice(1)}: ${value}`
        )
      : []),
    "",
    plan.steps.length > 0 ? stepsHeading : `${stepsHeading} none`,
    ...renderStepTable(plan.steps),
    ...(plan.errors.length > 0
      ? ["", "Errors:", ...plan.errors.map((error) => `  ! ${renderPipelineError(error)}`)]
      : []),
    "",
  ].join("\n");
}

interface WorkbenchInspection {
  pipelineId: string;
  plan: PipelinePlan;
  stepIds: string[];
  targetIds: string[];
}

function parseInspectArgs(argv: readonly string[]) {
  return parseSubcommandArgs(argv, {
    ...REGISTRATION_OPTIONS,
    ...STEP_METADATA_FILTER_OPTIONS,
    json: { type: "boolean" },
  });
}

export async function runInspect(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      usage: INSPECT_USAGE,
      parse: parseInspectArgs,
      positionalCountError: PIPELINE_FILE_POSITIONAL,
      async run(parsed, commandIo) {
        const loaded = await loadParsedPlanSource(parsed, commandIo, INSPECT_USAGE);
        if ("exitCode" in loaded) return loaded.exitCode;

        const { view } = loaded;
        const completePlan = view.plan();
        const plan = {
          ...completePlan,
          steps: querySteps(completePlan, {
            tags: parsed.values.tag,
            owner: parsed.values.owner,
            domain: parsed.values.domain,
          }),
        };
        const filtered =
          parsed.values.tag !== undefined ||
          parsed.values.owner !== undefined ||
          parsed.values.domain !== undefined;
        const matchingIds = new Set(plan.steps.map((step) => step.id));
        const stepIds = view.stepIds.filter((id) => !filtered || matchingIds.has(id));
        if (parsed.values.json) {
          const inspection: WorkbenchInspection = {
            pipelineId: view.id,
            targetIds: [...view.targetIds],
            stepIds,
            plan,
          };
          commandIo.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
          return TUBELESS_WORKBENCH_EXIT_CODE.success;
        }

        commandIo.stdout.write(renderInspection(view, plan, completePlan.steps.length, filtered));
        return TUBELESS_WORKBENCH_EXIT_CODE.success;
      },
    },
    argv,
    io
  );
}

const PLAN_USAGE = `Usage: tubeless plan [options] <pipeline-or-command-file>

Preview a registered or exported pipeline without running steps or requiring domain options.

Options:
  -e, --export <name>   Select a pipeline or command export when the file has more than one
  -p, --project <path>  Resolve a pipeline or command id from this project file
  -t, --target <id>     Select a declared target and its prerequisites (repeatable)
  -s, --step <id>       Select exact internal steps (repeatable)
      --dry-run         Show each step's dry-run disposition
      --explain         Include target/dependency selection provenance
      --json            Emit the complete structured plan as JSON
  -h, --help            Show this help
`;

function parsePlanArgs(argv: readonly string[]) {
  return parseSubcommandArgs(argv, {
    "dry-run": { type: "boolean" },
    explain: { type: "boolean" },
    ...REGISTRATION_OPTIONS,
    json: { type: "boolean" },
    step: { type: "string", short: "s", multiple: true },
    target: { type: "string", short: "t", multiple: true },
  });
}

export async function runPlan(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      usage: PLAN_USAGE,
      parse: parsePlanArgs,
      positionalCountError: PIPELINE_FILE_POSITIONAL,
      async run(parsed, commandIo) {
        const loaded = await loadParsedPlanSource(parsed, commandIo, PLAN_USAGE);
        if ("exitCode" in loaded) return loaded.exitCode;

        const controls: PipelineRunControls = {
          dryRun: parsed.values["dry-run"] ?? false,
        };
        if (parsed.values.step !== undefined) controls.stepIds = parsed.values.step;
        if (parsed.values.target !== undefined) controls.targets = parsed.values.target;
        const plan = loaded.view.plan(controls);
        const rendered = parsed.values.json
          ? renderPipelinePlan(plan, { format: "json", pretty: true })
          : renderPipelinePlan(plan, { explain: parsed.values.explain ?? false });
        commandIo.stdout.write(`${rendered}\n`);
        return plan.ok
          ? TUBELESS_WORKBENCH_EXIT_CODE.success
          : TUBELESS_WORKBENCH_EXIT_CODE.planning;
      },
    },
    argv,
    io
  );
}

function isMermaidDirection(value: string): value is PipelineMermaidDirection {
  // SAFETY: PIPELINE_MERMAID_DIRECTIONS is a const tuple of exactly the
  // PipelineMermaidDirection union members, so membership implies a valid direction.
  return (PIPELINE_MERMAID_DIRECTIONS as readonly string[]).includes(value);
}

const GRAPH_USAGE = `Usage: tubeless graph [options] <pipeline-or-command-file>

Generate Mermaid flowchart source from a registered or exported pipeline or command.

Options:
  -e, --export <name>       Select a pipeline or command export when the file has more than one
  -p, --project <path>      Resolve a pipeline or command id from this project file
  -d, --direction <value>   Flowchart direction: BT, LR, RL, TB, or TD (default: TD)
      --tag <tag>           Require a step tag (repeatable; all must match)
      --owner <owner>       Match step owner exactly
      --domain <domain>     Match step domain exactly
      --metadata            Include step metadata in labels
      --descriptions        Include step descriptions in node labels
      --markdown            Wrap the result in a fenced Mermaid Markdown block
  -h, --help                Show this help
`;

function parseGraphArgs(argv: readonly string[]) {
  return parseSubcommandArgs(argv, {
    descriptions: { type: "boolean" },
    direction: { type: "string", short: "d" },
    ...REGISTRATION_OPTIONS,
    ...STEP_METADATA_FILTER_OPTIONS,
    markdown: { type: "boolean" },
    metadata: { type: "boolean" },
  });
}

export async function runGraph(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      usage: GRAPH_USAGE,
      parse: parseGraphArgs,
      positionalCountError: PIPELINE_FILE_POSITIONAL,
      async run(parsed, commandIo) {
        const direction = parsed.values.direction ?? "TD";
        if (!isMermaidDirection(direction)) {
          return writeUsageError(
            commandIo,
            `Invalid direction ${JSON.stringify(direction)}.`,
            GRAPH_USAGE
          );
        }

        const loaded = await loadParsedPlanSource(parsed, commandIo, GRAPH_USAGE);
        if ("exitCode" in loaded) return loaded.exitCode;

        const source = loaded.view.toMermaid({
          direction,
          includeDescriptions: parsed.values.descriptions,
          includeMetadata: parsed.values.metadata,
          query: {
            tags: parsed.values.tag,
            owner: parsed.values.owner,
            domain: parsed.values.domain,
          },
        });
        const terminatedSource = `${source.replace(/\n+$/, "")}\n`;
        commandIo.stdout.write(
          parsed.values.markdown ? `\`\`\`mermaid\n${terminatedSource}\`\`\`\n` : terminatedSource
        );
        return TUBELESS_WORKBENCH_EXIT_CODE.success;
      },
    },
    argv,
    io
  );
}
