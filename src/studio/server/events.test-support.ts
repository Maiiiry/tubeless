import type { PipelineRunEventStore, StoredPipelineEvent } from "../../run-store/run-store.js";
import { decodePipelineTraceEvent } from "../../tracing/tracing-codec.js";
import type { PipelineTraceEvent } from "../../tracing/tracing.js";

export function memoryStore(events: readonly StoredPipelineEvent[]): PipelineRunEventStore {
  return {
    close() {},
    export() {},
    async listEvents(query = {}) {
      return events
        .filter(
          (event) =>
            (query.runId === undefined || event.runId === query.runId) &&
            (query.pipelineId === undefined || event.pipelineId === query.pipelineId) &&
            (query.afterId === undefined || event.id > query.afterId)
        )
        .slice(0, query.limit);
    },
  };
}

export function storedEvent(
  value: Record<string, unknown> & { id: number; name: PipelineTraceEvent["name"] }
): StoredPipelineEvent {
  const { id, name, payload: payloadOverrides, ...event } = value;
  const payloads: Partial<Record<PipelineTraceEvent["name"], Record<string, unknown>>> = {
    "pipeline.completed": {
      dryRun: false,
      errorCount: 0,
      finalized: false,
      status: "completed",
      stepCount: 0,
    },
    "pipeline.log": { level: "log", message: "" },
    "pipeline.started": { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
  };
  return {
    ...decodePipelineTraceEvent({
      ...event,
      name,
      payload: { ...payloads[name], ...(payloadOverrides as object | undefined) },
    }),
    id,
  };
}

export function recordedRun(message = "original"): StoredPipelineEvent[] {
  return [
    storedEvent({
      id: 1,
      name: "pipeline.started",
      pipelineId: "fixture",
      runId: "run",
      timestampMs: 1,
      version: 2,
    }),
    storedEvent({
      id: 2,
      name: "pipeline.log",
      pipelineId: "fixture",
      runId: "run",
      timestampMs: 2,
      version: 2,
      payload: { level: "log", message },
    }),
  ];
}
