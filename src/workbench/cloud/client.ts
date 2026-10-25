import { normalizeCloudHost } from "./config.js";
import {
  CLOUD_INPUT_MAX_DEPTH,
  isCloudJsonValue,
  isCloudObject,
  isCloudToken,
  parseCliError,
  parseCliPipelines,
  parseCliRun,
  parseCliSession,
  parseCloudDeviceCode,
  parseCloudDeviceError,
  parseCloudDeviceSession,
  type CliPipeline,
  type CliRun,
  type CliRunRequest,
  type CliSession,
  type CloudDeviceCode,
  type CloudDeviceError,
  type CloudDeviceSession,
} from "./protocol.js";
import { terminalSafeText } from "../workbench-shared.js";

const CLOUD_JSON_LIMIT = 64 * 1024;
const RUN_ENVELOPE_LIMIT = 66 * 1024;
const RESPONSE_LIMIT = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export class CloudClientError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(message: string, code: string, status?: number) {
    super(message);
    this.name = "CloudClientError";
    this.code = code;
    this.status = status;
  }
}

export function isCloudTransportError(error: unknown): error is CloudClientError {
  return (
    error instanceof CloudClientError &&
    error.status === undefined &&
    ["transport_error", "timeout"].includes(error.code)
  );
}

export interface CloudClientOptions {
  host: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CloudClient {
  readonly host: string;
  session(): Promise<CliSession>;
  logout(): Promise<void>;
  pipelines(workspaceId: string): Promise<CliPipeline[]>;
  run(workspaceId: string, request: CliRunRequest, idempotencyKey: string): Promise<CliRun>;
  getRun(workspaceId: string, runId: string): Promise<CliRun>;
  deviceCode(): Promise<CloudDeviceCode>;
  deviceToken(deviceCode: string): Promise<CloudDeviceSession | CloudDeviceError>;
}

function safeMessage(message: string, token?: string): string {
  const redacted = token ? message.split(token).join("[redacted]") : message;
  return terminalSafeText(redacted).slice(0, 1024);
}

function abortFailure(timedOut: boolean): CloudClientError {
  return new CloudClientError(
    timedOut ? "Cloud request timed out." : "Cloud request interrupted.",
    timedOut ? "timeout" : "cancelled"
  );
}

function validateRunInput(input: unknown): void {
  if (!isCloudObject(input))
    throw new CloudClientError("Cloud run input must be a JSON object.", "invalid_request");
  if (!isCloudJsonValue(input))
    throw new CloudClientError(
      `Cloud run input must contain JSON data with finite numbers and at most ${CLOUD_INPUT_MAX_DEPTH} levels of objects and arrays.`,
      "invalid_request"
    );
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(input);
  } catch {
    throw new CloudClientError("Cloud run input must contain JSON data.", "invalid_request");
  }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > CLOUD_JSON_LIMIT)
    throw new CloudClientError("Cloud run input exceeds the 64 KB JSON limit.", "invalid_request");
}

