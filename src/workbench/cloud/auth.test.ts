import { describe, expect, it, vi } from "vitest";
import { runAuth } from "./auth.js";
import { captureIo } from "../workbench.test-support.js";
import type { CloudCredentialStore, CloudCredential } from "./credentials.js";

const host = "http://localhost:8787";
const session = {
  user: { id: "u", login: "user", name: "User", email: "user@example.com", avatar: "" },
  expiresAt: 9999999999999,
  workspaces: [],
};
function storeFixture(): CloudCredentialStore & { entries: Map<string, CloudCredential> } {
  const entries = new Map<string, CloudCredential>();
  return {
    entries,
    get: async (origin) => entries.get(origin),
    set: async (origin, credential) => {
      entries.set(origin, credential);
    },
    delete: async (origin) => {
      entries.delete(origin);
    },
  };
}
function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function loginFetch(polls: unknown[], calls: string[] = []): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const pathname = new URL(String(input)).pathname;
    calls.push(pathname);
    if (pathname === "/api/auth/device/code")
      return json({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: `${host}/device`,
        verification_uri_complete: `${host}/device?user_code=ABCD-EFGH`,
        expires_in: 600,
        interval: 5,
      });
    if (pathname === "/api/auth/device/token") return json(polls.shift(), 200);
    if (pathname === "/api/v1/auth/logout") return json({ ok: true });
    if (pathname === "/api/v1/session") return json(session);
    throw new Error("Unexpected route");
  }) as typeof fetch;
}

