import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { PipelineRunEventStore, StoredPipelineEvent } from "../run-store/run-store.js";
import { decodePipelineTraceEvent } from "../tracing/tracing-codec.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import { PIPELINE_RUN_STUDIO_STYLE } from "./run-store-ui-page.js";
import { readStudioClientScript } from "./run-store-ui-page-node.js";
import { connectionPresentation } from "./run-store-ui-client.js";
import {
  isLiteralOrLocalhostHttpHost,
  startPipelineRunStudio,
  type PipelineRunStudioServer,
} from "./run-store-ui.js";

const PIPELINE_RUN_STUDIO_SCRIPT = readStudioClientScript();

function studioError(code: string, message: string, hint: string) {
  return { code, hint, message };
}

const untrustedHostError = studioError(
  "untrusted_host",
  "The request host is not trusted.",
  "Use the exact local Studio URL printed by tubeless ui."
);

async function requestWithHost(
  url: string,
  options: {
    body?: string;
    headers?: Record<string, string>;
    host: string;
    method: string;
  }
): Promise<{ status: number; body: unknown }> {
  const parsed = new URL(url);
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        headers: { host: options.host, ...options.headers },
        hostname: parsed.hostname,
        method: options.method,
        path: parsed.pathname,
        port: parsed.port,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            body: text === "" ? undefined : JSON.parse(text),
            status: response.statusCode ?? 0,
          });
        });
      }
    );
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

const servers: PipelineRunStudioServer[] = [];
const fixtureParameters = [
  {
    description: "Message to process.",
    flag: "message",
    key: "message",
    multiple: false,
    positional: false,
    required: true,
    type: "string" as const,
  },
];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function memoryStore(events: readonly StoredPipelineEvent[]): PipelineRunEventStore {
  return {
    close() {},
    export() {},
    async listEvents(query = {}) {
      return events
        .filter(
          (event) =>
            (query.runId === undefined || event.runId === query.runId) &&
            (query.pipelineId === undefined || event.pipelineId === query.pipelineId) &&
            (query.afterId === undefined || event.id > query.afterId)
        )
        .slice(0, query.limit);
    },
  };
}

