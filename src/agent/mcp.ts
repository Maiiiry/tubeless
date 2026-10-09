import type { AgentTool } from "./agent-types.js";
import { defineTool, ToolError } from "./tools.js";
import { httpTransport, type McpHttpOptions } from "./mcp-http.js";
import { mcpInputSchema, mcpResultSchema, type McpToolResult } from "./mcp-schema.js";
import {
  isRecord,
  McpRpcError,
  openMcpSession,
  type McpSession,
  type OpenMcpTransport,
} from "./mcp-session.js";
import { stdioTransport, type McpStdioOptions } from "./mcp-stdio.js";

export type { McpToolResult } from "./mcp-schema.js";
export type { McpHttpOptions } from "./mcp-http.js";
export type { McpStdioOptions } from "./mcp-stdio.js";

interface McpServerOptions {
  /** Expose only these server tool names; every name must exist. Defaults to all tools. */
  readonly tools?: readonly string[];
  /** Deadline for each request to this server; defaults to 60000 ms. */
  readonly timeoutMs?: number;
}

/** A Streamable HTTP endpoint (`url`) or a local stdio command (`command`). */
export type McpServer = McpServerOptions &
  ((McpHttpOptions & { readonly command?: never }) | (McpStdioOptions & { readonly url?: never }));

/** A tool discovered on an MCP server, called with its validated JSON arguments. */
export type McpTool = AgentTool<Record<string, unknown>, McpToolResult>;

/** Connected servers whose tools are named `<server>__<tool>`; close them after the agent's runs. */
export interface McpServers<Name extends string> {
  readonly tools: Readonly<Record<`${Name}__${string}`, McpTool>>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/** A validated server configuration, ready to connect. */
interface ServerPlan {
  readonly label: string;
  readonly timeoutMs: number;
  readonly allowed?: ReadonlySet<string>;
  readonly open: OpenMcpTransport;
}

/** The fields of a listed tool that the adapter uses. */
interface McpToolInfo {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
}

const MAX_TOOLS = 4096;
const nonblank = (value: unknown): value is string => typeof value === "string" && !!value.trim();

/** Validate one server entry before any connection starts. */
function plan(label: string, server: McpServer): ServerPlan {
  if (!/^[A-Za-z][A-Za-z0-9-]{0,31}$/.test(label))
    throw new Error(`Invalid MCP server name ${label}: use letters, digits and hyphens`);
  if (!isRecord(server) || (server.url !== undefined) === nonblank(server.command))
    throw new Error(`MCP server ${label} requires exactly one of url or command`);
  const { timeoutMs = 60_000, tools } = server;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
    throw new Error(`MCP server ${label} has an invalid timeoutMs`);
  return {
    label,
    timeoutMs,
    allowed: tools && new Set(tools),
    open:
      server.url !== undefined
        ? async (events) => httpTransport(label, server, events)
        : (events) => stdioTransport(label, server, events),
  };
}

/** List every tool, following pagination, and parse the fields the adapter relies on. */
async function discover(session: McpSession, label: string, signal?: AbortSignal) {
  const tools: McpToolInfo[] = [];
  let cursor: unknown;
  do {
    const page = await session.request("tools/list", cursor ? { cursor } : {}, signal);
    if (!isRecord(page) || !Array.isArray(page.tools))
      throw new Error(`MCP server ${label} returned an invalid tool list`);
    for (const tool of page.tools) {
      if (!isRecord(tool) || !nonblank(tool.name))
        throw new Error(`MCP server ${label} listed a tool without a name`);
      const description = [tool.description, tool.title].find(nonblank);
      tools.push({ name: tool.name, description, inputSchema: tool.inputSchema });
    }
    if (tools.length > MAX_TOOLS) throw new Error(`MCP server ${label} exceeds ${MAX_TOOLS} tools`);
    cursor = page.nextCursor;
  } while (nonblank(cursor));
  return tools;
}

function errorText(content: unknown): string {
  const text = Array.isArray(content)
    ? content
        .filter((item) => isRecord(item) && item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n")
    : "";
  return (text.trim() || "MCP tool reported an error").slice(0, 4096);
}

function bridge(
  session: McpSession,
  label: string,
  { name, description, inputSchema }: McpToolInfo
) {
  return defineTool({
    description: (description ?? `Call ${name} on MCP server ${label}`).slice(0, 4096),
    inputSchema: mcpInputSchema(inputSchema),
    outputSchema: mcpResultSchema,
    run: async (args, context) => {
      let result: unknown;
      try {
        result = await session.request("tools/call", { name, arguments: args }, context.signal);
      } catch (error) {
        // Protocol errors such as unknown tools or invalid arguments are observations.
        if (error instanceof McpRpcError)
          throw new ToolError("MCP_PROTOCOL_ERROR", `${error.code}: ${error.message}`);
        throw error;
      }
      if (isRecord(result) && result.isError === true)
        throw new ToolError("MCP_TOOL_ERROR", errorText(result.content));
      return result;
    },
  });
}

async function connect({ label, timeoutMs, allowed, open }: ServerPlan, signal?: AbortSignal) {
  const session = await openMcpSession(open, label, timeoutMs, signal);
  try {
    const listed = await discover(session, label, signal);
    const names = new Set(listed.map((tool) => tool.name));
    const missing = [...(allowed ?? [])].filter((name) => !names.has(name));
    if (missing.length > 0)
      throw new Error(`MCP server ${label} has no tool named ${missing.join(", ")}`);
    const tools: Record<string, McpTool> = {};
    for (const tool of listed) {
      if (allowed && !allowed.has(tool.name)) continue;
      const key = `${label}__${tool.name.replace(/[^A-Za-z0-9_-]/g, "_")}`;
      if (key.length > 128) throw new Error(`MCP tool name ${key} exceeds 128 characters`);
      if (Object.hasOwn(tools, key)) throw new Error(`MCP server ${label} tools collide as ${key}`);
      try {
        tools[key] = bridge(session, label, tool);
      } catch (cause) {
        throw new Error(`MCP tool ${key} cannot be used`, { cause });
      }
    }
    return { session, tools };
  } catch (error) {
    await session.close().catch(() => {});
    throw error;
  }
}

/**
 * Connect MCP servers and expose their tools to an agent, named `<server>__<tool>`.
 *
 * Tool inventories are discovered once, so agent definitions and durable checkpoints
 * see a fixed capability set. The caller owns the connections: close them, or use
 * `await using`, after the agent's last run.
 */
export async function connectMcpServers<const Servers extends Readonly<Record<string, McpServer>>>(
  servers: Servers,
  options: { readonly signal?: AbortSignal } = {}
): Promise<McpServers<keyof Servers & string>> {
  const plans = Object.entries(servers).map(([label, server]) => plan(label, server));
  const settled = await Promise.allSettled(plans.map((server) => connect(server, options.signal)));
  const connected = settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : []
  );
  const close = async () => {
    await Promise.allSettled(connected.map(({ session }) => session.close()));
  };
  const failure = settled.find((result) => result.status === "rejected");
  if (failure) {
    await close();
    throw failure.reason;
  }
  const tools = Object.assign({}, ...connected.map((server) => server.tools));
  return Object.freeze({
    tools: Object.freeze(tools),
    close,
    [Symbol.asyncDispose]: close,
  });
}
