import { describe, expect, it } from "vitest";
import { createStudioHost } from "./hosting-studio.js";

const store = { listEvents: async () => [] };

describe("edge Studio host", () => {
  it("serves the page and read-only API at the root mount", async () => {
    const host = await createStudioHost({ store, clientScript: "console.log(1)" });
    const page = await host.fetch(new Request("https://studio.example/"));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("console.log(1)");
    const capabilities = await host.fetch(new Request("https://studio.example/api/capabilities"));
    expect(await capabilities.json()).toEqual({ canCancel: false, canClearHistory: false });
  });

  it("requires a same-origin Origin for mutations", async () => {
    const host = await createStudioHost({ store, clientScript: "" });
    const init = {
      method: "POST",
      headers: { "content-type": "application/json", "x-tubeless-studio-launch": "1" },
      body: "{}",
    };
    const foreign = await host.fetch(
      new Request("https://studio.example/api/commands/x/runs", {
        ...init,
        headers: { ...init.headers, origin: "https://evil.example" },
      })
    );
    expect(foreign.status).toBe(403);
    const same = await host.fetch(
      new Request("https://studio.example/api/commands/x/runs", {
        ...init,
        headers: { ...init.headers, origin: "https://studio.example" },
      })
    );
    expect(same.status).toBe(405);
  });

  it("applies the authenticator first", async () => {
    const host = await createStudioHost({
      store,
      clientScript: "",
      authenticate: () => new Response("no", { status: 401 }),
    });
    expect((await host.fetch(new Request("https://studio.example/"))).status).toBe(401);
  });

  it("rejects oversized launch bodies", async () => {
    const launcher = {
      commands: [{ id: "x", name: "X", canPlan: false, parameters: [] }],
      launch: async () => ({ accepted: true as const, runId: "r" }),
    };
    const host = await createStudioHost({ store, launcher, clientScript: "" });
    const response = await host.fetch(
      new Request("https://studio.example/api/commands/x/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tubeless-studio-launch": "1",
          origin: "https://studio.example",
        },
        body: JSON.stringify({ values: { text: "x".repeat(70_000) } }),
      })
    );
    expect(response.status).toBe(413);
  });
});
