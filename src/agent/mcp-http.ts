import {
  isRecord,
  MAX_MESSAGE_BYTES,
  parseMessage,
  type McpMessage,
  type McpTransport,
  type McpTransportEvents,
} from "./mcp-session.js";

/** A remote server reached over Streamable HTTP. */
export interface McpHttpOptions {
  readonly url: string | URL;
  /** Sent with every request, for example an Authorization header. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Decode a bounded response body as text chunks. */
async function* text(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_MESSAGE_BYTES) throw new Error("MCP response exceeds 16 MiB");
      yield decoder.decode(chunk.value, { stream: true });
    }
    yield decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Yield the JSON-RPC messages carried by a JSON body or by `data` fields of an event stream. */
async function* messages(response: Response) {
  if (!response.body) return;
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    let body = "";
    for await (const chunk of text(response.body)) body += chunk;
    if (body.trim()) yield parseMessage(body);
    return;
  }
  let buffer = "";
  for await (const chunk of text(response.body)) {
    buffer += chunk.replace(/\r\n?/g, "\n");
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const data = buffer
        .slice(0, boundary)
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5))
        .join("\n");
      buffer = buffer.slice(boundary + 2);
      if (data) yield parseMessage(data);
    }
  }
}

/** Streamable HTTP: each message is a POST whose JSON or event-stream body carries replies. */
export function httpTransport(
  label: string,
  options: McpHttpOptions,
  events: Pick<McpTransportEvents, "receive">
): McpTransport {
  const url = new URL(options.url);
  let session: string | undefined;
  let version: string | undefined;
  const headers = () => ({
    ...options.headers,
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    ...(session === undefined ? {} : { "Mcp-Session-Id": session }),
    ...(version === undefined ? {} : { "MCP-Protocol-Version": version }),
  });
  return {
    async send(message, signal) {
      const response = await fetch(url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(message),
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`MCP server ${label} failed (HTTP ${response.status})`);
      }
      session = response.headers.get("mcp-session-id") ?? session;
      let answered = message.id === undefined;
      for await (const reply of messages(response)) {
        if (reply.id === message.id && reply.method === undefined) {
          answered = true;
          // Later requests carry the version this initialize response negotiated.
          if (message.method === "initialize" && isRecord(reply.result))
            version = String(reply.result.protocolVersion);
        }
        events.receive(reply);
      }
      if (!answered) throw new Error(`MCP server ${label} closed the stream without a response`);
    },
    async close() {
      if (session === undefined) return;
      // Servers may refuse explicit termination with 405; the session then expires on its own.
      await fetch(url, { method: "DELETE", headers: headers(), signal: AbortSignal.timeout(5_000) })
        .then((response) => response.body?.cancel())
        .catch(() => {});
      session = undefined;
    },
  };
}
