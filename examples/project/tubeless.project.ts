import { MetadataPipeline } from "../graph-metadata.ts";
import { definePipelineCommand } from "tubeless/cli";
import { defineProject } from "tubeless/project";
import { ValidatedPipeline } from "../validated-boundaries.ts";
import { OrderChecksPipeline } from "../parameterized-steps.ts";
import { ArtifactLineagePipeline } from "../artifact-lineage.ts";
import { CountPipeline } from "../precise-result.ts";
import { WelcomePipeline } from "../inherited-inputs.ts";
import { OverrideExamplePipeline } from "../step-output-overrides.ts";
import { CachedCountCommand } from "../step-output-cache.ts";
import { PaginatedPipeline } from "../iteration.ts";
import { ScriptedAgent } from "../agent.ts";
import { DelegatingAgentCommand } from "../agent-delegation.ts";
import { AgentPipelineCommand } from "../agent-pipeline.js";
import { CodingAgent } from "../agent-model.js";
import { ClaudeCodingAgent } from "../agent-model-anthropic.js";
import { EnvironmentWorkspaceAgent } from "../agent-environment.js";
import { DurableWorkspaceAgent } from "../agent-durable.js";
import { OpenAIAgentCommand } from "../agent-openai.ts";
import { WorkspaceAgentCommand } from "../agent-workspace.ts";
import { YamlImportCommand, YamlPreviewCommand } from "../yaml-pipelines.ts";
import { YamlPelotonCommand } from "../yaml-peloton.ts";
import { AirflowRemoteCommand } from "../airflow/remote.ts";
import { InngestPipeline } from "../inngest/pipeline.ts";
import { TemporalPipeline } from "../temporal/pipeline.ts";
import { DagsterPipeline } from "../dagster/pipeline.ts";
import { StepFunctionsPipeline } from "../step-functions/pipeline.ts";
import { NormalizePipeline } from "./pipelines/normalize.ts";
import { EnrichCommand } from "./scripts/enrich.ts";
import { ImportCommand } from "./scripts/import.ts";
import { PublishCommand } from "./scripts/publish.ts";

// One project serves application code, CLI, and Studio. Pipeline IDs are the
// command IDs. Schema-backed pipelines need no command adapter; explicit commands
// handle type-only inputs, custom params/mapOptions, and presentation.
export default defineProject(
  "example-jobs",
  [
    ValidatedPipeline,
    definePipelineCommand(MetadataPipeline, { params: {} }),
    // Plain cached results and their receipts appear in history and Studio.
    CachedCountCommand,
    ScriptedAgent,
    OpenAIAgentCommand,
    // Live model decisions and tools share the physical run cwd, including through symlinks.
    // Scoped guidance precedes nested file operations and task commands in separate turns.
    CodingAgent,
    ClaudeCodingAgent,
    EnvironmentWorkspaceAgent,
    DurableWorkspaceAgent,
    // Record with --trace/--store; history <run-id> shows turns, calls and child agents.
    DelegatingAgentCommand,
    AgentPipelineCommand,
    WorkspaceAgentCommand,
    definePipelineCommand(PaginatedPipeline, {
      params: { rows: { type: "string", multiple: true } },
    }),
    // Ordinary execution of the override recipe; supplied outputs are testing-only.
    definePipelineCommand(OverrideExamplePipeline, {
      params: { lines: { type: "string", multiple: true } },
    }),
    definePipelineCommand(ArtifactLineagePipeline, {
      params: {
        source: { type: "path", required: true },
        destination: { type: "string", required: true },
      },
    }),
    definePipelineCommand(WelcomePipeline, {
      params: { name: { type: "string" } },
    }),
    definePipelineCommand(CountPipeline, {
      params: { text: { type: "string", required: true } },
    }),
    definePipelineCommand(OrderChecksPipeline, {
      params: {
        quantities: { type: "number", multiple: true },
        prices: { type: "number", multiple: true },
      },
    }),
    // Register the entry pipelines; their compiled children remain implementation details.
    YamlImportCommand,
    YamlPreviewCommand,
    YamlPelotonCommand,
    AirflowRemoteCommand,
    // Local execution of the same pipeline hosted by the Temporal Activity.
    definePipelineCommand(TemporalPipeline, {
      params: { lines: { type: "string", multiple: true } },
    }),
    // Local execution; no Inngest event is sent.
    definePipelineCommand(InngestPipeline, {
      params: { lines: { type: "string", multiple: true } },
    }),
    definePipelineCommand(DagsterPipeline, {
      params: {
        lines: { type: "string", multiple: true },
        outputPath: { type: "path", required: true },
      },
    }),
    definePipelineCommand(StepFunctionsPipeline, {
      params: { lines: { type: "string", multiple: true } },
    }),
    definePipelineCommand(NormalizePipeline, {
      params: { rows: { type: "string", multiple: true } },
    }),
    ImportCommand,
    EnrichCommand,
    PublishCommand,
  ],
  {
    name: "Example jobs",
    description: "Import, enrich, and publish row datasets.",
  }
);
