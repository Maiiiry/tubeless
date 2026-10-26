import { vi } from "vitest";
import { defineAgentLoop, type AgentCall } from "./agent.js";
import type { AgentEnvironment } from "./environment.js";
import { emptyInput, textSchema } from "./agent.test-support.js";

export function remote(): AgentEnvironment {
  return {
    id: "container:one",
    resolveCwd: vi.fn(() => "/remote/project"),
    projectInstructions: vi.fn(() => [
      { path: "/remote/project/AGENTS.md", content: "REMOTE GUIDANCE" },
    ]),
    read: vi.fn(() => ({
      path: "/remote/project/a",
      content: "before",
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      truncated: false,
    })),
    write: vi.fn(() => ({ path: "/remote/project/a", bytes: 5 })),
    edit: vi.fn(() => ({ path: "/remote/project/a", bytes: 5 })),
    bash: vi.fn(() => ({
      cwd: "/remote/project",
      stdout: "verified",
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      truncated: false,
    })),
    list: vi.fn(() => ({
      path: "/remote/project",
      entries: [{ name: "a", kind: "file" as const }],
      truncated: false,
    })),
    search: vi.fn(() => ({
      matches: [{ path: "/remote/project/a", line: 1, text: "before" }],
      truncated: false,
      skippedFiles: 0,
    })),
  };
}

export function workspaceAgent(environment: AgentEnvironment, calls: readonly AgentCall[]) {
  const decide = vi.fn((state: string, context: { turn: number }) =>
    context.turn === 1 ? { kind: "continue", calls } : { kind: "finish", result: state }
  );
  const reduce = vi.fn((_state: string, outcomes: unknown) => JSON.stringify(outcomes));
  const agent = defineAgentLoop({
    id: "workspace-byte-boundary",
    environment,
    inputSchema: emptyInput,
    resultSchema: textSchema,
    initialState: () => "",
    decide,
    dryRun: decide,
    reduce,
  });
  return { agent, decide, reduce };
}
