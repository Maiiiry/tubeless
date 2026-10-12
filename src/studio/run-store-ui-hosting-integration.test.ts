import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodePipelineTraceEvent } from "../tracing/tracing-codec.js";
import { PIPELINE_RUN_STUDIO_STYLE } from "./run-store-ui-page.js";
import { readStudioClientScript } from "./run-store-ui-page-node.js";
import { parseStudioHosting } from "./run-store-ui-hosting.js";
import { startPipelineRunStudio } from "./run-store-ui.js";

const PIPELINE_RUN_STUDIO_SCRIPT = readStudioClientScript();

const token = "a1".repeat(32);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function close(server: Server) {
  return new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => close(server));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server");
  return address.port;
}
async function raw(
  port: number,
  path: string,
  headers: string[] = [],
  method = "GET",
  body = "",
  host = "example.test"
) {
  return new Promise<{
    status: number;
    text: string;
    headers: import("node:http").IncomingHttpHeaders;
  }>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: ["Host", host, "Content-Length", String(Buffer.byteLength(body)), ...headers],
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode!,
            text: Buffer.concat(chunks).toString(),
            headers: response.headers,
          })
        );
      }
    );
    request.on("error", reject);
    request.end(body);
  });
}
async function fixture(mount = "/admin/pipelines") {
  const event = {
    ...decodePipelineTraceEvent({
      version: 2,
      name: "pipeline.started",
      pipelineId: "fixture",
      runId: "run/id",
      timestampMs: 1,
      payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
    }),
    id: 1,
  };
  const listEvents = vi.fn(async (query: { afterId?: number } = {}) =>
    query.afterId ? [] : [event]
  );
  const launch = vi.fn(async () => ({ accepted: true as const, runId: "run/id" }));
  const plan = vi.fn(async () => ({
    pipelineId: "fixture",
    dryRun: false,
    ok: true,
    errors: [],
    steps: [],
  }));
  const cancel = vi.fn(async () => ({ cancelled: true as const, runId: "run/id" }));
  const clear = vi.fn();
  const hosting = parseStudioHosting("https://example.test" + mount + "/", token)!;
  const studio = await startPipelineRunStudio({
    host: "0.0.0.0",
    port: 0,
    hosting,
    store: { listEvents, close() {} },
    history: { clear },
    launcher: {
      commands: [{ id: "fixture/id", name: "Fixture", parameters: [], canPlan: true }],
      launch,
      plan,
      cancel,
      liveRunIds: () => ["run/id"],
    },
  });
  cleanups.push(() => studio.close());
  return { studio, listEvents, launch, plan, cancel, clear, hosting };
}
const auth = ["Authorization", "Bearer " + token];
const origin = ["Origin", "https://example.test"];

