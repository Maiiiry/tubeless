import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import {
  defineAgentLoop,
  defineTool,
  pipelineTool,
  type AgentCall,
  type AgentOutcome,
} from "./agent.js";
import { emptyInput, numberSchema, schema } from "./agent.test-support.js";

const directories: string[] = [];
async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), "tubeless-tools-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

const outcomesSchema = schema<readonly AgentOutcome[]>((value) => ({
  value: value as AgentOutcome[],
}));
function batch(calls: readonly AgentCall[]) {
  const decide = (state: readonly AgentOutcome[], context: { turn: number }) =>
    context.turn === 1 ? { kind: "continue", calls } : { kind: "finish", result: state };
  return defineAgentLoop({
    id: "default-tools",
    inputSchema: emptyInput,
    resultSchema: outcomesSchema,
    initialState: (): readonly AgentOutcome[] => [],
    decide,
    dryRun: decide,
    reduce: (_state, outcomes) => outcomes,
  });
}

describe("default agent tools", () => {
  it("includes defaults with no registry, preserves custom overrides, and exposes validated model descriptors", async () => {
    const tools = {
      read: defineTool({
        description: "Custom read",
        inputSchema: numberSchema,
        outputSchema: numberSchema,
        run: (input) => input * 2,
      }),
    };
    const call: AgentCall<typeof tools> = { id: "custom", tool: "read", input: 3 };
    // @ts-expect-error An overridden read uses the custom input, not the default file input.
    const invalid: AgentCall<typeof tools> = { id: "custom", tool: "read", input: { path: "x" } };
    void invalid;
    const agent = defineAgentLoop({
      id: "custom-default",
      inputSchema: emptyInput,
      resultSchema: numberSchema,
      tools,
      initialState: () => 0,
      decide: (state, context) => {
        expect(context.capabilities.map(({ name }) => name)).toEqual([
          "bash",
          "edit",
          "list",
          "read",
          "search",
          "write",
        ]);
        expect(context.capabilities.find(({ name }) => name === "read")?.description).toBe(
          "Custom read"
        );
        return context.turn === 1
          ? { kind: "continue", calls: [call] }
          : { kind: "finish", result: state };
      },
      reduce: (_state, outcomes) => {
        const outcome = outcomes[0]!;
        if (!outcome.ok || outcome.tool !== "read") throw new Error("Expected custom read");
        expectTypeOf(outcome.value).toEqualTypeOf<number>();
        return outcome.value;
      },
    });
    expect(await agent.runOrThrow({})).toBe(6);
    expect(
      batch([])
        .plan()
        .steps[0]!.agent!.capabilities.map(({ name }) => name)
    ).toEqual(["bash", "edit", "list", "read", "search", "write"]);
  });

  it("uses each run's cwd for write, exact edit, line reads, listing and literal search", async () => {
    const cwd = await workspace();
    const run = (call: AgentCall) => batch([call]).runOrThrow({}, undefined, { cwd });
    expect(
      await run({
        id: "write",
        tool: "write",
        input: { path: "nested/task.txt", content: "alpha\nbeta\ngamma" },
      })
    ).toMatchObject([{ ok: true, value: { bytes: 16 } }]);
    expect(
      await run({
        id: "edit",
        tool: "edit",
        input: { path: "nested/task.txt", oldText: "beta", newText: "BETTER" },
      })
    ).toMatchObject([{ ok: true }]);
    expect(
      await run({
        id: "read",
        tool: "read",
        input: { path: "nested/task.txt", startLine: 2, maxLines: 1 },
      })
    ).toMatchObject([
      {
        ok: true,
        value: { content: "BETTER", startLine: 2, endLine: 2, totalLines: 3, truncated: true },
      },
    ]);
    expect(await run({ id: "list", tool: "list", input: { path: null } })).toMatchObject([
      { ok: true, value: { entries: [{ name: "nested", kind: "directory" }], truncated: false } },
    ]);
    expect(await run({ id: "search", tool: "search", input: { query: "BETTER" } })).toMatchObject([
      {
        ok: true,
        value: { matches: [{ path: join(cwd, "nested/task.txt"), line: 2, text: "BETTER" }] },
      },
    ]);
    expect(await readFile(join(cwd, "nested/task.txt"), "utf8")).toBe("alpha\nBETTER\ngamma");
  });

  it("preserves text bytes and reports missing or ambiguous edits without writing", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "text"), "\uFEFFsame\r\nsame\r\nunique");
    for (const [oldText, code] of [
      ["same", "EDIT_AMBIGUOUS"],
      ["missing", "EDIT_NOT_FOUND"],
    ]) {
      const result = await batch([
        { id: "edit", tool: "edit", input: { path: "text", oldText, newText: "changed" } },
      ]).runOrThrow({}, undefined, { cwd });
      expect(result).toMatchObject([{ ok: false, error: { code } }]);
      expect(await readFile(join(cwd, "text"), "utf8")).toBe("\uFEFFsame\r\nsame\r\nunique");
    }
    await batch([
      { id: "edit", tool: "edit", input: { path: "text", oldText: "unique", newText: "changed" } },
    ]).runOrThrow({}, undefined, { cwd });
    expect(await readFile(join(cwd, "text"), "utf8")).toBe("\uFEFFsame\r\nsame\r\nchanged");
  });

  it("validates the full batch before mutations and keeps filesystem failures recoverable", async () => {
    const cwd = await workspace();
    const invalid = batch([
      { id: "write", tool: "write", input: { path: "untouched", content: "x" } },
      { id: "read", tool: "read", input: { path: "x", startLine: 0 } },
    ]);
    expect((await invalid.run({}, undefined, { cwd })).status).toBe("failed");
    await expect(readFile(join(cwd, "untouched"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await batch([{ id: "read", tool: "read", input: { path: "missing" } }]).runOrThrow(
        {},
        undefined,
        { cwd }
      )
    ).toMatchObject([{ ok: false, error: { code: "ENOENT" } }]);
    const unknownArgument = { id: "read", tool: "read", input: { path: "x", ignored: true } };
    expect((await batch([unknownArgument as AgentCall]).run({}, undefined, { cwd })).status).toBe(
      "failed"
    );
  });

  it("rejects special files without blocking on a named pipe or truncating a device", async () => {
    const cwd = await workspace();
    execFileSync("mkfifo", [join(cwd, "pipe")]);
    await symlink("pipe", join(cwd, "link"));
    await mkdir(join(cwd, ".git"));
    await mkdir(join(cwd, "node_modules"));
    const outcomes = await batch([
      { id: "read", tool: "read", input: { path: "pipe" } },
      { id: "write", tool: "write", input: { path: "pipe", content: "x" } },
      { id: "device", tool: "write", input: { path: "/dev/null", content: "x" } },
      { id: "search", tool: "search", input: { query: "needle" } },
    ]).runOrThrow({}, undefined, { cwd });
    expect(outcomes).toMatchObject([
      { ok: false, error: { code: "NOT_FILE" } },
      { ok: false, error: { code: "NOT_FILE" } },
      { ok: false, error: { code: "NOT_FILE" } },
      { ok: true, value: { matches: [], skippedFiles: 1, truncated: false } },
    ]);
  });

  it("bounds text and search results and skips binary files, large files and nested symlinks", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "long"), "é".repeat(20_000));
    const [read] = await batch([{ id: "read", tool: "read", input: { path: "long" } }]).runOrThrow(
      {},
      undefined,
      { cwd }
    );
    if (!read?.ok || read.tool !== "read") throw new Error("Expected read");
    expect(Buffer.byteLength(read.value.content)).toBe(16_384);
    expect(read.value.content).not.toContain("�");
    expect(read.value.truncated).toBe(true);
    await writeFile(join(cwd, "binary"), Buffer.from([0, 1, 2]));
    await writeFile(join(cwd, "large"), "x".repeat(1_048_577));
    await mkdir(join(cwd, "node_modules"));
    await writeFile(join(cwd, "node_modules", "ignored"), "needle");
    await symlink(cwd, join(cwd, "loop"));
    await writeFile(join(cwd, "hits"), "needle\n".repeat(60));
    const [search] = await batch([
      { id: "search", tool: "search", input: { query: "needle" } },
    ]).runOrThrow({}, undefined, { cwd });
    if (!search?.ok || search.tool !== "search") throw new Error("Expected search");
    expect(search.value.matches).toHaveLength(50);
    expect(search.value.truncated).toBe(true);
    expect(search.value.matches.every(({ path }) => path === join(cwd, "hits"))).toBe(true);
    expect(
      await batch([{ id: "read", tool: "read", input: { path: "binary" } }]).runOrThrow(
        {},
        undefined,
        { cwd }
      )
    ).toMatchObject([{ ok: false, error: { code: "NOT_TEXT" } }]);
    expect(
      await batch([{ id: "read", tool: "read", input: { path: "large" } }]).runOrThrow(
        {},
        undefined,
        { cwd }
      )
    ).toMatchObject([{ ok: false, error: { code: "FILE_TOO_LARGE" } }]);
  });

  it("runs read-only defaults in previews and skips write, edit and bash", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "existing"), "original");
    const preview = await batch([
      { id: "read", tool: "read", input: { path: "existing" } },
    ]).runOrThrow({}, { dryRun: true }, { cwd });
    expect(preview).toMatchObject([{ ok: true, value: { content: "original" } }]);
    const calls: AgentCall[] = [
      { id: "write", tool: "write", input: { path: "created", content: "new" } },
      {
        id: "edit",
        tool: "edit",
        input: { path: "existing", oldText: "original", newText: "changed" },
      },
      { id: "bash", tool: "bash", input: { command: "touch created" } },
    ];
    for (const call of calls)
      expect((await batch([call]).run({}, { dryRun: true }, { cwd })).status).toBe("failed");
    expect(await readFile(join(cwd, "existing"), "utf8")).toBe("original");
    await expect(readFile(join(cwd, "created"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("gives subagents their own defaults, shares call limits, and isolates concurrent root cwd values", async () => {
    const [first, second] = await Promise.all([workspace(), workspace()]);
    await Promise.all([
      writeFile(join(first, "text"), "first"),
      writeFile(join(second, "text"), "second"),
    ]);
    const child = batch([{ id: "read", tool: "read", input: { path: "text" } }]);
    const parent = (maxCalls: number) =>
      defineAgentLoop({
        id: "parent-tools",
        inputSchema: emptyInput,
        resultSchema: outcomesSchema,
        tools: { child: pipelineTool(child, { description: "Read with a child" }) },
        limits: { maxCalls, maxConcurrency: 1 },
        initialState: (): readonly AgentOutcome[] => [],
        decide: (state, context) =>
          context.turn === 1
            ? { kind: "continue", calls: [{ id: "child", tool: "child", input: {} }] }
            : { kind: "finish", result: state },
        reduce: (_state, outcomes) => {
          const outcome = outcomes[0];
          return outcome?.ok && outcome.tool === "child" ? outcome.value : [];
        },
      });
    const agent = parent(2);
    const results = await Promise.all([
      agent.runOrThrow({}, undefined, { cwd: first }),
      agent.runOrThrow({}, undefined, { cwd: second }),
    ]);
    expect(results).toMatchObject([
      [{ value: { content: "first" } }],
      [{ value: { content: "second" } }],
    ]);
    const exhausted = await parent(1).run({}, undefined, { cwd: first });
    expect(exhausted.status).toBe("failed");
    expect(JSON.stringify(exhausted.errors)).toContain("maxCalls");
  });
});
