import type { CliParameterDescriptor } from "../cli/cli.js";
import type { PipelinePlan, PipelineError, PipelineRunControls } from "../core/pipeline.js";
import {
  storedDefinitionSummarySchema,
  storedPipelineDefinitionSchema,
  storedPipelineRunSchema,
  storedRunSummarySchema,
} from "../run-store/run-store-schema.js";
import { pipelineMetadataSchema } from "../tracing/graph-metadata.js";
import {
  agentMetadataSchema,
  iterationControlsSchema,
  pipelineDefinitionIdentitySchema,
  pipelineDefinitionSnapshotSchema,
  pipelineTraceErrorSchema,
  remoteSchema,
  selectionReasonsSchema,
} from "../tracing/tracing-schema.js";
import {
  wireArray,
  wireBoolean,
  wireCustom,
  wireEnum,
  wireLiteral,
  wireNumber,
  wireObject,
  wireOptional,
  wireRefine,
  wireString,
  wireTransform,
  wireUnion,
  type InferWireSchema,
  type WireSchema,
} from "../tracing/wire-schema.js";

export const STUDIO_HISTORY_PAGE_SIZE = 50;
/** Recent run outcomes kept per pipeline for the navigation rail. */
export const STUDIO_PIPELINE_RECENT_RUNS = 10;
/** Pipelines summarized in one snapshot, most recently active first. */
export const STUDIO_PIPELINE_LIMIT = 1_000;
/** Direct child runs returned for one parent step. Matches the graph's drawn cap. */
export const STUDIO_CHILD_PAGE_SIZE = 16;

const text = wireString({ allowEmpty: true });
const id = wireString();
const number = wireNumber();
const count = wireNumber({ integer: true, minimum: 0 });
const planControls = wireTransform(iterationControlsSchema, (controls): PipelineRunControls => {
  const { targets, stepIds, ...common } = controls;
  if (targets !== undefined && stepIds !== undefined)
    throw new Error("Child selectors are mutually exclusive.");
  return targets !== undefined ? { ...common, targets } : { ...common, stepIds };
});
const strings = wireArray(id);

export const studioParameterSchema: WireSchema<CliParameterDescriptor> = wireRefine(
  wireObject({
    choices: wireOptional(wireArray(text)),
    default: wireOptional(wireUnion([text, number, wireBoolean()])),
    description: wireOptional(text),
    environment: wireOptional(text),
    exclusive: wireOptional(wireLiteral(true)),
    flag: id,
    group: wireOptional(wireLiteral("execution")),
    integer: wireOptional(wireBoolean()),
    key: id,
    max: wireOptional(number),
    min: wireOptional(number),
    multiple: wireBoolean(),
    mustExist: wireOptional(wireBoolean()),
    pathKind: wireOptional(wireEnum(["directory", "file"])),
    positional: wireBoolean(),
    required: wireBoolean(),
    short: wireOptional(text),
    type: wireEnum(["boolean", "number", "path", "string"]),
  }),
  (parameter, path) => {
    const expected =
      parameter.type === "boolean" ? "boolean" : parameter.type === "number" ? "number" : "string";
    if (parameter.default !== undefined && typeof parameter.default !== expected)
      throw new Error(`${path}.default must be a ${expected}`);
  }
);
export const studioCommandsSchema = wireObject({
  commands: wireArray(
    wireObject({
      canPlan: wireBoolean(),
      id,
      name: id,
      description: wireOptional(text),
      parameters: wireArray(studioParameterSchema),
    })
  ),
});

