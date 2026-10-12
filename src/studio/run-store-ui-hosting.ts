import { normalizeHttpAuthority } from "./run-store-ui-http.js";

/** Operator-owned configuration. Never serialize this object into the page. */
export interface StudioHosting {
  readonly publicUrl: string;
  readonly origin: string;
  readonly authority: string;
  readonly mount: string;
  readonly trustsAuthority: (authority: string | undefined) => boolean;
  readonly authenticates: (request: Request) => boolean;
}

/** Validate before loading user modules or opening resources. Errors contain no supplied values. */
export function parseStudioHosting(
  publicUrl: string | undefined,
  token: string | undefined
): StudioHosting | undefined {
  if (publicUrl === undefined) {
    if (token !== undefined)
      throw new Error("TUBELESS_STUDIO_GATEWAY_TOKEN requires --public-url.");
    return undefined;
  }
  if (!token || !/^[0-9a-fA-F]{64}$/.test(token)) {
    throw new Error(
      "--public-url requires TUBELESS_STUDIO_GATEWAY_TOKEN containing 64 hexadecimal characters (32 random bytes)."
    );
  }
  const invalidUrl = () =>
    new Error(
      "--public-url must be an absolute HTTPS URL (HTTP only on loopback), with an unreserved ASCII path and no credentials, query, fragment, or dot segments."
    );
  // Inspect the original spelling: URL parsing normalizes dot segments and backslashes.
  const match = /^(https?):\/\/([^/?#\\]+)(\/[^?#\\]*)?$/.exec(publicUrl);
  if (!match || /[\s@]/.test(match[2]!)) throw invalidUrl();
  const rawPath = match[3] ?? "/";
  const segments = rawPath.slice(1).split("/");
  if (segments.at(-1) === "") segments.pop();
  if (
    segments.some(
      (segment) => !/^[A-Za-z0-9_~.-]+$/.test(segment) || segment === "." || segment === ".."
    )
  )
    throw invalidUrl();
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    throw invalidUrl();
  }
  if (
    url.username ||
    url.password ||
    (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw invalidUrl();
  // Do not accept alternate numeric spellings that URL would coerce into loopback.
  if (
    url.protocol === "http:" &&
    !/^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/i.test(match[2]!)
  )
    throw invalidUrl();
  const authority = normalizeHttpAuthority(url.host, url.protocol);
  if (!authority) throw invalidUrl();
  const mount = segments.length ? "/" + segments.join("/") : "";
  const expected = hexBytes(token);
  return {
    publicUrl: url.origin + mount + "/",
    origin: url.origin,
    authority,
    mount,
    trustsAuthority: (value) => normalizeHttpAuthority(value, url.protocol) === authority,
    authenticates(request) {
      // Fetch joins duplicate headers with ", ", which fails this pattern, so duplicates stay rejected.
      const header = request.headers.get("authorization");
      if (!header || !/^Bearer [0-9a-fA-F]{64}$/.test(header)) return false;
      return constantTimeEqual(expected, hexBytes(header.slice(7)));
    },
  };
}

/** Precondition: already-validated even-length hex (callers match the 64-hex pattern first). */
function hexBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Compare equal-length secrets without data-dependent early exit. */
export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

/** Preserve opaque encoded route IDs; only reject ambiguous path structure. */
export function studioRoute(
  rawTarget: string,
  mount: string
): { path: string; search: string } | undefined {
  if (!rawTarget.startsWith("/") || rawTarget.startsWith("//") || /[\\#\s]/.test(rawTarget))
    return undefined;
  const query = rawTarget.indexOf("?");
  const path = query < 0 ? rawTarget : rawTarget.slice(0, query);
  const search = query < 0 ? "" : rawTarget.slice(query);
  if (path.split("/").some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment))) return undefined;
  if (path === mount) return { path: "", search };
  if (!path.startsWith(mount + "/")) return undefined;
  const route = path.slice(mount.length);
  if (route.includes("//")) return undefined;
  return { path: route, search };
}
