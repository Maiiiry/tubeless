/** Internal transport contracts for the first-party Cloud CLI API. */
export type CloudJsonValue =
  | null
  | string
  | number
  | boolean
  | CloudJsonValue[]
  | { [key: string]: CloudJsonValue };

export type CloudRole = "owner" | "admin" | "member" | "viewer";
export const CLOUD_INPUT_MAX_DEPTH = 128;
export type CloudRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface CliWorkspace {
  id: string;
  name: string;
  slug: string;
  role: CloudRole;
}

export interface CliSession {
  user: { id: string; login: string; name: string; email: string; avatar: string };
  expiresAt: number;
  workspaces: CliWorkspace[];
}

export interface CliPipeline {
  id: string;
  name: string;
  slug: string;
  branch: string;
  commit: string;
  enabled: boolean;
  available: boolean;
}

export interface CliRunRequest {
  pipelineId: string;
  input: Record<string, CloudJsonValue>;
}

export interface CliLogLine {
  time: number;
  level: "info" | "warn" | "error";
  message: string;
}

export interface CliRun {
  id: string;
  pipelineId: string;
  pipelineName: string;
  status: CloudRunStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs: number;
  commit: string;
  branch: string;
  trigger: "manual" | "push" | "rerun" | "schedule";
  schedule?: { id: string; name: string; scheduledAt: number; timezone: string };
  actor: string;
  steps: {
    id: string;
    name: string;
    status: CloudRunStatus | "pending" | "skipped";
    durationMs: number;
    dependencies: string[];
    error?: string;
  }[];
  logs: CliLogLine[];
  artifacts: { name: string; size: number; contentType: string }[];
  result?: CloudJsonValue;
  error?: string;
  input: Record<string, CloudJsonValue>;
}

export interface CloudDeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface CloudDeviceSession {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
}

export interface CloudDeviceError {
  error: string;
  error_description?: string;
}

export type CliErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "quota_exceeded"
  | "unavailable"
  | "internal_error";

const RUN_STATUSES = ["queued", "running", "completed", "failed", "cancelled"];
const ERROR_CODES = [
  "unauthenticated",
  "forbidden",
  "invalid_request",
  "not_found",
  "conflict",
  "rate_limited",
  "quota_exceeded",
  "unavailable",
  "internal_error",
];

export function isCloudObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Check finite, depth-bounded JSON without recursion or silently dropping data. */
export function isCloudJsonValue(value: unknown): value is CloudJsonValue {
  const pending: ({ value: unknown; depth: number } | { leave: object })[] = [{ value, depth: 1 }];
  const ancestors = new WeakSet<object>();
  while (pending.length) {
    const next = pending.pop()!;
    if ("leave" in next) {
      ancestors.delete(next.leave);
      continue;
    }
    const current = next.value;
    if (current === null || typeof current === "string" || typeof current === "boolean") continue;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return false;
      continue;
    }
    if (typeof current !== "object") return false;
    if (next.depth > CLOUD_INPUT_MAX_DEPTH) return false;
    if (!Array.isArray(current)) {
      const prototype: unknown = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) return false;
    }
    if (ancestors.has(current)) return false;
    ancestors.add(current);
    pending.push({ leave: current });
    for (const child of Array.isArray(current) ? current : Object.values(current))
      pending.push({ value: child, depth: next.depth + 1 });
  }
  return true;
}

function text(value: unknown, allowEmpty = false): value is string {
  return typeof value === "string" && (allowEmpty || value.length > 0);
}

function number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function optionalText(value: unknown): boolean {
  return value === undefined || text(value, true);
}

function timestamp(value: unknown): value is number {
  return number(value) && value <= 8.64e15;
}

function optionalTimestamp(value: unknown): boolean {
  return value === undefined || timestamp(value);
}

function hasTexts(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => text(value[field], true));
}

function oneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

export function isCloudToken(value: unknown): value is string {
  return text(value) && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value);
}

function parseResponse<T>(value: unknown, valid: boolean, name: string): T {
  if (!valid) throw new Error(`Invalid Cloud ${name} response.`);
  // SAFETY: each caller checks the complete transport shape before returning it.
  return value as T;
}

