import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { remote } from "./environment.test-support.js";
import { modelInstructions } from "./model-prompt.js";

const directories: string[] = [];
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "tubeless-prompt-"));
  directories.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

it("loads root-to-cwd guidance, stops at worktree git files and excludes unrelated directories", async () => {
  const outside = await workspace();
  const root = join(outside, "repo");
  const cwd = join(root, "nested");
  await mkdir(join(cwd, "deeper"), { recursive: true });
  await writeFile(join(outside, "AGENTS.md"), "OUTSIDE");
  await writeFile(join(root, ".git"), "gitdir: elsewhere");
  await writeFile(join(root, "AGENTS.md"), "ROOT RULE");
  await writeFile(join(cwd, "AGENTS.md"), "NESTED RULE");
  await writeFile(join(cwd, "deeper", "AGENTS.md"), "DEEPER RULE");
  const prompt = await modelInstructions(cwd, "APP RULE", true);
  expect(prompt).toContain(cwd);
  expect(prompt.indexOf("ROOT RULE")).toBeLessThan(prompt.indexOf("NESTED RULE"));
  expect(prompt.indexOf("NESTED RULE")).toBeLessThan(prompt.indexOf("APP RULE"));
  expect(prompt).not.toContain("OUTSIDE");
  expect(prompt).not.toContain("DEEPER RULE");
  expect(await modelInstructions(cwd, undefined, false)).not.toContain("NESTED RULE");
});

it.each([true, false])(
  "follows the physical workspace when cwd is a symlink (repo: %s)",
  async (repository) => {
    const outside = await workspace();
    const decoy = join(outside, "decoy");
    const root = join(outside, "actual");
    const target = join(root, "nested");
    const cwd = join(decoy, "linked");
    await mkdir(join(decoy, ".git"), { recursive: true });
    await mkdir(target, { recursive: true });
    if (repository) await mkdir(join(root, ".git"));
    await writeFile(join(decoy, "AGENTS.md"), "DECOY PROJECT");
    await writeFile(join(root, "AGENTS.md"), "ACTUAL ROOT");
    await writeFile(join(target, "AGENTS.md"), "ACTUAL WORKSPACE");
    await symlink(target, cwd, "dir");
    const prompt = await modelInstructions(cwd, undefined, true);
    expect(prompt).toContain(`Working directory: ${await realpath(target)}`);
    expect(prompt).toContain("ACTUAL WORKSPACE");
    expect(prompt.includes("ACTUAL ROOT")).toBe(repository);
    expect(prompt).not.toContain("DECOY PROJECT");
  }
);

it("uses cwd only outside a repository and allows missing instructions", async () => {
  const parent = await workspace();
  const cwd = join(parent, "workspace");
  await mkdir(cwd);
  await writeFile(join(parent, "AGENTS.md"), "OUTSIDE RULE");
  expect(await modelInstructions(cwd, undefined, true)).not.toContain("OUTSIDE RULE");
  await writeFile(join(cwd, "AGENTS.md"), "LOCAL RULE");
  expect(await modelInstructions(cwd, undefined, true)).toContain("LOCAL RULE");
});

it("fails on unreadable or oversized instructions rather than silently omitting them", async () => {
  const cwd = await workspace();
  await writeFile(join(cwd, "AGENTS.md"), "x".repeat(16385));
  await expect(modelInstructions(cwd, undefined, true)).rejects.toThrow("exceed read limits");
  await rm(join(cwd, "AGENTS.md"));
  await mkdir(join(cwd, "AGENTS.md"));
  await expect(modelInstructions(cwd, undefined, true)).rejects.toThrow();
  await expect(modelInstructions(cwd, "x".repeat(32768), false)).rejects.toThrow(
    "instructions exceed"
  );
});

it("honors cancellation before context discovery", async () => {
  const controller = new AbortController();
  const reason = new Error("cancel context");
  controller.abort(reason);
  await expect(modelInstructions("/missing", undefined, true, controller.signal)).rejects.toBe(
    reason
  );
});

it.each(["x".repeat(4097), " ".repeat(4096)])(
  "rejects oversized or blank guidance paths before reading their content",
  async (path) => {
    const environment = remote();
    const content = vi.fn(() => "GUIDANCE");
    environment.projectInstructions = () => [
      {
        path,
        get content() {
          return content();
        },
      },
    ];
    await expect(
      modelInstructions("/remote/project", undefined, true, undefined, environment)
    ).rejects.toThrow("Project instruction path");
    expect(content).not.toHaveBeenCalled();
  }
);

