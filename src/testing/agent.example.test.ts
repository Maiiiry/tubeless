import { DelegatingAgent } from "../../examples/agent-delegation.js";
import { AgentPipeline } from "../../examples/agent-pipeline.js";
import { describe, expect, expectTypeOf, it } from "vitest";
import { ScriptedAgent, runAgentExample } from "../../examples/agent.js";
import { WorkspaceAgent } from "../../examples/agent-workspace.js";
import { EnvironmentWorkspaceAgent } from "../../examples/agent-environment.js";
import { CodemodeAgent } from "../../examples/agent-codemode.js";
import { ExtractTriagePipeline } from "../../examples/agent-extract.js";
import { createDurableWorkspaceAgent } from "../../examples/agent-durable.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("public agent recipe", () => {
  it("lists a real workspace through the public Node environment adapter", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tubeless-environment-recipe-"));
    try {
      await writeFile(join(cwd, "fixture.txt"), "workspace fixture");
      const { answer } = await EnvironmentWorkspaceAgent.runOrThrow(
        { task: "List workspace" },
        undefined,
        { cwd }
      );
      expect(JSON.parse(answer).entries).toEqual([{ name: "fixture.txt", kind: "file" }]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it("surveys a real workspace with one codemode script, including previews", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tubeless-codemode-recipe-"));
    try {
      await writeFile(join(cwd, "one.txt"), "a\nb");
      await writeFile(join(cwd, "two.txt"), "c");
      const expected = {
        result: [
          { name: "one.txt", lines: 2 },
          { name: "two.txt", lines: 1 },
        ],
        logs: [],
        logsTruncated: false,
      };
      expect(await CodemodeAgent.runOrThrow({}, undefined, { cwd })).toEqual(expected);
      expect(await CodemodeAgent.runOrThrow({}, { dryRun: true }, { cwd })).toEqual(expected);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it("feeds an extract step's typed output to a typed agent and reports its typed result", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tubeless-extract-recipe-"));
    try {
      await writeFile(join(cwd, "a.txt"), "hi\n");
      await writeFile(join(cwd, "b.txt"), "");
      await writeFile(join(cwd, "c.txt"), "x".repeat(100));
      await writeFile(join(cwd, "skip.md"), "not extracted");
      expect(await ExtractTriagePipeline.runOrThrow({}, undefined, { cwd })).toBe(
        "a.txt: short\nb.txt: empty\nc.txt: long"
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it("reopens the public SQLite recipe and returns a committed answer without repeating a write", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tubeless-durable-recipe-"));
    try {
      const checkpoint = join(cwd, "state.db");
      expect(
        await createDurableWorkspaceAgent(checkpoint).runOrThrow(
          { task: "hello durable" },
          undefined,
          { cwd }
        )
      ).toEqual({ answer: "Verified .tubeless/durable-message.txt" });
      const target = join(cwd, ".tubeless/durable-message.txt");
      await rm(target);
      expect(
        await createDurableWorkspaceAgent(checkpoint).runOrThrow(
          { task: "hello durable" },
          undefined,
          { cwd }
        )
      ).toEqual({ answer: "Verified .tubeless/durable-message.txt" });
      await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it("passes a child agent's validated answer to an ordinary dependent step, including previews", async () => {
    expectTypeOf(AgentPipeline.runOrThrow).returns.resolves.toEqualTypeOf<string>();
    for (const dryRun of [false, true]) {
      expect(await AgentPipeline.runOrThrow({ question: "red missing" }, { dryRun })).toBe(
        "Summary: 3 characters; RED | 7 characters; Observed NOT_FOUND: Word unavailable"
      );
    }
  });
  it("uses every default tool and a custom tool to modify and verify a real workspace", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tubeless-workspace-recipe-"));
    try {
      expect(await WorkspaceAgent.runOrThrow({ directory: "demo" }, undefined, { cwd })).toEqual({
        answer: "Verified: all six default tools and a custom tool",
      });
      expect(await readFile(join(cwd, "demo/message.txt"), "utf8")).toBe("hello agent\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it("delegates to child agents and a mapped ordinary pipeline, including previews", async () => {
    expectTypeOf(DelegatingAgent.runOrThrow).returns.resolves.toEqualTypeOf<{ answer: string }>();
    for (const dryRun of [false, true]) {
      expect(await DelegatingAgent.runOrThrow({ question: "red blue" }, { dryRun })).toEqual({
        answer: "Summary: 3 characters; RED | 4 characters; BLUE",
      });
      expect(await DelegatingAgent.runOrThrow({ question: "missing" }, { dryRun })).toEqual({
        answer: "Summary: 7 characters; Observed NOT_FOUND: Word unavailable",
      });
    }
  });
  it("executes dynamic heterogeneous calls through public package imports", async () => {
    expectTypeOf(ScriptedAgent.runOrThrow).returns.resolves.toEqualTypeOf<{ answer: string }>();
    expect(await runAgentExample()).toEqual({ answer: "14 characters; HELLO; TUBELESS" });
    expect(await ScriptedAgent.runOrThrow({ question: "missing word" })).toEqual({
      answer: "12 characters; Observed NOT_FOUND: Word unavailable; WORD",
    });
    expect(await ScriptedAgent.runOrThrow({ question: "preview" }, { dryRun: true })).toEqual({
      answer: "7 characters; PREVIEW",
    });
  });
});
