import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createAccessAuthenticator,
  parseAccessConfig,
  type AccessConfig,
} from "./cloudflare-access.js";

const AUD = "4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2";
const config = parseAccessConfig("https://team.cloudflareaccess.com/", AUD) as AccessConfig;
let keys: CryptoKeyPair;
type TestJwk = JsonWebKey & { readonly kid: string };
let jwk: TestJwk;
const NOW = 1_800_000_000_000;
const MAX_KEY_AGE_MS = 3_600_000;

const encode = (value: unknown) =>
  btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Sign an arbitrary header and claim set with the test key; claims default to a valid token at NOW. */
async function sign(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  key = keys.privateKey
) {
  const head = encode(header);
  const body = encode({ iss: config.issuer, aud: [AUD], exp: NOW / 1000 + 300, ...claims });
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`))
  );
  return `${head}.${body}.${base64url(signature)}`;
}

async function token(claims: Record<string, unknown>, kid = "k1", key = keys.privateKey) {
  return sign({ alg: "RS256", kid, typ: "JWT" }, claims, key);
}

const request = (jwt?: string, path = "/api/snapshot") =>
  new Request(
    `https://studio.example${path}`,
    jwt ? { headers: { "cf-access-jwt-assertion": jwt } } : {}
  );

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1" } as TestJwk;
});

interface Harness {
  readonly count?: { value: number };
  readonly clock?: { now: number };
  readonly jwks?: TestJwk[];
  readonly fetchJson?: (url: string) => Promise<unknown>;
  readonly refreshIntervalMs?: number;
}

function authenticator(harness: Harness = {}) {
  const count = harness.count ?? { value: 0 };
  const clock = harness.clock ?? { now: NOW };
  const jwks = harness.jwks ?? [jwk];
  return createAccessAuthenticator(config, {
    now: () => clock.now,
    refreshIntervalMs: harness.refreshIntervalMs,
    fetchJson:
      harness.fetchJson ??
      (async (url) => {
        expect(url).toBe("https://team.cloudflareaccess.com/cdn-cgi/access/certs");
        count.value += 1;
        return { keys: jwks };
      }),
  });
}

describe("Access configuration", () => {
  it("normalizes the team domain and rejects partial or foreign config", () => {
    expect(config).toEqual({
      issuer: "https://team.cloudflareaccess.com",
      certsUrl: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
      audience: AUD,
    });
    expect(parseAccessConfig(undefined, undefined)).toBeUndefined();
    expect(parseAccessConfig("", "")).toBeUndefined();
    expect(() => parseAccessConfig("team.cloudflareaccess.com", undefined)).toThrow(/both/);
    expect(() => parseAccessConfig("evil.example.com", AUD)).toThrow(/cloudflareaccess\.com/);
  });
});

