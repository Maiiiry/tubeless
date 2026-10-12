import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, NoOpLog, type WorkerdStructuredLog } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed } from "vitest";

const dist = fileURLToPath(new URL("../../dist/", import.meta.url));
const AUD = "a".repeat(64);
const ISSUER = "https://test.cloudflareaccess.com";

const WORKER = String.raw`
import { env } from "cloudflare:workers";
import { createSteps, definePipeline } from "./core/pipeline.js";
import { defineProject } from "./project/project.js";
import { createCloudflareApp } from "./cloudflare/cloudflare.js";
import { createR2CacheStore, jsonCacheCodec } from "./cloudflare/cloudflare-cache.js";
// The documented pattern: step definitions hold a getter; the Worker entry binds the bucket.
let bucket;
const bindCacheBucket = (value) => { bucket = value; };
const r2Cache = { store: createR2CacheStore(() => { if (!bucket) throw new Error("Bind the R2 cache bucket in cloudflare/worker.ts before running cached steps."); return bucket; }), codec: jsonCacheCodec };
const schema = (validate, input) => ({ "~standard": { vendor: "test", version: 1, validate, jsonSchema: { input: () => input } } });
const nameInput = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };
const emptyInput = { type: "object", properties: {} };
const greetSteps = createSteps(schema((v) => typeof v?.name === "string" && v.name.length >= 3 ? { value: v } : { issues: [{ message: "Expected at least 3 characters", path: ["name"] }] }, nameInput));
const greet = greetSteps.step("greet", { run: (_i, c) => { c.log.log("hello " + c.options.name); return "hi " + c.options.name; } });
const slowSteps = createSteps(schema((v) => ({ value: v ?? {} }), emptyInput));
const wait = slowSteps.step("wait", { run: (_i, c) => new Promise((resolve, reject) => { const t = setTimeout(resolve, 20000, "done"); c.signal.addEventListener("abort", () => { clearTimeout(t); reject(c.signal.reason); }, { once: true }); }) });
const cachedSteps = createSteps(schema((v) => ({ value: v ?? {} }), emptyInput));
const cached = cachedSteps.step("cached", { cache: { version: "v1" }, run: () => ({ ok: true }) });
const r2Cached = cachedSteps.step("r2-cached", { cache: { version: "v1", ...r2Cache }, run: () => ({ rows: [1, 2, 3] }) });
const app = createCloudflareApp(defineProject("worker-test", [
  definePipeline({ id: "greeting", name: "Greeting", steps: [greet], finalize: greet }),
  definePipeline({ id: "slow", steps: [wait], finalize: wait }),
  definePipeline({ id: "cached", steps: [cached], finalize: cached }),
  definePipeline({ id: "r2-cached", steps: [r2Cached], finalize: r2Cached }),
]));
bindCacheBucket(env.TUBELESS_BUCKET);
export default app.worker;
export const { TubelessStudio, TubelessRun } = app.durableObjects;
`;

// Gate checks: the same app without Access bindings, or with only one of them.
const OPEN_WORKER = String.raw`
import { createSteps, definePipeline } from "./core/pipeline.js";
import { defineProject } from "./project/project.js";
import { createCloudflareApp } from "./cloudflare/cloudflare.js";
const schema = { "~standard": { vendor: "test", version: 1, validate: (v) => ({ value: v ?? {} }), jsonSchema: { input: () => ({ type: "object", properties: {} }) } } };
const echo = createSteps(schema).step("echo", { run: () => "ok" });
const app = createCloudflareApp(defineProject("open-test", [definePipeline({ id: "echo", steps: [echo], finalize: echo })]));
export default app.worker;
export const { TubelessStudio, TubelessRun } = app.durableObjects;
`;

// Reports whether createCloudflareApp accepts limits.maxRunDurationMs from the query string.
const LIMITS_WORKER = String.raw`
import { defineProject } from "./project/project.js";
import { createCloudflareApp } from "./cloudflare/cloudflare.js";
const project = defineProject("limits-test", []);
export default {
  fetch(request) {
    const maxRunDurationMs = Number(new URL(request.url).searchParams.get("ms"));
    try {
      createCloudflareApp(project, { limits: { maxRunDurationMs } });
      return new Response("accepted");
    } catch (error) {
      return new Response(error.message, { status: 400 });
    }
  },
};
`;

