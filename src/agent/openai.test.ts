import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineModelAgent, defineTool, type AgentModelRequest } from "./agent.js";
import { openaiModel } from "./openai.js";

const directories: string[] = [];
async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), "tubeless-openai-"));
  directories.push(cwd);
  await mkdir(join(cwd, ".git"));
  await writeFile(join(cwd, "AGENTS.md"), "Always verify edits.");
  await writeFile(join(cwd, "target"), "actual text");
  return cwd;
}
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
const call = (name: string, input: unknown, id = "call_1") => ({
  type: "function_call",
  id: `fc_${id}`,
  call_id: id,
  name,
  arguments: JSON.stringify({ [name === "_finish" ? "result" : "input"]: input }),
  status: "completed",
});
const finish = () => call("_finish", { answer: "Done." }, "finish");
const response = (output: unknown[]) => Response.json({ status: "completed", output });

describe("OpenAI model", () => {
  it.each([undefined, null, "none", "minimal", "low", "medium", "high", "xhigh", "max"] as const)(
    "configures reasoning effort independently of model selection: %s",
    async (reasoningEffort) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([finish()]));
      vi.stubGlobal("fetch", fetcher);
      await defineModelAgent({
        id: "reasoning",
        projectContext: false,
        model: openaiModel({ apiKey: "fixture", reasoningEffort }),
      }).runOrThrow({ task: "Finish" });
      const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
      if (reasoningEffort === undefined || reasoningEffort === null)
        expect(body).not.toHaveProperty("reasoning");
      else expect(body.reasoning).toEqual({ effort: reasoningEffort });
    }
  );

  it("rejects unsupported reasoning settings locally", () => {
    // @ts-expect-error Exercise the boundary for JavaScript callers.
    expect(() => openaiModel({ reasoningEffort: "fast" })).toThrow(
      "Invalid OpenAI model configuration"
    );
  });

  it.each([
    { model: undefined, environment: undefined, expected: "gpt-5.4-mini" },
    { model: undefined, environment: "", expected: "gpt-5.4-mini" },
    { model: undefined, environment: " \t\n ", expected: "gpt-5.4-mini" },
    { model: undefined, environment: " env-model\t ", expected: "env-model" },
    { model: " explicit-model\t ", environment: "env-model", expected: "explicit-model" },
    { model: "explicit-model", environment: "", expected: "explicit-model" },
  ])("normalizes the model selected at execution: %j", async ({ model, environment, expected }) => {
    vi.stubEnv("OPENAI_MODEL", "factory-time-model");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([finish()]));
    vi.stubGlobal("fetch", fetcher);
    const agent = defineModelAgent({
      id: "model-selection",
      projectContext: false,
      model: openaiModel({ apiKey: "fixture", ...(model === undefined ? {} : { model }) }),
    });
    vi.stubEnv("OPENAI_MODEL", environment);
    await agent.runOrThrow({ task: "Finish" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(body.model).toBe(expected);
    expect(body).not.toHaveProperty("reasoning");
  });

  it.each(["", " \t\n "])("rejects an explicit blank model: %j", (model) => {
    expect(() => openaiModel({ model })).toThrow("Invalid OpenAI model configuration");
  });

  it.each([
    { historyKiB: 500, schemaKiB: 500, compactAfterBytes: 65_536, compactedKiB: 1 },
    { historyKiB: 600, schemaKiB: 450, compactAfterBytes: 65_536, compactedKiB: 1 },
    { historyKiB: 500, schemaKiB: 500, compactAfterBytes: 1_048_575, compactedKiB: 1 },
    { historyKiB: 500, schemaKiB: 500, compactAfterBytes: 65_536, compactedKiB: 600 },
  ])(
    "budgets compaction separately from decision schemas: %j",
    async ({ historyKiB, schemaKiB, compactAfterBytes, compactedKiB }) => {
      const schema = {
        "~standard": {
          version: 1 as const,
          vendor: "fixture",
          validate: (value: unknown) => ({ value }),
          jsonSchema: {
            input: () => ({ type: "string", description: "s".repeat(schemaKiB * 1024) }),
          },
        },
      };
      const value = "v".repeat(100 * 1024);
      const compacted = [
        { type: "compaction", encrypted_content: "c".repeat(compactedKiB * 1024) },
      ];
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ object: "response.compaction", output: compacted }))
        .mockResolvedValueOnce(response([finish()]));
      vi.stubGlobal("fetch", fetcher);
      const transport = openaiModel({ apiKey: "fixture", compactAfterBytes });
      const agent = defineModelAgent({
        id: "compact-with-large-schemas",
        projectContext: false,
        tools: {
          custom: defineTool({
            description: "Custom tool",
            inputSchema: schema,
            outputSchema: schema,
            run: (input) => input,
          }),
        },
        model: (request, context) =>
          transport(
            {
              ...request,
              conversation: [
                { role: "user", content: "h".repeat(historyKiB * 1024) },
                call("custom", "input", "previous"),
              ],
              outcomes: [{ id: "previous", tool: "custom", ok: true, value }],
            },
            context
          ),
      });
      const result = await agent.run({ task: "Continue" });
      expect(fetcher.mock.calls[0]![0]).toBe("https://api.openai.com/v1/responses/compact");
      const compactRequest = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
      expect(compactRequest).not.toHaveProperty("tools");
      expect(compactRequest).not.toHaveProperty("reasoning");
      expect(compactRequest.input.at(-1)).toMatchObject({
        call_id: "previous",
        type: "function_call_output",
      });
      expect(JSON.parse(compactRequest.input.at(-1).output)).toEqual({ ok: true, value });
      for (const [, options] of fetcher.mock.calls)
        expect(Buffer.byteLength(options!.body as string)).toBeLessThanOrEqual(1_048_576);
      if (compactedKiB === 600) {
        expect(result.status).toBe("failed");
        expect(result.errors[0]!.message).toContain("request exceeds 1 MiB");
        expect(fetcher).toHaveBeenCalledTimes(1);
      } else {
        expect(result).toMatchObject({
          status: "completed",
          finalized: true,
          value: { answer: "Done." },
        });
        expect(fetcher).toHaveBeenCalledTimes(2);
        const decisionRequest = JSON.parse(fetcher.mock.calls[1]![1]!.body as string);
        expect(decisionRequest).not.toHaveProperty("reasoning");
        expect(decisionRequest.input).toEqual(compacted);
        expect(decisionRequest.tools.some((tool: { name: string }) => tool.name === "custom")).toBe(
          true
        );
      }
    }
  );

  it.each([
    {
      descriptor: {
        type: "object",
        properties: { value: { $ref: "#/$defs/word" } },
        $defs: { word: { type: "string" } },
      },
      message: "$ref is unsupported",
    },
    {
      descriptor: {
        type: "object",
        properties: {
          nested: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
        },
        required: ["nested"],
        additionalProperties: false,
      },
      message: 'tool custom.properties["nested"] requires additionalProperties: false',
    },
    {
      descriptor: {
        type: "object",
        properties: { value: { type: ["string", "null"] } },
        additionalProperties: false,
      },
      message: "tool custom must require every property exactly once",
    },
  ])(
    "rejects invalid schemas before HTTP even when compaction is due: $message",
    async ({ descriptor, message }) => {
      const fetcher = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetcher);
      const schema = {
        "~standard": {
          version: 1 as const,
          vendor: "fixture",
          validate: (value: unknown) => ({ value }),
          jsonSchema: {
            input: () => descriptor,
          },
        },
      };
      const transport = openaiModel({ apiKey: "fixture", compactAfterBytes: 1 });
      const result = await defineModelAgent({
        id: "schema-reference",
        projectContext: false,
        tools: {
          custom: defineTool({
            description: "A tool with a referenced argument schema.",
            inputSchema: schema,
            outputSchema: schema,
            run: (input) => input,
          }),
        },
        model: (request, context) =>
          transport(
            {
              ...request,
              conversation: [{ role: "user", content: request.task }],
              outcomes: [{ id: "old", tool: "custom", ok: true, value: "prior result" }],
            },
            context
          ),
      }).run({ task: "Work" });
      expect(result.status).toBe("failed");
      expect(result.errors[0]!.message).toContain(message);
      expect(fetcher).not.toHaveBeenCalled();
    }
  );

  it("compacts a permitted batch of 100 large reads and keeps full harness outcomes", async () => {
    const cwd = await workspace();
    const content = '"\\\t🙂'.repeat(2000);
    await writeFile(join(cwd, "target"), content);
    const calls = Array.from({ length: 100 }, (_, index) =>
      call("read", { path: "target" }, `read_${index}`)
    );
    const compacted = [{ type: "compaction", encrypted_content: "opaque" }];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(calls))
      .mockResolvedValueOnce(Response.json({ object: "response.compaction", output: compacted }))
      .mockResolvedValueOnce(response([finish()]));
    vi.stubGlobal("fetch", fetcher);
    const requests: AgentModelRequest[] = [];
    const transport = openaiModel({ apiKey: "fixture" });
    const agent = defineModelAgent({
      id: "large-batch",
      limits: { maxConcurrency: 8 },
      model: (request, context) => {
        requests.push(request);
        return transport(request, context);
      },
    });
    expect(await agent.runOrThrow({ task: "Read all files" }, undefined, { cwd })).toEqual({
      answer: "Done.",
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [, options] of fetcher.mock.calls)
      expect(Buffer.byteLength(options!.body as string)).toBeLessThanOrEqual(1_048_576);
    expect(fetcher.mock.calls[1]![0]).toBe("https://api.openai.com/v1/responses/compact");
    const input = JSON.parse(fetcher.mock.calls[1]![1]!.body as string).input;
    const outputs = input.slice(101);
    expect(outputs).toHaveLength(100);
    outputs.forEach((item: { call_id: string; output: string }, index: number) => {
      expect(item.call_id).toBe(`read_${index}`);
      expect(JSON.parse(item.output)).toMatchObject({ ok: true, truncated: true });
    });
    expect(JSON.parse(fetcher.mock.calls[2]![1]!.body as string).input).toEqual(compacted);
    expect(requests[1]!.outcomes).toHaveLength(100);
    for (const outcome of requests[1]!.outcomes)
      expect(outcome).toMatchObject({ ok: true, value: { content } });
  });

  it("fails compaction errors without retrying or making another decision request", async () => {
    const cwd = await workspace();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([call("list", {})]))
      .mockResolvedValueOnce(new Response("private provider error", { status: 500 }));
    vi.stubGlobal("fetch", fetcher);
    const result = await defineModelAgent({
      id: "compact-error",
      model: openaiModel({ apiKey: "fixture", compactAfterBytes: 1 }),
    }).run({ task: "List" }, undefined, { cwd });
    expect(result.status).toBe("failed");
    expect(result.errors[0]!.message).toContain("responses/compact failed (HTTP 500)");
    expect(result.errors[0]!.message).not.toContain("private provider error");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("aborts the active HTTP request at the configured decision deadline", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), {
            once: true,
          });
        })
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      defineModelAgent({
        id: "deadline",
        projectContext: false,
        model: openaiModel({ apiKey: "fixture", timeoutMs: 25 }),
      }).runOrThrow({ task: "Work" })
    ).rejects.toThrow();
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("replays every provider item and the exact ordered tool outputs with project instructions", async () => {
    const cwd = await workspace();
    const output = [
      { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque" },
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Inspecting.", annotations: [] }],
      },
      call("read", { path: "target" }),
      call("read", { path: "missing" }, "call_2"),
    ];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(output))
      .mockResolvedValueOnce(response([finish()]));
    vi.stubGlobal("fetch", fetcher);
    const agent = defineModelAgent({
      id: "openai",
      model: openaiModel({ apiKey: "fixture", model: "fixture-model" }),
    });
    expect(await agent.runOrThrow({ task: "Inspect workspace" }, undefined, { cwd })).toEqual({
      answer: "Done.",
    });
    const first = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    const second = JSON.parse(fetcher.mock.calls[1]![1]!.body as string);
    expect(first).toMatchObject({
      model: "fixture-model",
      store: false,
      include: ["reasoning.encrypted_content"],
      tool_choice: "required",
    });
    expect(first.instructions).toContain("Always verify edits.");
    expect(second.instructions).toBe(first.instructions);
    expect(second.input.slice(0, 5)).toEqual([
      { role: "user", content: "Inspect workspace" },
      ...output,
    ]);
    expect(
      second.input
        .slice(5)
        .map((item: { call_id: string; output: string }) => [item.call_id, JSON.parse(item.output)])
    ).toMatchObject([
      ["call_1", { ok: true, value: { content: "actual text" } }],
      ["call_2", { ok: false, error: { code: "ENOENT" } }],
    ]);
    expect(second).not.toHaveProperty("previous_response_id");
  });

  it("compacts completed batches and uses the entire returned window unchanged", async () => {
    const cwd = await workspace();
    const compacted = [
      { role: "user", content: "retained task" },
      { type: "compaction", id: "cmp_1", encrypted_content: "encrypted" },
    ];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([call("read", { path: "target" })]))
      .mockResolvedValueOnce(Response.json({ object: "response.compaction", output: compacted }))
      .mockResolvedValueOnce(response([finish()]));
    vi.stubGlobal("fetch", fetcher);
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await defineModelAgent({
      id: "compact",
      model: openaiModel({
        apiKey: " \t\nfixture\r\n ",
        model: " fixture-model ",
        compactAfterBytes: 1,
      }),
    }).runOrThrow({ task: "Read target" }, undefined, { cwd, log });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "https://api.openai.com/v1/responses",
      "https://api.openai.com/v1/responses/compact",
      "https://api.openai.com/v1/responses",
    ]);
    for (const [, options] of fetcher.mock.calls) {
      expect(JSON.parse(options!.body as string).model).toBe("fixture-model");
      expect(new Headers(options!.headers).get("Authorization")).toBe("Bearer fixture");
    }
    const compactBody = JSON.parse(fetcher.mock.calls[1]![1]!.body as string);
    expect(compactBody.input.at(-1)).toMatchObject({
      type: "function_call_output",
      call_id: "call_1",
    });
    expect(JSON.parse(fetcher.mock.calls[2]![1]!.body as string).input).toEqual(compacted);
    expect(log.log).toHaveBeenCalledWith("Compacted agent conversation");
  });

  it("does not make a decision request after cancellation during compaction", async () => {
    const cwd = await workspace();
    const controller = new AbortController();
    const reason = new Error("stop compaction");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([call("list", {})]))
      .mockImplementationOnce(async () => {
        controller.abort(reason);
        return Response.json({
          object: "response.compaction",
          output: [{ type: "compaction", encrypted_content: "opaque" }],
        });
      });
    vi.stubGlobal("fetch", fetcher);
    const result = await defineModelAgent({
      id: "cancel",
      model: openaiModel({ apiKey: "fixture", compactAfterBytes: 1 }),
    }).run({ task: "List" }, undefined, { cwd, signal: controller.signal });
    expect(result.status).toBe("cancelled");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    { status: "incomplete", output: [finish()] },
    { status: "completed", output: [call("_finish", { answer: "bad" }), call("list", {})] },
    {
      status: "completed",
      output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }],
    },
    { status: "completed", output: [{ ...call("list", {}), arguments: "not json" }] },
    {
      status: "completed",
      output: [{ ...call("list", {}), arguments: '{"input":{},"extra":true}' }],
    },
    { status: "completed", output: [call("not_registered", {})] },
    { status: "completed", output: [] },
  ])("fails invalid model output without starting another request: %j", async (body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      defineModelAgent({
        id: "invalid",
        projectContext: false,
        model: openaiModel({ apiKey: "fixture" }),
      }).runOrThrow({ task: "Do work" })
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("resolves credentials lazily and forwards cancellation to HTTP", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([finish()]));
    vi.stubGlobal("fetch", fetcher);
    const agent = defineModelAgent({ id: "lazy", projectContext: false, model: openaiModel() });
    expect(agent.plan().ok).toBe(true);
    await agent.run({ task: "Do work" }, { dryRun: true });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(agent.runOrThrow({ task: "Do work" })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    vi.stubEnv("OPENAI_API_KEY", " \t\nlate-credential\r\n ");
    await agent.runOrThrow({ task: "Do work" });
    expect(fetcher.mock.calls[0]![1]!.headers).toMatchObject({
      Authorization: "Bearer late-credential",
    });
    expect(fetcher.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
  });

  it("targets compatible Responses servers by option or OPENAI_BASE_URL", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response([finish()]));
    vi.stubGlobal("fetch", fetcher);
    vi.stubEnv("OPENAI_BASE_URL", "https://router.example.com/api/v1/");
    await defineModelAgent({
      id: "env-base",
      projectContext: false,
      model: openaiModel({ apiKey: "fixture" }),
    }).runOrThrow({ task: "Do work" });
    await defineModelAgent({
      id: "explicit-base",
      projectContext: false,
      model: openaiModel({ apiKey: "fixture", baseUrl: "http://localhost:11434/v1" }),
    }).runOrThrow({ task: "Do work" });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "https://router.example.com/api/v1/responses",
      "http://localhost:11434/v1/responses",
    ]);
  });

  it.each(["ftp://example.com", "not a url", "https://host/v1?tenant=abc", "https://host/v1#x"])(
    "rejects an invalid base URL: %s",
    (baseUrl) => {
      expect(() => openaiModel({ baseUrl })).toThrow("Invalid OpenAI base URL");
    }
  );

  it("never calls /responses/compact when compaction is disabled", async () => {
    const cwd = await workspace();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([call("read", { path: "target" })]))
      .mockResolvedValueOnce(response([finish()]));
    vi.stubGlobal("fetch", fetcher);
    await defineModelAgent({
      id: "no-compaction",
      model: openaiModel({ apiKey: "fixture", compactAfterBytes: null }),
    }).runOrThrow({ task: "Read target" }, undefined, { cwd });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "https://api.openai.com/v1/responses",
      "https://api.openai.com/v1/responses",
    ]);
  });
});