describe("authenticated Studio listener", () => {
  it("authenticates pages, redirects, unknown paths and health before any reader or launcher effect", async () => {
    const f = await fixture();
    for (const path of [
      "/admin/pipelines",
      "/admin/pipelines/",
      "/admin/pipelines/api/snapshot",
      "/admin/pipelines/api/health",
      "/unknown",
    ]) {
      for (const credentials of [
        [],
        ["Authorization", "Bearer bad"],
        [...auth, ...auth],
        ["Authorization", "Bearer " + "b2".repeat(32)],
      ]) {
        const response = await raw(f.studio.port, path, [
          ...credentials,
          "Forwarded",
          "host=example.test;proto=https",
          "X-Forwarded-User",
          "admin",
        ]);
        expect(response.status).toBe(401);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.text).not.toContain(token);
      }
    }
    expect(
      (
        await raw(
          f.studio.port,
          "/admin/pipelines/api/commands/fixture%2Fid/runs",
          [],
          "POST",
          "invalid JSON"
        )
      ).status
    ).toBe(401);
    expect(f.listEvents).not.toHaveBeenCalled();
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.plan).not.toHaveBeenCalled();
    expect(f.cancel).not.toHaveBeenCalled();
  });
  it("answers methods Fetch cannot represent in gateway order without logging", async () => {
    const f = await fixture();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const method of ["TRACE"]) {
        const path = "/admin/pipelines/api/snapshot";
        expect((await raw(f.studio.port, path, [], method)).status).toBe(401);
        expect(
          (await raw(f.studio.port, path, ["Authorization", "Bearer bad"], method)).status
        ).toBe(401);
        const untrusted = await raw(f.studio.port, path, auth, method, "", "evil.example");
        expect(untrusted.status).toBe(403);
        expect(JSON.parse(untrusted.text)).toMatchObject({ code: "untrusted_host" });
        const allowed = await raw(f.studio.port, path, auth, method);
        expect(allowed.status).toBe(405);
        expect(JSON.parse(allowed.text)).toMatchObject({ code: "method_not_allowed" });
      }
      expect(logged).not.toHaveBeenCalled();
      expect(f.listEvents).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
  it("checks raw mount boundaries before normalization and redirects only safe navigation", async () => {
    const { studio } = await fixture();
    const redirect = await raw(studio.port, "/admin/pipelines?run=run%2Fid", auth);
    expect(redirect.status).toBe(308);
    expect(redirect.headers.location).toBe("/admin/pipelines/?run=run%2Fid");
    expect((await raw(studio.port, "/admin/pipelines", [...auth, ...origin], "POST")).status).toBe(
      405
    );
    for (const path of [
      "/api/snapshot",
      "/admin/pipelines-sibling/api/snapshot",
      "/admin%2fpipelines/api/snapshot",
      "/admin/pipelines/../pipelines/api/snapshot",
      "/admin/pipelines/%2e%2e/pipelines/api/snapshot",
      "/admin/pipelines//api/snapshot",
      "/admin/pipelines\\api/snapshot",
    ])
      expect((await raw(studio.port, path, auth)).status).toBe(404);
  });
  it("requires original exact Origin for every mutation without weakening existing guards", async () => {
    const f = await fixture();
    for (const [path, method] of [
      ["commands/fixture%2Fid/plan", "POST"],
      ["commands/fixture%2Fid/runs", "POST"],
      ["runs/run%2Fid/cancel", "POST"],
      ["history", "DELETE"],
    ]) {
      for (const origins of [
        [],
        ["Origin", "null"],
        ["Origin", "https://other.test"],
        [...origin, ...origin],
        ["Origin", "https://example.test/"],
      ])
        expect(
          (
            await raw(
              f.studio.port,
              "/admin/pipelines/api/" + path,
              [...auth, ...origins],
              method,
              "invalid JSON"
            )
          ).status
        ).toBe(403);
    }
    expect(
      (
        await raw(
          f.studio.port,
          "/admin/pipelines/api/commands/fixture%2Fid/runs",
          [...auth, ...origin],
          "POST",
          "{}"
        )
      ).status
    ).toBe(415);
    expect(f.listEvents).not.toHaveBeenCalled();
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.plan).not.toHaveBeenCalled();
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.clear).not.toHaveBeenCalled();
  });
  it.each(["", "/admin/pipelines"])(
    "serves every route through a fixed upstream gateway at mount %s",
    async (mount) => {
      const f = await fixture(mount);
      let forwarded = 0;
      let backendToken = token;
      const proxy = createServer((request, response) => {
        // Synthetic admin decision. Production gateways verify their own session and permission.
        const user = request.headers["x-test-admin"];
        if (user !== "allowed") {
          response.writeHead(user === "denied" ? 403 : 401, {
            "content-type": "application/json",
            "cache-control": "no-store",
          });
          response.end(JSON.stringify({ message: "Access required" }));
          return;
        }
        if (
          (request.method === "POST" || request.method === "DELETE") &&
          request.headers.origin !== f.hosting.origin
        ) {
          response.writeHead(403);
          response.end();
          return;
        }
        forwarded++;
        const headers: Record<string, string> = {
          host: f.hosting.authority,
          authorization: "Bearer " + backendToken,
        };
        for (const name of [
          "origin",
          "content-type",
          "x-tubeless-studio-launch",
          "x-tubeless-studio-plan",
          "x-tubeless-studio-cancel",
          "x-tubeless-studio-clear-history",
        ]) {
          const value = request.headers[name];
          if (typeof value === "string") headers[name] = value;
        }
        // A fixed private DNS upstream with operator-owned public Host.
        const upstream = httpRequest(
          {
            hostname: "studio.private",
            lookup: (_hostname, _options, callback) =>
              callback(null, [{ address: "127.0.0.1", family: 4 }]),
            port: f.studio.port,
            path: request.url,
            method: request.method,
            headers,
          },
          (reply) => {
            if (reply.statusCode === 401) {
              reply.resume();
              response.writeHead(502, { "cache-control": "no-store" });
              response.end("Gateway configuration failed");
              return;
            }
            response.writeHead(reply.statusCode!, reply.headers);
            reply.pipe(response);
          }
        );
        upstream.on("error", () => {
          response.writeHead(502);
          response.end();
        });
        request.pipe(upstream);
      });
      const port = await listen(proxy);
      expect((await raw(port, mount + "/api/snapshot")).status).toBe(401);
      expect((await raw(port, mount + "/api/snapshot", ["x-test-admin", "denied"])).status).toBe(
        403
      );
      expect(forwarded).toBe(0);
      const user = [
        "x-test-admin",
        "allowed",
        "Authorization",
        "Bearer browser-supplied",
        "Cookie",
        "browser-session",
      ];
      const page = await raw(port, mount + "/?run=run%2Fid", user);
      expect(page.status).toBe(200);
      expect(page.text).toContain('name="tubeless-studio-mount" content="' + mount + '"');
      expect(page.text).not.toContain(token);
      const csp = page.headers["content-security-policy"];
      for (const asset of [PIPELINE_RUN_STUDIO_SCRIPT, PIPELINE_RUN_STUDIO_STYLE])
        expect(csp).toContain(
          "'sha256-" + createHash("sha256").update(asset).digest("base64") + "'"
        );
      expect(csp).toContain("connect-src 'self'; base-uri 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      for (const route of ["snapshot", "commands", "runs/run%2Fid", "health"])
        expect((await raw(port, mount + "/api/" + route, user)).status).toBe(200);
      expect(JSON.parse((await raw(port, mount + "/api/health", user)).text)).toEqual({
        ready: true,
      });
      expect(JSON.parse((await raw(port, mount + "/api/capabilities", user)).text)).toEqual({
        canCancel: true,
        canClearHistory: false,
      });
      const json = [...user, ...origin, "Content-Type", "application/json"];
      expect(
        (
          await raw(
            port,
            mount + "/api/commands/fixture%2Fid/plan",
            [...json, "x-tubeless-studio-plan", "1"],
            "POST",
            "{}"
          )
        ).status
      ).toBe(200);
      expect(f.plan).toHaveBeenCalledWith("fixture/id", {});
      expect(
        (
          await raw(
            port,
            mount + "/api/commands/fixture%2Fid/runs",
            [...json, "x-tubeless-studio-launch", "1"],
            "POST",
            '{"values":{}}'
          )
        ).status
      ).toBe(202);
      expect(f.launch).toHaveBeenCalledWith("fixture/id", {});
      expect(
        (
          await raw(
            port,
            mount + "/api/runs/run%2Fid/cancel",
            [...user, ...origin, "x-tubeless-studio-cancel", "1"],
            "POST"
          )
        ).status
      ).toBe(202);
      expect(f.cancel).toHaveBeenCalledWith("run/id");
      expect(
        (
          await raw(
            port,
            mount + "/api/history",
            [...user, ...origin, "x-tubeless-studio-clear-history", "1"],
            "DELETE"
          )
        ).status
      ).toBe(405);
      expect(f.clear).not.toHaveBeenCalled();
      backendToken = "b2".repeat(32);
      expect((await raw(port, mount + "/api/health", user)).status).toBe(502);
    }
  );
  it("rejects private DNS Host and forwarded authority unless the explicit public Host is used", async () => {
    const { studio } = await fixture();
    const response = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: "127.0.0.1",
          port: studio.port,
          path: "/admin/pipelines/api/health",
          headers: {
            host: "studio.private",
            authorization: "Bearer " + token,
            "x-forwarded-host": "example.test",
          },
        },
        (reply) => {
          reply.resume();
          resolve(reply.statusCode!);
        }
      );
      request.on("error", reject);
      request.end();
    });
    expect(response).toBe(403);
  });
});

it("closes authenticated readiness with the listener", async () => {
  const studio = await startPipelineRunStudio({
    port: 0,
    hosting: parseStudioHosting("https://example.test/admin", token),
    store: { listEvents: async () => [], close() {} },
  });
  expect(JSON.parse((await raw(studio.port, "/admin/api/health", auth)).text)).toEqual({
    ready: true,
  });
  const closed = studio.close();
  // Once close starts, either a still-served request sees 503 or the socket is closed.
  const result = await raw(studio.port, "/admin/api/health", auth).catch(() => undefined);
  if (result) {
    expect(result.status).toBe(503);
    expect(JSON.parse(result.text)).toEqual({ ready: false });
  }
  await closed;
  await expect(raw(studio.port, "/admin/api/health", auth)).rejects.toThrow();
});
