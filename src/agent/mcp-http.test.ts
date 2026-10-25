import { afterEach, describe, expect, it, vi } from "vitest";
import { httpTransport } from "./mcp-http.js";

afterEach(() => vi.unstubAllGlobals());

describe("MCP HTTP transport", () => {
  it.each(["\r\n", "\r", "\n"])(
    "parses multiline SSE across every byte boundary using %j",
    async (newline) => {
      const receive = vi.fn();
      const cancel = vi.fn();
      const bytes = new TextEncoder().encode(
        `: heartbeat${newline}data: {"jsonrpc":"2.0",${newline}data: "id":1,"result":{"text":"café"}}${newline}${newline}`
      );
      let offset = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset < bytes.length) controller.enqueue(bytes.slice(offset, ++offset));
          else controller.close();
        },
        cancel,
      });
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response(body, { headers: { "Content-Type": "text/event-stream" } })
          )
      );
      const transport = httpTransport("fake", { url: "https://mcp.example.test" }, { receive });
      await transport.send(
        { jsonrpc: "2.0", id: 1, method: "tools/call" },
        new AbortController().signal
      );
      expect(receive).toHaveBeenCalledExactlyOnceWith({
        jsonrpc: "2.0",
        id: 1,
        result: { text: "café" },
      });
      await transport.close();
    }
  );

  it("releases a stream as soon as its response arrives", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n')
        );
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(body, { headers: { "Content-Type": "text/event-stream" } }))
    );
    const transport = httpTransport(
      "fake",
      { url: "https://mcp.example.test" },
      { receive: vi.fn() }
    );
    await transport.send(
      { jsonrpc: "2.0", id: 1, method: "tools/call" },
      new AbortController().signal
    );
    expect(cancel).toHaveBeenCalledOnce();
    await transport.close();
  });

  it.each([false, true])(
    "aborts active requests on close with a session: %s",
    async (withSession) => {
      const signals: AbortSignal[] = [];
      const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => {
        if (init.method === "DELETE") return new Response(null, { status: 405 });
        if (JSON.parse(String(init.body)).method === "initialize")
          return Response.json(
            { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } },
            {
              headers: withSession ? { "Mcp-Session-Id": "session" } : {},
            }
          );
        const signal = init.signal!;
        signals.push(signal);
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      const transport = httpTransport(
        "fake",
        { url: "https://mcp.example.test" },
        { receive: vi.fn() }
      );
      await transport.send(
        { jsonrpc: "2.0", id: 1, method: "initialize" },
        new AbortController().signal
      );
      const running = [2, 3].map((id) =>
        transport.send({ jsonrpc: "2.0", id, method: "tools/call" }, new AbortController().signal)
      );
      const outcomes = Promise.allSettled(running);
      await Promise.all([transport.close(), transport.close()]);
      expect(signals).toHaveLength(2);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect((await outcomes).every((outcome) => outcome.status === "rejected")).toBe(true);
      expect(fetchMock.mock.calls.filter(([, init]) => init.method === "DELETE")).toHaveLength(
        withSession ? 1 : 0
      );
      await expect(
        transport.send(
          { jsonrpc: "2.0", id: 4, method: "tools/call" },
          new AbortController().signal
        )
      ).rejects.toThrow("is closed");
    }
  );
});
