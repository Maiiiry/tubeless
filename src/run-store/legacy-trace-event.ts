import { decodePipelineTraceEvent } from "../tracing/tracing-codec.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";

/**
 * One `pipeline_run_events` row from schema version 1 or 2.
 * Version 1 stores scalar attributes in `attributes_json`. Version 2 stores the
 * structured payload in that same column and adds `correlation_id`.
 */
export interface LegacyAttributeRow {
  readonly attempt_id: string | null;
  readonly attributes_json: string;
  readonly correlation_id?: string | null;
  readonly duration_ms: number | null;
  readonly error_json: string | null;
  readonly event_name: string;
  readonly id: number | bigint;
  readonly item_key: string | null;
  readonly parent_run_id: string | null;
  readonly pipeline_id: string;
  readonly run_id: string;
  readonly step_id: string | null;
  readonly timestamp_ms: number | bigint;
  readonly version: number | bigint;
}

type LegacyAttribute = boolean | number | string;
type LegacyAttributes = Readonly<Record<string, LegacyAttribute>>;

/**
 * Validate a schema 1 or 2 row as a current trace event.
 * Schema 1 attributes become a version 2 payload. Retired `PIPES_` error codes
 * become the `TUBELESS_` prefix those codes use now.
 */
export function upgradeLegacyAttributeRow(row: LegacyAttributeRow): PipelineTraceEvent {
  try {
    const version = Number(row.version);
    const body = parseJson(row.attributes_json, "attributes_json");
    const error = row.error_json == null ? undefined : parseJson(row.error_json, "error_json");
    const event: Record<string, unknown> = {
      name: row.event_name,
      payload:
        version === 1 ? payloadFromLegacyAttributes(row.event_name, scalarAttributes(body)) : body,
      pipelineId: row.pipeline_id,
      runId: row.run_id,
      timestampMs: Number(row.timestamp_ms),
      version: version === 1 ? 2 : version,
    };
    if (row.correlation_id != null) event.correlationId = row.correlation_id;
    if (row.parent_run_id != null) event.parentRunId = row.parent_run_id;
    if (row.step_id != null) event.stepId = row.step_id;
    if (row.attempt_id != null) event.attemptId = row.attempt_id;
    if (row.item_key != null) event.itemKey = row.item_key;
    if (row.duration_ms != null) event.durationMs = Number(row.duration_ms);
    if (error !== undefined) event.error = renameRetiredErrorCode(error);
    return decodePipelineTraceEvent(event);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Cannot upgrade pipeline run event ${String(row.id)} (${row.event_name}): ${message}`,
      { cause }
    );
  }
}

function parseJson(value: string, column: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${column} must contain JSON`);
  }
}

function renameRetiredErrorCode(error: unknown): unknown {
  if (error === null || typeof error !== "object" || Array.isArray(error)) return error;
  const source = error as Record<string, unknown>;
  if (typeof source.code !== "string" || !source.code.startsWith("PIPES_")) return error;
  return { ...source, code: `TUBELESS_${source.code.slice("PIPES_".length)}` };
}

function scalarAttributes(value: unknown): LegacyAttributes {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("attributes must be an object");
  }
  const attributes: Record<string, LegacyAttribute> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "number" && !Number.isFinite(item)) {
      throw new Error(`attributes.${key} must be a finite number`);
    }
    if (typeof item !== "boolean" && typeof item !== "number" && typeof item !== "string") {
      throw new Error(`attributes.${key} must be a boolean, number, or string`);
    }
    attributes[key] = item;
  }
  return attributes;
}

function jsonValue(value: LegacyAttribute | undefined, label: string): unknown {
  if (typeof value !== "string") throw new Error(`${label} must contain JSON`);
  return parseJson(value, label);
}

function jsonStringArray(value: LegacyAttribute | undefined): unknown {
  if (value === undefined) return [];
  return jsonValue(value, "attributes list");
}

function omitUndefined(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter((entry) => entry[1] !== undefined));
}

