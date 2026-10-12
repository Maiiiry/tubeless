import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { toFetchRequest, writeFetchResponse } from "./run-store-ui-node.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
  );
});

async function serve(handler: (request: Request) => Promise<Response>): Promise<number> {
  const server = createServer(async (incoming, outgoing) => {
    await writeFetchResponse(
      outgoing,
      await handler(toFetchRequest(incoming)),
      incoming.method ?? "GET"
    );
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

interface RawResult {
  status: number;
  headers: Record<string, unknown>;
  body: string;
}

function raw(
  port: number,
  method: string,
  headers: [string, string][],
  body?: string
): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path: "/x",
        // SAFETY: http.request accepts a flat [name, value, ...] array to send duplicate headers.
        // Node does not add a Host header in this form, so one is sent explicitly.
        headers: [["Host", `127.0.0.1:${port}`], ...headers].flat() as unknown as Record<
          string,
          string
        >,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text })
        );
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("Node bridge", () => {
  it("preserves duplicate request headers as one combined value", async () => {
    const port = await serve(async (request) => new Response(request.headers.get("origin") ?? ""));
    const result = await raw(port, "GET", [
      ["Origin", "https://a"],
      ["Origin", "https://b"],
    ]);
    expect(result.body).toBe("https://a, https://b");
  });

  it("streams request bodies and writes response status and headers", async () => {
    const port = await serve(
      async (request) =>
        new Response(`got:${await request.text()}`, { status: 202, headers: { "x-test": "1" } })
    );
    const result = await raw(port, "POST", [["content-type", "application/json"]], '{"a":1}');
    expect(result).toMatchObject({ status: 202, body: 'got:{"a":1}' });
    expect(result.headers["x-test"]).toBe("1");
  });

  it("omits bodies for HEAD", async () => {
    const port = await serve(
      async () => new Response("page", { headers: { "content-type": "text/html" } })
    );
    const result = await raw(port, "HEAD", []);
    expect(result).toMatchObject({ status: 200, body: "" });
    expect(result.headers["content-type"]).toBe("text/html");
  });
});