export function parseCliSession(value: unknown): CliSession {
  const valid =
    isCloudObject(value) &&
    timestamp(value.expiresAt) &&
    isCloudObject(value.user) &&
    hasTexts(value.user, ["id", "login", "name", "email", "avatar"]) &&
    text(value.user.id) &&
    Array.isArray(value.workspaces) &&
    value.workspaces.every(
      (workspace: unknown) =>
        isCloudObject(workspace) &&
        hasTexts(workspace, ["id", "name", "slug"]) &&
        text(workspace.id) &&
        oneOf(workspace.role, ["owner", "admin", "member", "viewer"])
    );
  return parseResponse(value, valid, "session");
}

function isPipeline(value: unknown): boolean {
  return (
    isCloudObject(value) &&
    ["id", "name", "slug", "branch", "commit"].every((field) => text(value[field])) &&
    typeof value.enabled === "boolean" &&
    typeof value.available === "boolean"
  );
}

export function parseCliPipelines(value: unknown): CliPipeline[] {
  return parseResponse(value, Array.isArray(value) && value.every(isPipeline), "pipelines");
}

export function parseCliRun(value: unknown): CliRun {
  const valid =
    isCloudObject(value) &&
    ["id", "pipelineId", "pipelineName", "commit", "branch", "actor"].every((field) =>
      text(value[field])
    ) &&
    oneOf(value.status, RUN_STATUSES) &&
    oneOf(value.trigger, ["manual", "push", "rerun", "schedule"]) &&
    timestamp(value.createdAt) &&
    number(value.durationMs) &&
    optionalTimestamp(value.startedAt) &&
    optionalTimestamp(value.finishedAt) &&
    optionalText(value.error) &&
    isCloudObject(value.input) &&
    isCloudJsonValue(value.input) &&
    (value.result === undefined || isCloudJsonValue(value.result)) &&
    (value.schedule === undefined ||
      (isCloudObject(value.schedule) &&
        hasTexts(value.schedule, ["id", "name", "timezone"]) &&
        timestamp(value.schedule.scheduledAt))) &&
    Array.isArray(value.steps) &&
    value.steps.every(
      (step: unknown) =>
        isCloudObject(step) &&
        hasTexts(step, ["id", "name"]) &&
        oneOf(step.status, [...RUN_STATUSES, "pending", "skipped"]) &&
        number(step.durationMs) &&
        optionalText(step.error) &&
        Array.isArray(step.dependencies) &&
        step.dependencies.every((dependency: unknown) => text(dependency))
    ) &&
    Array.isArray(value.logs) &&
    value.logs.length <= 400 &&
    value.logs.every(
      (log: unknown) =>
        isCloudObject(log) &&
        timestamp(log.time) &&
        oneOf(log.level, ["info", "warn", "error"]) &&
        text(log.message, true)
    ) &&
    Array.isArray(value.artifacts) &&
    value.artifacts.every(
      (artifact: unknown) =>
        isCloudObject(artifact) &&
        hasTexts(artifact, ["name", "contentType"]) &&
        number(artifact.size)
    );
  return parseResponse(value, valid, "run");
}

export function parseCloudDeviceCode(value: unknown): CloudDeviceCode {
  const valid =
    isCloudObject(value) &&
    ["device_code", "user_code", "verification_uri", "verification_uri_complete"].every((field) =>
      text(value[field])
    ) &&
    number(value.expires_in) &&
    value.expires_in > 0 &&
    value.expires_in <= 3600 &&
    number(value.interval) &&
    value.interval > 0 &&
    value.interval <= 60;
  return parseResponse(value, valid, "device authorization");
}

export function parseCloudDeviceSession(value: unknown): CloudDeviceSession {
  return parseResponse(
    value,
    isCloudObject(value) &&
      isCloudToken(value.access_token) &&
      value.token_type === "Bearer" &&
      number(value.expires_in) &&
      value.expires_in > 0 &&
      value.expires_in <= 365 * 24 * 60 * 60 &&
      text(value.scope, true),
    "device session"
  );
}

export function parseCliError(value: unknown): { code: CliErrorCode; message: string } | undefined {
  if (
    !isCloudObject(value) ||
    !isCloudObject(value.error) ||
    !oneOf(value.error.code, ERROR_CODES) ||
    !text(value.error.message)
  ) {
    return undefined;
  }
  // SAFETY: the error code allowlist and message were checked above.
  return value.error as { code: CliErrorCode; message: string };
}

export function parseCloudDeviceError(value: unknown): CloudDeviceError | undefined {
  if (!isCloudObject(value) || !text(value.error) || !optionalText(value.error_description)) {
    return undefined;
  }
  return {
    error: value.error,
    ...(value.error_description === undefined
      ? {}
      : { error_description: String(value.error_description) }),
  };
}
