import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineAgent } from "./agent.js";
import { anthropicModel } from "./anthropic.js";
import { anthropicTool } from "./anthropic-protocol.js";

const directories: string[] = [];
async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), "tubeless-anthropic-"));
  directories.push(cwd);
  await mkdir(join(cwd, ".git"));
  await writeFile(join(cwd, "AGENTS.md"), "Always verify edits.");
  await writeFile(join(cwd, "target"), "actual text");
  return cwd;
}
beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", undefined);
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined);
  vi.stubEnv("ANTHROPIC_BASE_URL", undefined);
  vi.stubEnv("ANTHROPIC_MODEL", undefined);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

const use = (name: string, value: unknown, id = `toolu_${name}`) => ({
  type: "tool_use",
  id,
  name,
  input: { [name === "_finish" ? "result" : "input"]: value },
});
const finish = () => use("_finish", { answer: "Done." });
const thinking = { type: "thinking", thinking: "", signature: "sig-1" };
const message = (content: unknown[], stop_reason = "tool_use") =>
  Response.json({ type: "message", role: "assistant", content, stop_reason });
const body = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>, index: number) =>
  JSON.parse(fetcher.mock.calls[index]![1]!.body as string);
const headers = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>, index: number) =>
  fetcher.mock.calls[index]![1]!.headers as Record<string, string>;

