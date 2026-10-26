import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createPipelineTestRuntime } from "../testing/testing.js";
import { defineAgentLoop, defineAgent, type AgentOutcome } from "./agent.js";
import { emptyInput, schema } from "./agent.test-support.js";
import { connectMcpServers, type McpServers, type McpTool } from "./mcp.js";
import { serveFakeMcpHttp } from "./mcp.test-support.js";
import { parameter } from "./openai-protocol.js";

const fixture = fileURLToPath(new URL("./mcp.test-support.ts", import.meta.url));
const stdioServer = {
  command: process.execPath,
  args: ["--disable-warning=ExperimentalWarning", fixture, "stdio"],
};
const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((resource) => resource.close()));
});

/** Call the given tools in one batch, then finish with the observed outcomes. */
function callingAgent(
  tools: Readonly<Record<string, McpTool>>,
  calls: { tool: string; input: unknown }[]
) {
  return defineAgentLoop({
    id: "mcp-agent",
    inputSchema: emptyInput,
    resultSchema: schema<unknown>((value) => ({ value })),
    resultJsonSchema: {},
    tools,
    limits: { maxConcurrency: 4 },
    initialState: () => ({ outcomes: [] as readonly AgentOutcome[] }),
    decide: (state) =>
      state.outcomes.length
        ? { kind: "finish", result: state.outcomes }
        : {
            kind: "continue",
            // SAFETY: tests address discovered tools by runtime name.
            calls: calls.map((call, index) => ({ id: `c${index}`, ...call })) as never,
          },
    reduce: (_state, outcomes) => ({ outcomes: outcomes as readonly AgentOutcome[] }),
  });
}

