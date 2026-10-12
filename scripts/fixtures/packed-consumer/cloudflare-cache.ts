import { createSteps, definePipeline } from "tubeless";
import {
  createR2CacheStore,
  jsonCacheCodec,
  type R2BucketLike,
  type R2ObjectLike,
} from "tubeless/cloudflare/cache";

// Type-checked and run in Node: the cache entry must load outside workerd.
const objects = new Map<string, R2ObjectLike>();
let bucket: R2BucketLike | undefined;
const bindCacheBucket = (value: R2BucketLike) => {
  bucket = value;
};
const store = createR2CacheStore(() => {
  if (!bucket) throw new Error("Bind the R2 cache bucket before running cached steps.");
  return bucket;
});
const { step } = createSteps();
let runs = 0;
const report = step("report", {
  cache: { version: "v1", store, codec: jsonCacheCodec },
  run: () => {
    runs += 1;
    return { ok: true };
  },
});
const pipeline = definePipeline({ id: "report", steps: [report], finalize: report });
bindCacheBucket({
  async get(key) {
    return objects.get(key) ?? null;
  },
  async put(key, value, options) {
    const bytes = value.slice().buffer;
    objects.set(key, {
      arrayBuffer: async () => bytes,
      customMetadata: options?.customMetadata,
      uploaded: new Date(),
    });
  },
});
for (let attempt = 0; attempt < 2; attempt++) {
  const result = await pipeline.runOrThrow({});
  if (!result.ok) throw new Error("Invalid cached result");
}
if (runs !== 1 || objects.size !== 1) {
  throw new Error(`Expected one execution and one R2 entry, saw ${runs} and ${objects.size}.`);
}