// dispatchFetch reaches the first worker, so it forwards each request unchanged to the named one.
const GATE_ROUTER = String.raw`
export default { fetch: (request, env) => env[request.headers.get("x-gate-target")].fetch(request) };
`;

function relativeImports(source: string, directory: string): string[] {
  return [...source.matchAll(/(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)["'](\.[^"']+)["']/g)].map(
    (match) => posix.normalize(posix.join(directory, match[1]!))
  );
}

function manifestModules(entry: string): Record<string, { type: "esm"; contents: string }> {
  const modules: Record<string, { type: "esm"; contents: string }> = {
    "worker.js": { type: "esm", contents: entry },
  };
  const pending = relativeImports(entry, "");
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (modules[name]) continue;
    const contents = readFileSync(join(dist, name), "utf8");
    modules[name] = { type: "esm", contents };
    pending.push(...relativeImports(contents, posix.dirname(name)));
  }
  return modules;
}

let mf: Miniflare;
let gates: Miniflare;
// Worker console output is kept quiet and replayed only for the test that failed.
let workerLogs: string[] = [];
let persist: string | undefined;
let keys: CryptoKeyPair;
let jwk: JsonWebKey;

const b64url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};
async function accessToken(): Promise<string> {
  const encode = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));
  const head = encode({ alg: "RS256", kid: "k1" });
  const body = encode({
    iss: ISSUER,
    aud: [AUD],
    exp: Math.floor(Date.now() / 1000) + 600,
    email: "ops@example.com",
  });
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keys.privateKey,
    new TextEncoder().encode(`${head}.${body}`)
  );
  return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
}

interface CallInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