export const studioPlanSchema: WireSchema<PipelinePlan> = wireObject({
  definition: wireOptional(pipelineDefinitionSnapshotSchema),
  dryRun: wireBoolean(),
  ok: wireBoolean(),
  pipelineId: id,
  errors: wireArray(
    wireCustom<PipelineError>(pipelineTraceErrorSchema.jsonSchema, (value, path) => ({
      ...pipelineTraceErrorSchema.decode(value, path),
      ...wireObject({ message: text, stepId: wireOptional(text) }).decode(value, path),
    }))
  ),
  steps: wireArray(
    wireObject({
      metadata: wireOptional(pipelineMetadataSchema),
      agent: wireOptional(agentMetadataSchema),
      dependencies: strings,
      description: wireOptional(text),
      dryRun: wireEnum(["custom", "run", "skip"]),
      id,
      name: wireOptional(text),
      optionalDependencies: strings,
      runtimeSkipPossible: wireBoolean(),
      selected: wireBoolean(),
      selectionReasons: selectionReasonsSchema,
      skipAfterFailureOf: strings,
      skipReason: wireOptional(
        wireEnum([
          "dry-run",
          "failed-dependency",
          "fail-fast",
          "filtered",
          "policy",
          "unmet-dependency",
        ])
      ),
      remote: wireOptional(remoteSchema),
      nestedPipeline: wireOptional(
        wireRefine(
          wireObject({
            mode: wireEnum(["single", "for-each", "iterate"]),
            maxIterations: wireOptional(wireNumber({ integer: true, minimum: 1 })),
            controls: wireOptional(planControls),
            identity: wireOptional(pipelineDefinitionIdentitySchema),
            concurrency: wireOptional(wireUnion([number, wireLiteral("dynamic")])),
            pipelineId: id,
            stepIds: wireArray(id),
          }),
          (nested, path) => {
            if ((nested.mode === "iterate") !== (nested.maxIterations !== undefined))
              throw new Error(`${path}: only iterate requires maxIterations`);
          }
        )
      ),
    })
  ),
});

export const studioPipelineSummarySchema = wireObject({
  pipelineId: id,
  topLevelRunCount: count,
  nestedRunCount: count,
  runningCount: count,
  latestStartedAtMs: number,
  recent: wireArray(
    wireObject({ runId: id, status: wireEnum(["running", "completed", "failed", "cancelled"]) }),
    { maxItems: STUDIO_PIPELINE_RECENT_RUNS }
  ),
});
export const studioSnapshotSchema = wireObject({
  activeRunCount: count,
  completedRunCount: count,
  failedRunCount: count,
  generatedAtMs: number,
  lastEventId: count,
  revision: count,
  runCount: count,
  eventCount: count,
  rootRunCount: count,
  matchingRootCount: count,
  offset: count,
  definitions: wireArray(storedDefinitionSummarySchema),
  pipelines: wireArray(studioPipelineSummarySchema, { maxItems: STUDIO_PIPELINE_LIMIT }),
  liveRunIds: wireArray(id),
  runs: wireArray(storedRunSummarySchema, { maxItems: STUDIO_HISTORY_PAGE_SIZE }),
  selectedRun: wireOptional(storedRunSummarySchema),
});
export const studioChildStepSchema = wireObject({
  stepId: wireOptional(id),
  count,
});
export const studioRunDetailSchema = wireObject({
  run: storedPipelineRunSchema,
  ancestors: wireArray(storedRunSummarySchema),
  children: wireArray(storedRunSummarySchema),
  childCount: count,
  childSteps: wireArray(studioChildStepSchema),
  descendantCount: count,
});
export const studioChildRunsSchema = wireObject({
  children: wireArray(storedRunSummarySchema),
  page: count,
  childCount: count,
});
export const studioDefinitionSchema = wireObject({ definition: storedPipelineDefinitionSchema });
export const studioDefinitionRunsSchema = wireObject({
  runs: wireArray(storedRunSummarySchema, { maxItems: STUDIO_HISTORY_PAGE_SIZE }),
  offset: count,
  runCount: count,
});
export type StudioSnapshot = InferWireSchema<typeof studioSnapshotSchema>;
export type StudioPipelineSummary = InferWireSchema<typeof studioPipelineSummarySchema>;
export type StudioChildStep = InferWireSchema<typeof studioChildStepSchema>;
export type StudioRunDetail = InferWireSchema<typeof studioRunDetailSchema>;
export type StudioChildRuns = InferWireSchema<typeof studioChildRunsSchema>;
export type StudioDefinitionRuns = InferWireSchema<typeof studioDefinitionRunsSchema>;

export function parseStudioPayload<T>(schema: WireSchema<T>, value: unknown): T | undefined {
  try {
    return schema.decode(value, "Studio response");
  } catch {
    return undefined;
  }
}
