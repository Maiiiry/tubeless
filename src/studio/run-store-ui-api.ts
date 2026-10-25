import type { PipelineRunEventReader } from "../run-store/run-store.js";
import {
  isPipelineRunStudioParameter,
  parseStudioLaunchRequest,
  parseStudioPlanInput,
  type PipelineRunStudioCommand,
  type PipelineRunStudioLauncher,
} from "./run-store-ui-protocol.js";
import {
  PipelineRunStudioEventState,
  PipelineRunStudioHistoryBusyError,
  type PipelineRunStudioHistoryMaintenance,
} from "./run-store-ui-state.js";
import {
  jsonResponse,
  errorResponse,
  readJsonBody,
  decodePathSegment,
  StudioRequestError,
  unexpectedStudioErrorResponse,
} from "./run-store-ui-http.js";

export interface PipelineRunStudioApiOptions {
  /** Optional all-history maintenance capability. Omit it to keep history immutable. */
  history?: PipelineRunStudioHistoryMaintenance;
  /** Optional execution capability. Omit it to keep the studio read-only. */
  launcher?: PipelineRunStudioLauncher;
  store: Pick<PipelineRunEventReader, "listEvents">;
}

/** Own API routes and their state without opening a listener or concrete storage. */
export function createStudioApiHandler(
  options: PipelineRunStudioApiOptions
): (request: Request, url: URL) => Promise<Response> {
  const history = options.history;
  const launcher = options.launcher;
  const commands = [...(launcher?.commands ?? [])];
  const commandById = new Map<string, PipelineRunStudioCommand>();
  for (const command of commands) {
    if (!command.id || !command.name || !Array.isArray(command.parameters)) {
      throw new Error(
        "Studio commands require non-empty id and name values plus parameter metadata."
      );
    }
    if (!command.parameters.every(isPipelineRunStudioParameter)) {
      throw new Error(`Studio command ${JSON.stringify(command.id)} has invalid parameters.`);
    }
    if (commandById.has(command.id)) {
      throw new Error(`Duplicate studio command id ${JSON.stringify(command.id)}.`);
    }
    commandById.set(command.id, command);
  }
  const eventState = new PipelineRunStudioEventState(options.store);
  const instanceId = crypto.randomUUID();
  return async (request, url) => {
    try {
      if (request.method === "GET" && url.pathname === "/api/snapshot") {
        const query = url.searchParams.get("query") ?? "";
        if (query.length > 4096)
          throw new StudioRequestError(
            "invalid_query",
            "Search is too long.",
            400,
            "Use at most 4096 characters."
          );
        const pipelineId = url.searchParams.get("pipeline") ?? "";
        if (pipelineId.length > 4096)
          throw new StudioRequestError(
            "invalid_pipeline",
            "Pipeline ID is too long.",
            400,
            "Use at most 4096 characters."
          );
        const snapshot = await eventState.workspace(
          query,
          historyOffset(url),
          url.searchParams.get("run"),
          pipelineId
        );
        const liveRunIds = launcher?.liveRunIds?.() ?? [];
        const etag = `"${await sha256Hex(JSON.stringify([instanceId, snapshot.revision, url.search, liveRunIds]))}"`;
        if (request.headers.get("if-none-match") === etag) {
          return new Response(null, { status: 304, headers: { etag } });
        }
        return jsonResponse({ ...snapshot, liveRunIds }, 200, { etag });
      }
      if (
        request.method === "GET" &&
        (url.pathname === "/api/definitions" || url.pathname === "/api/definitions/runs")
      ) {
        const pipelineId = url.searchParams.get("pipelineId") ?? "";
        const definitionId = url.searchParams.get("definitionId") ?? undefined;
        const result =
          url.pathname === "/api/definitions/runs"
            ? await eventState.definitionRuns(pipelineId, definitionId, historyOffset(url))
            : await eventState
                .definition(pipelineId, definitionId)
                .then((definition) => definition && { definition });
        return result
          ? jsonResponse(result)
          : errorResponse(
              404,
              "definition_not_found",
              "Definition not found.",
              "Refresh the observed definitions."
            );
      }
      if (request.method === "GET" && url.pathname === "/api/capabilities") {
        return jsonResponse({
          canCancel: launcher?.cancel !== undefined && launcher.liveRunIds !== undefined,
          canClearHistory: history !== undefined,
        });
      }
      const childrenMatch = /^\/api\/runs\/([^/]+)\/children$/.exec(url.pathname);
      if (request.method === "GET" && childrenMatch) {
        const runId = decodePathSegment(childrenMatch[1]!);
        const page = await eventState.childRuns(runId, childPage(url));
        return page
          ? jsonResponse(page)
          : errorResponse(
              404,
              "run_not_found",
              "Run not found.",
              "Refresh /api/snapshot and choose an available runId."
            );
      }
      const runMatch = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && runMatch) {
        const runId = decodePathSegment(runMatch[1]!);
        const detail = await eventState.detail(runId);
        return detail
          ? jsonResponse(detail)
          : errorResponse(
              404,
              "run_not_found",
              "Run not found.",
              "Refresh /api/snapshot and choose an available runId."
            );
      }
      const cancelMatch = /^\/api\/runs\/([^/]+)\/cancel$/.exec(url.pathname);
      if (request.method === "POST" && cancelMatch) {
        if (!launcher?.cancel) {
          return errorResponse(
            405,
            "cancellation_not_enabled",
            "Pipeline cancellation is not enabled.",
            "Start the Studio with a launcher that provides cancel and liveRunIds."
          );
        }
        if (request.headers.get("x-tubeless-studio-cancel") !== "1") {
          return errorResponse(
            415,
            "cancel_guard_required",
            "A same-origin cancel request is required.",
            "Send x-tubeless-studio-cancel: 1 from the Studio origin."
          );
        }
        const runId = decodePathSegment(cancelMatch[1]!);
        const result = await launcher.cancel(runId);
        if (!result.cancelled) {
          return errorResponse(
            404,
            "run_not_live",
            "The run is not a live launch.",
            "Refresh /api/snapshot and cancel a run listed in liveRunIds."
          );
        }
        return jsonResponse({ cancelled: true, runId: result.runId }, 202);
      }
      if (request.method === "DELETE" && url.pathname === "/api/history") {
        if (!history) {
          return errorResponse(
            405,
            "history_maintenance_not_enabled",
            "History maintenance is not enabled.",
            "Start the Studio with a history maintenance adapter."
          );
        }
        if (request.headers.get("x-tubeless-studio-clear-history") !== "1") {
          return errorResponse(
            415,
            "history_guard_required",
            "A same-origin history request is required.",
            "Send x-tubeless-studio-clear-history: 1 from the Studio origin."
          );
        }
        const cleared = await eventState.clear(history);
        return jsonResponse({ cleared: true, ...cleared });
      }
      if (request.method === "GET" && url.pathname === "/api/commands") {
        return jsonResponse({ commands });
      }
      const planMatch = /^\/api\/commands\/([^/]+)\/plan$/.exec(url.pathname);
      if (request.method === "POST" && planMatch) {
        const commandId = decodePathSegment(planMatch[1]!);
        if (!launcher?.plan || !commandById.get(commandId)?.canPlan) {
          return errorResponse(
            405,
            "planning_not_enabled",
            "Pipeline planning is not enabled.",
            "Choose a command with canPlan or start the Studio with a planning launcher."
          );
        }
        if (
          !request.headers.get("content-type")?.startsWith("application/json") ||
          request.headers.get("x-tubeless-studio-plan") !== "1"
        ) {
          return errorResponse(
            415,
            "plan_guard_required",
            "A same-origin JSON plan request is required.",
            "Send application/json with x-tubeless-studio-plan: 1 from the Studio origin."
          );
        }
        const input = parseStudioPlanInput(await readJsonBody(request));
        if (!input) {
          return errorResponse(
            400,
            "invalid_plan_input",
            "Plan input must contain bounded selections.",
            "Send optional dryRun, stepIds, or targets fields within the documented limits."
          );
        }
        return jsonResponse({ plan: await launcher.plan(commandId, input) });
      }
      const launchMatch = /^\/api\/commands\/([^/]+)\/runs$/.exec(url.pathname);
      if (request.method === "POST" && launchMatch) {
        if (!launcher) {
          return errorResponse(
            405,
            "launching_not_enabled",
            "Pipeline launching is not enabled.",
            "Start the Studio with an execution launcher."
          );
        }
        if (
          !request.headers.get("content-type")?.startsWith("application/json") ||
          request.headers.get("x-tubeless-studio-launch") !== "1"
        ) {
          return errorResponse(
            415,
            "launch_guard_required",
            "A same-origin JSON launch request is required.",
            "Send application/json with x-tubeless-studio-launch: 1 from the Studio origin."
          );
        }
        const launch = parseStudioLaunchRequest(await readJsonBody(request));
        if (!launch) {
          return errorResponse(
            400,
            "invalid_launch_input",
            "values must contain at most 128 bounded JSON-safe entries.",
            "Send a values object matching the selected command descriptor."
          );
        }
        const commandId = decodePathSegment(launchMatch[1]!);
        if (!commandById.has(commandId)) {
          return errorResponse(
            404,
            "command_not_found",
            "Pipeline command not found.",
            "Refresh /api/commands and choose an available commandId."
          );
        }
        const result = await launcher.launch(commandId, launch.values);
        if (result.accepted) return jsonResponse(result, 202);
        return jsonResponse(
          {
            ...result,
            code: "launch_rejected",
            hint: "Review errors and retry only after resolving the reported cause.",
            message: "Pipeline launch was rejected.",
          },
          400
        );
      }
      if (request.method !== "GET") {
        return errorResponse(
          405,
          "method_not_allowed",
          "Method not allowed.",
          "Read the Studio guide at https://tubeless.io/docs/studio."
        );
      }
      return errorResponse(
        404,
        "endpoint_not_found",
        "Not found.",
        "Read the Studio guide at https://tubeless.io/docs/studio and choose a supported endpoint."
      );
    } catch (error) {
      if (error instanceof StudioRequestError) {
        return errorResponse(error.status, error.code, error.message, error.hint);
      }
      if (error instanceof PipelineRunStudioHistoryBusyError) {
        return errorResponse(
          409,
          "history_busy",
          error.message,
          "Wait for live runs to finish, then retry the clear request."
        );
      }
      return unexpectedStudioErrorResponse(error);
    }
  };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function historyOffset(url: URL): number {
  return queryInteger(url, "offset", "invalid_offset", "Invalid history offset.");
}

function childPage(url: URL): number {
  return queryInteger(url, "page", "invalid_page", "Invalid child page.");
}

function queryInteger(url: URL, name: string, code: string, message: string): number {
  const value = url.searchParams.get(name) ?? "0";
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed))
    throw new StudioRequestError(code, message, 400, "Use a nonnegative safe integer.");
  return parsed;
}
