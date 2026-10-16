import { throwIfAborted } from "../utilities/abort.js";

export const MAX_REQUEST_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 2_097_152;

/** Resolve an http(s) base URL without a trailing slash, or throw a provider-labelled error. */
export function providerBaseUrl(provider: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`Invalid ${provider} base URL`);
  }
  // Endpoints are appended to the path, so a query or fragment would swallow them.
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.search || url.hash)
    throw new Error(`Invalid ${provider} base URL`);
  return url.href.replace(/\/+$/, "");
}

/** Read a bounded JSON body. The caller labels abort and size errors with `provider`. */
export async function readProviderJson(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
  provider: string
): Promise<unknown> {
  if (!response.body) throw new Error(`${provider} returned an empty response`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      throwIfAborted(signal, `${provider} response`);
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error(`${provider} response exceeds ${maxBytes} bytes`);
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  throwIfAborted(signal, `${provider} response`);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error(`${provider} returned invalid JSON`);
  }
}

/**
 * POST bounded JSON to a model provider.
 * `onHttpError` owns the body and returns text appended to the status error.
 * Without it, the body is discarded so provider text never reaches diagnostics.
 */
export async function providerRequest(
  provider: string,
  endpoint: string,
  url: string,
  headers: Readonly<Record<string, string>>,
  payload: object,
  signal: AbortSignal,
  onHttpError?: (response: Response) => Promise<string>
): Promise<unknown> {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES)
    throw new Error(`${provider} request exceeds 1 MiB`);
  throwIfAborted(signal, `${provider} request`);
  const response = await fetch(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    signal,
    body,
  });
  if (!response.ok) {
    const extra = onHttpError ? await onHttpError(response) : "";
    if (!onHttpError) await response.body?.cancel().catch(() => {});
    throw new Error(`${provider} ${endpoint} failed (HTTP ${response.status})${extra}`);
  }
  return readProviderJson(response, signal, MAX_RESPONSE_BYTES, provider);
}
