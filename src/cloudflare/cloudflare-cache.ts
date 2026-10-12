import type { StepCacheCodec, StepCacheStore } from "../core/pipeline.js";

/** Structural subset of an R2 object body that the cache store reads. */
export interface R2ObjectLike {
  arrayBuffer(): Promise<ArrayBuffer>;
  readonly customMetadata?: Record<string, string>;
  readonly uploaded: Date;
}

/** Structural subset of an R2 bucket binding that the cache store uses. */
export interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>;
  put(
    key: string,
    value: Uint8Array,
    options?: { customMetadata?: Record<string, string> }
  ): Promise<unknown>;
}

/**
 * Step cache entries in R2. Core still enforces versions, keys and maxAge.
 * Pass a getter to bind the bucket later; it is resolved on every read and write.
 */
export function createR2CacheStore(
  bucket: R2BucketLike | (() => R2BucketLike),
  options: { readonly prefix?: string } = {}
): StepCacheStore {
  const prefix = options.prefix ?? "tubeless-cache/";
  const resolve = typeof bucket === "function" ? bucket : () => bucket;
  return {
    async get(key) {
      const object = await resolve().get(prefix + key);
      if (!object) return undefined;
      const raw = object.customMetadata?.createdAtMs ?? "";
      const recorded = raw.trim() === "" ? Number.NaN : Number(raw);
      return {
        value: new Uint8Array(await object.arrayBuffer()),
        createdAtMs: Number.isFinite(recorded) ? recorded : object.uploaded.getTime(),
      };
    },
    async set(key, entry) {
      await resolve().put(prefix + key, entry.value, {
        customMetadata: { createdAtMs: String(entry.createdAtMs) },
      });
    },
  };
}

function roundTripError(path: string, reason: string): Error {
  return new Error(`jsonCacheCodec cannot store ${path}: ${reason}`);
}

/** Read an own data property without invoking accessors. */
function dataValue(descriptor: PropertyDescriptor | undefined, path: string): unknown {
  if (!descriptor) throw roundTripError(path, "only own data properties round-trip.");
  if (!("value" in descriptor))
    throw roundTripError(path, "accessor properties do not round-trip.");
  if (!descriptor.enumerable)
    throw roundTripError(path, "non-enumerable properties do not round-trip.");
  return descriptor.value;
}

/** Canonical array index: "0", "1", ... but not "01", "-0" or "1.5". */
function isArrayIndexKey(key: string): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 2 ** 32 - 1 && String(index) === key;
}

function assertPlainArray(value: unknown[], path: string, seen: Set<object>): void {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw roundTripError(path, "array subclasses do not round-trip.");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key !== "length" && (typeof key !== "string" || !isArrayIndexKey(key))) {
      throw roundTripError(path, "arrays may only own index and length properties.");
    }
  }
  for (let index = 0; index < value.length; index++) {
    const itemPath = `${path}[${index}]`;
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor) throw roundTripError(itemPath, "sparse arrays do not round-trip.");
    assertPlainJson(dataValue(descriptor, itemPath), itemPath, seen);
  }
}

function assertPlainObject(value: object, path: string, seen: Set<object>): void {
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw roundTripError(path, "only objects with Object.prototype round-trip.");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") throw roundTripError(path, "symbol keys do not round-trip.");
    const itemPath = `${path}.${key}`;
    assertPlainJson(
      dataValue(Object.getOwnPropertyDescriptor(value, key), itemPath),
      itemPath,
      seen
    );
  }
}

/**
 * Reject every value that would not come back identical from JSON.stringify and JSON.parse.
 * Inspects own properties through descriptors so no user getter runs during validation.
 * `seen` rejects shared and circular references, which JSON would duplicate or fail on.
 */
function assertPlainJson(value: unknown, path: string, seen: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw roundTripError(path, "NaN and infinities do not round-trip.");
    if (Object.is(value, -0)) throw roundTripError(path, "-0 does not round-trip.");
    return;
  }
  if (typeof value !== "object") {
    throw roundTripError(
      path,
      "only plain objects, arrays, strings, finite numbers, booleans and null round-trip."
    );
  }
  if (seen.has(value)) {
    throw roundTripError(path, "shared or circular references do not round-trip.");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    assertPlainArray(value, path, seen);
  } else {
    assertPlainObject(value, path, seen);
  }
}

/** Lossless JSON codec for Workers, where the default V8 codec is unavailable. */
export const jsonCacheCodec: StepCacheCodec = {
  encode(value) {
    assertPlainJson(value, "value", new Set());
    return new TextEncoder().encode(JSON.stringify(value));
  },
  decode(bytes) {
    return JSON.parse(new TextDecoder().decode(bytes));
  },
};
