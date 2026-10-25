import { normalizeCloudHost } from "./config.js";
import { isCloudObject, isCloudToken } from "./protocol.js";

export interface CloudCredential {
  token: string;
  expiresAt: number;
}

export interface CloudCredentialStore {
  get(host: string): Promise<CloudCredential | undefined>;
  set(host: string, credential: CloudCredential): Promise<void>;
  delete(host: string): Promise<void>;
}

export interface ResolvedCloudCredential {
  token: string;
  source: "environment" | "stored";
  expiresAt?: number;
}

interface NativeSecretOptions {
  service: string;
  name: string;
}

interface NativeSecrets {
  get(options: NativeSecretOptions): Promise<string | null>;
  set(options: NativeSecretOptions & { value: string; persist?: "local" }): Promise<void>;
  delete(options: NativeSecretOptions): Promise<boolean>;
}

function parseCredential(value: unknown): CloudCredential {
  if (
    !isCloudObject(value) ||
    !isCloudToken(value.token) ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt <= 0
  ) {
    throw new Error("The saved Cloud credential is invalid. Run tubeless auth login again.");
  }
  return { token: value.token, expiresAt: value.expiresAt };
}

function nativeSecrets(): NativeSecrets {
  const bun: unknown = Reflect.get(globalThis, "Bun");
  const secrets: unknown = isCloudObject(bun) ? bun.secrets : undefined;
  if (
    !isCloudObject(secrets) ||
    typeof secrets.get !== "function" ||
    typeof secrets.set !== "function" ||
    typeof secrets.delete !== "function"
  ) {
    throw new Error(
      "The OS credential store requires Bun 1.3.14 or later and an available native credential service. Headless clients can supply TUBELESS_TOKEN."
    );
  }
  // SAFETY: Bun's three native credential operations were narrowed above.
  return secrets as unknown as NativeSecrets;
}

function storageError(): Error {
  // Native errors are intentionally omitted; some stores echo the supplied value.
  return new Error(
    "Cannot access the OS credential store. Unlock or enable your native credential service and retry. Headless clients can supply TUBELESS_TOKEN; credentials are never saved to plaintext files."
  );
}

function localPersistenceOption(): { persist?: "local" } {
  const bun: unknown = Reflect.get(globalThis, "Bun");
  if (!isCloudObject(bun) || typeof bun.version !== "string") return {};
  const version = /^(\d+)\.(\d+)\.(\d+)/.exec(bun.version);
  if (!version) return {};
  const major = Number(version[1]);
  const minor = Number(version[2]);
  const patch = Number(version[3]);
  // Bun 1.3.14 does not expose persist. Use the option only on a documented
  // supporting runtime; older runtimes retain their native platform default.
  return major > 1 || (major === 1 && (minor > 4 || (minor === 4 && patch >= 2)))
    ? { persist: "local" }
    : {};
}

/** Native access is lazy so help and local CLI commands never touch the keychain. */
export function createNativeCredentialStore(): CloudCredentialStore {
  const key = (host: string): NativeSecretOptions => ({
    service: "tubeless-cloud",
    name: normalizeCloudHost(host),
  });
  return {
    async get(host) {
      const secrets = nativeSecrets();
      let source: string | null;
      try {
        source = await secrets.get(key(host));
      } catch {
        throw storageError();
      }
      if (source === null) return undefined;
      if (typeof source !== "string" || source.length > 8192) {
        throw new Error("The saved Cloud credential is invalid. Run tubeless auth login again.");
      }
      let value: unknown;
      try {
        value = JSON.parse(source) as unknown;
      } catch {
        throw new Error("The saved Cloud credential is invalid. Run tubeless auth login again.");
      }
      return parseCredential(value);
    },
    async set(host, credential) {
      const validated = parseCredential(credential);
      const secrets = nativeSecrets();
      try {
        await secrets.set({
          ...key(host),
          value: JSON.stringify(validated),
          ...localPersistenceOption(),
        });
      } catch {
        throw storageError();
      }
    },
    async delete(host) {
      const secrets = nativeSecrets();
      try {
        await secrets.delete(key(host));
      } catch {
        throw storageError();
      }
    },
  };
}

/** Environment credentials take precedence and are never persisted. */
export async function resolveCloudCredential(
  host: string,
  options: {
    store?: CloudCredentialStore;
    env?: Record<string, string | undefined>;
    now?: () => number;
  } = {}
): Promise<ResolvedCloudCredential | undefined> {
  const origin = normalizeCloudHost(host);
  const environmentToken = (options.env ?? process.env).TUBELESS_TOKEN;
  if (environmentToken !== undefined) {
    if (!isCloudToken(environmentToken)) {
      throw new Error(
        "TUBELESS_TOKEN is empty or invalid. Remove it or supply an active Cloud session token."
      );
    }
    return { token: environmentToken, source: "environment" };
  }
  const store = options.store ?? createNativeCredentialStore();
  const credential = await store.get(origin);
  if (!credential) return undefined;
  const validated = parseCredential(credential);
  if (validated.expiresAt <= (options.now ?? Date.now)()) {
    await store.delete(origin);
    return undefined;
  }
  return { ...validated, source: "stored" };
}
