import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWorkbenchCli } from "../workbench.js";
import { captureIo, writeModule } from "../workbench.test-support.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function call(name: string, value: unknown, id: string) {
  return {
    type: "function_call",
    call_id: id,
    name,
    arguments: JSON.stringify({ [name === "_finish" ? "result" : "input"]: value }),
  };
}
const response = (output: unknown[]) => Response.json({ status: "completed", output });

describe("agent conversation sessions", () => {
  it("retains user messages, reasoning, tool results and the final answer, including repeated prompts", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture");
    const { directory } = await writeModule("");
    const reasoning = { type: "reasoning", encrypted_content: "opaque" };
    const list = call("list", { path: "." }, "files");
    const firstFinish = call("_finish", { answer: "First answer" }, "first-finish");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([reasoning, list]))
      .mockResolvedValueOnce(response([firstFinish]))
      .mockResolvedValueOnce(
        response([call("_finish", { answer: "Second answer" }, "second-finish")])
      )
      .mockResolvedValueOnce(
        response([call("_finish", { answer: "Fresh answer" }, "fresh-finish")])
      );
    vi.stubGlobal("fetch", fetcher);
    const io = {
      ...captureIo(directory),
      stdin: Readable.from(["inspect\ninspect\n/clear\nfresh\n/quit\n"]),
    };
    expect(await runWorkbenchCli(["agent", "--model", "fixture"], io)).toBe(0);
    const bodies = fetcher.mock.calls.map(([, options]) => JSON.parse(options!.body as string));
    expect(bodies).toHaveLength(4);
    expect(bodies[0].input).toEqual([{ role: "user", content: "inspect" }]);
    expect(bodies[1].input.slice(0, 3)).toEqual([bodies[0].input[0], reasoning, list]);
    expect(bodies[1].input[3]).toMatchObject({ type: "function_call_output", call_id: "files" });
    expect(JSON.parse(bodies[1].input[3].output)).toMatchObject({ ok: true });
    expect(bodies[2].input).toEqual([
      ...bodies[1].input,
      firstFinish,
      {
        type: "function_call_output",
        call_id: "first-finish",
        output: '{"answer":"First answer"}',
      },
      { role: "user", content: "inspect" },
    ]);
    expect(bodies[3].input).toEqual([{ role: "user", content: "fresh" }]);
    expect(io.output.join("")).toContain("Second answer");
    expect(io.errors).toEqual([]);
  });

  it("compacts completed history between user prompts and preserves the new prompt verbatim", async () => {
    const openaiUrl = new URL("../../../dist/agent/openai.js", import.meta.url).href;
    const { directory } = await writeModule(`
      import { openaiModel } from ${JSON.stringify(openaiUrl)};
      export default () => openaiModel({ apiKey: "fixture", compactAfterBytes: 1 });
    `);
    const compacted = [{ type: "compaction", encrypted_content: "compacted" }];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([call("_finish", { answer: "Remembered" }, "finish")]))
      .mockResolvedValueOnce(Response.json({ object: "response.compaction", output: compacted }))
      .mockResolvedValueOnce(response([call("_finish", { answer: "Continued" }, "next-finish")]));
    vi.stubGlobal("fetch", fetcher);
    const io = { ...captureIo(directory), stdin: Readable.from(["remember this\nfollow up\n"]) };
    expect(await runWorkbenchCli(["agent", "--model-module", "pipeline.mjs"], io)).toBe(0);
    expect(fetcher.mock.calls[1]![0]).toBe("https://api.openai.com/v1/responses/compact");
    const compact = JSON.parse(fetcher.mock.calls[1]![1]!.body as string);
    expect(compact.input.at(-1)).toMatchObject({ type: "function_call_output", call_id: "finish" });
    const next = JSON.parse(fetcher.mock.calls[2]![1]!.body as string);
    expect(next.input).toEqual([...compacted, { role: "user", content: "follow up" }]);
    expect(io.errors).toEqual([]);
  });

  it("owns the finish conversation and keeps the previous committed context after an invalid finish", async () => {
    const { directory } = await writeModule(`
      const owned = { nested: { value: "original" } };
      let factories = 0;
      export default () => {
        if (++factories > 1) owned.nested.value = "mutated";
        return (request) => {
          if (request.conversation !== null && !Object.isFrozen(request.conversation.nested))
            throw new Error("unowned conversation");
          return {
            decision: { kind: "finish", result: { answer: request.task === "invalid" ? 42 : request.conversation?.nested.value ?? "first" } },
            conversation: request.task === "invalid" ? { nested: { value: "invalid" } } : owned,
          };
        };
      };
    `);
    const io = { ...captureIo(directory), stdin: Readable.from(["seed\ninvalid\nfollow up\n"]) };
    expect(await runWorkbenchCli(["agent", "--model-module", "pipeline.mjs"], io)).toBe(0);
    expect(io.output.join("")).toContain("\noriginal\n");
    expect(io.output.join("")).not.toContain("\nmutated\n");
    expect(io.errors.join("")).toContain("answer");
  });

  it("isolates separate sessions and keeps single-shot invocations fresh", async () => {
    const { directory } = await writeModule(`
      export default () => (request) => ({
        decision: { kind: "finish", result: { answer: JSON.stringify(request.conversation) } },
        conversation: [...(request.conversation ?? []), request.task],
      });
    `);
    const first = { ...captureIo(directory), stdin: Readable.from(["alpha\nnext\n"]) };
    const second = { ...captureIo(directory), stdin: Readable.from(["beta\nnext\n"]) };
    expect(
      await Promise.all(
        [first, second].map((io) =>
          runWorkbenchCli(["agent", "--model-module", "pipeline.mjs"], io)
        )
      )
    ).toEqual([0, 0]);
    expect(first.output.join("")).toContain('["alpha"]');
    expect(first.output.join("")).not.toContain('["beta"]');
    expect(second.output.join("")).toContain('["beta"]');
    for (const task of ["one", "two"]) {
      const io = captureIo(directory);
      expect(
        await runWorkbenchCli(["agent", "--model-module", "pipeline.mjs", "--prompt", task], io)
      ).toBe(0);
      expect(io.output.join("")).toContain("\nnull\n");
    }
  });
});
