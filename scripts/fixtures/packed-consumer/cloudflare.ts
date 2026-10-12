import { createSteps, definePipeline } from "tubeless";
import {
  createCloudflareApp,
  createR2CacheStore,
  jsonCacheCodec,
  type CloudflareApp,
  type CloudflareAppOptions,
  type CloudflareDurableObjectClass,
  type CloudflareWorker,
  type R2BucketLike,
  type R2ObjectLike,
} from "tubeless/cloudflare";
import { defineProject } from "tubeless/project";

// Type-checked only: the Cloudflare entry loads in workerd, not Node.
const objects = new Map<string, R2ObjectLike>();
const bucket: R2BucketLike = {
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
};
const { step } = createSteps();
const report = step("report", {
  cache: { version: "v1", store: createR2CacheStore(bucket), codec: jsonCacheCodec },
  run: () => ({ ok: true }),
});
const pipeline = definePipeline({ id: "report", steps: [report], finalize: report });
const options: CloudflareAppOptions = { limits: { maxRunDurationMs: 600_000 } };
const app: CloudflareApp = createCloudflareApp(
  defineProject("packed-cloudflare", [pipeline]),
  options
);
const worker: CloudflareWorker = app.worker;
const studio: CloudflareDurableObjectClass = app.durableObjects.TubelessStudio;
export { studio as TubelessStudio, worker as default };
export const { TubelessRun } = app.durableObjects;
