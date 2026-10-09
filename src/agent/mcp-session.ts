import { createAbortError } from "../utilities/abort.js";

export interface McpMessage {
  readonly jsonrpc: "2.0";
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

/** Inbound traffic: every received message, or a failure that ends the connection. */
export interface McpTransportEvents {
  receive(message: McpMessage): void;
  fail(error: Error): void;
}

/** Carries JSON-RPC messages; the session owns ids, deadlines, replies and lifecycle. */
export interface McpTransport {
  /** Deliver one message; any replies arrive through `receive`. */
  send(message: McpMessage, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export type OpenMcpTransport = (events: McpTransportEvents) => Promise<McpTransport>;

/** A JSON-RPC error returned by the server; the connection remains usable. */
export class McpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
    this.name = "McpRpcError";
  }
}

export const MAX_MESSAGE_BYTES = 16_777_216;
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse one inbound message, rejecting shapes that cannot be JSON-RPC. */
export function parseMessage(text: string): McpMessage {
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    throw new Error("MCP server sent invalid JSON");
  }
  if (!isRecord(message) || message.jsonrpc !== "2.0")
    throw new Error("MCP server sent an invalid JSON-RPC message");
  // SAFETY: the version guard identifies JSON-RPC; fields are checked where they are consumed.
  return message as unknown as McpMessage;
}

/** This client declares no capabilities: answer pings and refuse every other server request. */
function reply(request: McpMessage & { id: number | string }): McpMessage {
  return request.method === "ping"
    ? { jsonrpc: "2.0", id: request.id, result: {} }
    : {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: `Unsupported method ${request.method}` },
      };
}

export interface McpSession {
  request(method: string, params: object, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

/** Initialize a session: version negotiation, the initialized notification, then requests. */
export async function openMcpSession(
  open: OpenMcpTransport,
  label: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<McpSession> {
  const pending = new Map<number | string, (response: McpMessage | Error) => void>();
  let failure: Error | undefined;
  let nextId = 1;
  const fail = (error: Error) => {
    failure ??= error;
    for (const settle of pending.values()) settle(failure);
    pending.clear();
  };
  const transport = await open({
    receive(message) {
      if (message.id === undefined) return;
      if (message.method !== undefined)
        void transport
          .send(reply({ ...message, id: message.id }), AbortSignal.timeout(timeoutMs))
          .catch(() => {});
      else pending.get(message.id)?.(message);
    },
    fail,
  });
  const notify = (method: string, params?: object) =>
    transport.send({ jsonrpc: "2.0", method, params }, AbortSignal.timeout(timeoutMs));

  const request = async (method: string, params: object, caller?: AbortSignal) => {
    if (failure) throw failure;
    const id = nextId++;
    const timeout = AbortSignal.timeout(timeoutMs);
    const deadline = caller ? AbortSignal.any([caller, timeout]) : timeout;
    const response = new Promise<McpMessage>((resolve, reject) => {
      const settle = (outcome: McpMessage | Error) => {
        pending.delete(id);
        deadline.removeEventListener("abort", abort);
        if (outcome instanceof Error) reject(outcome);
        else resolve(outcome);
      };
      const abort = () => {
        // Best effort: tell the server to stop work this client will never observe.
        notify("notifications/cancelled", { requestId: id }).catch(() => {});
        settle(
          caller?.aborted
            ? createAbortError(caller, `MCP ${method}`)
            : new Error(`MCP server ${label} timed out after ${timeoutMs} ms during ${method}`)
        );
      };
      if (deadline.aborted) return abort();
      deadline.addEventListener("abort", abort, { once: true });
      pending.set(id, settle);
    });
    transport
      .send({ jsonrpc: "2.0", id, method, params }, deadline)
      .catch((error: Error) => pending.get(id)?.(error));
    const { result, error } = await response;
    if (error)
      throw new McpRpcError(
        typeof error.code === "number" ? error.code : -32603,
        String(error.message ?? "Unknown error").slice(0, 4096)
      );
    return result;
  };
  const close = async () => {
    fail(new Error(`MCP server ${label} is closed`));
    await transport.close();
  };

  try {
    const result = await request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSIONS[0],
        capabilities: {},
        clientInfo: { name: "tubeless", version: "unversioned" },
      },
      signal
    );
    if (
      !isRecord(result) ||
      typeof result.protocolVersion !== "string" ||
      !PROTOCOL_VERSIONS.includes(result.protocolVersion)
    )
      throw new Error(`MCP server ${label} requires an unsupported protocol version`);
    await notify("notifications/initialized");
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
  return { request, close };
}