describe("Anthropic model", () => {
  it("sends Messages API tools, replays thinking verbatim, and returns tool results", async () => {
    const cwd = await workspace();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        message([
          thinking,
          { type: "text", text: "Reading." },
          use("read", { path: "target", startLine: null, maxLines: null }),
          use("read", { path: "missing", startLine: null, maxLines: null }, "toolu_missing"),
        ])
      )
      .mockResolvedValueOnce(message([finish()]));
    vi.stubGlobal("fetch", fetcher);
    const agent = defineAgent({
      id: "anthropic",
      model: anthropicModel({ apiKey: " fixture\n", reasoningEffort: "high" }),
    });
    expect(await agent.runOrThrow({ task: "Read target" }, undefined, { cwd })).toEqual({
      answer: "Done.",
    });

    expect(fetcher.mock.calls[0]![0]).toBe("https://api.anthropic.com/v1/messages");
    expect(headers(fetcher, 0)).toMatchObject({
      "x-api-key": "fixture",
      "anthropic-version": "2023-06-01",
    });
    expect(headers(fetcher, 0)).not.toHaveProperty("anthropic-beta");
    const first = body(fetcher, 0);
    expect(first).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 32_000,
      output_config: { effort: "high" },
      cache_control: { type: "ephemeral" },
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: "Read target" }],
    });
    expect(first.system).toContain("Always verify edits.");
    expect(first.system).toContain("Call _finish alone");
    const read = first.tools.find((tool: { name: string }) => tool.name === "read");
    expect(read.strict).toBe(true);
    const path = read.input_schema.properties.input.properties.path;
    expect(path).not.toHaveProperty("maxLength");
    expect(path.description).toContain('"maxLength":4096');
    expect(first.tools.at(-1)).toMatchObject({
      name: "_finish",
      input_schema: { required: ["result"], additionalProperties: false },
    });

    const second = body(fetcher, 1);
    expect(second.messages[1]).toEqual({
      role: "assistant",
      content: [
        thinking,
        { type: "text", text: "Reading." },
        use("read", { path: "target", startLine: null, maxLines: null }),
        use("read", { path: "missing", startLine: null, maxLines: null }, "toolu_missing"),
      ],
    });
    const [ok, failed] = second.messages[2].content;
    expect(second.messages[2].role).toBe("user");
    expect(ok).toMatchObject({ type: "tool_result", tool_use_id: "toolu_read" });
    expect(ok).not.toHaveProperty("is_error");
    expect(JSON.parse(ok.content).value.content).toContain("actual text");
    expect(failed).toMatchObject({
      type: "tool_result",
      tool_use_id: "toolu_missing",
      is_error: true,
    });
  });

  it("sends schemas unchanged without strict mode", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => message([finish()]));
    vi.stubGlobal("fetch", fetcher);
    await defineAgent({
      id: "relaxed",
      projectContext: false,
      model: anthropicModel({ apiKey: "fixture", strict: false }),
    }).runOrThrow({ task: "Finish" });
    const read = body(fetcher, 0).tools.find((tool: { name: string }) => tool.name === "read");
    expect(read).not.toHaveProperty("strict");
    expect(read.input_schema.properties.input.properties.path.maxLength).toBe(4096);
    expect(body(fetcher, 0)).not.toHaveProperty("output_config");
  });

  it("asks once for tool calls after a text-only reply, then fails", async () => {
    const text = { type: "text", text: "All done." };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(message([text], "end_turn"))
      .mockResolvedValueOnce(message([finish()]));
    vi.stubGlobal("fetch", fetcher);
    const agent = defineAgent({
      id: "retry",
      projectContext: false,
      model: anthropicModel({ apiKey: "fixture" }),
    });
    expect(await agent.runOrThrow({ task: "Finish" })).toEqual({ answer: "Done." });
    expect(body(fetcher, 1).messages.slice(1)).toEqual([
      { role: "assistant", content: [text] },
      { role: "user", content: expect.stringContaining("Respond only by calling tools") },
    ]);

    fetcher.mockReset().mockImplementation(async () => message([text], "end_turn"));
    const result = await agent.run({ task: "Finish" });
    expect(result.status).toBe("failed");
    expect(result.errors[0]!.message).toContain("Anthropic returned no tool calls");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    { stop: "max_tokens", error: "raise maxTokens" },
    { stop: "refusal", error: "Anthropic refused the request" },
    { stop: "pause_turn", error: "stopped unexpectedly (pause_turn)" },
  ])("fails explicitly on stop reason $stop", async ({ stop, error }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () => message([finish()], stop))
    );
    const result = await defineAgent({
      id: "stop",
      projectContext: false,
      model: anthropicModel({ apiKey: "fixture" }),
    }).run({ task: "Finish" });
    expect(result.status).toBe("failed");
    expect(result.errors[0]!.message).toContain(error);
  });

  it("compacts on demand and carries the signed block first with the beta header", async () => {
    const cwd = await workspace();
    const block = { type: "compaction", content: "Summary.", signature: "sig-c" };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        message([use("read", { path: "target", startLine: null, maxLines: null })])
      )
      .mockResolvedValueOnce(message([block], "compaction"))
      .mockResolvedValueOnce(message([finish()]));
    vi.stubGlobal("fetch", fetcher);
    await defineAgent({
      id: "compact",
      model: anthropicModel({ apiKey: "fixture", compactAfterBytes: 1 }),
    }).runOrThrow({ task: "Read target" }, undefined, { cwd });

    const compaction = body(fetcher, 1);
    expect(headers(fetcher, 1)["anthropic-beta"]).toBe("compact-2026-09-04");
    expect(compaction.compaction).toMatchObject({ type: "summarize" });
    expect(compaction).not.toHaveProperty("tool_choice");
    expect(compaction).not.toHaveProperty("cache_control");
    expect(compaction.tools).toEqual(body(fetcher, 0).tools);
    expect(compaction.messages.at(-1).content[0]).toMatchObject({ type: "tool_result" });

    const decision = body(fetcher, 2);
    expect(headers(fetcher, 2)["anthropic-beta"]).toBe("compact-2026-09-04");
    expect(decision.messages).toEqual([
      { role: "assistant", content: [block] },
      { role: "user", content: "Continue the task from this summary." },
    ]);
  });

  it("closes _finish and keeps a continued prompt outside compaction", async () => {
    const block = { type: "compaction", content: "Summary.", signature: "sig-c" };
    const previous = [
      { role: "user", content: "remember this" },
      {
        role: "assistant",
        content: [use("_finish", { answer: "Remembered" }, "toolu_finish")],
      },
    ];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(message([block], "compaction"))
      .mockResolvedValueOnce(message([finish()]));
    vi.stubGlobal("fetch", fetcher);
    const transport = anthropicModel({ apiKey: "fixture", compactAfterBytes: 1 });
    await defineAgent({
      id: "continue",
      projectContext: false,
      model: (request, context) =>
        transport({ ...request, conversation: previous, outcomes: [] }, context),
    }).runOrThrow({ task: "follow up" });
    const compact = body(fetcher, 0);
    expect(compact.messages).toEqual([
      ...previous,
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_finish",
            content: '{"answer":"Remembered"}',
          },
        ],
      },
    ]);
    expect(body(fetcher, 1).messages).toEqual([
      { role: "assistant", content: [block] },
      {
        role: "user",
        content: [
          { type: "text", text: "Continue the task from this summary." },
          { type: "text", text: "follow up" },
        ],
      },
    ]);

    fetcher.mockReset();
    const unfinished = await defineAgent({
      id: "unfinished",
      projectContext: false,
      model: (request, context) =>
        transport(
          {
            ...request,
            conversation: [{ role: "assistant", content: [use("read", { path: "target" })] }],
            outcomes: [],
          },
          context
        ),
    }).run({ task: "follow up" });
    expect(unfinished.status).toBe("failed");
    expect(unfinished.errors[0]!.message).toContain("unfinished tool calls");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("continues uncompacted when no summary is returned, and never compacts when disabled", async () => {
    const cwd = await workspace();
    const step = () => message([use("read", { path: "target", startLine: null, maxLines: null })]);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(step())
      .mockResolvedValueOnce(message([], "tool_use"))
      .mockResolvedValueOnce(message([finish()]));
    vi.stubGlobal("fetch", fetcher);
    await defineAgent({
      id: "missing-summary",
      model: anthropicModel({ apiKey: "fixture", compactAfterBytes: 1 }),
    }).runOrThrow({ task: "Read target" }, undefined, { cwd });
    expect(body(fetcher, 2).messages).toHaveLength(3);
    expect(headers(fetcher, 2)).not.toHaveProperty("anthropic-beta");

    // A compaction stop reason without a signed compaction block keeps the history.
    fetcher
      .mockReset()
      .mockResolvedValueOnce(step())
      .mockResolvedValueOnce(message([{ type: "text", text: "Summary." }], "compaction"))
      .mockResolvedValueOnce(message([finish()]));
    await defineAgent({
      id: "malformed-summary",
      model: anthropicModel({ apiKey: "fixture", compactAfterBytes: 1 }),
    }).runOrThrow({ task: "Read target" }, undefined, { cwd });
    expect(body(fetcher, 2).messages).toHaveLength(3);
    expect(headers(fetcher, 2)).not.toHaveProperty("anthropic-beta");

    fetcher
      .mockReset()
      .mockResolvedValueOnce(step())
      .mockResolvedValueOnce(message([finish()]));
    await defineAgent({
      id: "no-compaction",
      model: anthropicModel({ apiKey: "fixture", compactAfterBytes: null }),
    }).runOrThrow({ task: "Read target" }, undefined, { cwd });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(body(fetcher, 1)).not.toHaveProperty("compaction");
  });

  it("resolves model, base URL, and credentials at execution", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => message([finish()]));
    vi.stubGlobal("fetch", fetcher);
    const agent = defineAgent({
      id: "environment",
      projectContext: false,
      model: anthropicModel(),
    });
    await expect(agent.runOrThrow({ task: "Finish" })).rejects.toThrow(
      "ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN"
    );
    expect(fetcher).not.toHaveBeenCalled();

    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", " gateway-token ");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://gateway.example.com/anthropic/");
    vi.stubEnv("ANTHROPIC_MODEL", " env-model ");
    await agent.runOrThrow({ task: "Finish" });
    expect(fetcher.mock.calls[0]![0]).toBe("https://gateway.example.com/anthropic/v1/messages");
    expect(headers(fetcher, 0)).toMatchObject({ Authorization: "Bearer gateway-token" });
    expect(headers(fetcher, 0)).not.toHaveProperty("x-api-key");
    expect(body(fetcher, 0).model).toBe("env-model");

    vi.stubEnv("ANTHROPIC_API_KEY", "env-key");
    await defineAgent({
      id: "explicit",
      projectContext: false,
      model: anthropicModel({ model: "claude-sonnet-5-5", baseUrl: "http://localhost:4000" }),
    }).runOrThrow({ task: "Finish" });
    expect(fetcher.mock.calls[1]![0]).toBe("http://localhost:4000/v1/messages");
    expect(headers(fetcher, 1)).toMatchObject({ "x-api-key": "env-key" });
    expect(body(fetcher, 1).model).toBe("claude-sonnet-5-5");
  });

  it("sends an explicit bearer token and omits optional fields for compatible servers", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "ignored-key");
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => message([finish()]));
    vi.stubGlobal("fetch", fetcher);
    await defineAgent({
      id: "compatible",
      projectContext: false,
      model: anthropicModel({
        baseUrl: "https://openrouter.ai/api",
        authToken: " router-key ",
        model: "anthropic/claude-opus-5",
        strict: false,
        promptCaching: false,
        compactAfterBytes: null,
      }),
    }).runOrThrow({ task: "Finish" });
    expect(fetcher.mock.calls[0]![0]).toBe("https://openrouter.ai/api/v1/messages");
    expect(headers(fetcher, 0)).toMatchObject({ Authorization: "Bearer router-key" });
    expect(headers(fetcher, 0)).not.toHaveProperty("x-api-key");
    expect(body(fetcher, 0)).not.toHaveProperty("cache_control");
  });

  it.each([
    { apiKey: "key", authToken: "token" },
    { authToken: " " },
    { promptCaching: "yes" },
    { model: " " },
    { apiKey: "" },
    { baseUrl: "ftp://example.com" },
    { baseUrl: "not a url" },
    { baseUrl: "https://gateway.example.com/anthropic?tenant=abc" },
    { baseUrl: "https://gateway.example.com/anthropic#fragment" },
    { maxTokens: 0 },
    { compactAfterBytes: 1_048_576 },
    { timeoutMs: 0 },
    { reasoningEffort: "minimal" },
  ])("rejects invalid configuration locally: %j", (options) => {
    // @ts-expect-error Exercise the boundary for JavaScript callers.
    expect(() => anthropicModel(options)).toThrow(
      /^Invalid Anthropic (model configuration|base URL)$/
    );
  });

  it("rejects relocated references before any request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const schema = {
      "~standard": {
        version: 1 as const,
        vendor: "fixture",
        validate: (value: unknown) => ({ value }),
        jsonSchema: {
          input: () => ({ $defs: { word: { type: "string" } }, $ref: "#/$defs/word" }),
        },
      },
    };
    const { defineTool } = await import("./agent.js");
    const result = await defineAgent({
      id: "references",
      projectContext: false,
      tools: {
        custom: defineTool({
          description: "Custom",
          inputSchema: schema,
          outputSchema: schema,
          run: (input) => input,
        }),
      },
      model: anthropicModel({ apiKey: "fixture" }),
    }).run({ task: "Finish" });
    expect(result.status).toBe("failed");
    expect(result.errors[0]!.message).toContain("$ref is unsupported");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

