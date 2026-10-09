import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createPipelineTestRuntime } from "../testing/testing.js";
import { defineAgent, type AgentOutcome } from "./agent.js";
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
  return defineAgent({
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
    const agent = defineAgent({
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
    const { url, server, fake, requests } = await serveFakeMcpHttp();
    open.push({ close: () => new Promise((resolve) => server.close(() => resolve())) });
    const mcp = await connectMcpServers({
      remote: { url, headers: { Authorization: "Bearer token" } },
    });
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
    server.closeAllConnections();
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
});
