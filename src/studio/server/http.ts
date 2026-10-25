/** Format a host literal for an HTTP URL or authority. */
export function formatHttpUrlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

/** Normalize a bare HTTP authority, including omission of the default port. */
export function normalizeHttpAuthority(
  authority: string | undefined,
  protocol = "http:"
): string | undefined {
  if (!authority || /[\s\\/@?#]/.test(authority)) return undefined;
  try {
    const parsed = new URL(`${protocol}//${authority}/`);
    if (parsed.username || parsed.password || parsed.pathname !== "/") return undefined;
    return parsed.host.toLowerCase();
  } catch {
    return undefined;
  }
}

/** True for bind addresses that cannot appear in a client Host header. */
export function isUnspecifiedHttpHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

/** Split a normalized authority into hostname and port (empty port = default). */
export function parseHttpAuthority(
  authority: string | undefined
): { hostname: string; port: string } | undefined {
  const normalized = normalizeHttpAuthority(authority);
  if (!normalized) return undefined;
  try {
    const parsed = new URL(`http://${normalized}/`);
    const hostname = parsed.hostname.startsWith("[")
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;
    return { hostname, port: parsed.port };
  } catch {
    return undefined;
  }
}

export class StudioRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly hint: string
  ) {
    super(message);
  }
}

export function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new StudioRequestError(
      "malformed_path_segment",
      "Malformed path segment.",
      400,
      "Percent-encode the path segment as valid UTF-8."
    );
  }
}

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
} as const;

const MAX_REQUEST_BODY_BYTES = 65_536;

export function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(value), { status, headers: { ...JSON_HEADERS, ...headers } });
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  hint: string
): Response {
  return jsonResponse({ code, hint, message }, status);
}

/** Read at most 64 KiB of JSON without assuming a runtime-specific body helper. */
export async function readJsonBody(request: Request): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const reader = request.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel();
        throw new StudioRequestError(
          "request_body_too_large",
          "Request body exceeds 64 KiB.",
          413,
          "Send a JSON body no larger than 64 KiB."
        );
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new StudioRequestError(
      "invalid_json",
      "Request body must be valid JSON.",
      400,
      "Send a valid JSON object with content-type application/json."
    );
  }
}

export function unexpectedStudioErrorResponse(error: unknown): Response {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  return errorResponse(
    500,
    "studio_internal_error",
    "The studio hit an unexpected error.",
    "Inspect the local Studio process logs and retry after fixing the reported cause."
  );
}
