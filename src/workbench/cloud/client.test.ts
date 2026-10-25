import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudClientError, cloudVerificationUrl, createCloudClient } from "./client.js";
import type { CliRun, CliSession, CloudJsonValue } from "./protocol.js";

afterEach(() => vi.useRealTimers());

const host = "https://cloud.example";
const session: CliSession = {
  user: { id: "user", login: "login", name: "Name", email: "user@example.com", avatar: "" },
  expiresAt: 2000,
  workspaces: [
    {
      id: "workspace",
      name: "Workspace",
      slug: "workspace",
      role: "owner",
    },
  ],
};
const run: CliRun = {
  id: "run",
  pipelineId: "pipeline",
  pipelineName: "Pipeline",
  status: "completed",
  createdAt: 100,
  durationMs: 100,
  commit: "stored-commit",
  branch: "main",
  trigger: "manual",
  actor: "user",
  steps: [],
  logs: [{ time: 101, level: "info", message: "done" }],
  artifacts: [],
  input: {},
  result: { done: true },
};
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Cloud HTTP client", () => {
  it("binds bearer authority to one origin, omits cookies and rejects redirects", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(session));
    const client = createCloudClient({ host, token: "credential", fetch: fetcher });
    expect(await client.session()).toEqual(session);
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).toBe(`${host}/api/v1/session`);
    expect(options?.redirect).toBe("error");
    expect(options?.credentials).toBe("omit");
    expect(new Headers(options?.headers).get("Authorization")).toBe("Bearer credential");
    expect(new Headers(options?.headers).has("Cookie")).toBe(false);
    fetcher.mockResolvedValue(
      new Response(null, { status: 302, headers: { Location: "https://other.example" } })
    );
    await expect(client.session()).rejects.toMatchObject({ code: "invalid_response", status: 302 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("encodes workspace and run identities as path segments and uses one supplied admission key", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(run));
    const client = createCloudClient({ host, token: "credential", fetch: fetcher });
    await client.run(
      "space/with?characters",
      { pipelineId: "pipeline", input: { hello: "world" } },
      "fixed-key"
    );
    expect(String(fetcher.mock.calls[0][0])).toBe(
      `${host}/api/v1/workspaces/space%2Fwith%3Fcharacters/runs`
    );
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("Idempotency-Key")).toBe("fixed-key");
    expect(fetcher.mock.calls[0][1]?.body).toBe(
      JSON.stringify({ pipelineId: "pipeline", input: { hello: "world" } })
    );
    await client.getRun("workspace", "run/with?characters");
    expect(String(fetcher.mock.calls[1][0])).toBe(
      `${host}/api/v1/workspaces/workspace/runs/run%2Fwith%3Fcharacters`
    );
    expect(fetcher.mock.calls[1][1]?.method).toBe("GET");
  });

  it("never sends session authority during native device issuance and polling", async () => {
    const code = {
      device_code: "device",
      user_code: "CODE",
      verification_uri: `${host}/device`,
      verification_uri_complete: `${host}/device?user_code=CODE`,
      expires_in: 600,
      interval: 5,
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(code))
      .mockResolvedValueOnce(
        json({ error: "authorization_pending", error_description: "Pending approval" }, 400)
      )
      .mockResolvedValueOnce(json({ error: "slow_down" }, 400))
      .mockResolvedValueOnce(
        json({ access_token: "session-token", token_type: "Bearer", expires_in: 3600, scope: "" })
      );
    const client = createCloudClient({ host, token: "must-not-send", fetch: fetcher });
    expect(await client.deviceCode()).toEqual(code);
    expect(await client.deviceToken("device")).toEqual({
      error: "authorization_pending",
      error_description: "Pending approval",
    });
    expect(await client.deviceToken("device")).toEqual({ error: "slow_down" });
    expect(await client.deviceToken("device")).toMatchObject({ access_token: "session-token" });
    for (const call of fetcher.mock.calls)
      expect(new Headers(call[1]?.headers).has("Authorization")).toBe(false);
    expect(fetcher.mock.calls[1][1]?.body).toBe(
      JSON.stringify({
        client_id: "tubeless-cli",
        device_code: "device",
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      })
    );
  });

  it("checks transport DTOs rather than treating successful JSON as trusted", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createCloudClient({ host, token: "credential", fetch: fetcher });
    for (const invalid of [
      null,
      [],
      { ...session, expiresAt: "tomorrow" },
      { ...session, user: { id: "only-id" } },
      { ...session, workspaces: [{ ...session.workspaces[0], role: "superuser" }] },
      { ...session, workspaces: [{ ...session.workspaces[0], role: ["owner"] }] },
    ]) {
      fetcher.mockResolvedValue(json(invalid));
      await expect(client.session()).rejects.toMatchObject({ code: "invalid_response" });
    }
    fetcher.mockResolvedValue(json({ ...run, status: "unknown" }));
    await expect(client.getRun("workspace", "run")).rejects.toMatchObject({
      code: "invalid_response",
    });
    for (const invalid of [
      { ...run, status: ["completed"] },
      { ...run, trigger: ["manual"] },
      { ...run, logs: [{ ...run.logs[0], level: ["info"] }] },
      {
        ...run,
        steps: [
          { id: "step", name: "Step", status: ["completed"], durationMs: 1, dependencies: [] },
        ],
      },
    ]) {
      fetcher.mockResolvedValue(json(invalid));
      await expect(client.getRun("workspace", "run")).rejects.toMatchObject({
        code: "invalid_response",
      });
    }
    fetcher.mockResolvedValue(json({ ...run, logs: [{ message: "missing-fields" }] }));
    await expect(client.getRun("workspace", "run")).rejects.toMatchObject({
      code: "invalid_response",
    });
    fetcher.mockResolvedValue(
      json({ ...run, logs: Array.from({ length: 401 }, () => run.logs[0]) })
    );
    await expect(client.getRun("workspace", "run")).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("validates loaded pipeline summaries without requiring source selectors", async () => {
    const pipeline = {
      id: "cloud-id",
      name: "Orders sync",
      slug: "orders-sync",
      branch: "main",
      commit: "stored-sha",
      enabled: true,
      available: true,
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json([pipeline]));
    const client = createCloudClient({ host, token: "credential", fetch: fetcher });
    expect(await client.pipelines("workspace")).toEqual([pipeline]);
    for (const invalid of [
      { ...pipeline, name: undefined },
      { ...pipeline, slug: undefined },
      { ...pipeline, slug: "" },
      { ...pipeline, available: "yes" },
      { ...pipeline, enabled: undefined },
    ]) {
      fetcher.mockResolvedValue(json([invalid]));
      await expect(client.pipelines("workspace")).rejects.toMatchObject({
        code: "invalid_response",
      });
    }
  });

  it.each(["input", "result"])(
    "rejects overflowing numeric literals in run response %s",
    async (field) => {
      const body = JSON.stringify({ ...run, [field]: { nested: ["overflow"] } }).replace(
        '"overflow"',
        "1e400"
      );
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(
          async () => new Response(body, { headers: { "Content-Type": "application/json" } })
        );
      const client = createCloudClient({ host, token: "credential", fetch: fetcher });
      await expect(client.getRun("workspace", "run")).rejects.toMatchObject({
        code: "invalid_response",
        status: 200,
      });
      await expect(
        client.run("workspace", { pipelineId: "pipeline", input: {} }, "key")
      ).rejects.toMatchObject({ code: "invalid_response", status: 200 });
    }
  );

  it.each(["input", "result"])("rejects excessive nesting in run response %s", async (field) => {
    const raw = '{"a":'.repeat(129) + "1" + "}".repeat(129);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => json({ ...run, [field]: JSON.parse(raw) }));
    const client = createCloudClient({ host, token: "credential", fetch: fetcher });
    await expect(client.getRun("workspace", "run")).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it.each([null, false, 0, "", [1, { nested: "value" }], { a: 1 }])(
    "preserves valid JSON run result %j",
    async (result) => {
      const response = { ...run, result };
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(response));
      const client = createCloudClient({ host, token: "credential", fetch: fetcher });
      expect(await client.getRun("workspace", "run")).toEqual(response);
    }
  );

  it("allows input and result at the nesting boundary, including absent result", async () => {
    const raw = '{"a":'.repeat(128) + "1" + "}".repeat(128);
    const response = { ...run, input: JSON.parse(raw), result: JSON.parse(raw) };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(response));
    const client = createCloudClient({ host, token: "credential", fetch: fetcher });
    expect(JSON.stringify(await client.getRun("workspace", "run"))).toBe(JSON.stringify(response));
    const { result: _result, ...withoutResult } = response;
    fetcher.mockResolvedValue(json(withoutResult));
    expect(await client.getRun("workspace", "run")).toEqual(withoutResult);
  });

  it("rejects unrepresentable Date timestamps and accepts the inclusive maximum", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createCloudClient({ host, token: "credential", fetch: fetcher });
    for (const invalid of [
      { ...run, logs: [{ ...run.logs[0], time: 8.64e15 + 1 }] },
      { ...run, createdAt: 8.64e15 + 1 },
      { ...run, startedAt: 8.64e15 + 1 },
      { ...run, finishedAt: 8.64e15 + 1 },
      {
        ...run,
        schedule: { id: "schedule", name: "Schedule", timezone: "UTC", scheduledAt: 8.64e15 + 1 },
      },
    ]) {
      fetcher.mockResolvedValue(json(invalid));
      await expect(client.getRun("workspace", "run")).rejects.toMatchObject({
        code: "invalid_response",
      });
    }
    fetcher.mockResolvedValue(json({ ...session, expiresAt: 8.64e15 + 1 }));
    await expect(client.session()).rejects.toMatchObject({ code: "invalid_response" });
    const maximum = { ...run, logs: [{ ...run.logs[0], time: 8.64e15 }] };
    fetcher.mockResolvedValue(json(maximum));
    const accepted = await client.getRun("workspace", "run");
    expect(new Date(accepted.logs[0].time).toISOString()).toBe("+275760-09-13T00:00:00.000Z");
  });

  it("preserves stable service errors while removing terminal controls and the active token", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      json(
        {
          error: {
            code: "forbidden",
            message: "Membership removed. secret-token\u001b[31m\u009b\u202e",
          },
        },
        403
      )
    );
    const client = createCloudClient({ host, token: "secret-token", fetch: fetcher });
    await expect(client.session()).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
      message: "Membership removed. [redacted] [31m  ",
    });
    fetcher.mockRejectedValue(new Error("Request authorization secret-token was rejected"));
    await expect(client.session()).rejects.toMatchObject({ code: "transport_error" });
    await expect(client.session()).rejects.not.toThrow("secret-token");
  });

  it("bounds requests before sending and validates admission keys", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createCloudClient({ host, token: "credential", fetch: fetcher });
    await expect(
      client.run(
        "workspace",
        { pipelineId: "pipeline", input: { data: "x".repeat(64 * 1024) } },
        "key"
      )
    ).rejects.toMatchObject({ code: "invalid_request" });
    for (const key of ["key\nHeader: secret", "x".repeat(201)])
      await expect(
        client.run("workspace", { pipelineId: "pipeline", input: {} }, key)
      ).rejects.toThrow("idempotency key");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts the service's full 200-character idempotency key budget", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(run));
    const client = createCloudClient({ host, token: "credential", fetch: fetcher });
    await expect(
      client.run("workspace", { pipelineId: "pipeline", input: {} }, "x".repeat(200))
    ).resolves.toEqual(run);
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("Idempotency-Key")).toHaveLength(200);
  });

  it.each([Infinity, -Infinity, NaN])(
    "rejects nested non-finite input %s before HTTP",
    async (value) => {
      const fetcher = vi.fn<typeof fetch>();
      const client = createCloudClient({ host, token: "credential", fetch: fetcher });
      await expect(
        client.run("workspace", { pipelineId: "pipeline", input: { nested: [{ value }] } }, "key")
      ).rejects.toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("finite"),
      });
      expect(fetcher).not.toHaveBeenCalled();
    }
  );

  it("rejects cyclic and overly nested input but permits shared objects and the nesting limit", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(run));
    const client = createCloudClient({ host, token: "credential", fetch: fetcher });
    const cyclic: Record<string, CloudJsonValue> = {};
    cyclic.self = cyclic;
    await expect(
      client.run("workspace", { pipelineId: "pipeline", input: cyclic }, "cyclic")
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetcher).not.toHaveBeenCalled();
    const shared = { value: 1 };
    await client.run(
      "workspace",
      { pipelineId: "pipeline", input: { a: shared, b: shared } },
      "shared"
    );
    const deepJson = '{"a":'.repeat(128) + "1" + "}".repeat(128);
    const input: Record<string, CloudJsonValue> = JSON.parse(deepJson);
    await client.run("workspace", { pipelineId: "pipeline", input }, "deep");
    expect(fetcher.mock.calls[1][1]?.body).toBe(`{"pipelineId":"pipeline","input":${deepJson}}`);
    const excessive: Record<string, CloudJsonValue> = JSON.parse(
      '{"a":'.repeat(129) + "1" + "}".repeat(129)
    );
    await expect(
      client.run("workspace", { pipelineId: "pipeline", input: excessive }, "excessive")
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("128 levels"),
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("allows a full 64 KiB multibyte input with the run envelope and rejects the next byte", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(run));
    const client = createCloudClient({ host, token: "credential", fetch: fetcher });
    const emptyBytes = Buffer.byteLength(JSON.stringify({ data: "" }), "utf8");
    const remaining = 64 * 1024 - emptyBytes;
    const data = "é".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2);
    const input = { data };
    expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBe(65536);
    expect(await client.run("workspace", { pipelineId: "pipeline", input }, "exact-limit")).toEqual(
      run
    );
    const requestBody = fetcher.mock.calls[0][1]?.body;
    expect(typeof requestBody).toBe("string");
    expect(Buffer.byteLength(String(requestBody), "utf8")).toBeGreaterThan(65536);
    expect(JSON.parse(String(requestBody))).toEqual({ pipelineId: "pipeline", input });
    const oversized = { data: `${data}x` };
    expect(Buffer.byteLength(JSON.stringify(oversized), "utf8")).toBe(65537);
    await expect(
      client.run("workspace", { pipelineId: "pipeline", input: oversized }, "over-limit")
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: "Cloud run input exceeds the 64 KB JSON limit.",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("bounds streamed response bytes even without a Content-Length", async () => {
    const cancel = vi.fn();
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks++;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel,
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(body, { headers: { "Content-Type": "application/json" } }));
    await expect(
      createCloudClient({ host, token: "credential", fetch: fetcher }).session()
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(chunks).toBeLessThanOrEqual(6);
  });

  it("rejects HTML and malformed JSON without echoing response bodies", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("<html>secret-token</html>", { headers: { "Content-Type": "text/html" } })
      );
    const client = createCloudClient({ host, token: "secret-token", fetch: fetcher });
    await expect(client.session()).rejects.toThrow("non-JSON");
    fetcher.mockResolvedValue(
      new Response("bad-json secret-token", { headers: { "Content-Type": "application/json" } })
    );
    await expect(client.session()).rejects.toThrow("invalid JSON");
  });

  it("times out a fetch that ignores AbortSignal and honors caller interruption", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Promise<Response>(() => {}));
    const controller = new AbortController();
    const client = createCloudClient({
      host,
      token: "credential",
      fetch: fetcher,
      timeoutMs: 10,
      signal: controller.signal,
    });
    const timeout = client.session().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    expect(await timeout).toMatchObject({ code: "timeout" });
    const interrupted = client.session().catch((error: unknown) => error);
    controller.abort();
    expect(await interrupted).toMatchObject({ code: "cancelled" });
    expect(fetcher.mock.calls[1][1]?.signal?.aborted).toBe(true);
  });

  it("rejects missing credentials and invalid timeouts before transport", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(createCloudClient({ host, fetch: fetcher }).session()).rejects.toBeInstanceOf(
      CloudClientError
    );
    expect(() => createCloudClient({ host, timeoutMs: Infinity })).toThrow("timeout");
    expect(() => createCloudClient({ host, token: "token\nheader" })).toThrow(
      "credential is invalid"
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("device browser URL validation", () => {
  it("permits same-origin approval URLs and rejects other origins and embedded authority", () => {
    expect(cloudVerificationUrl(host, `${host}/device?user_code=CODE`)).toBe(
      `${host}/device?user_code=CODE`
    );
    for (const url of [
      "https://other.example/device",
      "https://user:secret@cloud.example/device",
      "https://@cloud.example/device",
      `${host}/device#`,
      `${host}/device#fragment`,
      "/device",
    ]) {
      expect(() => cloudVerificationUrl(host, url)).toThrow("Cloud");
    }
  });
});