it.each(["", "指导".repeat(100)])(
  "stops reading guidance as soon as the aggregate prompt exceeds its byte budget",
  async (text) => {
    const environment = remote();
    const content = vi.fn(() => text);
    const file = {
      path: "/remote/项目/AGENTS.md",
      get content() {
        return content();
      },
    };
    const unread = vi.fn(() => "/must-not-be-read");
    environment.projectInstructions = () => [
      ...Array.from({ length: 2000 }, () => file),
      {
        get path() {
          return unread();
        },
        content: "AFTER THE LIMIT",
      },
    ];
    await expect(
      modelInstructions("/remote/project", undefined, true, undefined, environment)
    ).rejects.toThrow("Agent instructions exceed 32768 UTF-8 bytes");
    expect(content.mock.calls.length).toBeLessThan(2000);
    expect(unread).not.toHaveBeenCalled();
  }
);

it.each(["guidance", "application", "workspace"])(
  "rejects oversized %s strings before encoding or assembling them",
  async (kind) => {
    const environment = remote();
    const oversized = "x".repeat(1_000_000);
    environment.projectInstructions = () =>
      kind === "guidance" ? [{ path: "/remote/AGENTS.md", content: oversized }] : [];
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      await expect(
        modelInstructions(
          kind === "workspace" ? oversized : "/remote/project",
          kind === "application" ? oversized : undefined,
          true,
          undefined,
          environment
        )
      ).rejects.toThrow("exceed");
      expect(encode.mock.calls.every(([text]) => (text?.length ?? 0) <= 32_768)).toBe(true);
    } finally {
      encode.mockRestore();
    }
  }
);

it("preserves a complete multibyte guidance prompt at exactly 32 KiB", async () => {
  const environment = remote();
  environment.projectInstructions = () => [];
  const base = await modelInstructions("/remote/project", undefined, true, undefined, environment);
  const first = { path: "/remote/根/AGENTS.md", content: "界".repeat(5461) + "x" };
  const secondPath = "/remote/根/子/AGENTS.md";
  const prefix = `${base}\n\nProject instructions from ${first.path}:\n${first.content}\n\nProject instructions from ${secondPath}:\n`;
  const remaining = 32_768 - new TextEncoder().encode(prefix).length;
  const content = "界".repeat(Math.floor(remaining / 3)) + "x".repeat(remaining % 3);
  environment.projectInstructions = () => [first, { path: secondPath, content }];
  const prompt = await modelInstructions(
    "/remote/project",
    undefined,
    true,
    undefined,
    environment
  );
  expect(prompt).toBe(prefix + content);
  expect(new TextEncoder().encode(prompt).length).toBe(32_768);
  environment.projectInstructions = () => [first, { path: secondPath, content: content + "x" }];
  await expect(
    modelInstructions("/remote/project", undefined, true, undefined, environment)
  ).rejects.toThrow("Agent instructions exceed 32768 UTF-8 bytes");
});

it("counts application headers and separators within the UTF-8 prompt budget", async () => {
  const environment = remote();
  const base = await modelInstructions("/remote/project", undefined, true, undefined, environment);
  const prefix = `${base}\n\nApplication instructions:\n`;
  const remaining = 32_768 - new TextEncoder().encode(prefix).length;
  const instructions = "界".repeat(Math.floor(remaining / 3)) + "x".repeat(remaining % 3);
  const prompt = await modelInstructions(
    "/remote/project",
    instructions,
    true,
    undefined,
    environment
  );
  expect(prompt).toBe(prefix + instructions);
  expect(new TextEncoder().encode(prompt).length).toBe(32_768);
  await expect(
    modelInstructions("/remote/project", instructions + "x", true, undefined, environment)
  ).rejects.toThrow("Agent instructions exceed 32768 UTF-8 bytes");
});

it("selects the workspace prompt with project context and a task-neutral prompt without", async () => {
  const environment = remote();
  const workspace = await modelInstructions(
    "/remote/project",
    undefined,
    true,
    undefined,
    environment
  );
  expect(workspace).toContain("coding, writing, and computer use agent");
  expect(workspace).toContain("REMOTE GUIDANCE");
  const task = await modelInstructions(
    "/remote/project",
    "Classify files.",
    false,
    undefined,
    environment
  );
  expect(task).toContain("autonomous agent completing one task");
  expect(task).not.toContain("AGENTS.md");
  expect(task).not.toContain("REMOTE GUIDANCE");
  expect(task).toContain("Working directory: /remote/project");
  expect(task.endsWith("Application instructions:\nClassify files.")).toBe(true);
  const codemode = await modelInstructions(
    "/remote/project",
    undefined,
    false,
    undefined,
    environment,
    true
  );
  expect(codemode).toContain("Code mode: your only tool is codemode.");
  expect(codemode).not.toContain("AGENTS.md");
  expect(
    await modelInstructions("/remote/project", undefined, true, undefined, environment, true)
  ).toContain("read applicable AGENTS.md files in a script");
});