function storedEvent(
  value: Record<string, unknown> & { id: number; name: PipelineTraceEvent["name"] }
): StoredPipelineEvent {
  const { id, name, payload: payloadOverrides, ...event } = value;
  const payloads: Partial<Record<PipelineTraceEvent["name"], Record<string, unknown>>> = {
    "pipeline.completed": {
      dryRun: false,
      errorCount: 0,
      finalized: false,
      status: "completed",
      stepCount: 0,
    },
    "pipeline.log": { level: "log", message: "" },
    "pipeline.started": { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
  };
  return {
    ...decodePipelineTraceEvent({
      ...event,
      name,
      payload: { ...payloads[name], ...(payloadOverrides as object | undefined) },
    }),
    id,
  };
}

const events: StoredPipelineEvent[] = [
  storedEvent({
    id: 1,
    name: "pipeline.started",
    pipelineId: "studio-fixture",
    runId: "run-1",
    timestampMs: 10,
    version: 2,
  }),
  storedEvent({
    durationMs: 5,
    id: 2,
    name: "pipeline.completed",
    pipelineId: "studio-fixture",
    runId: "run-1",
    timestampMs: 15,
    version: 2,
  }),
];

describe("local pipeline run studio", () => {
  it("rejects malformed command parameter metadata before listening", async () => {
    await expect(
      startPipelineRunStudio({
        launcher: {
          commands: [
            {
              canPlan: false,
              id: "invalid",
              name: "Invalid",
              parameters: [{ flag: "value", key: "value", type: "mystery" }] as never,
            },
          ],
          async launch() {
            return { accepted: true, runId: "unused" };
          },
        },
        port: 0,
        store: memoryStore(events),
      })
    ).rejects.toThrow('Studio command "invalid" has invalid parameters.');
  });

  it("rejects ambiguous launcher command definitions before listening", async () => {
    await expect(
      startPipelineRunStudio({
        launcher: {
          commands: [
            {
              canPlan: false,
              id: "duplicate",
              name: "First",
              parameters: fixtureParameters,
            },
            {
              canPlan: false,
              id: "duplicate",
              name: "Second",
              parameters: fixtureParameters,
            },
          ],
          async launch() {
            return { accepted: true, runId: "unused" };
          },
        },
        port: 0,
        store: memoryStore(events),
      })
    ).rejects.toThrow('Duplicate studio command id "duplicate".');
  });

  it("serves the standalone interface and keeps launching disabled by default", async () => {
    const server = await startPipelineRunStudio({ port: 0, store: memoryStore(events) });
    servers.push(server);

    const page = await fetch(server.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain("<title>Tubeless — Studio</title>");
    expect(html).toContain("nested work stays with its parent");
    expect(html).toContain("/api/runs/");
    expect(html).not.toContain('data-view="active"');
    expect(html).not.toContain('data-view="definitions"');
    expect(html).toContain("Run pipeline");
    expect(html).toContain("Available pipelines");
    expect(html).toContain("Preview plan");
    expect(html).toContain("Pipeline inputs");
    expect(html).toContain("Execution controls");
    expect(html).toContain("Built into Tubeless");
    expect(html).toContain("Clear run history?");
    expect(html).toContain("Cancel run");
    expect(html).toContain("x-tubeless-studio-cancel");
    expect(html).toContain("liveRunIds");
    expect(html).toContain("step-status-icon");
    expect(html).toContain("status-mark");
    expect(html).toContain("progress-details");
    expect(html).toContain("Remote step");
    expect(html).toContain("declared steps");
    expect(html).toContain("Showing ");
    expect(html).not.toContain("mode-tabs");
    expect(html).not.toContain("Pipes");

    const snapshot = await fetch(`${server.url}/api/snapshot`).then((response) => response.json());
    expect(snapshot).toMatchObject({
      activeRunCount: 0,
      completedRunCount: 1,
      liveRunIds: [],
      runs: [{ pipelineId: "studio-fixture", status: "completed" }],
    });
    const run = await fetch(`${server.url}/api/runs/run-1`).then((response) => response.json());
    expect(run).toMatchObject({ run: { runId: "run-1", status: "completed" } });

    await expect(
      fetch(`${server.url}/api/commands`).then((response) => response.json())
    ).resolves.toEqual({ commands: [] });
    await expect(
      fetch(`${server.url}/api/capabilities`).then((response) => response.json())
    ).resolves.toEqual({ canCancel: false, canClearHistory: false });
    const clear = await fetch(`${server.url}/api/history`, {
      headers: { "x-tubeless-studio-clear-history": "1" },
      method: "DELETE",
    });
    expect(clear.status).toBe(405);
    const mutation = await fetch(`${server.url}/api/commands/fixture/runs`, {
      body: JSON.stringify({ values: {} }),
      headers: { "content-type": "application/json", "x-tubeless-studio-launch": "1" },
      method: "POST",
    });
    expect(mutation.status).toBe(405);
    const cancel = await fetch(`${server.url}/api/runs/run-1/cancel`, {
      headers: { "x-tubeless-studio-cancel": "1" },
      method: "POST",
    });
    expect(cancel.status).toBe(405);
  });

  it("returns actionable structured JSON errors for unknown API routes", async () => {
    const server = await startPipelineRunStudio({ port: 0, store: memoryStore(events) });
    servers.push(server);

    const response = await fetch(`${server.url}/api/missing`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    await expect(response.json()).resolves.toEqual(
      studioError(
        "endpoint_not_found",
        "Not found.",
        "Read the Studio guide at https://tubeless.io/docs/studio and choose a supported endpoint."
      )
    );

    const unsupportedMethod = await fetch(`${server.url}/api/missing`, { method: "POST" });
    expect(unsupportedMethod.status).toBe(405);
    await expect(unsupportedMethod.json()).resolves.toEqual(
      studioError(
        "method_not_allowed",
        "Method not allowed.",
        "Read the Studio guide at https://tubeless.io/docs/studio."
      )
    );
  });

  it("pins the studio page CSP hashes to the exact inline script and style", async () => {
    const server = await startPipelineRunStudio({ port: 0, store: memoryStore(events) });
    servers.push(server);

    const page = await fetch(server.url);
    const csp = page.headers.get("content-security-policy") ?? "";
    const html = await page.text();
    const script = /<script type="module">([\s\S]*)<\/script>/.exec(html)?.[1];
    const style = /<style>([\s\S]*)<\/style>/.exec(html)?.[1];
    expect(script).toBeTruthy();
    expect(style).toBeTruthy();
    const scriptHash = `'sha256-${createHash("sha256").update(script!).digest("base64")}'`;
    const styleHash = `'sha256-${createHash("sha256").update(style!).digest("base64")}'`;
    expect(html).toContain(`<script type="module">${PIPELINE_RUN_STUDIO_SCRIPT}</script>`);
    expect(csp).toBe(
      `default-src 'none'; style-src ${styleHash}; script-src ${scriptHash}; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
    );
    expect(csp).not.toContain("unsafe-inline");
  });

  it("keeps studio styles in the hashed stylesheet instead of inline declarations", async () => {
    const server = await startPipelineRunStudio({ port: 0, store: memoryStore(events) });
    servers.push(server);

    const html = await fetch(server.url).then((response) => response.text());
    const script = /<script type="module">([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
    const style = /<style>([\s\S]*)<\/style>/.exec(html)?.[1] ?? "";
    expect(script).toBe(PIPELINE_RUN_STUDIO_SCRIPT);
    expect(style).toBe(PIPELINE_RUN_STUDIO_STYLE);
    expect(script).not.toMatch(/\bstyle="/);
    expect(style).toContain(".pulse.lost");
    expect(style).toContain(".detail-heading-copy");
    expect(style).toContain(".detail-heading-actions");
    expect(style).toContain(".progress > i.w0");
    expect(style).toContain(".progress > i.w100");
    expect(script).toContain("Math.round");
    expect(script).toContain("Connection lost");
  });

  it("clears the pulse lost class after a disconnect then reconnect", () => {
    expect(connectionPresentation(false)).toEqual({
      className: "pulse lost",
      label: "Connection lost",
    });
    expect(connectionPresentation(true)).toEqual({
      className: "pulse",
      label: "Connected · local",
    });
  });

  it("escapes step status labels and guards isoTime in the served script", async () => {
    const server = await startPipelineRunStudio({ port: 0, store: memoryStore(events) });
    servers.push(server);

    const html = await fetch(server.url).then((response) => response.text());
    expect(html).toContain('id="studio-root"');
    expect(PIPELINE_RUN_STUDIO_SCRIPT).toContain("aria-label");
  });

  it("exposes only injected commands and delegates bounded structured launch values", async () => {
    const launches: { commandId: string; values: Record<string, unknown> }[] = [];
    const plans: { commandId: string; dryRun?: boolean; targets?: readonly string[] }[] = [];
    const server = await startPipelineRunStudio({
      launcher: {
        commands: [
          {
            canPlan: true,
            description: "Run the fixture.",
            id: "fixture",
            name: "Fixture",
            parameters: fixtureParameters,
          },
        ],
        plan(commandId, input) {
          plans.push({ commandId, dryRun: input.dryRun, targets: input.targets });
          return {
            dryRun: input.dryRun === true,
            errors: [],
            ok: true,
            pipelineId: "fixture",
            steps: [],
          };
        },
        async launch(commandId, values) {
          launches.push({ commandId, values });
          return { accepted: true, runId: "studio-run-1" };
        },
      },
      port: 0,
      store: memoryStore(events),
    });
    servers.push(server);

    await expect(
      fetch(`${server.url}/api/commands`).then((response) => response.json())
    ).resolves.toEqual({
      commands: [
        {
          canPlan: true,
          description: "Run the fixture.",
          id: "fixture",
          name: "Fixture",
          parameters: fixtureParameters,
        },
      ],
    });
    const planResponse = await fetch(`${server.url}/api/commands/fixture/plan`, {
      body: JSON.stringify({ dryRun: true, targets: ["publish"] }),
      headers: { "content-type": "application/json", "x-tubeless-studio-plan": "1" },
      method: "POST",
    });
    expect(planResponse.status).toBe(200);
    await expect(planResponse.json()).resolves.toMatchObject({
      plan: { dryRun: true, ok: true, pipelineId: "fixture" },
    });
    expect(plans).toEqual([{ commandId: "fixture", dryRun: true, targets: ["publish"] }]);
    const response = await fetch(`${server.url}/api/commands/fixture/runs`, {
      body: JSON.stringify({
        values: { dryRun: false, message: "hello world", retries: [1, 2], tags: ["one", "two"] },
      }),
      headers: { "content-type": "application/json", "x-tubeless-studio-launch": "1" },
      method: "POST",
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true, runId: "studio-run-1" });
    expect(launches).toEqual([
      {
        commandId: "fixture",
        values: { dryRun: false, message: "hello world", retries: [1, 2], tags: ["one", "two"] },
      },
    ]);

    const crossOriginShape = await fetch(`${server.url}/api/commands/fixture/runs`, {
      body: JSON.stringify({ values: {} }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(crossOriginShape.status).toBe(415);

    const missingPlanHeader = await fetch(`${server.url}/api/commands/fixture/plan`, {
      body: JSON.stringify({ dryRun: true }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(missingPlanHeader.status).toBe(415);
    const missingLaunchType = await fetch(`${server.url}/api/commands/fixture/runs`, {
      body: JSON.stringify({ values: { message: "hello" } }),
      headers: { "x-tubeless-studio-launch": "1" },
      method: "POST",
    });
    expect(missingLaunchType.status).toBe(415);
    const forgedHost = await requestWithHost(`${server.url}/api/commands/fixture/runs`, {
      body: JSON.stringify({ values: { message: "hello" } }),
      headers: { "content-type": "application/json", "x-tubeless-studio-launch": "1" },
      host: `evil.example:${new URL(server.url).port}`,
      method: "POST",
    });
    expect(forgedHost.status).toBe(403);
    expect(forgedHost.body).toEqual(untrustedHostError);
    expect(launches).toHaveLength(1);
    await expect(
      fetch(`${server.url}/api/capabilities`).then((response) => response.json())
    ).resolves.toEqual({ canCancel: false, canClearHistory: false });
    const cancelWithoutCapability = await fetch(`${server.url}/api/runs/studio-run-1/cancel`, {
      headers: { "x-tubeless-studio-cancel": "1" },
      method: "POST",
    });
    expect(cancelWithoutCapability.status).toBe(405);
  });

  it("does not advertise cancel when liveRunIds is missing", async () => {
    const server = await startPipelineRunStudio({
      launcher: {
        commands: [
          {
            canPlan: false,
            id: "fixture",
            name: "Fixture",
            parameters: fixtureParameters,
          },
        ],
        async launch() {
          return { accepted: true, runId: "live-run" };
        },
        async cancel(runId) {
          return { cancelled: true, runId };
        },
      },
      port: 0,
      store: memoryStore(events),
    });
    servers.push(server);

    await expect(
      fetch(`${server.url}/api/capabilities`).then((response) => response.json())
    ).resolves.toEqual({ canCancel: false, canClearHistory: false });
    await expect(
      fetch(`${server.url}/api/snapshot`).then((response) => response.json())
    ).resolves.toMatchObject({ liveRunIds: [] });
  });

  it("cancels a live launch only through an injected launcher cancel", async () => {
    const cancelled: string[] = [];
    const server = await startPipelineRunStudio({
      launcher: {
        commands: [
          {
            canPlan: false,
            id: "fixture",
            name: "Fixture",
            parameters: fixtureParameters,
          },
        ],
        async launch() {
          return { accepted: true, runId: "live-run" };
        },
        async cancel(runId) {
          cancelled.push(runId);
          return runId === "live-run" ? { cancelled: true, runId } : { cancelled: false };
        },
        liveRunIds() {
          return ["live-run"];
        },
      },
      port: 0,
      store: memoryStore(events),
    });
    servers.push(server);

    await expect(
      fetch(`${server.url}/api/capabilities`).then((response) => response.json())
    ).resolves.toEqual({ canCancel: true, canClearHistory: false });
    await expect(
      fetch(`${server.url}/api/snapshot`).then((response) => response.json())
    ).resolves.toMatchObject({ liveRunIds: ["live-run"] });
    const missingHeader = await fetch(`${server.url}/api/runs/live-run/cancel`, { method: "POST" });
    expect(missingHeader.status).toBe(415);
    const forgedHost = await requestWithHost(`${server.url}/api/runs/live-run/cancel`, {
      headers: { "x-tubeless-studio-cancel": "1" },
      host: `evil.example:${new URL(server.url).port}`,
      method: "POST",
    });
    expect(forgedHost.status).toBe(403);
    expect(forgedHost.body).toEqual(untrustedHostError);
    const unknown = await fetch(`${server.url}/api/runs/missing-run/cancel`, {
      headers: { "x-tubeless-studio-cancel": "1" },
      method: "POST",
    });
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toEqual(
      studioError(
        "run_not_live",
        "The run is not a live launch.",
        "Refresh /api/snapshot and cancel a run listed in liveRunIds."
      )
    );
    const response = await fetch(`${server.url}/api/runs/live-run/cancel`, {
      headers: { "x-tubeless-studio-cancel": "1" },
      method: "POST",
    });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ cancelled: true, runId: "live-run" });
    expect(cancelled).toEqual(["missing-run", "live-run"]);
  });

  it("pages beyond a store query cap and incrementally loads newer events", async () => {
    const stored = [...events];
    const cursors: (number | undefined)[] = [];
    const store: PipelineRunEventStore = {
      close() {},
      export() {},
      async listEvents(query = {}) {
        cursors.push(query.afterId);
        return stored.filter((event) => event.id > (query.afterId ?? 0)).slice(0, 1);
      },
    };
    const server = await startPipelineRunStudio({ port: 0, store });
    servers.push(server);

    await expect(
      fetch(`${server.url}/api/snapshot`).then((response) => response.json())
    ).resolves.toMatchObject({
      completedRunCount: 1,
      lastEventId: 2,
      runs: [{ runId: "run-1", status: "completed" }],
    });
    expect(cursors).toEqual([undefined, 1, 2]);

    stored.push(
      storedEvent({
        id: 3,
        name: "pipeline.started",
        pipelineId: "studio-fixture",
        runId: "run-2",
        timestampMs: 20,
        version: 2,
      }),
      storedEvent({
        durationMs: 5,
        id: 4,
        name: "pipeline.completed",
        pipelineId: "studio-fixture",
        runId: "run-2",
        timestampMs: 25,
        version: 2,
      })
    );
    await expect(
      fetch(`${server.url}/api/snapshot`).then((response) => response.json())
    ).resolves.toMatchObject({ completedRunCount: 2, lastEventId: 4 });
    expect(cursors.slice(-3)).toEqual([2, 3, 4]);
  });

  it("reads one run from the store and omits snapshot log bodies", async () => {
    const queries: { afterId?: number; runId?: string }[] = [];
    const stored: StoredPipelineEvent[] = [
      storedEvent({
        id: 1,
        name: "pipeline.started",
        pipelineId: "studio-fixture",
        runId: "run-1",
        timestampMs: 10,
        version: 2,
      }),
      storedEvent({
        id: 2,
        name: "pipeline.log",
        payload: { level: "log", message: "loaded rows" },
        pipelineId: "studio-fixture",
        runId: "run-1",
        stepId: "load",
        timestampMs: 12,
        version: 2,
      }),
      storedEvent({
        durationMs: 5,
        id: 3,
        name: "pipeline.completed",
        pipelineId: "studio-fixture",
        runId: "run-1",
        timestampMs: 15,
        version: 2,
      }),
      storedEvent({
        id: 4,
        name: "pipeline.started",
        pipelineId: "other",
        runId: "run-2",
        timestampMs: 20,
        version: 2,
      }),
      storedEvent({
        id: 5,
        name: "pipeline.log",
        payload: { level: "warn", message: "other run only" },
        pipelineId: "other",
        runId: "run-2",
        timestampMs: 21,
        version: 2,
      }),
    ];
    const store: PipelineRunEventStore = {
      close() {},
      export() {},
      async listEvents(query = {}) {
        queries.push({ afterId: query.afterId, runId: query.runId });
        return stored
          .filter(
            (event) =>
              (query.runId === undefined || event.runId === query.runId) &&
              (query.afterId === undefined || event.id > query.afterId)
          )
          .slice(0, query.limit);
      },
    };
    const server = await startPipelineRunStudio({ port: 0, store });
    servers.push(server);

    const snapshot = await fetch(`${server.url}/api/snapshot`).then((response) => response.json());
    expect(JSON.stringify(snapshot)).not.toContain("loaded rows");
    expect(JSON.stringify(snapshot)).not.toContain("other run only");
    expect(snapshot.runs).toEqual([
      expect.objectContaining({
        eventCount: 2,
        runId: "run-2",
        status: "running",
      }),
      expect.objectContaining({
        eventCount: 3,
        runId: "run-1",
        status: "completed",
      }),
    ]);

    queries.length = 0;
    const detail = await fetch(`${server.url}/api/runs/run-1`).then((response) => response.json());
    expect(detail).not.toHaveProperty("events");
    expect(detail.run).toMatchObject({
      logCount: 1,
      logs: [{ message: "loaded rows" }],
      runId: "run-1",
      status: "completed",
    });
    expect(queries.length).toBeGreaterThan(0);
    expect(
      queries.filter((query) => query.runId !== undefined).every((query) => query.runId === "run-1")
    ).toBe(true);

    const missing = await fetch(`${server.url}/api/runs/missing`);
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual(
      studioError(
        "run_not_found",
        "Run not found.",
        "Refresh /api/snapshot and choose an available runId."
      )
    );
  });

  it("loads batch artifacts only in selected run details as workspace history grows", async () => {
    const stored: StoredPipelineEvent[] = [];
    const server = await startPipelineRunStudio({ port: 0, store: memoryStore(stored) });
    servers.push(server);
    for (const batchCount of [1, 128]) {
      for (const runId of ["run-1", "run-2"]) {
        for (let batch = 0; batch < batchCount; batch += 1) {
          stored.push(
            storedEvent({
              id: stored.length + 1,
              name: "step.artifact",
              pipelineId: "batch-writer",
              runId,
              stepId: "write",
              attemptId: `${runId}-attempt`,
              timestampMs: stored.length,
              version: 2,
              payload: {
                operation: "write",
                preview: false,
                artifact: {
                  id: `${runId}-artifact-${batch}`,
                  metadata: { text: "x".repeat(4096) },
                },
              },
            })
          );
        }
      }
      const snapshot = await fetch(`${server.url}/api/snapshot`).then((response) =>
        response.json()
      );
      expect(snapshot.runs).toHaveLength(2);
      for (const run of snapshot.runs) {
        expect(run.stepCount).toBe(1);
        expect(run).not.toHaveProperty("steps");
      }
      expect(JSON.stringify(snapshot).length).toBeLessThan(2000);
      const detail = await fetch(`${server.url}/api/runs/run-1`).then((response) =>
        response.json()
      );
      expect(detail.run.steps[0].artifacts).toEqual(
        stored
          .filter((event) => event.runId === "run-1" && event.name === "step.artifact")
          .map((event) => ({
            ...event.payload,
            attemptId: event.attemptId,
            timestampMs: event.timestampMs,
          }))
      );
    }
  });

  it("pages compact roots, searches descendants and conditionally refreshes history", async () => {
    const stored: StoredPipelineEvent[] = [];
    const start = (runId: string, parentRunId?: string) =>
      stored.push(
        storedEvent({
          id: stored.length + 1,
          version: 2,
          name: "pipeline.started",
          pipelineId: runId,
          runId,
          parentRunId,
          timestampMs: stored.length + 1,
          payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
        })
      );
    for (let index = 0; index < 110; index += 1) start(`root-${index}`);
    start("searchable-child", "root-0");
    const server = await startPipelineRunStudio({ port: 0, store: memoryStore(stored) });
    servers.push(server);
    const endpoint = `${server.url}/api/snapshot`;
    const initial = await fetch(endpoint);
    const snapshot = await initial.json();
    expect(snapshot).toMatchObject({
      runCount: 111,
      rootRunCount: 110,
      matchingRootCount: 110,
      offset: 0,
    });
    expect(snapshot.runs).toHaveLength(50);
    expect(snapshot.runs[0].runId).toBe("root-109");
    expect(snapshot.runs.every((run: object) => !("steps" in run) && !("logs" in run))).toBe(true);
    expect(
      snapshot.definitions.every(
        (definition: object) => !("steps" in definition) && !("snapshot" in definition)
      )
    ).toBe(true);
    const unchanged = await fetch(endpoint, {
      headers: { "if-none-match": initial.headers.get("etag")! },
    });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    const replacement = await startPipelineRunStudio({ port: 0, store: memoryStore(stored) });
    servers.push(replacement);
    expect(
      (
        await fetch(`${replacement.url}/api/snapshot`, {
          headers: { "if-none-match": initial.headers.get("etag")! },
        })
      ).status
    ).toBe(200);
    const second = await fetch(endpoint + "?offset=50").then((response) => response.json());
    expect(second.runs).toHaveLength(50);
    expect(second.runs[0].runId).toBe("root-59");
    const search = await fetch(endpoint + "?query=SEARCHABLE&run=searchable-child").then(
      (response) => response.json()
    );
    expect(search.runs).toMatchObject([
      { runId: "root-0", descendantCount: 1, subtreeEventCount: 2 },
    ]);
    expect(search.selectedRun).toMatchObject({ runId: "searchable-child", rootRunId: "root-0" });
    const nested = await fetch(`${server.url}/api/runs/searchable-child`).then((response) =>
      response.json()
    );
    expect(nested.ancestors).toMatchObject([{ runId: "root-0" }]);
    const root = await fetch(`${server.url}/api/runs/root-0`).then((response) => response.json());
    expect(root.children).toMatchObject([{ runId: "searchable-child" }]);
    expect(root.descendantCount).toBe(1);
    start("new-root");
    const changed = await fetch(endpoint, {
      headers: { "if-none-match": initial.headers.get("etag")! },
    });
    expect(changed.status).toBe(200);
    expect((await changed.json()).runCount).toBe(112);
    expect((await fetch(endpoint + "?offset=-1")).status).toBe(400);
    const definition = await fetch(`${server.url}/api/definitions?pipelineId=root-0`).then(
      (response) => response.json()
    );
    expect(definition.definition).toMatchObject({ pipelineId: "root-0", steps: [], runCount: 1 });
    expect(definition).not.toHaveProperty("runs");
    const page = await fetch(`${server.url}/api/definitions/runs?pipelineId=root-0&offset=50`).then(
      (response) => response.json()
    );
    expect(page).toMatchObject({ runs: [{ runId: "root-0" }], offset: 0, runCount: 1 });
    expect(page).not.toHaveProperty("definition");
    expect(
      (await fetch(`${server.url}/api/definitions/runs?pipelineId=root-0&offset=-1`)).status
    ).toBe(400);
    expect((await fetch(`${server.url}/api/definitions?pipelineId=missing`)).status).toBe(404);
    expect((await fetch(`${server.url}/api/definitions/runs?pipelineId=missing`)).status).toBe(404);
  });

  it("includes a first store event whose id is zero in snapshots", async () => {
    const store = memoryStore([
      storedEvent({
        id: 0,
        name: "pipeline.started",
        pipelineId: "studio-fixture",
        runId: "run-zero",
        timestampMs: 1,
        version: 2,
      }),
    ]);
    const server = await startPipelineRunStudio({ port: 0, store });
    servers.push(server);

    await expect(
      fetch(`${server.url}/api/snapshot`).then((response) => response.json())
    ).resolves.toMatchObject({
      activeRunCount: 1,
      lastEventId: 0,
      runs: [{ runId: "run-zero", status: "running", startedAtMs: 1 }],
    });
  });

  it("clears complete history only through an injected maintenance capability", async () => {
    let stored = [...events];
    let clearCount = 0;
    const store: PipelineRunEventStore = {
      close() {},
      export() {},
      async listEvents(query = {}) {
        return stored.filter((event) => event.id > (query.afterId ?? 0));
      },
    };
    const server = await startPipelineRunStudio({
      history: {
        clear() {
          clearCount += 1;
          stored = [];
        },
      },
      port: 0,
      store,
    });
    servers.push(server);

    await expect(
      fetch(`${server.url}/api/capabilities`).then((response) => response.json())
    ).resolves.toEqual({ canCancel: false, canClearHistory: true });
    const missingHeader = await fetch(`${server.url}/api/history`, { method: "DELETE" });
    expect(missingHeader.status).toBe(415);
    const forgedHost = await requestWithHost(`${server.url}/api/history`, {
      headers: { "x-tubeless-studio-clear-history": "1" },
      host: `evil.example:${new URL(server.url).port}`,
      method: "DELETE",
    });
    expect(forgedHost.status).toBe(403);
    expect(forgedHost.body).toEqual(untrustedHostError);
    expect(clearCount).toBe(0);
    const response = await fetch(`${server.url}/api/history`, {
      headers: { "x-tubeless-studio-clear-history": "1" },
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cleared: true,
      eventCount: 2,
      runCount: 1,
    });
    expect(clearCount).toBe(1);
    await expect(
      fetch(`${server.url}/api/snapshot`).then((snapshot) => snapshot.json())
    ).resolves.toMatchObject({ lastEventId: 0, runs: [] });
  });

  it("clears a persisted run left active by an interrupted process", async () => {
    let clearCount = 0;
    const server = await startPipelineRunStudio({
      history: {
        clear() {
          clearCount += 1;
        },
      },
      port: 0,
      store: memoryStore(events.slice(0, 1)),
    });
    servers.push(server);

    const response = await fetch(`${server.url}/api/history`, {
      headers: { "x-tubeless-studio-clear-history": "1" },
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      cleared: true,
      runCount: 1,
    });
    expect(clearCount).toBe(1);
  });

  it("refuses to clear while the maintenance host knows a writer is live", async () => {
    let clearCount = 0;
    const server = await startPipelineRunStudio({
      history: {
        clear() {
          clearCount += 1;
        },
        isBusy: () => true,
      },
      port: 0,
      store: memoryStore(events),
    });
    servers.push(server);

    const response = await fetch(`${server.url}/api/history`, {
      headers: { "x-tubeless-studio-clear-history": "1" },
      method: "DELETE",
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(
      studioError(
        "history_busy",
        "Wait for active runs to finish before clearing history.",
        "Wait for live runs to finish, then retry the clear request."
      )
    );
    expect(clearCount).toBe(0);
  });

  it("brackets an IPv6 host in URLs and trusted request authorities", async () => {
    let clearCount = 0;
    const server = await startPipelineRunStudio({
      history: {
        clear() {
          clearCount += 1;
        },
      },
      host: "::1",
      port: 0,
      store: memoryStore(events),
    });
    servers.push(server);

    expect(server.url).toMatch(/^http:\/\/\[::1\]:\d+$/);
    const response = await fetch(`${server.url}/api/history`, {
      headers: { "x-tubeless-studio-clear-history": "1" },
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    expect(clearCount).toBe(1);
  });

  it("rejects a snapshot read whose Host does not match the bound authority", async () => {
    const server = await startPipelineRunStudio({ port: 0, store: memoryStore(events) });
    servers.push(server);

    const forgedHost = await requestWithHost(`${server.url}/api/snapshot`, {
      host: `evil.example:${new URL(server.url).port}`,
      method: "GET",
    });
    expect(forgedHost.status).toBe(403);
    expect(forgedHost.body).toEqual(untrustedHostError);
  });

  it("rejects the studio page when Host does not match the bound authority", async () => {
    const server = await startPipelineRunStudio({ port: 0, store: memoryStore(events) });
    servers.push(server);

    const forgedHost = await requestWithHost(server.url, {
      host: `evil.example:${new URL(server.url).port}`,
      method: "GET",
    });
    expect(forgedHost.status).toBe(403);
    expect(forgedHost.body).toEqual(untrustedHostError);
  });

  it("rejects a run read whose Host does not match the bound authority", async () => {
    const server = await startPipelineRunStudio({ port: 0, store: memoryStore(events) });
    servers.push(server);

    const forgedHost = await requestWithHost(`${server.url}/api/runs/some-id`, {
      host: `evil.example:${new URL(server.url).port}`,
      method: "GET",
    });
    expect(forgedHost.status).toBe(403);
    expect(forgedHost.body).toEqual(untrustedHostError);
  });

  it("rejects a literal-IP Host that does not match a specific bind", async () => {
    const server = await startPipelineRunStudio({ port: 0, store: memoryStore(events) });
    servers.push(server);

    const port = new URL(server.url).port;
    const forgedHost = await requestWithHost(`${server.url}/api/snapshot`, {
      host: `192.0.2.10:${port}`,
      method: "GET",
    });
    expect(forgedHost.status).toBe(403);
    expect(forgedHost.body).toEqual(untrustedHostError);
  });

  it("accepts localhost and literal-IP Hosts on a wildcard bind", async () => {
    const server = await startPipelineRunStudio({
      host: "0.0.0.0",
      port: 0,
      store: memoryStore(events),
    });
    servers.push(server);

    const port = new URL(server.url).port;
    const snapshotUrl = `http://127.0.0.1:${port}/api/snapshot`;
    for (const host of [
      `127.0.0.1:${port}`,
      `192.0.2.10:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
    ]) {
      const response = await requestWithHost(snapshotUrl, { host, method: "GET" });
      expect({ host, status: response.status }).toEqual({ host, status: 200 });
    }

    const forgedHost = await requestWithHost(snapshotUrl, {
      host: `evil.example:${port}`,
      method: "GET",
    });
    expect(forgedHost.status).toBe(403);
    expect(forgedHost.body).toEqual(untrustedHostError);
  });

  it("rejects a malformed run path segment with a generic 400", async () => {
    const server = await startPipelineRunStudio({ port: 0, store: memoryStore(events) });
    servers.push(server);

    const response = await fetch(`${server.url}/api/runs/%zz`);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      studioError(
        "malformed_path_segment",
        "Malformed path segment.",
        "Percent-encode the path segment as valid UTF-8."
      )
    );
  });

  it("hides unexpected store errors from the client and logs them", async () => {
    const logged: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    const secret = "SQLITE_ERROR: /secret/abs/path/studio.sqlite";
    try {
      const server = await startPipelineRunStudio({
        port: 0,
        store: {
          ...memoryStore([]),
          async listEvents() {
            throw new Error(secret);
          },
        },
      });
      servers.push(server);

      const response = await fetch(`${server.url}/api/snapshot`);
      const body = await response.json();
      expect(response.status).toBe(500);
      expect(body).toEqual(
        studioError(
          "studio_internal_error",
          "The studio hit an unexpected error.",
          "Inspect the local Studio process logs and retry after fixing the reported cause."
        )
      );
      expect(JSON.stringify(body)).not.toContain(secret);
      expect(logged.flat().join("\n")).toContain(secret);
    } finally {
      console.error = originalError;
    }
  });
});

describe("studio wildcard Host names", () => {
  it("accepts localhost and literal IPs as wildcard Host names", () => {
    expect(isLiteralOrLocalhostHttpHost("localhost")).toBe(true);
    expect(isLiteralOrLocalhostHttpHost("LOCALHOST")).toBe(true);
    expect(isLiteralOrLocalhostHttpHost("127.0.0.1")).toBe(true);
    expect(isLiteralOrLocalhostHttpHost("192.0.2.10")).toBe(true);
    expect(isLiteralOrLocalhostHttpHost("::1")).toBe(true);
    expect(isLiteralOrLocalhostHttpHost("[::1]")).toBe(true);
    expect(isLiteralOrLocalhostHttpHost("evil.example")).toBe(false);
    expect(isLiteralOrLocalhostHttpHost("0.0.0.0")).toBe(true);
  });
});
