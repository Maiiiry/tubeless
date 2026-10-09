import { createServer, type Server } from "node:http";
import { createInterface } from "node:readline";

type Message = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  result?: unknown;
  params?: {
    cursor?: string;
    requestId?: number;
    name?: string;
    arguments?: { text?: string; times?: number };
  };
};

const tools = [
  {
    name: "echo",
    description: "Repeat text",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { text: { type: "string" }, times: { type: "integer" } },
      required: ["text"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "fail",
    inputSchema: { type: "object" },
  },
  {
    name: "slow",
    description: "Wait until cancelled",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "nested.ref",
    description: "Use a referenced schema",
    inputSchema: {
      type: "object",
      properties: { point: { $ref: "#/$defs/point" } },
      required: ["point"],
      $defs: {
        point: {
          type: "object",
          properties: { x: { type: "number" }, label: { type: "string" } },
          required: ["x"],
        },
      },
    },
  },
];

/** A small MCP server: two-tool pages, per-call behavior, and observed cancellations. */
export function createFakeMcpServer() {
  const cancelled: unknown[] = [];
  const calls: unknown[] = [];
  const responses: Message[] = [];
  const handle = (message: Message): Message | undefined => {
    if (message.method === "notifications/cancelled") cancelled.push(message.params?.requestId);
    if (message.id === undefined) return undefined;
    if (message.method === undefined) return void responses.push(message);
    const reply = (result: unknown) => ({ jsonrpc: "2.0" as const, id: message.id, result });
    switch (message.method) {
      case "initialize":
        return reply({
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake", version: "1" },
        });
      case "tools/list": {
        const start = Number(message.params?.cursor ?? 0);
        const next = start + 2 < tools.length ? String(start + 2) : undefined;
        return reply({ tools: tools.slice(start, start + 2), nextCursor: next });
      }
      case "tools/call": {
        const { name, arguments: args = {} } = message.params ?? {};
        calls.push({ name, args });
        if (name === "echo")
          return reply({
            content: [{ type: "text", text: String(args.text).repeat(args.times ?? 1) }],
          });
        if (name === "fail")
          return reply({ isError: true, content: [{ type: "text", text: "boom" }] });
        if (name === "nested.ref") return reply({ content: [], structuredContent: args });
        if (name === "slow") return undefined;
        return {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32602, message: "No tool" },
        } as Message;
      }
      default:
        return {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "No method" },
        } as Message;
    }
  };
  return { handle, cancelled, calls, responses };
}

/** Serve the fake over Streamable HTTP, answering tool calls as event streams. */
export async function serveFakeMcpHttp(): Promise<{
  url: string;
  server: Server;
  fake: ReturnType<typeof createFakeMcpServer>;
  requests: { method: string; session?: string; version?: string; auth?: string }[];
}> {
  const fake = createFakeMcpServer();
  const requests: { method: string; session?: string; version?: string; auth?: string }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const message: Message | undefined = body ? JSON.parse(body) : undefined;
    requests.push({
      method: message?.method ?? request.method!,
      session: request.headers["mcp-session-id"] as string | undefined,
      version: request.headers["mcp-protocol-version"] as string | undefined,
      auth: request.headers.authorization,
    });
    if (!message) return response.writeHead(204).end();
    const reply = fake.handle(message);
    if (message.method === "initialize") response.setHeader("Mcp-Session-Id", "session-1");
    if (!reply) {
      if (message.id === undefined) return response.writeHead(202).end();
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      request.once("close", () => response.end());
      return;
    }
    if (message.method === "tools/call") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const event of [
        { jsonrpc: "2.0", method: "notifications/progress", params: {} },
        { jsonrpc: "2.0", id: "server-ping", method: "ping" },
      ])
        response.write(`event: message\ndata: ${JSON.stringify(event)}\n\n`);
      return response.end(`data: ${JSON.stringify(reply)}\r\n\r\n`);
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(reply));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/mcp`, server, fake, requests };
}

// Executed directly, speak newline-delimited JSON-RPC over stdio.
if (process.argv[2] === "stdio") {
  const fake = createFakeMcpServer();
  process.stderr.write("fake server ready\n");
  for await (const line of createInterface({ input: process.stdin })) {
    const message: Message = JSON.parse(line);
    const reply = fake.handle(message);
    if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
  }
}