it("moves array constraints that strict mode rejects into descriptions", () => {
  const schema = {
    type: "array",
    items: { type: "string" },
    minItems: 1,
    contains: { const: "x" },
    minContains: 1,
    maxContains: 2,
    maxItems: 3,
  };
  const tool = anthropicTool("custom", "Custom", "input", schema, true);
  const input = tool.input_schema.properties.input as Record<string, unknown>;
  expect(input).toEqual({
    type: "array",
    items: { type: "string" },
    minItems: 1,
    description: expect.any(String),
  });
  expect(JSON.parse((input.description as string).replace("Constraints: ", ""))).toEqual({
    maxItems: 3,
    contains: { const: "x" },
    minContains: 1,
    maxContains: 2,
  });
});

it("moves enums with complex values into descriptions", () => {
  const complex = { type: ["array", "string"], enum: [["a"], "b"] };
  const tool = anthropicTool("custom", "Custom", "input", complex, true);
  const input = tool.input_schema.properties.input as Record<string, unknown>;
  expect(input).not.toHaveProperty("enum");
  expect(input.description).toBe(`Constraints: {"enum":[["a"],"b"]}`);
  const scalar = anthropicTool("custom", "Custom", "input", { enum: ["a", 1, null] }, true);
  expect(scalar.input_schema.properties.input).toEqual({
    anyOf: [
      { type: "string", enum: ["a"] },
      { type: "integer", enum: [1] },
      { type: "null", enum: [null] },
    ],
  });
  expect(
    anthropicTool("custom", "Custom", "input", { enum: ["a", "b"], const: "a" }, true).input_schema
      .properties.input
  ).toEqual({ type: "string", const: "a", enum: ["a", "b"] });
  expect(
    anthropicTool("custom", "Custom", "input", { enum: [1, 1.5] }, true).input_schema.properties
      .input
  ).toEqual({ type: "number", enum: [1, 1.5] });
});