describe("Cloud authentication commands", () => {
  it("help touches neither HTTP nor credentials", async () => {
    const fetcher = vi.fn();
    const store = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
    const io = captureIo("/detached");
    expect(await runAuth(["--help"], io, { fetch: fetcher, store })).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled();
  });
  it("honors pending and slow_down then stores a host-specific expiring session", async () => {
    const store = storeFixture();
    const io = captureIo("/detached");
    const sleep = vi.fn(async (_milliseconds: number) => {});
    const result = await runAuth(["login", "--host", host, "--no-browser"], io, {
      env: {},
      store,
      sleep,
      now: () => 1000,
      fetch: loginFetch([
        { error: "authorization_pending" },
        { error: "slow_down" },
        { access_token: "session-secret", token_type: "Bearer", scope: "", expires_in: 3600 },
      ]),
    });
    expect(result).toBe(0);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([5000, 5000, 10000]);
    expect(store.entries.get(host)).toEqual({ token: "session-secret", expiresAt: 3601000 });
    expect(io.output.join("")).toContain("ABCD-EFGH");
    expect(io.output.join("") + io.errors.join("")).not.toContain("session-secret");
    expect(io.output.join("")).not.toContain("device-secret");
  });
  it("prints instructions after browser launch failure and handles denial", async () => {
    const io = captureIo("/detached");
    const store = storeFixture();
    expect(
      await runAuth(["login", "--host", host], io, {
        env: {},
        store,
        sleep: async () => {},
        fetch: loginFetch([{ error: "access_denied" }]),
        openBrowser: async () => {
          throw new Error("failure");
        },
      })
    ).toBe(2);
    expect(io.errors.join("")).toContain("printed URL");
    expect(store.entries.size).toBe(0);
  });
  it("rejects a cross-origin verification URL without opening it", async () => {
    const io = captureIo("/detached");
    const browser = vi.fn();
    const fetcher = vi.fn(async () =>
      json({
        device_code: "code",
        user_code: "ABCD",
        verification_uri: "https://evil.example/device",
        verification_uri_complete: "https://evil.example/device",
        expires_in: 600,
        interval: 5,
      })
    ) as typeof fetch;
    expect(
      await runAuth(["login", "--host", host], io, {
        env: {},
        store: storeFixture(),
        fetch: fetcher,
        openBrowser: browser,
      })
    ).toBe(2);
    expect(browser).not.toHaveBeenCalled();
  });
  it("revokes a newly issued session if secure storage fails", async () => {
    const io = captureIo("/detached");
    const calls: string[] = [];
    const store = storeFixture();
    store.set = async () => {
      throw new Error("Secure store unavailable");
    };
    expect(
      await runAuth(["login", "--host", host, "--no-browser"], io, {
        env: {},
        store,
        sleep: async () => {},
        fetch: loginFetch(
          [{ access_token: "session-secret", token_type: "Bearer", scope: "", expires_in: 60 }],
          calls
        ),
      })
    ).toBe(2);
    expect(calls).toContain("/api/v1/auth/logout");
    expect(io.errors.join("")).not.toContain("session-secret");
  });
  it("status verifies the environment session remotely without exposing it", async () => {
    const io = captureIo("/detached");
    const store = storeFixture();
    expect(
      await runAuth(["status", "--host", host, "--json"], io, {
        store,
        env: { TUBELESS_TOKEN: "environment-secret" },
        fetch: loginFetch([]),
      })
    ).toBe(0);
    expect(JSON.parse(io.output.join(""))).toMatchObject({
      host,
      credentialSource: "environment",
      user: session.user,
    });
    expect(io.output.join("")).not.toContain("environment-secret");
    expect(store.entries.size).toBe(0);
  });
  it("logout never revokes environment tokens", async () => {
    const io = captureIo("/detached");
    const fetcher = vi.fn();
    expect(
      await runAuth(["logout", "--host", host], io, {
        env: { TUBELESS_TOKEN: "secret" },
        fetch: fetcher,
        store: storeFixture(),
      })
    ).toBe(2);
    expect(fetcher).not.toHaveBeenCalled();
    expect(io.errors.join("")).toContain("Remove it");
  });

  it("sanitizes human session identity and preserves JSON identity", async () => {
    const remote = "remote\u001b[2J\u009b\u202e\nspoof";
    const response = { ...session, user: { ...session.user, name: remote, email: remote } };
    for (const json of [false, true]) {
      const io = captureIo("/detached");
      expect(
        await runAuth(["status", "--host", host, ...(json ? ["--json"] : [])], io, {
          env: { TUBELESS_TOKEN: "secret" },
          store: storeFixture(),
          fetch: async () => Response.json(response),
        })
      ).toBe(0);
      if (json) expect(JSON.parse(io.output.join("")).user).toEqual(response.user);
      else {
        expect(io.output.join("")).not.toMatch(/[\u001b\u009b\u202e]/);
        expect(io.output.join("")).toContain("remote [2J   spoof (remote [2J   spoof)\n");
      }
    }
  });

  it("sanitizes the displayed device code", async () => {
    const remote = "ABCD\u001b[2J\u009b\u202e\nspoof";
    const original = loginFetch([{ error: "access_denied" }]);
    const io = captureIo("/detached");
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      const response = await original(url, init);
      if (String(url).endsWith("/device/code"))
        return Response.json({ ...(await response.json()), user_code: remote });
      return response;
    }) as typeof fetch;
    expect(
      await runAuth(["login", "--host", host, "--no-browser"], io, {
        env: {},
        store: storeFixture(),
        sleep: async () => {},
        fetch: fetcher,
      })
    ).toBe(2);
    expect(io.output.join("")).toContain("Confirm code: ABCD [2J   spoof\n");
    expect(io.output.join("")).not.toMatch(/[\u001b\u009b\u202e]/);
  });
  it("logout clears the local entry even if remote revocation fails", async () => {
    const io = captureIo("/detached");
    const store = storeFixture();
    await store.set(host, { token: "secret", expiresAt: Date.now() + 10000 });
    expect(
      await runAuth(["logout", "--host", host], io, {
        env: {},
        store,
        fetch: async () => {
          throw new Error("network down");
        },
      })
    ).toBe(2);
    expect(store.entries.size).toBe(0);
    expect(io.errors.join("")).toContain("could remain valid");
  });
  it("interruption stops login polling without storing anything", async () => {
    const io = { ...captureIo("/detached"), signal: AbortSignal.abort() };
    const store = storeFixture();
    expect(
      await runAuth(["login", "--host", host], io, { store, env: {}, fetch: loginFetch([]) })
    ).toBe(7);
    expect(store.entries.size).toBe(0);
  });
});