describe("MCP servers", () => {
  it("calls MCP tools from one code-mode script with declared result types", async () => {
    const mcp = await connectMcpServers({ fake: stdioServer });
    open.push(mcp);
    let description = "";
    const agent = defineAgent({
      id: "mcp-codemode",
      projectContext: false,
      codemode: true,
      tools: mcp.tools,
      model: (request, context) => {
        description = context.capabilities[0]!.description;
        return context.turn === 1
          ? {
              conversation: null,
              decision: {
                kind: "continue",
                calls: [
                  {
                    id: "script",
                    tool: "codemode",
                    input: {
                      code: `
                        const texts = [];
                        for (const times of [1, 2]) {
                          const { content } = await tools.fake__echo({ text: "ab", times });
                          texts.push(content[0].text);
                        }
                        try { await tools.fake__fail({}); } catch (error) { texts.push(error.code); }
                        return texts;`,
                    },
                  },
                ],
              },
            }
          : {
              conversation: null,
              decision: { kind: "finish", result: { answer: JSON.stringify(request.outcomes) } },
            };
      },
    });
    const { answer } = await agent.runOrThrow({ task: "echo" });
    expect(JSON.parse(answer)[0].value.result).toEqual(["ab", "abab", "MCP_TOOL_ERROR"]);
    expect(description).toContain(`fake__echo(input: {
    text: string;
    times: number | null;
  }): Promise<{
    content: {
      type: string;
      text?: string;
    }[];
    structuredContent?: Record<string, unknown>;
  }>;`);
  });

  it("exposes stdio tools with strict descriptors and maps results and tool errors", async () => {
    const mcp = await connectMcpServers({ fake: stdioServer });
    open.push(mcp);
    expectTypeOf(mcp).toEqualTypeOf<McpServers<"fake">>();
    expectTypeOf(mcp.tools).toEqualTypeOf<Readonly<Record<`fake__${string}`, McpTool>>>();
    expect(Object.keys(mcp.tools).sort()).toEqual([
      "fake__echo",
      "fake__fail",
      "fake__nested_ref",
      "fake__slow",
    ]);
    let descriptors: Record<string, unknown> = {};
    const agent = defineAgentLoop({
      id: "describe",
      inputSchema: emptyInput,
      resultSchema: schema<unknown>((value) => ({ value })),
      resultJsonSchema: {},
      tools: mcp.tools,
      initialState: () => 0,
      decide: (_state, context) => {
        descriptors = Object.fromEntries(
          context.capabilities.map(({ name, inputJsonSchema }) => [name, inputJsonSchema])
        );
        return { kind: "finish", result: null };
      },
    });
    await createPipelineTestRuntime().runOrThrow(agent, {});
    expect(descriptors.fake__echo).toEqual({
      type: "object",
      properties: {
        text: { type: "string" },
        times: { anyOf: [{ type: "integer" }, { type: "null" }] },
      },
      required: ["text", "times"],
      additionalProperties: false,
    });
    for (const name of Object.keys(mcp.tools))
      expect(() => parameter("input", descriptors[name] as Record<string, unknown>)).not.toThrow();

    const result = await createPipelineTestRuntime().runOrThrow(
      callingAgent(mcp.tools, [
        { tool: "fake__echo", input: { text: "hi", times: null } },
        { tool: "fake__echo", input: { text: "ab", times: 2 } },
        { tool: "fake__fail", input: {} },
        { tool: "fake__nested_ref", input: { point: { x: 1, label: null } } },
      ]),
      {}
    );
    expect(result).toEqual([
      {
        id: "c0",
        tool: "fake__echo",
        ok: true,
        value: { content: [{ type: "text", text: "hi" }] },
      },
      {
        id: "c1",
        tool: "fake__echo",
        ok: true,
        value: { content: [{ type: "text", text: "abab" }] },
      },
      {
        id: "c2",
        tool: "fake__fail",
        ok: false,
        error: { code: "MCP_TOOL_ERROR", message: "boom" },
      },
      {
        id: "c3",
        tool: "fake__nested_ref",
        ok: true,
        value: { content: [], structuredContent: { point: { x: 1 } } },
      },
    ]);
  });

  it("rejects arguments outside the strict descriptor before calling the server", async () => {
    const mcp = await connectMcpServers({ fake: { ...stdioServer, tools: ["echo"] } });
    open.push(mcp);
    expect(Object.keys(mcp.tools)).toEqual(["fake__echo"]);
    const result = await createPipelineTestRuntime().run(
      callingAgent(mcp.tools, [{ tool: "fake__echo", input: { text: 1, times: null } }]),
      {}
    );
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result.errors)).toContain("input.text must be");
  });

  it("speaks Streamable HTTP with session headers, event streams, pings, and cancellation", async () => {
    const { url, close, fake, requests } = await serveFakeMcpHttp();
    open.push({ close });
    const mcp = await connectMcpServers({
      remote: { url, headers: { Authorization: "Bearer token" } },
    });
    open.push(mcp);
    const done = await createPipelineTestRuntime().runOrThrow(
      callingAgent(mcp.tools, [{ tool: "remote__echo", input: { text: "x", times: 3 } }]),
      {}
    );
    expect(done).toMatchObject([{ ok: true, value: { content: [{ text: "xxx" }] } }]);
    // Server requests on a response stream are answered like those on stdio.
    await vi.waitFor(() =>
      expect(fake.responses).toEqual([{ jsonrpc: "2.0", id: "server-ping", result: {} }])
    );

    const runtime = createPipelineTestRuntime();
    const running = runtime.run(callingAgent(mcp.tools, [{ tool: "remote__slow", input: {} }]), {});
    await vi.waitFor(() => expect(fake.calls).toContainEqual({ name: "slow", args: {} }));
    runtime.abort("operator stopped");
    expect((await running).status).toBe("cancelled");
    await vi.waitFor(() => expect(fake.cancelled).toHaveLength(1));

    await mcp.close();
    expect(requests[0]).toMatchObject({ method: "initialize", session: undefined });
    expect(requests.slice(1)).toEqual(
      requests.slice(1).map((request) =>
        expect.objectContaining({
          ...request,
          session: "session-1",
          version: "2025-06-18",
          auth: "Bearer token",
        })
      )
    );
    expect(requests.at(-1)!.method).toBe("DELETE");
  });

  it("validates configuration and reports servers that fail to start", async () => {
    await expect(connectMcpServers({ bad_name: stdioServer })).rejects.toThrow(
      "Invalid MCP server name"
    );
    await expect(
      // @ts-expect-error a server needs exactly one transport.
      connectMcpServers({ both: { ...stdioServer, url: "http://localhost" } })
    ).rejects.toThrow("exactly one of url or command");
    await expect(
      connectMcpServers({ fake: { ...stdioServer, tools: ["missing"] } })
    ).rejects.toThrow("no tool named missing");
    await expect(
      connectMcpServers({
        dead: {
          command: process.execPath,
          args: ["-e", "console.error('no auth'); process.exit(2)"],
        },
      })
    ).rejects.toThrow(/MCP server dead exited \(2\): no auth/);
    await expect(
      connectMcpServers({ missing: { command: "tubeless-mcp-server-that-does-not-exist" } })
    ).rejects.toThrow("MCP server missing failed to start");
  });

  it("fails calls after close and supports await using", async () => {
    let tools: Readonly<Record<string, McpTool>> = {};
    {
      await using mcp = await connectMcpServers({ fake: stdioServer });
      tools = mcp.tools;
    }
    const result = await createPipelineTestRuntime().run(
      callingAgent(tools, [{ tool: "fake__echo", input: { text: "x", times: null } }]),
      {}
    );
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result.errors)).toContain("MCP server fake is closed");
  });

  it.each(["repeated", "unbounded"])(
    "rejects %s pagination and closes the failed session",
    async (mode) => {
      const { url, close, fake, requests } = await serveFakeMcpHttp();
      open.push({ close });
      const handle = fake.handle;
      let pages = 0;
      vi.spyOn(fake, "handle").mockImplementation((message) =>
        message.method === "tools/list"
          ? {
              jsonrpc: "2.0",
              id: message.id,
              result: { tools: [], nextCursor: mode === "repeated" ? "repeat" : String(++pages) },
            }
          : handle(message)
      );
      await expect(connectMcpServers({ fake: { url } })).rejects.toThrow(
        mode === "repeated" ? "repeated a tool cursor" : "exceeds 1024 tool pages"
      );
      expect(requests.at(-1)!.method).toBe("DELETE");
      expect(requests.filter(({ method }) => method === "tools/list")).toHaveLength(
        mode === "repeated" ? 2 : 1024
      );
    }
  );

  it("keeps long JSON-RPC errors recoverable and the connection usable", async () => {
    const { url, close, fake } = await serveFakeMcpHttp();
    open.push({ close });
    const handle = fake.handle;
    vi.spyOn(fake, "handle").mockImplementation((message) =>
      message.method === "tools/call" && message.params?.name === "fail"
        ? { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "x".repeat(4096) } }
        : handle(message)
    );
    const mcp = await connectMcpServers({ fake: { url } });
    open.push(mcp);
    const runtime = createPipelineTestRuntime();
    const outcomes = await runtime.runOrThrow(
      callingAgent(mcp.tools, [{ tool: "fake__fail", input: {} }]),
      {}
    );
    expect(outcomes).toEqual([
      {
        id: "c0",
        tool: "fake__fail",
        ok: false,
        error: { code: "MCP_PROTOCOL_ERROR", message: `-32602: ${"x".repeat(4088)}` },
      },
    ]);
    expect(
      await runtime.runOrThrow(
        callingAgent(mcp.tools, [
          { tool: "fake__echo", input: { text: "still works", times: null } },
        ]),
        {}
      )
    ).toMatchObject([{ ok: true, value: { content: [{ text: "still works" }] } }]);
  });
});
