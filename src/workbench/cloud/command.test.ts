import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCloud } from "./command.js";
import { captureIo } from "../workbench.test-support.js";
import type { CliRun, CliPipeline, CliWorkspace } from "./protocol.js";

const host = "http://localhost:8787";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const pipeline: CliPipeline = {
  id: "cloud-orders",
  name: "Orders",
  slug: "orders",
  branch: "main",
  commit: "stored-sha",
  enabled: true,
  available: true,
};
const baseRun: CliRun = {
  id: "run-1",
  pipelineId: pipeline.id,
  pipelineName: pipeline.name,
  status: "queued",
  createdAt: 1000,
  durationMs: 0,
  commit: "accepted-sha",
  branch: "main",
  trigger: "manual",
  actor: "user",
  steps: [],
  logs: [],
  artifacts: [],
  input: {},
};
async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "tubeless-cloud-command-"));
  roots.push(root);
  await mkdir(path.join(root, ".tubeless"));
  await writeFile(path.join(root, ".tubeless/cloud.json"), "stale malformed project configuration");
  return root;
}
function service(
  options: {
    pipelines?: CliPipeline[];
    workspaces?: CliWorkspace[];
    runs?: CliRun[];
    admission?: CliRun;
    admissionStatus?: number;
    admissionError?: string;
    lostAcknowledgement?: boolean;
  } = {}
) {
  const calls: { method: string; url: string; body?: unknown; key?: string }[] = [];
  let admitted = false;
  const runs = [...(options.runs ?? [{ ...baseRun, status: "completed", result: { ok: true } }])];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({
      method,
      url: url.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      key: headers.get("Idempotency-Key") ?? undefined,
    });
    if (url.pathname === "/api/v1/session")
      return Response.json({
        user: { id: "user", login: "user", name: "User", email: "user@example.com", avatar: "" },
        expiresAt: Date.now() + 60000,
        workspaces: options.workspaces ?? [
          {
            id: "workspace",
            name: "Workspace",
            slug: "workspace",
            role: "owner",
          },
        ],
      });
    if (url.pathname.endsWith("/pipelines")) return Response.json(options.pipelines ?? [pipeline]);
    if (url.pathname.endsWith("/runs")) {
      if (options.admissionError)
        return Response.json(
          { error: { code: options.admissionError, message: "Rejected" } },
          { status: options.admissionStatus ?? 429 }
        );
      if (options.lostAcknowledgement && !admitted) {
        admitted = true;
        throw new Error("lost response");
      }
      return Response.json(options.admission ?? baseRun, { status: 202 });
    }
    if (url.pathname.endsWith(`/runs/${encodeURIComponent(options.admission?.id ?? baseRun.id)}`))
      return Response.json(runs.length > 1 ? runs.shift() : runs[0]);
    throw new Error("Unexpected route");
  }) as typeof fetch;
  return {
    calls,
    fetch: fetcher,
    env: { TUBELESS_TOKEN: "fixture-secret" },
    sleep: async () => {},
  };
}