async function responseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    await response.body?.cancel().catch(() => {});
    throw new CloudClientError(
      "Cloud returned a non-JSON response.",
      "invalid_response",
      response.status
    );
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > RESPONSE_LIMIT) {
    await response.body?.cancel().catch(() => {});
    throw new CloudClientError(
      "Cloud response exceeds the size limit.",
      "invalid_response",
      response.status
    );
  }
  if (!response.body) {
    throw new CloudClientError(
      "Cloud returned an empty response.",
      "invalid_response",
      response.status
    );
  }
  const reader = response.body.getReader();
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let body = "";
  try {
    while (true) {
      if (signal.aborted) throw new Error("Aborted");
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > RESPONSE_LIMIT) {
        await reader.cancel();
        throw new CloudClientError(
          "Cloud response exceeds the size limit.",
          "invalid_response",
          response.status
        );
      }
      body += decoder.decode(next.value, { stream: true });
    }
    body += decoder.decode();
    return JSON.parse(body) as unknown;
  } catch (error) {
    if (error instanceof CloudClientError) throw error;
    throw new CloudClientError("Cloud returned invalid JSON.", "invalid_response", response.status);
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

/** A bounded origin-bound HTTP client; commands own polling and admission retries. */
export function createCloudClient(options: CloudClientOptions): CloudClient {
  const host = normalizeCloudHost(options.host);
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new CloudClientError(
      "Cloud request timeout must be between 1 and 120000 milliseconds.",
      "invalid_request"
    );
  }
  if (options.token !== undefined && !isCloudToken(options.token)) {
    throw new CloudClientError(
      "The Cloud credential is invalid. Run tubeless auth login again.",
      "unauthenticated"
    );
  }

  const request = async <T>(
    pathname: string,
    parse: (value: unknown) => T,
    requestOptions: {
      body?: unknown;
      nativeAuth?: boolean;
      devicePolling?: boolean;
      idempotencyKey?: string;
      bodyLimit?: number;
    } = {}
  ): Promise<T> => {
    const url = new URL(pathname, host);
    if (url.origin !== host) {
      throw new CloudClientError(
        "Cloud request must remain on the selected host.",
        "invalid_request"
      );
    }
    if (!requestOptions.nativeAuth && !options.token) {
      throw new CloudClientError(
        "No Cloud credential. Run tubeless auth login or set TUBELESS_TOKEN.",
        "unauthenticated"
      );
    }
    let body: string | undefined;
    if (requestOptions.body !== undefined) {
      try {
        body = JSON.stringify(requestOptions.body);
      } catch {
        throw new CloudClientError("Cloud request must contain JSON data.", "invalid_request");
      }
      const bodyLimit = requestOptions.bodyLimit ?? CLOUD_JSON_LIMIT;
      if (body === undefined || Buffer.byteLength(body, "utf8") > bodyLimit) {
        throw new CloudClientError(
          `Cloud request exceeds the ${bodyLimit / 1024} KB JSON limit.`,
          "invalid_request"
        );
      }
    }
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const headers = new Headers({ Accept: "application/json" });
    if (!requestOptions.nativeAuth) headers.set("Authorization", `Bearer ${options.token}`);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (requestOptions.idempotencyKey !== undefined) {
      headers.set("Idempotency-Key", requestOptions.idempotencyKey);
    }
    let removeAbortListener = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      const rejectAbort = () => reject(abortFailure(timedOut));
      removeAbortListener = () => controller.signal.removeEventListener("abort", rejectAbort);
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
      if (controller.signal.aborted) rejectAbort();
    });
    const send = async (): Promise<T> => {
      if (controller.signal.aborted) throw abortFailure(timedOut);
      const response = await fetcher(url, {
        method: body === undefined ? "GET" : "POST",
        headers,
        body,
        redirect: "error",
        credentials: "omit",
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw abortFailure(timedOut);
      }
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        void response.body?.cancel().catch(() => {});
        throw new CloudClientError(
          "Cloud redirects are rejected; select the service origin with --host.",
          "invalid_response",
          response.status
        );
      }
      const value = await responseJson(response, controller.signal);
      if (!response.ok) {
        if (requestOptions.nativeAuth) {
          const deviceError = parseCloudDeviceError(value);
          if (deviceError) {
            if (requestOptions.devicePolling) return parse(deviceError);
            throw new CloudClientError(
              safeMessage(deviceError.error_description ?? "Device authorization failed."),
              deviceError.error,
              response.status
            );
          }
        }
        const error = parseCliError(value);
        throw new CloudClientError(
          error
            ? safeMessage(error.message, options.token)
            : `Cloud request failed (HTTP ${response.status}).`,
          error?.code ?? (response.status === 429 ? "rate_limited" : "invalid_response"),
          response.status
        );
      }
      try {
        return parse(value);
      } catch {
        throw new CloudClientError(
          "Cloud returned an invalid response shape.",
          "invalid_response",
          response.status
        );
      }
    };
    try {
      return await Promise.race([send(), aborted]);
    } catch (error) {
      if (error instanceof CloudClientError) throw error;
      if (controller.signal.aborted) throw abortFailure(timedOut);
      // A fetch implementation's diagnostic may include credential headers.
      throw new CloudClientError(
        "Cloud request failed. Check the selected host and network connection.",
        "transport_error"
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      removeAbortListener();
    }
  };

  const workspacePath = (workspace: string) =>
    `/api/v1/workspaces/${encodeURIComponent(workspace)}`;
  return {
    host,
    session: () => request("/api/v1/session", parseCliSession),
    logout: () =>
      request(
        "/api/v1/auth/logout",
        (value) => {
          if (!isCloudObject(value) || value.ok !== true)
            throw new Error("Invalid logout response");
        },
        { body: {} }
      ),
    pipelines: (workspace) => request(`${workspacePath(workspace)}/pipelines`, parseCliPipelines),
    run: async (workspace, body, idempotencyKey) => {
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(idempotencyKey)) {
        throw new CloudClientError("Invalid Cloud run idempotency key.", "invalid_request");
      }
      validateRunInput(body.input);
      return request(`${workspacePath(workspace)}/runs`, parseCliRun, {
        body,
        idempotencyKey,
        bodyLimit: RUN_ENVELOPE_LIMIT,
      });
    },
    getRun: (workspace, runId) =>
      request(`${workspacePath(workspace)}/runs/${encodeURIComponent(runId)}`, parseCliRun),
    deviceCode: () =>
      request("/api/auth/device/code", parseCloudDeviceCode, {
        nativeAuth: true,
        body: { client_id: "tubeless-cli" },
      }),
    deviceToken: (deviceCode) =>
      request(
        "/api/auth/device/token",
        (value) => parseCloudDeviceError(value) ?? parseCloudDeviceSession(value),
        {
          nativeAuth: true,
          devicePolling: true,
          body: {
            client_id: "tubeless-cli",
            device_code: deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          },
        }
      ),
  };
}

/** Only open approval URLs from the selected service, never arbitrary redirect destinations. */
export function cloudVerificationUrl(host: string, value: string): string {
  const origin = normalizeCloudHost(host);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CloudClientError(
      "Cloud returned an invalid device verification URL.",
      "invalid_response"
    );
  }
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    value.includes("#") ||
    /^https?:\/\/[^/]*@/i.test(value)
  ) {
    throw new CloudClientError(
      "Cloud verification URL must belong to the selected host.",
      "invalid_response"
    );
  }
  return url.href;
}
