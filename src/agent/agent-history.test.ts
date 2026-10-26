import { createDefinitionIdentity } from "../core/pipeline-definition-identity.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPipelineTestRuntime } from "../testing/testing.js";
import { decodeStoredTraceEvent } from "../run-store/run-store-event-decoder.js";
import { openSqlitePipelineRunStore } from "../run-store/run-store-sqlite.js";
import { projectPipelineRunStore, type StoredPipelineEvent } from "../run-store/run-store.js";
import { defineAgentLoop, defineTool, ToolError, type AgentLimits } from "./agent.js";
import { emptyInput, numberSchema, schema } from "./agent.test-support.js";

function agent(
  limits?: AgentLimits,
  implementationVersion?: string,
  inputDescriptor: Record<string, unknown> = { type: "number" }
) {
  const tools = {
    double: defineTool({
      description: "Double a number or report a missing value",
      inputSchema: numberSchema,
      inputJsonSchema: inputDescriptor,
      outputSchema: numberSchema,
      run: (value) => {
        if (value === 0) throw new ToolError("MISSING", "No value");
        return value * 2;
      },
    }),
  };
  return defineAgentLoop({
    id: "recorded-agent",
    inputSchema: emptyInput,
    resultSchema: numberSchema,
    tools,
    limits,
    implementationVersion,
    initialState: () => ({ secret: "state-not-recorded", value: 0 }),
    decide: (state, context) =>
      context.turn === 1
        ? { kind: "continue", calls: [{ id: "same", tool: "double", input: 0 }] }
        : context.turn === 2
          ? { kind: "continue", calls: [{ id: "same", tool: "double", input: 5 }] }
          : { kind: "finish", result: state.value },
    reduce: (state, outcomes) => ({
      ...state,
      value: outcomes[0]?.ok && outcomes[0].tool === "double" ? outcomes[0].value : state.value,
    }),
  });
}

