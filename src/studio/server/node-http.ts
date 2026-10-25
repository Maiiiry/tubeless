import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

interface NodeStreamingRequestInit extends RequestInit {
  /** Required by Node's fetch implementation for streaming request bodies. */
  duplex: "half";
}

/** Copy raw request headers except Host; the placeholder URL is the only authority. */
export function toFetchHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]!;
    if (name.toLowerCase() === "host") continue;
    headers.append(name, request.rawHeaders[index + 1]!);
  }
  return headers;
}

/**
 * Convert a Node request into a Fetch request. The URL is a fixed placeholder:
 * the listener passes `request.url` as the handler's `rawTarget` and
 * `request.headers.host` as its `authority`, so no Host-derived value is trusted here.
 */
export function toFetchRequest(request: IncomingMessage): Request {
  const method = request.method ?? "GET";
  const init: NodeStreamingRequestInit = {
    duplex: "half",
    headers: toFetchHeaders(request),
    method,
  };
  if (method !== "GET" && method !== "HEAD") {
    // SAFETY: Readable.toWeb returns a byte stream for an IncomingMessage.
    init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
  }
  return new Request("http://studio.local/", init);
}

export async function writeFetchResponse(
  target: ServerResponse,
  response: Response,
  method: string
): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  target.writeHead(response.status, headers);
  if (method === "HEAD" || response.body === null) {
    await response.body?.cancel();
    target.end();
    return;
  }
  target.end(Buffer.from(await response.arrayBuffer()));
}