async function call(path: string, init: CallInit = {}, authenticated = true) {
  const headers = { ...init.headers };
  if (authenticated) headers["cf-access-jwt-assertion"] = await accessToken();
  return mf.dispatchFetch(`http://localhost${path}`, { ...init, headers });
}
const mutation = (extra: Record<string, string>, body?: unknown): CallInit => ({
  method: "POST",
  headers: {
    origin: "http://localhost",
    ...extra,
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const launch = (command: string, values: Record<string, unknown>) =>
  call(`/api/commands/${command}/runs`, mutation({ "x-tubeless-studio-launch": "1" }, { values }));

async function runStatus(runId: string, until: (status: string) => boolean): Promise<string> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const response = await call(`/api/runs/${encodeURIComponent(runId)}`);
    if (response.status === 200) {
      const status = ((await response.json()) as { run: { status: string } }).run.status;
      if (until(status)) return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Run ${runId} did not reach the expected status.`);
}

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
  jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1" } as JsonWebKey;
  persist = mkdtempSync(join(tmpdir(), "tubeless-workers-"));
  mf = new Miniflare({
    resourcePersistencePath: persist,
    telemetry: { enabled: false },
    log: new NoOpLog(),
    handleStructuredLogs: ({ level, message }: WorkerdStructuredLog) => {
      workerLogs.push(`[${level}] ${message}`);
    },
    workers: [
      {
        config: {
          name: "tubeless-test",
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          manifest: { mainModule: "worker.js", modules: manifestModules(WORKER) },
          env: {
            TUBELESS_STUDIO: {
              type: "durable-object",
              worker: "tubeless-test",
              exportName: "TubelessStudio",
            },
            TUBELESS_RUN: {
              type: "durable-object",
              worker: "tubeless-test",
              exportName: "TubelessRun",
            },
            TUBELESS_BUCKET: { type: "r2", name: "tubeless-test" },
            ACCESS_TEAM_DOMAIN: { type: "text", value: "test.cloudflareaccess.com" },
            ACCESS_AUD: { type: "text", value: AUD },
          },
          exports: {
            TubelessStudio: { type: "durable-object", storage: "sqlite" },
            TubelessRun: { type: "durable-object", storage: "sqlite" },
          },
        },
        dev: {
          outboundService: {
            type: "fetcher",
            handler: async (request: Request) =>
              request.url === `${ISSUER}/cdn-cgi/access/certs`
                ? Response.json({ keys: [jwk] })
                : new Response("Outbound requests are blocked in tests.", { status: 502 }),
          },
        },
      },
    ],
  });
  const gateWorker = (name: string, env: Record<string, unknown>) => ({
    config: {
      name,
      compatibilityDate: "2026-10-01",
      compatibilityFlags: ["nodejs_compat"],
      manifest: { mainModule: "worker.js", modules: manifestModules(OPEN_WORKER) },
      env: {
        TUBELESS_STUDIO: { type: "durable-object", worker: name, exportName: "TubelessStudio" },
        TUBELESS_RUN: { type: "durable-object", worker: name, exportName: "TubelessRun" },
        ...env,
      },
      exports: {
        TubelessStudio: { type: "durable-object", storage: "sqlite" },
        TubelessRun: { type: "durable-object", storage: "sqlite" },
      },
    },
  });
  gates = new Miniflare({
    resourcePersistencePath: join(persist, "gates"),
    telemetry: { enabled: false },
    log: new NoOpLog(),
    handleStructuredLogs: ({ level, message }: WorkerdStructuredLog) => {
      workerLogs.push(`[${level}] ${message}`);
    },
    workers: [
      {
        config: {
          name: "gate-router",
          compatibilityDate: "2026-10-01",
          manifest: { mainModule: "worker.js", modules: manifestModules(GATE_ROUTER) },
          env: Object.fromEntries(
            [
              "tubeless-open",
              "tubeless-blank",
              "tubeless-half",
              "tubeless-limits",
              "tubeless-no-studio",
            ].map((worker) => [worker, { type: "worker", worker }])
          ),
        },
      },
      gateWorker("tubeless-open", {}),
      gateWorker("tubeless-blank", {
        ACCESS_TEAM_DOMAIN: { type: "text", value: "" },
        ACCESS_AUD: { type: "text", value: " " },
      }),
      gateWorker("tubeless-half", { ACCESS_AUD: { type: "text", value: AUD } }),
      // A Studio binding that cannot be reached makes the forward throw.
      gateWorker("tubeless-no-studio", { TUBELESS_STUDIO: { type: "text", value: "unbound" } }),
      {
        config: {
          name: "tubeless-limits",
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          manifest: { mainModule: "worker.js", modules: manifestModules(LIMITS_WORKER) },
        },
      },
    ],
  });
}, 60_000);

afterAll(async () => {
  try {
    await Promise.all([mf?.dispose(), gates?.dispose()]);
  } finally {
    if (persist) rmSync(persist, { recursive: true, force: true });
  }
});

beforeEach(() => {
  workerLogs = [];
  onTestFailed(() => {
    if (workerLogs.length > 0) console.error(`Worker logs:\n${workerLogs.join("\n")}`);
  });
});

describe("tubeless/cloudflare on workerd", { timeout: 60_000 }, () => {
  it("requires Cloudflare Access", async () => {
    expect((await call("/api/snapshot", {}, false)).status).toBe(401);
    expect((await call("/", {}, false)).status).toBe(403);
  });

  it("serves Studio and the project's commands", async () => {
    const page = await call("/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'sha256-");
    const { commands } = (await (await call("/api/commands")).json()) as {
      commands: { id: string }[];
    };
    expect(commands.map((command) => command.id)).toEqual([
      "greeting",
      "slow",
      "cached",
      "r2-cached",
    ]);
  });

  it("rejects cross-origin mutations", async () => {
    const response = await call("/api/commands/greeting/runs", {
      ...mutation({ "x-tubeless-studio-launch": "1" }, { values: { name: "ada" } }),
      headers: {
        origin: "https://evil.example",
        "x-tubeless-studio-launch": "1",
        "content-type": "application/json",
      },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "untrusted_origin" });
  });

  it("launches a run, acknowledges with its id, and records completion and logs", async () => {
    const response = await launch("greeting", { name: "ada" });
    expect(response.status).toBe(202);
    const { runId } = (await response.json()) as { runId: string };
    expect(await runStatus(runId, (status) => status !== "running")).toBe("completed");
    const detail = JSON.stringify(
      await (await call(`/api/runs/${encodeURIComponent(runId)}`)).json()
    );
    expect(detail).toContain("hello ada");
  });

  it("records an options-schema rejection as a failed run", async () => {
    // The run object parses values first, then core records the schema failure as a run.
    const response = await launch("greeting", { name: "ab" });
    expect(response.status).toBe(202);
    const { runId } = (await response.json()) as { runId: string };
    expect(await runStatus(runId, (status) => status !== "running")).toBe("failed");
  });

  it("cancels a live run", async () => {
    const { runId } = (await (await launch("slow", {})).json()) as { runId: string };
    const snapshot = (await (await call("/api/snapshot")).json()) as { liveRunIds: string[] };
    expect(snapshot.liveRunIds).toContain(runId);
    const cancel = await call(
      `/api/runs/${encodeURIComponent(runId)}/cancel`,
      mutation({ "x-tubeless-studio-cancel": "1" })
    );
    expect(cancel.status).toBe(202);
    expect(await runStatus(runId, (status) => status !== "running")).toBe("cancelled");
  });

  it("reuses a cached step through R2 bound from the Worker entry", async () => {
    const stepSource = async () => {
      const response = await launch("r2-cached", {});
      expect(response.status).toBe(202);
      const { runId } = (await response.json()) as { runId: string };
      expect(await runStatus(runId, (status) => status !== "running")).toBe("completed");
      const { run } = (await (await call(`/api/runs/${encodeURIComponent(runId)}`)).json()) as {
        run: { steps: { id: string; outputSource?: string }[] };
      };
      return run.steps.find((step) => step.id === "r2-cached")?.outputSource;
    };
    expect(await stepSource()).toBeUndefined();
    expect(await stepSource()).toBe("cache");
  });

  it("fails a cached step that has no Workers cache store without breaking Studio", async () => {
    const { runId } = (await (await launch("cached", {})).json()) as { runId: string };
    expect(await runStatus(runId, (status) => status !== "running")).toBe("failed");
    const { run } = (await (await call(`/api/runs/${encodeURIComponent(runId)}`)).json()) as {
      run: { error?: { message: string; cause?: { message: string } } };
    };
    expect(run.error?.message).toMatch(/cache encode failed/i);
    expect(run.error?.cause?.message).toMatch(/serialize|not implemented/i);
    expect((await call("/api/snapshot")).status).toBe(200);
  });
});

describe("tubeless/cloudflare Worker gate and limits on workerd", { timeout: 60_000 }, () => {
  const gate = (worker: string, url: string) =>
    gates.dispatchFetch(url, { headers: { "x-gate-target": worker } });

  it("fails closed without Access bindings except on loopback hosts", async () => {
    for (const worker of ["tubeless-open", "tubeless-blank"]) {
      const remote = await gate(worker, "https://studio.example.com/api/snapshot");
      expect(remote.status).toBe(503);
      expect(await remote.json()).toMatchObject({ code: "access_not_configured" });
    }
    expect((await gate("tubeless-open", "http://localhost/api/snapshot")).status).toBe(200);
  });

  it("rejects a half-configured Access binding pair", async () => {
    for (const origin of ["https://studio.example.com", "http://localhost"]) {
      const response = await gate("tubeless-half", `${origin}/api/snapshot`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "access_misconfigured" });
    }
  });

  it("answers 503 when the Studio object cannot be reached", async () => {
    const api = await gate("tubeless-no-studio", "http://localhost/api/snapshot");
    expect(api.status).toBe(503);
    expect(await api.json()).toMatchObject({ code: "studio_unavailable" });
    const page = await gate("tubeless-no-studio", "http://localhost/");
    expect(page.status).toBe(503);
    expect(page.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await page.text()).toMatch(/Studio is temporarily unavailable/);
    expect(workerLogs.join("\n")).toMatch(/getByName/);
  });

  it("validates limits.maxRunDurationMs", async () => {
    for (const ms of [840_001, 0, 1.5]) {
      const response = await gate("tubeless-limits", `http://localhost/?ms=${ms}`);
      expect(response.status).toBe(400);
      expect(await response.text()).toMatch(/no greater than 840000/);
    }
    const accepted = await gate("tubeless-limits", "http://localhost/?ms=840000");
    expect(await accepted.text()).toBe("accepted");
  });
});
