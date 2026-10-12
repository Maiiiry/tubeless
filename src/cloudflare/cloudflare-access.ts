import { errorResponse } from "../studio/run-store-ui-http.js";

export interface AccessConfig {
  readonly issuer: string;
  readonly certsUrl: string;
  readonly audience: string;
}

export interface AccessAuthenticatorOptions {
  readonly fetchJson?: (url: string) => Promise<unknown>;
  readonly now?: () => number;
  readonly refreshIntervalMs?: number;
}

const CLOCK_SKEW_SECONDS = 60;
// Keys older than this are not trusted, so rotated-out keys stop verifying without a restart.
const MAX_KEY_AGE_MS = 3_600_000;
const TEAM_DOMAIN = /^[a-z0-9-]+\.cloudflareaccess\.com$/;
const RSA_PARAMETERS = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/** Read the two Access bindings. Both unset means "not configured"; half-set is an operator error. */
export function parseAccessConfig(
  teamDomain: string | undefined,
  audience: string | undefined
): AccessConfig | undefined {
  const domain = teamDomain?.trim() ?? "";
  const aud = audience?.trim() ?? "";
  if (!domain && !aud) return undefined;
  if (!domain || !aud) throw new Error("ACCESS_TEAM_DOMAIN and ACCESS_AUD must both be set.");
  const host = domain
    .replace(/^https:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  if (!TEAM_DOMAIN.test(host)) {
    throw new Error("ACCESS_TEAM_DOMAIN must be <team>.cloudflareaccess.com.");
  }
  const issuer = `https://${host}`;
  return { issuer, certsUrl: `${issuer}/cdn-cgi/access/certs`, audience: aud };
}

function base64UrlBytes(segment: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) throw new Error("Invalid base64url.");
  const base64 = segment.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJson(segment: string): Record<string, unknown> {
  const value: unknown = JSON.parse(new TextDecoder().decode(base64UrlBytes(segment)));
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid JWT segment.");
  // SAFETY: checked to be a non-array object above.
  return value as Record<string, unknown>;
}

function denial(request: Request, status: 401 | 403): Response {
  if (new URL(request.url).pathname.startsWith("/api/")) {
    return status === 401
      ? errorResponse(
          401,
          "access_required",
          "Cloudflare Access sign-in is required.",
          "Open Studio again to sign in."
        )
      : errorResponse(
          403,
          "access_denied",
          "Cloudflare Access denied this request.",
          "Ask an administrator for access to this Studio."
        );
  }
  const message =
    status === 401
      ? "Cloudflare Access sign-in is required. Open Studio again to sign in.\n"
      : "Cloudflare Access denied this request. Ask an administrator for access.\n";
  return new Response(message, {
    status: 403,
    headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
  });
}

// Bound the certificate request so a hung fetch cannot stall requests sharing the refresh.
const CERTS_TIMEOUT_MS = 5_000;

async function defaultFetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(CERTS_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Access certificates request failed with ${response.status}.`);
  return response.json();
}

/** Verify Cf-Access-Jwt-Assertion on every request; never trust identity headers alone. */
export function createAccessAuthenticator(
  config: AccessConfig,
  options: AccessAuthenticatorOptions = {}
): (request: Request) => Promise<Response | undefined> {
  const fetchJson = options.fetchJson ?? defaultFetchJson;
  const now = options.now ?? Date.now;
  const refreshIntervalMs = options.refreshIntervalMs ?? 30_000;
  let keys = new Map<string, CryptoKey>();
  // Start time of the last successful refresh; governs key trust.
  let keysFetchedAtMs: number | undefined;
  // Start time of the last attempt; governs the refetch rate limit.
  let fetchedAtMs: number | undefined;
  // In-flight refresh shared by concurrent callers, so one fetch serves them all.
  let pending: Promise<void> | undefined;

  function keysAreFresh(): boolean {
    return keysFetchedAtMs !== undefined && now() - keysFetchedAtMs < MAX_KEY_AGE_MS;
  }

  async function refresh(): Promise<void> {
    const startedAt = now();
    fetchedAtMs = startedAt;
    const body = await fetchJson(config.certsUrl);
    const next = new Map<string, CryptoKey>();
    const entries =
      typeof body === "object" && body !== null && "keys" in body && Array.isArray(body.keys)
        ? body.keys
        : [];
    for (const entry of entries as unknown[]) {
      if (typeof entry !== "object" || entry === null) continue;
      // SAFETY: fields are checked individually before use.
      const jwk = entry as { kid?: unknown; kty?: unknown; n?: unknown; e?: unknown };
      if (
        typeof jwk.kid !== "string" ||
        jwk.kty !== "RSA" ||
        typeof jwk.n !== "string" ||
        typeof jwk.e !== "string"
      )
        continue;
      let key: CryptoKey;
      try {
        key = await crypto.subtle.importKey(
          "jwk",
          { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
          RSA_PARAMETERS,
          false,
          ["verify"]
        );
      } catch {
        // One malformed key must not drop the rest of the set.
        continue;
      }
      next.set(jwk.kid, key);
    }
    keys = next;
    keysFetchedAtMs = startedAt;
  }

  async function keyFor(kid: string): Promise<CryptoKey | undefined> {
    const cached = keys.get(kid);
    if (cached && keysAreFresh()) return cached;
    if (!pending) {
      if (fetchedAtMs !== undefined && now() - fetchedAtMs < refreshIntervalMs) return undefined;
      pending = refresh().finally(() => {
        pending = undefined;
      });
    }
    await pending;
    // Stale keys after a failed refresh must deny, so freshness is checked again here.
    const refreshed = keys.get(kid);
    return refreshed && keysAreFresh() ? refreshed : undefined;
  }

  return async (request) => {
    const jwt = request.headers.get("cf-access-jwt-assertion");
    if (!jwt) return denial(request, 401);
    const parts = jwt.split(".");
    if (parts.length !== 3) return denial(request, 401);
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    let signature: Uint8Array<ArrayBuffer>;
    try {
      header = decodeJson(encodedHeader);
      payload = decodeJson(encodedPayload);
      signature = base64UrlBytes(encodedSignature);
    } catch {
      return denial(request, 401);
    }
    if (header.alg !== "RS256" || typeof header.kid !== "string") return denial(request, 401);
    let key: CryptoKey | undefined;
    try {
      key = await keyFor(header.kid);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      return denial(request, 401);
    }
    if (!key) return denial(request, 401);
    let valid: boolean;
    try {
      valid = await crypto.subtle.verify(
        RSA_PARAMETERS.name,
        key,
        signature,
        new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
      );
    } catch {
      return denial(request, 401);
    }
    if (!valid) return denial(request, 401);
    const seconds = now() / 1000;
    if (typeof payload.exp !== "number" || seconds > payload.exp + CLOCK_SKEW_SECONDS)
      return denial(request, 401);
    if (
      payload.nbf !== undefined &&
      (typeof payload.nbf !== "number" || payload.nbf > seconds + CLOCK_SKEW_SECONDS)
    ) {
      return denial(request, 401);
    }
    if (payload.iss !== config.issuer) return denial(request, 403);
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(config.audience)) return denial(request, 403);
    return undefined;
  };
}
