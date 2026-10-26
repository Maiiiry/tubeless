import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { defineAgent, defineTool, pipelineTool, type AgentModelRequest } from "./agent.js";
import { toolObject } from "./default-tool-schema.js";

it.each([true, false])(
  "uses the physical cwd across model and tool calls (project context: %s)",
  async (projectContext) => {
    const root = await mkdtemp(join(tmpdir(), "tubeless-model-cwd-"));
    try {
      const actual = join(root, "actual");
      const decoy = join(root, "decoy");
      const cwd = join(decoy, "linked");
      await mkdir(join(actual, "workspace"), { recursive: true });
      await mkdir(decoy);
      await mkdir(join(actual, ".git"));
      await writeFile(join(actual, "AGENTS.md"), "PHYSICAL PROJECT GUIDANCE");
      await writeFile(join(actual, "target"), "original");
      await writeFile(join(decoy, "target"), "decoy");
      await symlink(join(actual, "workspace"), cwd, "dir");
      const physicalCwd = await realpath(cwd);
      const target = join(dirname(physicalCwd), "target");
      const requests: AgentModelRequest[] = [];
      const empty = toolObject({});
      const child = defineAgent({
        id: "cwd-child",
        projectContext,
        model: (_request, context) => ({
          decision: { kind: "finish", result: { answer: context.cwd } },
          conversation: null,
        }),
      });
      const decisions = [
        {
          kind: "continue",
          calls: [
            { id: "read", tool: "read", input: { path: "../target" } },
            { id: "list", tool: "list", input: { path: ".." } },
            { id: "search", tool: "search", input: { path: "..", query: "original" } },
            { id: "bash", tool: "bash", input: { command: "cat ../target" } },
            { id: "custom", tool: "custom", input: {} },
            { id: "child", tool: "child", input: { task: "Report cwd" } },
          ],
        },
        {
          kind: "continue",
          calls: [{ id: "write", tool: "write", input: { path: "../target", content: "written" } }],
        },
        {
          kind: "continue",
          calls: [
            {
              id: "edit",
              tool: "edit",
              input: { path: "../target", oldText: "written", newText: "edited" },
            },
          ],
        },
        { kind: "finish", result: { answer: "Done" } },
      ];
      const agent = defineAgent({
        id: "physical-workspace",
        projectContext,
        tools: {
          custom: defineTool({
            description: "Check tool cwd",
            inputSchema: empty,
            outputSchema: empty,
            run: (_input, context) => {
              expect(context.cwd).toBe(physicalCwd);
              return {};
            },
          }),
          child: pipelineTool(child, { description: "Check child cwd" }),
        },
        model: (request, context) => {
          expect(context.cwd).toBe(physicalCwd);
          expect(request.instructions).toContain(`Working directory: ${physicalCwd}`);
          expect(request.instructions.includes("PHYSICAL PROJECT GUIDANCE")).toBe(projectContext);
          requests.push(request);
          return { decision: decisions[context.turn - 1], conversation: null };
        },
      });
      expect(
        await agent.runOrThrow({ task: "Update physical sibling" }, undefined, { cwd })
      ).toEqual({ answer: "Done" });
      expect(requests[1]!.outcomes).toMatchObject([
        { id: "read", ok: true, value: { path: target, content: "original" } },
        {
          id: "list",
          ok: true,
          value: {
            path: dirname(physicalCwd),
            entries: expect.arrayContaining([{ name: "workspace", kind: "directory" }]),
          },
        },
        { id: "search", ok: true, value: { matches: [{ path: target, text: "original" }] } },
        { id: "bash", ok: true, value: { cwd: physicalCwd, stdout: "original", exitCode: 0 } },
        { id: "custom", ok: true },
        { id: "child", ok: true, value: { answer: physicalCwd } },
      ]);
      expect(requests[2]!.outcomes).toMatchObject([
        { id: "write", ok: true, value: { path: target } },
      ]);
      expect(requests[3]!.outcomes).toMatchObject([
        { id: "edit", ok: true, value: { path: target } },
      ]);
      expect(await readFile(target, "utf8")).toBe("edited");
      expect(await readFile(join(decoy, "target"), "utf8")).toBe("decoy");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