describe("Access authenticator", () => {
  it("accepts a valid token with an array or string audience", async () => {
    expect(await authenticator()(request(await token({})))).toBeUndefined();
    expect(await authenticator()(request(await token({ aud: AUD })))).toBeUndefined();
  });

  it("tolerates 60 seconds of skew and no more", async () => {
    expect(await authenticator()(request(await token({ exp: NOW / 1000 - 59 })))).toBeUndefined();
    expect((await authenticator()(request(await token({ exp: NOW / 1000 - 61 }))))?.status).toBe(
      401
    );
    expect((await authenticator()(request(await token({ nbf: NOW / 1000 + 61 }))))?.status).toBe(
      401
    );
  });

  it("returns 401 for missing, malformed and forged tokens", async () => {
    const auth = authenticator();
    expect(await (await auth(request()))!.json()).toMatchObject({ code: "access_required" });
    expect((await auth(request("a.b")))?.status).toBe(401);
    const other = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"]
    )) as CryptoKeyPair;
    expect((await auth(request(await token({}, "k1", other.privateKey))))?.status).toBe(401);
    expect(
      (await auth(request(`${encode({ alg: "none", kid: "k1" })}.${encode({})}.`)))?.status
    ).toBe(401);
  });

  it("rejects RS512 headers and missing kid even when the signature is valid", async () => {
    const auth = authenticator();
    expect(
      (await auth(request(await sign({ alg: "RS512", kid: "k1", typ: "JWT" }, {}))))?.status
    ).toBe(401);
    expect((await auth(request(await sign({ alg: "RS256", typ: "JWT" }, {}))))?.status).toBe(401);
  });

  it("rejects tokens with a missing or non-numeric exp", async () => {
    const auth = authenticator();
    expect((await auth(request(await token({ exp: undefined }))))?.status).toBe(401);
    expect((await auth(request(await token({ exp: "soon" }))))?.status).toBe(401);
  });

  it("returns 403 for a foreign issuer or audience", async () => {
    expect((await authenticator()(request(await token({ aud: ["other"] }))))?.status).toBe(403);
    expect(
      (await authenticator()(request(await token({ iss: "https://evil.cloudflareaccess.com" }))))
        ?.status
    ).toBe(403);
  });

  it("answers page requests with plain text", async () => {
    const response = await authenticator()(request(undefined, "/"));
    expect(response?.status).toBe(403);
    expect(response?.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await response?.text()).toMatch(/sign-in is required/);
  });

  it("answers page requests denied by issuer or audience with an administrator message", async () => {
    const response = await authenticator()(request(await token({ aud: ["other"] }), "/"));
    expect(response?.status).toBe(403);
    expect(await response?.text()).toMatch(/denied this request/);
  });

  it("caches keys and rate-limits refetches for unknown key ids", async () => {
    const count = { value: 0 };
    const auth = authenticator({ count });
    await auth(request(await token({})));
    await auth(request(await token({})));
    expect(count.value).toBe(1);
    expect((await auth(request(await token({}, "unknown"))))?.status).toBe(401);
    expect((await auth(request(await token({}, "unknown"))))?.status).toBe(401);
    expect(count.value).toBe(1);
  });

  it("refetches a new kid once refreshIntervalMs has elapsed", async () => {
    const count = { value: 0 };
    const clock = { now: NOW };
    const jwks = [jwk];
    const auth = authenticator({ count, clock, jwks });
    await auth(request(await token({})));
    jwks.push({ ...jwk, kid: "k2" });
    expect((await auth(request(await token({}, "k2"))))?.status).toBe(401);
    expect(count.value).toBe(1);
    clock.now = NOW + 30_000;
    expect(await auth(request(await token({}, "k2")))).toBeUndefined();
    expect(count.value).toBe(2);
  });

  it("denies without throwing when the certificate fetch rejects", async () => {
    const auth = authenticator({
      fetchJson: async () => {
        throw new Error("network down");
      },
    });
    expect((await auth(request(await token({}))))?.status).toBe(401);
  });

  it("denies once the default certificate request hangs for five seconds", async () => {
    vi.useFakeTimers();
    // Node's AbortSignal.timeout uses internal timers that fake timers cannot advance.
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
        ms
      );
      return controller.signal;
    });
    const hungFetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        })
    );
    vi.stubGlobal("fetch", hungFetch);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const auth = createAccessAuthenticator(config, { now: () => NOW });
      let settled = false;
      const outcome = auth(request(await token({}))).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(hungFetch).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await outcome)?.status).toBe(401);
      expect(timeout).toHaveBeenCalledWith(5_000);
      expect(hungFetch).toHaveBeenCalledWith(config.certsUrl, {
        signal: expect.any(AbortSignal),
      });
      expect(errors).toHaveBeenCalledWith("The operation timed out.");
    } finally {
      errors.mockRestore();
      vi.unstubAllGlobals();
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it("denies without throwing when WebCrypto verification throws", async () => {
    const auth = authenticator();
    expect(await auth(request(await token({})))).toBeUndefined();
    const verify = vi
      .spyOn(crypto.subtle, "verify")
      .mockRejectedValueOnce(new DOMException("operation failed", "OperationError"));
    try {
      expect((await auth(request(await token({}))))?.status).toBe(401);
    } finally {
      verify.mockRestore();
    }
  });

  it("shares one fetch between concurrent first requests", async () => {
    const count = { value: 0 };
    const auth = authenticator({ count });
    const [first, second] = [await token({}), await token({})];
    const results = await Promise.all([auth(request(first)), auth(request(second))]);
    expect(results).toEqual([undefined, undefined]);
    expect(count.value).toBe(1);
  });

  it("keeps the other keys when one JWK fails to import", async () => {
    // Node's importKey accepts most malformed RSA JWKs, so the first import is forced to reject.
    const auth = authenticator({
      jwks: [{ kid: "bad", kty: "RSA", n: "AAAA", e: "AQAB" } as TestJwk, jwk],
    });
    const importKey = vi
      .spyOn(crypto.subtle, "importKey")
      .mockRejectedValueOnce(new DOMException("malformed key", "DataError"));
    try {
      expect(await auth(request(await token({})))).toBeUndefined();
    } finally {
      importKey.mockRestore();
    }
  });

  it("stops trusting keys that have aged out of the JWKS", async () => {
    const clock = { now: NOW };
    const jwks = [jwk];
    const auth = authenticator({ clock, jwks });
    expect(await auth(request(await token({})))).toBeUndefined();
    clock.now = NOW + MAX_KEY_AGE_MS;
    const exp = clock.now / 1000 + 300;
    jwks.splice(0, jwks.length, { ...jwk, kid: "k2" });
    expect((await auth(request(await token({ exp }))))?.status).toBe(401);
    expect(await auth(request(await token({ exp }, "k2")))).toBeUndefined();
  });

  it("keeps accepting an aged key that is still in the JWKS", async () => {
    const clock = { now: NOW };
    const auth = authenticator({ clock });
    expect(await auth(request(await token({})))).toBeUndefined();
    clock.now = NOW + MAX_KEY_AGE_MS;
    const exp = clock.now / 1000 + 300;
    expect(await auth(request(await token({ exp })))).toBeUndefined();
  });

  it("denies stale keys when the refresh after aging fails", async () => {
    const clock = { now: NOW };
    let failing = false;
    const auth = authenticator({
      clock,
      fetchJson: async () => {
        if (failing) throw new Error("network down");
        return { keys: [jwk] };
      },
    });
    expect(await auth(request(await token({})))).toBeUndefined();
    failing = true;
    clock.now = NOW + MAX_KEY_AGE_MS;
    const exp = clock.now / 1000 + 300;
    expect((await auth(request(await token({ exp }))))?.status).toBe(401);
  });
});