describe("Cloud remote commands", () => {
  it("help makes no HTTP requests", async () => {
    const dependencies = service();
    expect(await runCloud(["run", "--help"], captureIo("/detached"), dependencies)).toBe(0);
    expect(dependencies.calls).toEqual([]);
  });

  it.each([["--input-file", ""], ["--input-file="]])(
    "rejects an explicitly empty input-file path before HTTP: %j",
    async (...flags) => {
      const dependencies = service();
      const io = captureIo("/detached");
      expect(await runCloud(["run", pipeline.slug, ...flags], io, dependencies)).toBe(1);
      expect(dependencies.calls).toHaveLength(0);
      expect(io.errors.join("")).toContain("nonempty --input-file path");
      expect(io.output.join("")).toBe("");
    }
  );
  it("runs deployed code without executing a side-effecting local module", async () => {
    const root = await fixture();
    const marker = path.join(root, "unexpected.txt");
    await writeFile(
      path.join(root, pipeline.name),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad'); throw new Error('local source must not load');`
    );
    const io = captureIo(root);
    const dependencies = service();
    expect(await runCloud(["run", pipeline.name, "--json"], io, dependencies)).toBe(0);
    await expect(access(marker)).rejects.toThrow();
    expect(dependencies.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /api/v1/session",
      "GET /api/v1/workspaces/workspace/pipelines",
      "POST /api/v1/workspaces/workspace/runs",
      "GET /api/v1/workspaces/workspace/runs/run-1",
    ]);
    expect(JSON.parse(io.output.join(""))).toMatchObject({
      status: "completed",
      commit: "accepted-sha",
    });
    expect(io.errors.join("")).toContain("Local changes are not used");
    expect(io.errors.join("")).toContain("workspace=workspace");
    expect(io.output.join("")).not.toContain("fixture-secret");
  });
  it("explicit IDs work outside a Git repository", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tubeless-detached-"));
    roots.push(root);
    const dependencies = service();
    expect(
      await runCloud(
        ["run", "--id", pipeline.id, "--host", host, "--workspace", "workspace", "--detach"],
        captureIo(root),
        dependencies
      )
    ).toBe(0);
  });
  it("unknown or duplicate names never admit", async () => {
    const root = await fixture();
    for (const pipelines of [[], [pipeline, { ...pipeline, id: "other" }]]) {
      const io = captureIo(root);
      const dependencies = service({ pipelines });
      expect(await runCloud(["run", pipeline.name], io, dependencies)).toBe(2);
      expect(dependencies.calls.every((call) => call.method === "GET")).toBe(true);
      expect(io.errors.join("")).toMatch(/cloud list|Multiple pipelines/);
    }
  });
  it("invalid/oversized JSON input fails before admission", async () => {
    const root = await fixture();
    for (const input of [
      "null",
      "[]",
      "{",
      '"scalar"',
      JSON.stringify({ long: "x".repeat(65536) }),
    ]) {
      const dependencies = { ...service(), readStdin: async () => input };
      expect(
        await runCloud(["run", pipeline.name, "--input-file", "-"], captureIo(root), dependencies)
      ).toBe(4);
      expect(dependencies.calls.every((call) => call.method === "GET")).toBe(true);
    }
  });
  it("passes stdin JSON objects and reuses the key after a lost acknowledgement", async () => {
    const root = await fixture();
    const dependencies = {
      ...service({ lostAcknowledgement: true }),
      readStdin: async () => '{"hello":"world"}',
    };
    expect(
      await runCloud(
        ["run", pipeline.name, "--input-file", "-", "--detach"],
        captureIo(root),
        dependencies
      )
    ).toBe(0);
    const admissions = dependencies.calls.filter((call) => call.method === "POST");
    expect(admissions).toHaveLength(2);
    expect(admissions[0]!.key).toBe(admissions[1]!.key);
    expect(admissions[0]!.body).toEqual({ pipelineId: pipeline.id, input: { hello: "world" } });
  });

  it.each(["-", "input.json"])(
    "rejects overflowing numbers and excessive nesting from %s without admission or retries",
    async (file) => {
      const root = await fixture();
      for (const input of [
        '{"threshold":1e400}',
        '{"nested":[{"threshold":-1e400}]}',
        '{"a":'.repeat(129) + "1" + "}".repeat(129),
      ]) {
        await writeFile(path.join(root, "input.json"), input);
        const dependencies = { ...service(), readStdin: async () => input };
        const io = captureIo(root);
        expect(await runCloud(["run", pipeline.name, "--input-file", file], io, dependencies)).toBe(
          4
        );
        expect(dependencies.calls.every((call) => call.method === "GET")).toBe(true);
        expect(io.errors.join("")).toContain("finite numbers");
        expect(io.errors.join("")).not.toContain("Admission could not be confirmed");
        expect(io.errors.join("")).not.toContain("idempotency key");
      }
    }
  );

  it("sanitizes human pipeline fields while preserving JSON fields", async () => {
    const remote = `remote\u001b]52;c;clipboard\u0007\u009b31m\u061c\u200e\u200f\u202e\u2066\nspoof`;
    const unsafe = {
      ...pipeline,
      id: remote,
      name: remote,
      slug: remote,
      branch: remote,
      commit: remote,
    };
    const human = captureIo(await fixture());
    expect(await runCloud(["list"], human, service({ pipelines: [unsafe] }))).toBe(0);
    expect(human.output.join("").slice(0, -1)).not.toMatch(
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/
    );
    expect(human.output.join("").split("\n")).toHaveLength(2);
    const machine = captureIo(await fixture());
    expect(await runCloud(["list", "--json"], machine, service({ pipelines: [unsafe] }))).toBe(0);
    expect(JSON.parse(machine.output.join(""))).toEqual([unsafe]);
  });

  it.each([[], ["--follow"]])(
    "sanitizes retained and followed logs while preserving JSON %j",
    async (...flags) => {
      const remote = "before\u001b]8;;https://evil.example\u0007link\u009b31m\u202e\nafter";
      const log = { time: 1000, level: "info" as const, message: remote };
      const run = { ...baseRun, status: "completed" as const, logs: [log] };
      const human = captureIo(await fixture());
      expect(await runCloud(["logs", run.id, ...flags], human, service({ runs: [run] }))).toBe(0);
      expect(human.output.join("")).toContain(
        "info: before ]8;;https://evil.example link 31m  after\n"
      );
      const machine = captureIo(await fixture());
      expect(
        await runCloud(["logs", run.id, ...flags, "--json"], machine, service({ runs: [run] }))
      ).toBe(0);
      expect(JSON.parse(machine.output.join("")).logs).toEqual([log]);
    }
  );

  it("sanitizes run progress, results and failures without changing machine snapshots", async () => {
    const remote = "remote\u001b[2J\u009b\u202e\nspoof";
    const run: CliRun = {
      ...baseRun,
      id: remote,
      pipelineName: remote,
      commit: remote,
      status: "failed",
      result: { value: remote },
      error: remote,
    };
    for (const json of [false, true]) {
      const io = captureIo(await fixture());
      expect(
        await runCloud(
          ["run", pipeline.name, ...(json ? ["--json"] : [])],
          io,
          service({ admission: run })
        )
      ).toBe(6);
      const human = json ? io.errors.join("") : io.output.join("") + io.errors.join("");
      expect(human).not.toMatch(/[\u001b\u009b\u202e]/);
      expect(human).toContain("Run remote [2J   spoof: remote [2J   spoof\n");
      expect(human).toContain("Deployed commit: remote [2J   spoof\n");
      if (json) expect(JSON.parse(io.output.join(""))).toEqual(run);
      else expect(io.errors.join("")).toBe("remote [2J   spoof\n");
    }
  });

  it("sanitizes workspace choices and admitted run diagnostics", async () => {
    const remote = "remote\u001b[2J\u009b\u202e\nspoof";
    const choices = service({
      workspaces: [
        { id: remote, name: remote, slug: "workspace", role: "owner" },
        { id: "other", name: "Other", slug: "other", role: "owner" },
      ],
    });
    const selection = captureIo(await fixture());
    expect(await runCloud(["list"], selection, choices)).toBe(2);
    expect(selection.errors.join("")).not.toMatch(/[\u001b\u009b\u202e]/);
    expect(selection.errors.join("")).toContain("Other (other)");
    const dependencies = service({ admission: { ...baseRun, id: remote } });
    const original = dependencies.fetch;
    dependencies.fetch = (async (url: string | URL | Request, init?: RequestInit) =>
      init?.method === "POST" ||
      String(url).endsWith("/session") ||
      String(url).endsWith("/pipelines")
        ? original(url, init)
        : Response.json(
            { error: { code: "not_found", message: remote } },
            { status: 404 }
          )) as typeof fetch;
    const failed = captureIo(await fixture());
    expect(await runCloud(["run", pipeline.name], failed, dependencies)).toBe(2);
    expect(failed.errors.join("")).not.toMatch(/[\u001b\u009b\u202e]/);
    expect(failed.errors.join("")).toContain("Run remote [2J   spoof\n");
  });
  it("does not retry or report uncertain admission when normalized JSON exceeds the input budget", async () => {
    const input = `{"values":[${Array(4000).fill("1e20").join(",")}]}`;
    expect(Buffer.byteLength(input)).toBeLessThan(65536);
    expect(Buffer.byteLength(JSON.stringify(JSON.parse(input)))).toBeGreaterThan(65536);
    const dependencies = { ...service(), readStdin: async () => input };
    const io = captureIo(await fixture());
    expect(await runCloud(["run", pipeline.name, "--input-file", "-"], io, dependencies)).toBe(4);
    expect(dependencies.calls.every((call) => call.method === "GET")).toBe(true);
    expect(io.errors.join("")).not.toContain("idempotency key");
    expect(io.errors.join("")).not.toContain("Admission could not be confirmed");
  });
  it("reports a recoverable key after a server error following the POST", async () => {
    const root = await fixture();
    const dependencies = service({ admissionError: "internal_error", admissionStatus: 500 });
    const io = captureIo(root);
    expect(await runCloud(["run", pipeline.name, "--json"], io, dependencies)).toBe(2);
    const admissions = dependencies.calls.filter((call) => call.method === "POST");
    expect(admissions).toHaveLength(1);
    expect(io.errors.join("")).toContain(
      `Workspace: workspace; idempotency key: ${admissions[0]!.key}`
    );
    expect(io.output.join("")).toBe("");
  });
  it("reports a recoverable key for an unusable successful admission response", async () => {
    const root = await fixture();
    const dependencies = service();
    const original = dependencies.fetch;
    dependencies.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const response = await original(url, init);
      return init?.method === "POST"
        ? Response.json({ admitted: true }, { status: 202 })
        : response;
    }) as typeof fetch;
    const io = captureIo(root);
    expect(await runCloud(["run", pipeline.name], io, dependencies)).toBe(2);
    const admissions = dependencies.calls.filter((call) => call.method === "POST");
    expect(admissions).toHaveLength(1);
    expect(io.errors.join("")).toContain(`idempotency key: ${admissions[0]!.key}`);
  });
  it("reports the same key when interruption loses a pending POST acknowledgement", async () => {
    const root = await fixture();
    const controller = new AbortController();
    const dependencies = service();
    const original = dependencies.fetch;
    let markPosted: () => void = () => {};
    const posted = new Promise<void>((resolve) => {
      markPosted = resolve;
    });
    dependencies.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const response = await original(url, init);
      if (init?.method !== "POST") return response;
      markPosted();
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    const io = { ...captureIo(root), signal: controller.signal };
    const result = runCloud(["run", pipeline.name, "--json"], io, dependencies);
    await posted;
    controller.abort();
    expect(await result).toBe(7);
    const admissions = dependencies.calls.filter((call) => call.method === "POST");
    expect(admissions).toHaveLength(1);
    expect(io.errors.join("")).toContain(
      `Workspace: workspace; idempotency key: ${admissions[0]!.key}`
    );
    expect(io.output.join("")).toBe("");
  });
  it("keeps one recoverable key through the bounded failed transport retry", async () => {
    const root = await fixture();
    const dependencies = service();
    const original = dependencies.fetch;
    dependencies.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const response = await original(url, init);
      if (init?.method === "POST") throw new Error("lost response");
      return response;
    }) as typeof fetch;
    const io = captureIo(root);
    expect(await runCloud(["run", pipeline.name], io, dependencies)).toBe(2);
    const admissions = dependencies.calls.filter((call) => call.method === "POST");
    expect(admissions).toHaveLength(2);
    expect(admissions[0]!.key).toBe(admissions[1]!.key);
    expect(io.errors.join("").match(/Admission could not be confirmed/g)).toHaveLength(1);
    expect(io.errors.join("")).toContain(`idempotency key: ${admissions[0]!.key}`);
  });
  it("definite 4xx rejection does not suggest an uncertain admission", async () => {
    const root = await fixture();
    const dependencies = service({ admissionError: "invalid_request", admissionStatus: 400 });
    const io = captureIo(root);
    expect(await runCloud(["run", pipeline.name], io, dependencies)).toBe(4);
    expect(dependencies.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(io.errors.join("")).not.toContain("idempotency key");
  });
  it("retains duplicate logs and deduplicates by snapshot array index", async () => {
    const root = await fixture();
    const log = { time: 1000, level: "info" as const, message: "repeated" };
    const dependencies = service({
      runs: [
        { ...baseRun, status: "running", logs: [log, log] },
        { ...baseRun, status: "completed", logs: [log, log] },
      ],
    });
    const io = captureIo(root);
    expect(await runCloud(["logs", "run-1", "--follow"], io, dependencies)).toBe(0);
    expect(io.output.join("").match(/repeated/g)).toHaveLength(2);
  });
  it.each([
    ["completed", 0],
    ["failed", 6],
    ["cancelled", 7],
  ] as const)("maps remote %s to %i", async (status, exit) => {
    const root = await fixture();
    const dependencies = service({ runs: [{ ...baseRun, status }] });
    expect(await runCloud(["run", pipeline.name, "--json"], captureIo(root), dependencies)).toBe(
      exit
    );
  });
  it("rate-limited admission exits execution failure without retry", async () => {
    const root = await fixture();
    const dependencies = service({ admissionError: "rate_limited" });
    expect(await runCloud(["run", pipeline.name], captureIo(root), dependencies)).toBe(6);
    expect(dependencies.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });
  it("interrupting foreground follow prints the run ID without cancellation", async () => {
    const root = await fixture();
    const controller = new AbortController();
    const dependencies = {
      ...service(),
      sleep: async () => {
        controller.abort();
        throw new Error("Aborted");
      },
    };
    const io = { ...captureIo(root), signal: controller.signal };
    expect(await runCloud(["run", pipeline.name], io, dependencies)).toBe(7);
    expect(io.errors.join("")).toContain("Run run-1");
    expect(dependencies.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });
  it("interrupting a pending stdin read admits no run", async () => {
    const root = await fixture();
    const controller = new AbortController();
    let inputStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      inputStarted = resolve;
    });
    const dependencies = {
      ...service(),
      readStdin: () => {
        inputStarted();
        return new Promise<string>(() => {});
      },
    };
    const io = { ...captureIo(root), signal: controller.signal };
    const result = runCloud(["run", pipeline.name, "--input-file", "-"], io, dependencies);
    await started;
    controller.abort();
    expect(await result).toBe(7);
    expect(dependencies.calls.every((call) => call.method === "GET")).toBe(true);
    expect(io.errors.join("")).not.toContain("idempotency key");
  });
  it("stops foreground following after bounded transport failures and keeps the run URL", async () => {
    const root = await fixture();
    const dependencies = service();
    const original = dependencies.fetch;
    dependencies.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/runs/run-1")) throw new Error("network unavailable");
      return original(url, init);
    }) as typeof fetch;
    const io = captureIo(root);
    expect(await runCloud(["run", pipeline.name], io, dependencies)).toBe(2);
    expect(io.errors.join("")).toContain("Run run-1");
    expect(io.errors.join("")).toContain("/app/runs/run-1?workspace=workspace");
  });
  it.each([
    [403, "forbidden"],
    [404, "not_found"],
  ])("stops logs following on HTTP %i without hiding the run ID", async (status, code) => {
    const root = await fixture();
    const dependencies = service({ runs: [{ ...baseRun, status: "running" }] });
    const original = dependencies.fetch;
    let reads = 0;
    dependencies.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/runs/run-1") && ++reads > 1)
        return Response.json(
          { error: { code, message: "Run is no longer accessible" } },
          { status: Number(status) }
        );
      return original(url, init);
    }) as typeof fetch;
    const io = captureIo(root);
    expect(await runCloud(["logs", "run-1", "--follow", "--json"], io, dependencies)).toBe(2);
    expect(reads).toBe(2);
    expect(io.output.join("")).toBe("");
    expect(io.errors.join("")).toContain("Run run-1");
  });
  it.runIf(process.platform !== "win32")(
    "rejects FIFO input without waiting for a writer or admitting a run",
    async () => {
      const root = await fixture();
      await promisify(execFile)("mkfifo", [path.join(root, "input.json")]);
      const dependencies = service();
      expect(
        await runCloud(
          ["run", pipeline.name, "--input-file", "input.json"],
          captureIo(root),
          dependencies
        )
      ).toBe(4);
      expect(dependencies.calls.every((call) => call.method === "GET")).toBe(true);
    }
  );
  it("lists slugs, names and IDs before deployment availability", async () => {
    const io = captureIo(await fixture());
    expect(await runCloud(["list"], io, service())).toBe(0);
    expect(io.output.join("")).toBe(
      "orders: Orders (cloud-orders) available commit=stored-sha branch=main\n"
    );
  });
  it.each(["Orders sync", "pipelines/cli.ts"])(
    "treats %s as an exact name without requiring a file",
    async (name) => {
      const root = await fixture();
      const dependencies = service({
        pipelines: [
          { ...pipeline, name, slug: name === "Orders sync" ? "orders-sync" : "pipelines-cli-ts" },
        ],
      });
      expect(await runCloud(["run", name, "--detach"], captureIo(root), dependencies)).toBe(0);
      expect((await readdir(root)).sort()).toEqual([".tubeless"]);
      expect(await readFile(path.join(root, ".tubeless/cloud.json"), "utf8")).toBe(
        "stale malformed project configuration"
      );
    }
  );
  it("requires an exact name or slug and offers IDs for duplicate names", async () => {
    for (const [name, pipelines, diagnostic] of [
      ["ORDERS", [pipeline], "cloud list"],
      ["Orders", [pipeline, { ...pipeline, id: "other" }], "Choose --id"],
    ] as const) {
      const io = captureIo(await fixture());
      const dependencies = service({ pipelines: [...pipelines] });
      expect(await runCloud(["run", name], io, dependencies)).toBe(2);
      expect(io.errors.join("")).toContain(diagnostic);
      expect(dependencies.calls.every((call) => call.method === "GET")).toBe(true);
      if (pipelines.length > 1) {
        expect(io.errors.join("")).toContain("cloud-orders");
        expect(io.errors.join("")).toContain("other");
        expect(
          await runCloud(
            ["run", "--id", "other", "--detach"],
            captureIo(await fixture()),
            dependencies
          )
        ).toBe(0);
      }
    }
  });
  it("runs by slug and watches retained logs by default", async () => {
    const dependencies = service({
      runs: [
        {
          ...baseRun,
          status: "completed",
          logs: [{ time: 1000, level: "info", message: "synced" }],
        },
      ],
    });
    const io = captureIo(await fixture());
    expect(await runCloud(["run", pipeline.slug], io, dependencies)).toBe(0);
    expect(io.output.join("")).toContain("info: synced");
    expect(dependencies.calls.filter((call) => call.method === "POST")[0]!.body).toEqual({
      pipelineId: pipeline.id,
      input: {},
    });
    expect(dependencies.calls.some((call) => call.url.endsWith("/runs/run-1"))).toBe(true);
  });
  it("returns the admitted run ID without polling when detached", async () => {
    const dependencies = service();
    const io = captureIo(await fixture());
    expect(await runCloud(["run", pipeline.slug, "--detach", "--json"], io, dependencies)).toBe(0);
    expect(JSON.parse(io.output.join(""))).toMatchObject({ id: "run-1", status: "queued" });
    expect(dependencies.calls.some((call) => call.url.endsWith("/runs/run-1"))).toBe(false);
  });
  it("requires IDs when slugs collide, including an exact-name collision", async () => {
    const dependencies = service({
      pipelines: [
        { ...pipeline, name: "Orders sync", slug: "orders-sync" },
        { ...pipeline, id: "other", name: "orders-sync", slug: "orders-sync" },
      ],
    });
    const io = captureIo(await fixture());
    expect(await runCloud(["run", "orders-sync"], io, dependencies)).toBe(2);
    expect(io.errors.join("")).toContain("cloud-orders");
    expect(io.errors.join("")).toContain("other");
    expect(dependencies.calls.every((call) => call.method === "GET")).toBe(true);
    expect(
      await runCloud(["run", "--id", "other", "--detach"], captureIo(await fixture()), dependencies)
    ).toBe(0);
    expect(dependencies.calls.find((call) => call.method === "POST")!.body).toEqual({
      pipelineId: "other",
      input: {},
    });
  });
  it("fails before listing or admission when automatic workspace selection is unavailable", async () => {
    const second: CliWorkspace = {
      id: "other",
      name: "Other",
      slug: "other",
      role: "owner",
    };
    for (const workspaces of [[], [second, { ...second, id: "third", name: "Third" }]]) {
      for (const args of [["run", pipeline.name], ["list"], ["logs", "run-1"]]) {
        const dependencies = service({ workspaces });
        const io = captureIo(await fixture());
        expect(await runCloud(args, io, dependencies)).toBe(2);
        expect(dependencies.calls.map((call) => call.url)).toEqual(["/api/v1/session"]);
        expect(io.errors.join("")).toContain(workspaces.length ? "--workspace" : "Cloud dashboard");
        if (workspaces.length) expect(io.errors.join("")).toContain("Other (other)");
      }
    }
  });
  it("explicit workspace bypasses session enumeration and remains authoritative", async () => {
    const dependencies = service({ workspaces: [] });
    expect(
      await runCloud(
        ["run", pipeline.name, "--workspace", "chosen", "--detach"],
        captureIo(await fixture()),
        dependencies
      )
    ).toBe(0);
    expect(dependencies.calls.map((call) => call.url)).toEqual([
      "/api/v1/workspaces/chosen/pipelines",
      "/api/v1/workspaces/chosen/runs",
    ]);
  });
  it.each([
    ["link"],
    ["add", "pipeline.ts"],
    ...["export", "pipeline-id", "registry", "repository", "branch", "name", "project"].map(
      (flag) => ["run", "Orders", `--${flag}`, "value"]
    ),
    ["run", "Orders", "--id", "cloud"],
    ["run", "Orders", "--id", ""],
    ["run", "--id", "   "],
    ["run", "Orders", "--workspace", ""],
    ["list", "--workspace", "   "],
    ["list", "--input-file", "input.json"],
  ])("rejects obsolete commands and invalid combinations before HTTP: %j", async (...args) => {
    const dependencies = service();
    expect(await runCloud(args, captureIo("/detached"), dependencies)).toBe(1);
    expect(dependencies.calls).toHaveLength(0);
  });
});