function payloadFromLegacyAttributes(name: string, attributes: LegacyAttributes): unknown {
  switch (name) {
    case "pipeline.started":
      return {
        dryRun: attributes.dry_run === true,
        planOk: typeof attributes.plan_ok === "boolean" ? attributes.plan_ok : true,
        stepCount: typeof attributes.step_count === "number" ? attributes.step_count : 0,
        targetIds: jsonStringArray(attributes.target_ids ?? "[]"),
      };
    case "pipeline.log":
      return {
        level:
          attributes.level === "error" || attributes.level === "warn" || attributes.level === "log"
            ? attributes.level
            : "log",
        message: typeof attributes.message === "string" ? attributes.message : "",
      };
    case "pipeline.completed":
      return {
        dryRun: attributes.dry_run === true,
        errorCount: typeof attributes.error_count === "number" ? attributes.error_count : 0,
        finalized: attributes.finalized === true,
        status: attributes.status,
        stepCount: typeof attributes.step_count === "number" ? attributes.step_count : 0,
      };
    case "pipeline.finalize.started":
    case "pipeline.finalize.completed":
    case "pipeline.finalize.failed":
      return {};
    case "step.planned":
      return omitUndefined({
        dependencies: jsonStringArray(attributes.dependencies ?? "[]"),
        description:
          typeof attributes.description === "string" ? attributes.description : undefined,
        dryRun: attributes.dry_run ?? "run",
        name: typeof attributes.name === "string" ? attributes.name : undefined,
        nestedPipeline:
          attributes.nested_pipeline === undefined
            ? undefined
            : nestedPipeline(jsonValue(attributes.nested_pipeline, "attributes.nested_pipeline")),
        optionalDependencies: jsonStringArray(attributes.optional_dependencies ?? "[]"),
        remote:
          attributes.remote === undefined
            ? undefined
            : jsonValue(attributes.remote, "attributes.remote"),
        runtimeSkipPossible: attributes.runtime_skip_possible === true,
        selected: typeof attributes.selected === "boolean" ? attributes.selected : true,
        selectionReasons:
          attributes.selection_reasons === undefined
            ? []
            : selectionReasons(
                jsonValue(attributes.selection_reasons, "attributes.selection_reasons")
              ),
        skipAfterFailureOf: jsonStringArray(attributes.skip_after_failure_of ?? "[]"),
      });
    case "step.running":
      return omitUndefined({ progress: progress(attributes) });
    case "step.attempted":
      return attempted(attributes);
    case "step.complete":
      return { status: "completed" };
    case "step.skipped":
      return omitUndefined({
        dependencyId:
          typeof attributes.dependency_id === "string" ? attributes.dependency_id : undefined,
        message: typeof attributes.message === "string" ? attributes.message : undefined,
        reason: attributes.reason,
        status: "skipped",
      });
    case "step.cancelled":
      return { status: "cancelled" };
    case "step.failed":
      return { status: "failed" };
    default:
      throw new Error(`attributes cannot be upgraded for ${name}`);
  }
}

function nestedPipeline(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("attributes.nested_pipeline must contain an object");
  }
  const source = value as Record<string, unknown>;
  const stepIds = Array.isArray(source.stepIds) ? source.stepIds : [];
  return omitUndefined({
    maxIterations: source.maxIterations,
    mode: source.mode,
    pipelineId: source.pipelineId,
    stepCount: source.stepCount ?? source.step_count ?? stepIds.length,
    stepIds,
  });
}

function selectionReasons(value: unknown): unknown {
  if (!Array.isArray(value)) throw new Error("attributes.selection_reasons must contain an array");
  return value.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    const source = item as Record<string, unknown>;
    return omitUndefined({
      dependentId: source.dependentId ?? source.dependent_id,
      kind: source.kind,
      targetId: source.targetId ?? source.target_id,
    });
  });
}

function progress(attributes: LegacyAttributes): unknown {
  if (typeof attributes.completed !== "number") return undefined;
  return omitUndefined({
    completed: attributes.completed,
    detailCount: typeof attributes.detail_count === "number" ? attributes.detail_count : undefined,
    details:
      typeof attributes.details === "string"
        ? jsonValue(attributes.details, "attributes.details")
        : undefined,
    message: typeof attributes.message === "string" ? attributes.message : undefined,
    total: typeof attributes.total === "number" ? attributes.total : undefined,
  });
}

function attempted(attributes: LegacyAttributes): {
  attempt: LegacyAttribute | undefined;
  attributes: LegacyAttributes;
} {
  const { attempt, ...custom } = attributes;
  return { attempt, attributes: custom };
}
