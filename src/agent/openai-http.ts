import { throwIfAborted } from "../utilities/abort.js";
import { record } from "./provider-schema.js";
import { providerBaseUrl, providerRequest, readProviderJson } from "./provider-http.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const MAX_ERROR_RESPONSE_BYTES = 16_384;

async function authenticationFailure(response: Response, signal: AbortSignal): Promise<string> {
  let body: unknown;
  try {
    body = await readProviderJson(response, signal, MAX_ERROR_RESPONSE_BYTES, "OpenAI");
  } catch {
    throwIfAborted(signal, "OpenAI response");
    // A missing, malformed, oversized or unreadable error body does not hide the HTTP status.
  }
  const code = record(body) && record(body.error) ? body.error.code : undefined;
  // Never print raw error.message or unknown codes: providers may echo API keys in them.
  if (code === "invalid_api_key")
    return "[invalid_api_key] The API key was rejected. Use an active API key from the correct OpenAI project.";
  if (code === "ip_not_authorized")
    return "[ip_not_authorized] Your IP is not on the project's or organization's allowlist. Use an allowed network or update the OpenAI IP allowlist.";
  return "Authentication was rejected. Check that the API key is active, its project and organization are accessible, and your IP is allowed.";
}

export async function openaiRequest(
  endpoint: "responses" | "responses/compact",
  payload: object,
  apiKey: string | undefined,
  signal: AbortSignal,
  baseUrl?: string
): Promise<unknown> {
  const key = (apiKey ?? process.env.OPENAI_API_KEY)?.trim();
  if (!key) throw new Error("OPENAI_API_KEY is required for live model execution");
  const base = providerBaseUrl(
    "OpenAI",
    baseUrl ?? (process.env.OPENAI_BASE_URL?.trim() || DEFAULT_BASE_URL)
  );
  return providerRequest(
    "OpenAI",
    endpoint,
    `${base}/${endpoint}`,
    { Authorization: `Bearer ${key}` },
    payload,
    signal,
    async (response) => {
      const advice = response.status === 401 ? await authenticationFailure(response, signal) : "";
      if (response.status !== 401) await response.body?.cancel().catch(() => {});
      const requestId = response.headers.get("x-request-id");
      const request =
        requestId && /^req_[A-Za-z0-9_-]{1,128}$/.test(requestId) && !requestId.includes(key)
          ? ` Request ID: ${requestId}.`
          : "";
      return `${advice ? `: ${advice}` : ""}${request}`;
    }
  );
}
