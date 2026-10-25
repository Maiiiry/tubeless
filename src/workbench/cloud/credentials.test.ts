import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNativeCredentialStore,
  resolveCloudCredential,
  type CloudCredential,
  type CloudCredentialStore,
} from "./credentials.js";

afterEach(() => vi.unstubAllGlobals());

function memoryStore(): CloudCredentialStore & { entries: Map<string, CloudCredential> } {
  const entries = new Map<string, CloudCredential>();
  return {
    entries,
    get: async (host) => entries.get(host),
    set: async (host, credential) => {
      entries.set(host, credential);
    },
    delete: async (host) => {
      entries.delete(host);
    },
  };
}

describe("Cloud credential resolution", () => {
  it("uses an environment session without reading or persisting the OS store", async () => {
    const store = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
    expect(
      await resolveCloudCredential("https://cloud.tubeless.io", {
        env: { TUBELESS_TOKEN: "headless-session" },
        store,
      })
    ).toEqual({ token: "headless-session", source: "environment" });
    expect(store.get).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
    expect(store.delete).not.toHaveBeenCalled();
  });

  it("keeps hosts isolated and removes only the selected expired credential", async () => {
    const store = memoryStore();
    store.entries.set("https://first.example", { token: "first", expiresAt: 100 });
    store.entries.set("https://second.example:8443", { token: "second", expiresAt: 200 });
    expect(
      await resolveCloudCredential("https://first.example/", { store, env: {}, now: () => 100 })
    ).toBeUndefined();
    expect(store.entries.has("https://first.example")).toBe(false);
    expect(
      await resolveCloudCredential("https://second.example:8443/", {
        store,
        env: {},
        now: () => 100,
      })
    ).toEqual({ token: "second", expiresAt: 200, source: "stored" });
  });

  it("rejects empty and header-injecting environment values without diagnostics containing them", async () => {
    for (const token of ["", "token\nX-Leak: secret", "token with spaces"]) {
      await expect(
        resolveCloudCredential("https://cloud.tubeless.io", { env: { TUBELESS_TOKEN: token } })
      ).rejects.toThrow("TUBELESS_TOKEN is empty or invalid");
    }
  });
});

describe("native Cloud credential store", () => {
  it("is lazy and uses an origin-specific native entry with local persistence", async () => {
    let reads = 0;
    const secrets = {
      get: vi.fn(async () => JSON.stringify({ token: "stored", expiresAt: 999 })),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => true),
    };
    vi.stubGlobal("Bun", {
      version: "1.4.2",
      get secrets() {
        reads++;
        return secrets;
      },
    });
    const store = createNativeCredentialStore();
    expect(reads).toBe(0);
    expect(await store.get("https://CLOUD.example:8443/")).toEqual({
      token: "stored",
      expiresAt: 999,
    });
    await store.set("https://cloud.example:8443/", { token: "new", expiresAt: 1000 });
    await store.delete("https://cloud.example:8443");
    expect(secrets.get).toHaveBeenCalledWith({
      service: "tubeless-cloud",
      name: "https://cloud.example:8443",
    });
    expect(secrets.set).toHaveBeenCalledWith({
      service: "tubeless-cloud",
      name: "https://cloud.example:8443",
      value: JSON.stringify({ token: "new", expiresAt: 1000 }),
      persist: "local",
    });
    expect(secrets.delete).toHaveBeenCalledWith({
      service: "tubeless-cloud",
      name: "https://cloud.example:8443",
    });
  });

  it("uses supported Bun 1.3.14's native defaults without an unsupported persistence option", async () => {
    const secrets = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => true),
    };
    vi.stubGlobal("Bun", { version: "1.3.14", secrets });
    await createNativeCredentialStore().set("https://cloud.example", {
      token: "stored",
      expiresAt: 999,
    });
    expect(secrets.set).toHaveBeenCalledWith({
      service: "tubeless-cloud",
      name: "https://cloud.example",
      value: JSON.stringify({ token: "stored", expiresAt: 999 }),
    });
  });

  it("reports unavailable storage and never provides a plaintext fallback", async () => {
    vi.stubGlobal("Bun", undefined);
    const store = createNativeCredentialStore();
    await expect(store.get("https://cloud.tubeless.io")).rejects.toThrow(
      "OS credential store requires Bun"
    );
    await expect(
      store.set("https://cloud.tubeless.io", { token: "new", expiresAt: 999 })
    ).rejects.toThrow("TUBELESS_TOKEN");
  });

  it("redacts native failures and rejects malformed stored records", async () => {
    const secrets = {
      get: vi.fn(async () => "invalid plaintext secret"),
      set: vi.fn(async () => {
        throw new Error("secret-value exposed by OS");
      }),
      delete: vi.fn(async () => {
        throw new Error("secret-value exposed by OS");
      }),
    };
    vi.stubGlobal("Bun", { secrets });
    const store = createNativeCredentialStore();
    await expect(store.get("https://cloud.tubeless.io")).rejects.toThrow(
      "saved Cloud credential is invalid"
    );
    await expect(
      store.set("https://cloud.tubeless.io", { token: "secret-value", expiresAt: 999 })
    ).rejects.toThrow("never saved to plaintext");
    await expect(store.delete("https://cloud.tubeless.io")).rejects.not.toThrow("secret-value");
    secrets.get.mockResolvedValue(JSON.stringify({ token: "stored", expiresAt: "tomorrow" }));
    await expect(store.get("https://cloud.tubeless.io")).rejects.toThrow(
      "saved Cloud credential is invalid"
    );
  });
});