it("rejects strict schemas that have no type and no combinator", () => {
  expect(() => anthropicTool("custom", "Custom", "input", { description: "bare" }, true)).toThrow(
    "requires a type"
  );
});

it("rejects tool names the Messages API will not accept", () => {
  const name = `tool_${"a".repeat(60)}`;
  expect(name).toHaveLength(65);
  expect(() => anthropicTool(name, "Custom", "input", { type: "string" }, false)).toThrow(
    "exceeds 64 characters"
  );
  expect(
    anthropicTool("a".repeat(64), "Custom", "input", { type: "string" }, false).name
  ).toHaveLength(64);
});

it("keeps only strict-supported keywords and rewrites oneOf to anyOf", () => {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    oneOf: [
      { type: "string", pattern: "^a" },
      { type: "array", prefixItems: [{ type: "string" }] },
    ],
    not: { type: "null" },
  };
  const tool = anthropicTool("custom", "Custom", "input", schema, true);
  expect(tool.input_schema.properties.input).toEqual({
    anyOf: [
      { type: "string", description: `Constraints: {"pattern":"^a"}` },
      { type: "array", description: `Constraints: {"prefixItems":[{"type":"string"}]}` },
    ],
    description: `Constraints: {"not":{"type":"null"}}`,
  });
});

it("checks strict object rules only on the schema the provider sees", () => {
  const schema = {
    type: "array",
    items: { type: "string" },
    contains: { type: "object", properties: { id: { type: "string" } } },
  };
  const tool = anthropicTool("custom", "Custom", "input", schema, true);
  expect(tool.input_schema.properties.input).not.toHaveProperty("contains");
  expect(() =>
    anthropicTool("custom", "Custom", "input", { ...schema, items: { type: "object" } }, true)
  ).toThrow("requires additionalProperties: false");
});
