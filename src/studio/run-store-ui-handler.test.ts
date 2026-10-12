import { describe, expect, it } from "vitest";
import {
  createStudioRequestHandler,
  type StudioRequestHandlerOptions,
} from "./run-store-ui-handler.js";
import { jsonResponse } from "./run-store-ui-http.js";

function handler(overrides: Partial<StudioRequestHandlerOptions> = {}) {
  return createStudioRequestHandler({
    api: async (_request, url) => jsonResponse({ path: url.pathname }),
    page: { csp: "default-src 'none'", html: (mount) => `<page ${mount}>` },
    mount: "",
    trustsAuthority: () => true,
    isReady: () => true,
    ...overrides,
  });
}
const get = (rawTarget: string, init?: RequestInit) =>
  [new Request("http://studio.local/", init), { rawTarget, authority: "studio.example" }] as const;

describe("Studio request pipeline", () => {
  it("authenticates before any other check", async () => {
    const denied = new Response("no", { status: 401 });
    const response = await handler({ authenticate: () => denied, trustsAuthority: () => false })(
      ...get("/")
    );
    expect(response.status).toBe(401);
  });

  it("rejects untrusted hosts and foreign origins on mutations", async () => {
    expect((await handler({ trustsAuthority: () => false })(...get("/"))).status).toBe(403);
    const origin = handler({ allowedOrigin: () => "https://studio.example" });
    const foreign = await origin(
      ...get("/api/commands/x/runs", {
        method: "POST",
        headers: { origin: "https://evil.example" },
      })
    );
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({ code: "untrusted_origin" });
    const same = await origin(
      ...get("/api/commands/x/runs", {
        method: "POST",
        headers: { origin: "https://studio.example" },
      })
    );
    expect(same.status).toBe(200);
    for (const value of [
      "null",
      "https://studio.example/",
      "https://studio.example, https://studio.example",
    ]) {
      const rejected = await origin(
        ...get("/api/commands/x/runs", { method: "DELETE", headers: { origin: value } })
      );
      expect(rejected.status).toBe(403);
    }
    expect((await origin(...get("/api/commands/x/runs", { method: "DELETE" }))).status).toBe(403);
  });

  it("serves the page with CSP, health, redirects and API routes", async () => {
    const page = await handler()(...get("/"));
    expect(page.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(await page.text()).toBe("<page >");
    expect(await (await handler({ isReady: () => false })(...get("/api/health"))).json()).toEqual({
      ready: false,
    });
    const mounted = await handler({ mount: "/admin" })(...get("/admin?run=1"));
    expect(mounted.status).toBe(308);
    expect(mounted.headers.get("location")).toBe("/admin/?run=1");
    expect(await (await handler()(...get("/api/runs/a%2Fb"))).json()).toEqual({
      path: "/api/runs/a%2Fb",
    });
    expect((await handler()(...get("/../x"))).status).toBe(404);
  });

  it("converts thrown errors into a generic 500", async () => {
    const original = console.error;
    console.error = () => {};
    try {
      const response = await handler({
        api: async () => {
          throw new Error("boom");
        },
      })(...get("/api/x"));
      expect(response.status).toBe(500);
    } finally {
      console.error = original;
    }
  });
});