describe("agent definition and recorded execution", () => {
  it("round-trips ordinary turn/tool lifecycles, call correlations, and recoverable failures through SQLite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tubeless-agent-"));
    try {
      const filename = join(directory, "agent.sqlite");
      const store = await openSqlitePipelineRunStore(filename);
      const events: StoredPipelineEvent[] = [];
      const pipeline = agent();
      const runtime = createPipelineTestRuntime();
      const run = await pipeline.run(
        {},
        {},
        {
          ...runtime.context,
          tracing: {
            exporter: {
              export(event) {
                const decoded = decodeStoredTraceEvent(JSON.parse(JSON.stringify(event)));
                events.push({ ...decoded, id: events.length + 1 });
                store.export(decoded);
              },
            },
          },
        }
      );
      await store.close();
      expect(run.status).toBe("completed");
      expect(run.value).toBe(10);
      expect(runtime.logs.filter(({ level }) => level === "warn")).toEqual([]);
      expect(JSON.stringify(events)).not.toContain("state-not-recorded");
      const reader = await openSqlitePipelineRunStore(filename, { readOnly: true });
      let saved: readonly StoredPipelineEvent[];
      try {
        saved = await reader.listEvents();
      } finally {
        await reader.close();
      }
      expect(saved).toEqual(events);
      const projected = projectPipelineRunStore(saved);
      const root = projected.runs.find(({ runId }) => runId === run.runId)!;
      const turns = projected.runs.filter(({ parentRunId }) => parentRunId === run.runId);
      expect(root.status).toBe("completed");
      expect(turns).toHaveLength(3);
      expect(turns.map(({ iteration }) => iteration!.index).sort()).toEqual([1, 2, 3]);
      const calls = projected.runs.filter(
        ({ pipelineId }) => pipelineId === "recorded-agent/tool/double"
      );
      expect(calls).toHaveLength(2);
      expect(calls.map(({ status }) => status).sort()).toEqual(["completed", "failed"]);
      expect(new Set(calls.map(({ parentRunId }) => parentRunId)).size).toBe(2);
      for (const call of calls) {
        expect(call.iteration).toBeUndefined();
        const start = saved.find(
          (event) => event.runId === call.runId && event.name === "pipeline.started"
        )!;
        expect(start.itemKey).toBe("same");
        const attempt = saved.find(
          (event) => event.runId === call.runId && event.name === "step.attempted"
        )!;
        if (attempt.name !== "step.attempted") throw new Error("Missing call correlation");
        const turn = turns.find(({ runId }) => runId === call.parentRunId)!;
        expect(attempt.payload.attributes).toMatchObject({
          "agent.runId": run.runId,
          "agent.turn": turn.iteration!.index,
          "agent.callId": "same",
          "agent.tool": "double",
          "agent.parentAttemptId": turn.steps.find(({ id }) => id === "calls")!.attempt!.attemptId,
        });
      }
      expect(
        projected.definitions.find(({ pipelineId }) => pipelineId === pipeline.id)?.snapshot
      ).toEqual(pipeline.definition);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fingerprints declared capabilities and limits independently of execution and property order", async () => {
    const pipeline = agent();
    expect(pipeline.definition.identity.version).toBe(2);
    expect(pipeline.plan().steps[0]!.agent).toEqual(pipeline.definition.steps[0]!.agent);
    expect(Object.isFrozen(pipeline.plan().steps[0]!.agent!.capabilities)).toBe(true);
    for (const other of [
      agent({ maxCalls: 2 }),
      agent({ maxDepth: 2 }),
      agent({ maxDecisions: 5 }),
      agent({ maxConcurrency: 2 }),
      agent({ maxTurns: 7 }),
      agent(undefined, undefined, { type: "integer" }),
    ]) {
      expect(other.definition.identity.structuralFingerprint).not.toBe(
        pipeline.definition.identity.structuralFingerprint
      );
    }
    const version = agent(undefined, "new-build");
    expect(version.definition.identity.structuralFingerprint).toBe(
      pipeline.definition.identity.structuralFingerprint
    );
    expect(version.definition.identity.definitionId).not.toBe(
      pipeline.definition.identity.definitionId
    );
    expect(agent(undefined, undefined, { title: "Count", type: "number" }).definition).toEqual(
      agent(undefined, undefined, { type: "number", title: "Count" }).definition
    );
    const recorded: unknown[] = [];
    await pipeline.run(
      {},
      {},
      {
        ...createPipelineTestRuntime().context,
        tracing: {
          exporter: {
            export: (event) => {
              recorded.push(event);
            },
          },
        },
      }
    );
    for (const event of recorded) {
      const reordered = JSON.parse(JSON.stringify(event), (_key, value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).reverse())
          : value
      );
      expect(() => decodeStoredTraceEvent(reordered)).not.toThrow();
    }
    expect(pipeline.definition).toEqual(agent().definition);
  });

  it("keeps changing batches out of definition identity and detects forged agent metadata", () => {
    const definition = agent().definition;
    const event = {
      version: 3,
      name: "pipeline.started",
      pipelineId: "recorded-agent",
      runId: "root",
      timestampMs: 0,
      payload: {
        dryRun: false,
        planOk: true,
        stepCount: 1,
        targetIds: ["agent"],
        definitionIdentity: definition.identity,
        definitionSnapshot: JSON.parse(JSON.stringify(definition)),
      },
    };
    event.payload.definitionSnapshot.steps[0].agent.limits.maxCalls++;
    expect(() => decodeStoredTraceEvent(event)).toThrow("structural fingerprint");
  });

  it("reads legacy agent definitions without a depth field", () => {
    const current = agent().definition;
    const snapshot = {
      ...current,
      steps: current.steps.map((step) => {
        if (!step.agent) return step;
        const { maxDepth, ...limits } = step.agent.limits;
        expect(maxDepth).toBe(4);
        return { ...step, agent: { ...step.agent, limits } };
      }),
    };
    const identity = createDefinitionIdentity(snapshot, undefined);
    const event = {
      version: 3,
      name: "pipeline.started",
      pipelineId: "recorded-agent",
      runId: "legacy",
      timestampMs: 0,
      payload: {
        dryRun: false,
        planOk: true,
        stepCount: 1,
        targetIds: ["agent"],
        definitionIdentity: identity,
        definitionSnapshot: { ...snapshot, identity },
      },
    };
    expect(() => decodeStoredTraceEvent(event)).not.toThrow();
  });

  it("reads input descriptors once and keeps the model inventory immutable and handler-free", async () => {
    let conversions = 0;
    const descriptor = { type: "number" };
    const input = schema<number>((value) => ({ value: Number(value) }));
    const withConversion = {
      "~standard": {
        ...input["~standard"],
        jsonSchema: {
          input: () => {
            conversions++;
            return descriptor;
          },
        },
      },
    };
    const tool = defineTool({
      description: "Number",
      inputSchema: withConversion,
      outputSchema: numberSchema,
      run: (value) => value,
    });
    descriptor.type = "string";
    const pipeline = defineAgentLoop({
      id: "descriptors",
      inputSchema: emptyInput,
      resultSchema: numberSchema,
      tools: { number: tool },
      initialState: () => 0,
      decide: (_state, context) => {
        expect(context.capabilities.map(({ name }) => name)).toEqual([
          "bash",
          "edit",
          "list",
          "number",
          "read",
          "search",
          "write",
        ]);
        expect(context.capabilities.filter(({ name }) => name === "number")).toEqual([
          { name: "number", description: "Number", inputJsonSchema: { type: "number" } },
        ]);
        expect(Object.isFrozen(context.capabilities[0]!.inputJsonSchema)).toBe(true);
        return { kind: "finish", result: 1 };
      },
    });
    pipeline.plan();
    await createPipelineTestRuntime().runOrThrow(pipeline, {});
    expect(conversions).toBe(1);
  });
});
