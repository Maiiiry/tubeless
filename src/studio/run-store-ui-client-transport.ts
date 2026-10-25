import type { StoredPipelineDefinition } from "../run-store/run-store.js";
import type { PipelinePlan, PipelineRunControls } from "../core/pipeline.js";
import type {
  PipelineRunStudioCommand,
  PipelineRunStudioLaunchRequest,
} from "./run-store-ui-protocol.js";
import {
  parseStudioPayload,
  studioSnapshotSchema,
  studioCommandsSchema,
  studioPlanSchema,
  studioRunDetailSchema,
  studioChildRunsSchema,
  studioDefinitionSchema,
  studioDefinitionRunsSchema,
  type StudioSnapshot,
  type StudioRunDetail,
  type StudioChildRuns,
  type StudioDefinitionRuns,
} from "./run-store-ui-schema.js";
export type {
  StudioSnapshot,
  StudioRunDetail,
  StudioChildRuns,
  StudioDefinitionRuns,
} from "./run-store-ui-schema.js";

export interface StudioHistoryQuery {
  /** Limit history to one pipeline's runs at any depth. */
  pipelineId?: string;
  query?: string;
  offset?: number;
  selectedRunId?: string | null;
}
interface StudioCapabilities {
  canCancel: boolean;
  canClearHistory: boolean;
}
interface StudioClearResult {
  eventCount: number;
}
export type StudioAccessDenied = 401 | 403;

class StudioHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export interface StudioApi {
  subscribeAccessDenied?(listener: (status: StudioAccessDenied) => void): () => void;
  cancelRun(runId: string): Promise<void>;
  clearHistory(): Promise<StudioClearResult>;
  loadCapabilities(): Promise<StudioCapabilities>;
  loadCommands(): Promise<PipelineRunStudioCommand[]>;
  loadRunDetail(runId: string): Promise<StudioRunDetail | null>;
  loadChildRuns(runId: string, page: number): Promise<StudioChildRuns | null>;
  loadSnapshot(query?: StudioHistoryQuery): Promise<StudioSnapshot>;
  loadDefinition(pipelineId: string, definitionId?: string): Promise<StoredPipelineDefinition>;
  loadDefinitionRuns(
    pipelineId: string,
    definitionId?: string,
    offset?: number
  ): Promise<StudioDefinitionRuns>;
  launch(commandId: string, values: PipelineRunStudioLaunchRequest["values"]): Promise<string>;
  previewPlan(commandId: string, input: PipelineRunControls): Promise<PipelinePlan>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function parseStudioSnapshot(value: unknown): StudioSnapshot | undefined {
  return parseStudioPayload(studioSnapshotSchema, value);
}
export function parseStudioCommands(value: unknown): PipelineRunStudioCommand[] | undefined {
  return parseStudioPayload(studioCommandsSchema, value)?.commands;
}
function responseError(value: unknown, fallback: string, status: number): Error {
  if (!isRecord(value)) return new StudioHttpError(status, fallback);
  if (Array.isArray(value.errors) && value.errors.every((item) => typeof item === "string")) {
    return new StudioHttpError(status, value.errors.join("\n"));
  }
  return new StudioHttpError(status, typeof value.message === "string" ? value.message : fallback);
}

function invalidResponse(endpoint: string): Error {
  return new Error(`Studio API returned an invalid response for ${endpoint}.`);
}

/** Same-origin Studio transport. Every successful payload is validated before use. */
export function createStudioApi(fetcher: typeof fetch = fetch, mount = ""): StudioApi {
  const listeners = new Set<(status: StudioAccessDenied) => void>();
  let denied: StudioAccessDenied | undefined;
  let cachedSnapshot: { key: string; etag: string | null; snapshot: StudioSnapshot } | undefined;
  const assertAccess = () => {
    if (denied)
      throw new StudioHttpError(denied, denied === 401 ? "Sign in to continue." : "Access denied.");
  };
  const request: typeof fetch = async (input, init) => {
    assertAccess();
    const response = await fetcher(mount + String(input), init);
    if (!denied && (response.status === 401 || response.status === 403)) {
      denied = response.status;
      for (const listener of listeners) listener(denied);
    }
    assertAccess();
    return response;
  };
  const readJson = async (response: Response): Promise<unknown> => {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      assertAccess();
      throw new StudioHttpError(response.status, "Studio API returned invalid JSON.");
    }
    assertAccess();
    return payload;
  };
  return {
    subscribeAccessDenied(listener) {
      listeners.add(listener);
      if (denied) listener(denied);
      return () => {
        listeners.delete(listener);
      };
    },
    async loadSnapshot({ query = "", offset = 0, pipelineId, selectedRunId } = {}) {
      const params = new URLSearchParams();
      if (pipelineId) params.set("pipeline", pipelineId);
      if (query) params.set("query", query);
      if (offset) params.set("offset", String(offset));
      if (selectedRunId) params.set("run", selectedRunId);
      const key = "/api/snapshot" + (params.size ? "?" + params : "");
      const previous = cachedSnapshot?.key === key ? cachedSnapshot : undefined;
      const response = await request(key, {
        cache: "no-store",
        headers: previous?.etag ? { "if-none-match": previous.etag } : undefined,
      });
      if (response.status === 304 && previous) return previous.snapshot;
      const payload = await readJson(response);
      if (!response.ok) throw responseError(payload, "Snapshot request failed.", response.status);
      const snapshot = parseStudioSnapshot(payload);
      if (!snapshot) throw invalidResponse("snapshot");
      cachedSnapshot = { key, etag: response.headers.get("etag"), snapshot };
      return snapshot;
    },
    async loadDefinition(pipelineId, definitionId) {
      const params = new URLSearchParams({ pipelineId });
      if (definitionId) params.set("definitionId", definitionId);
      const response = await request("/api/definitions?" + params, { cache: "no-store" });
      const payload = await readJson(response);
      if (!response.ok) throw responseError(payload, "Definition request failed.", response.status);
      const detail = parseStudioPayload(studioDefinitionSchema, payload);
      if (!detail) throw invalidResponse("definition");
      return detail.definition;
    },
    async loadDefinitionRuns(pipelineId, definitionId, offset = 0) {
      const params = new URLSearchParams({ pipelineId, offset: String(offset) });
      if (definitionId) params.set("definitionId", definitionId);
      const response = await request("/api/definitions/runs?" + params, { cache: "no-store" });
      const payload = await readJson(response);
      if (!response.ok)
        throw responseError(payload, "Definition runs request failed.", response.status);
      const page = parseStudioPayload(studioDefinitionRunsSchema, payload);
      if (!page) throw invalidResponse("definition runs");
      return page;
    },
    async loadRunDetail(runId) {
      const response = await request("/api/runs/" + encodeURIComponent(runId), {
        cache: "no-store",
      });
      const payload = await readJson(response);
      if (response.status === 404) return null;
      if (!response.ok) throw responseError(payload, "Run detail request failed.", response.status);
      const detail = parseStudioPayload(studioRunDetailSchema, payload);
      if (!detail) throw invalidResponse("run detail");
      return detail;
    },
    async loadChildRuns(runId, page) {
      const response = await request(
        "/api/runs/" + encodeURIComponent(runId) + "/children?page=" + page,
        { cache: "no-store" }
      );
      const payload = await readJson(response);
      if (response.status === 404) return null;
      if (!response.ok) throw responseError(payload, "Child runs request failed.", response.status);
      const parsed = parseStudioPayload(studioChildRunsSchema, payload);
      if (!parsed) throw invalidResponse("child runs");
      return parsed;
    },
    async loadCommands() {
      const response = await request("/api/commands", { cache: "no-store" });
      const payload = await readJson(response);
      if (!response.ok) throw responseError(payload, "Commands request failed.", response.status);
      const commands = parseStudioCommands(payload);
      if (!commands) throw invalidResponse("commands");
      return commands;
    },
    async loadCapabilities() {
      const response = await request("/api/capabilities", { cache: "no-store" });
      const payload = await readJson(response);
      if (
        !response.ok ||
        !isRecord(payload) ||
        typeof payload.canCancel !== "boolean" ||
        typeof payload.canClearHistory !== "boolean"
      ) {
        if (!response.ok)
          throw responseError(payload, "Capabilities request failed.", response.status);
        throw invalidResponse("capabilities");
      }
      return {
        canCancel: payload.canCancel,
        canClearHistory: payload.canClearHistory,
      };
    },
    async clearHistory() {
      const response = await request("/api/history", {
        method: "DELETE",
        headers: { "x-tubeless-studio-clear-history": "1" },
      });
      const payload = await readJson(response);
      if (!response.ok)
        throw responseError(payload, "History could not be cleared.", response.status);
      if (!isRecord(payload) || payload.cleared !== true || !isFiniteNumber(payload.eventCount)) {
        throw invalidResponse("clear history");
      }
      cachedSnapshot = undefined;
      return { eventCount: payload.eventCount };
    },
    async previewPlan(commandId, input) {
      const response = await request("/api/commands/" + encodeURIComponent(commandId) + "/plan", {
        method: "POST",
        headers: { "content-type": "application/json", "x-tubeless-studio-plan": "1" },
        body: JSON.stringify(input),
      });
      const payload = await readJson(response);
      if (!response.ok) throw responseError(payload, "Plan request failed.", response.status);
      const plan = isRecord(payload)
        ? parseStudioPayload(studioPlanSchema, payload.plan)
        : undefined;
      if (!plan) throw invalidResponse("plan");
      return plan;
    },
    async cancelRun(runId) {
      const response = await request("/api/runs/" + encodeURIComponent(runId) + "/cancel", {
        method: "POST",
        headers: { "x-tubeless-studio-cancel": "1" },
      });
      const payload = await readJson(response);
      if (!response.ok)
        throw responseError(payload, "Run could not be cancelled.", response.status);
      if (!isRecord(payload) || payload.cancelled !== true || payload.runId !== runId) {
        throw invalidResponse("cancel run");
      }
    },
    async launch(commandId, values) {
      const response = await request("/api/commands/" + encodeURIComponent(commandId) + "/runs", {
        method: "POST",
        headers: { "content-type": "application/json", "x-tubeless-studio-launch": "1" },
        body: JSON.stringify({ values }),
      });
      const payload = await readJson(response);
      if (!response.ok) throw responseError(payload, "Launch failed.", response.status);
      if (
        !isRecord(payload) ||
        payload.accepted !== true ||
        typeof payload.runId !== "string" ||
        payload.runId.length === 0
      ) {
        throw invalidResponse("launch");
      }
      return payload.runId;
    },
  };
}
