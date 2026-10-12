import { describe, expect, it } from "vitest";
import { createR2CacheStore, jsonCacheCodec, type R2BucketLike } from "./cloudflare-cache.js";

function memoryBucket(): R2BucketLike & { keys(): string[] } {
  const objects = new Map<string, { value: Uint8Array; customMetadata?: Record<string, string> }>();
  return {
    async get(key) {
      const object = objects.get(key);
      return object
        ? {
            arrayBuffer: async () => object.value.slice().buffer,
            customMetadata: object.customMetadata,
            uploaded: new Date(5),
          }
        : null;
    },
    async put(key, value, options) {
      objects.set(key, { value, customMetadata: options?.customMetadata });
    },
    keys: () => [...objects.keys()],
  };
}

describe("R2 cache store", () => {
  it("round-trips bytes and creation time under a prefix", async () => {
    const bucket = memoryBucket();
    const store = createR2CacheStore(bucket, { prefix: "p/" });
    expect(await store.get("k", {})).toBeUndefined();
    await store.set("k", { value: new Uint8Array([1, 2]), createdAtMs: 42 }, {});
    expect(bucket.keys()).toEqual(["p/k"]);
    expect(await store.get("k", {})).toEqual({ value: new Uint8Array([1, 2]), createdAtMs: 42 });
  });

  it("writes under the default tubeless-cache/ prefix", async () => {
    const bucket = memoryBucket();
    await createR2CacheStore(bucket).set("k", { value: new Uint8Array([1]), createdAtMs: 42 }, {});
    expect(bucket.keys()).toEqual(["tubeless-cache/k"]);
  });

  it("falls back to the upload time when metadata is missing", async () => {
    const bucket = memoryBucket();
    await bucket.put("tubeless-cache/k", new Uint8Array([1]));
    expect((await createR2CacheStore(bucket).get("k", {}))?.createdAtMs).toBe(5);
  });

  it("resolves a bucket getter on every read and write", async () => {
    const buckets = [memoryBucket(), memoryBucket()];
    let current: R2BucketLike | undefined;
    let resolutions = 0;
    const store = createR2CacheStore(() => {
      resolutions += 1;
      if (!current) throw new Error("bucket is not bound");
      return current;
    });
    expect(resolutions).toBe(0);
    await expect(store.get("k", {})).rejects.toThrow("bucket is not bound");
    current = buckets[0];
    await store.set("k", { value: new Uint8Array([1]), createdAtMs: 42 }, {});
    current = buckets[1];
    expect(await store.get("k", {})).toBeUndefined();
    expect(buckets.map((bucket) => bucket.keys())).toEqual([["tubeless-cache/k"], []]);
    expect(resolutions).toBe(3);
  });

  it("falls back to the upload time when createdAtMs metadata is empty", async () => {
    const bucket = memoryBucket();
    await bucket.put("tubeless-cache/k", new Uint8Array([1]), {
      customMetadata: { createdAtMs: "" },
    });
    expect((await createR2CacheStore(bucket).get("k", {}))?.createdAtMs).toBe(5);
  });
});

describe("JSON cache codec", () => {
  it("round-trips plain nested JSON", async () => {
    const value = { a: [1, "two", true, null], nested: { ok: 1.5, list: [{ deep: [0] }] } };
    expect(await jsonCacheCodec.decode(await jsonCacheCodec.encode(value))).toEqual(value);
  });

  it.each([
    ["a Date", { at: new Date(0) }],
    ["a Map", new Map()],
    ["undefined", { missing: undefined }],
    ["NaN", [Number.NaN]],
    ["a bigint", { n: 1n }],
    [
      "a class instance",
      new (class Point {
        x = 1;
      })(),
    ],
  ])("rejects %s", async (_label, value) => {
    await expect(async () => jsonCacheCodec.encode(value)).rejects.toThrow(/jsonCacheCodec/);
  });

  it.each([
    [
      "a sparse array",
      (() => {
        const sparse = [1, 2, 3];
        delete sparse[1];
        return sparse;
      })(),
      "value[1]",
    ],
    ["-0", { n: -0 }, "value.n"],
    ["a symbol key", { [Symbol("s")]: 1 }, "value"],
    ["an extra array property", Object.assign([1], { foo: 1 }), "value"],
    ["an Array subclass", class Tags extends Array<number> {}.of(1), "value"],
    ["a null-prototype object", Object.assign(Object.create(null), { a: 1 }), "value"],
    [
      "a non-enumerable property",
      Object.defineProperty({}, "hidden", { value: 1, enumerable: false }),
      "value.hidden",
    ],
    [
      "a circular reference",
      (() => {
        const cyclic: { self?: unknown } = {};
        cyclic.self = cyclic;
        return cyclic;
      })(),
      "value.self",
    ],
    [
      "a shared reference",
      (() => {
        const shared = { x: 1 };
        return { a: shared, b: shared };
      })(),
      "value.b",
    ],
  ])("rejects %s at its path", async (_label, value, path) => {
    await expect(async () => jsonCacheCodec.encode(value)).rejects.toThrow(
      `jsonCacheCodec cannot store ${path}: `
    );
  });

  it("rejects accessor properties without invoking the getter", async () => {
    let getterCalls = 0;
    const value = {
      get x() {
        getterCalls += 1;
        return 1;
      },
    };
    await expect(async () => jsonCacheCodec.encode(value)).rejects.toThrow(
      "jsonCacheCodec cannot store value.x: "
    );
    expect(getterCalls).toBe(0);
  });
});
