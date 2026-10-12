import { bindings, defineConfig, defineWorker, exports as workerExports } from "cf/config";
import * as entrypoint from "./cloudflare/worker.ts" with { type: "cf-worker" };

export default defineConfig(() => {
  const worker = defineWorker({
    name: "cloudflare",
    entrypoint,
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    // Workers Paid: allow up to 5 minutes of CPU per run (runs are capped at 14 minutes of wall time).
    // limits: { cpuMs: 300_000 },
    exports: {
      TubelessStudio: workerExports.durableObject({ storage: "sqlite" }),
      TubelessRun: workerExports.durableObject({ storage: "sqlite" }),
    },
  });
  return {
    worker: {
      ...worker,
      workersDev: true,
      observability: { enabled: true, logs: { enabled: true } },
      env: {
        TUBELESS_STUDIO: bindings.durableObject<typeof worker, "TubelessStudio">({
          worker,
          exportName: "TubelessStudio",
        }),
        TUBELESS_RUN: bindings.durableObject<typeof worker, "TubelessRun">({
          worker,
          exportName: "TubelessRun",
        }),
        TUBELESS_BUCKET: bindings.r2({ name: "cloudflare-artifacts" }),
        // After enabling Cloudflare Access: "<team>.cloudflareaccess.com" and the application AUD tag.
        ACCESS_TEAM_DOMAIN: bindings.text(""),
        ACCESS_AUD: bindings.text(""),
      },
    },
  };
});
