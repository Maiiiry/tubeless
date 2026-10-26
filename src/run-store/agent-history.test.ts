import { describe, expect, it } from "vitest";
import { defineAgentLoop, defineTool, pipelineTool, ToolError } from "../agent/agent.js";
import { emptyInput, numberSchema } from "../agent/agent.test-support.js";
import { createSteps, definePipeline, type Pipeline } from "../core/pipeline.js";
import { createPipelineTestRuntime } from "../testing/testing.js";
import { decodeStoredTraceEvent } from "./run-store-event-decoder.js";
import {
  createPipelineRunProjector,
  projectPipelineRunStore,
  type StoredPipelineEvent,
} from "./run-store.js";
import { projectAgentHistory } from "./agent-history.js";
import { createRunHistoryIndex, summarizeRun } from "./run-history.js";

function fixture() {
  const child = defineAgentLoop({
    id: "history-child",
    inputSchema: emptyInput,
    resultSchema: numberSchema,
    initialState: () => 0,
    decide: () => ({ kind: "finish", result: 42 }),
  });
  const nested = createSteps(emptyInput).fromPipeline("nested", { pipeline: child });
  const wrapper = definePipeline({ id: "history-wrapper", steps: [nested], finalize: nested });
  return defineAgentLoop({
    id: "history-agent",
    inputSchema: emptyInput,
    resultSchema: numberSchema,
    limits: { maxConcurrency: 3 },
    initialState: () => ({ secret: "PRIVATE STATE", count: 0 }),
    tools: {
      double: defineTool({
        description: "Double a value",
        inputSchema: numberSchema,
        outputSchema: numberSchema,
        run(value) {
          if (value === 0) throw new ToolError("MISSING", "Missing number");
          return value * 2;
        },
      }),
      left: pipelineTool(child, { description: "First alias" }),
      right: pipelineTool(child, { description: "Second alias" }),
      wrapped: pipelineTool(wrapper, { description: "Nested agent through a pipeline" }),
    },
    decide: (state, context) =>
      context.turn === 1
        ? {
            kind: "continue",
            calls: [
              { id: "same", tool: "double", input: 0 },
              { id: "left", tool: "left", input: {} },
              { id: "right", tool: "right", input: {} },
              { id: "wrapped", tool: "wrapped", input: {} },
            ],
          }
        : context.turn === 2
          ? { kind: "continue", calls: [{ id: "same", tool: "double", input: 3 }] }
          : { kind: "finish", result: state.count },
    reduce: (state) => ({ ...state, count: state.count + 1 }),
  });
}

async function record(pipeline: Pipeline<object, unknown>, dryRun = false, signal?: AbortSignal) {
  const events: StoredPipelineEvent[] = [];
  const run = await pipeline.run(
    {},
    { dryRun },
    {
      ...createPipelineTestRuntime().context,
      signal,
      tracing: {
        exporter: {
          export(event) {
            events.push({
              ...decodeStoredTraceEvent(JSON.parse(JSON.stringify(event))),
              id: events.length,
            });
          },
        },
      },
    }
  );
  return { events, run };
}

describe("agent history projection", () => {
  it("keeps every observed call when live progress rows are truncated", async () => {
    const agent = defineAgentLoop({
      id: "wide-history",
      inputSchema: emptyInput,
      resultSchema: numberSchema,
      initialState: () => 0,
      limits: { maxCalls: 80, maxConcurrency: 4 },
      tools: {
        value: defineTool({
          description: "Return a value",
          inputSchema: numberSchema,
          outputSchema: numberSchema,
          run: (value) => value,
        }),
      },
      decide: (_state, context) =>
        context.turn === 1
          ? {
              kind: "continue",
              calls: Array.from({ length: 70 }, (_, index) => ({
                id: `call-${index}`,
                tool: "value" as const,
                input: index,
              })),
            }
          : { kind: "finish", result: 70 },
    });
    const { events } = await record(agent);
    const { runs } = projectPipelineRunStore(events);
    let callIdReads = 0;
    for (const run of runs) {
      for (const call of run.agentTurn?.calls ?? []) {
        const callId = call.callId;
        Object.defineProperty(call, "callId", {
          get() {
            callIdReads++;
            return callId;
          },
        });
      }
    }
    const root = projectAgentHistory(runs).agents[0]!;
    // Bound work by calls, rather than wall-clock time or the chosen collection type.
    expect(callIdReads).toBeLessThanOrEqual(70 * 10);
    expect(root.turns[0]!.calls).toHaveLength(70);
    expect(new Set(root.turns[0]!.calls.map((call) => call.callId)).size).toBe(70);
    // Batch, call, decision and state reports all describe initial attempts.
    for (const run of runs) {
      for (const step of run.steps) {
        if (step.attempt) expect(step.attempt.retries).toEqual([]);
      }
    }
    expect(
      events.some(
        (event) =>
          event.name === "step.running" &&
          event.stepId === "calls" &&
          event.payload.progress?.completed === 70 &&
          (event.payload.progress.details?.length ?? 0) < 70
      )
    ).toBe(true);
  });

  it("retains repeated call IDs, aliases, recovery and agents nested through ordinary pipelines", async () => {
    const { events, run } = await record(fixture());
    expect(run.status).toBe("completed");
    const { agents } = projectAgentHistory(projectPipelineRunStore(events).runs);
    const root = agents.find((agent) => agent.runId === run.runId)!;
    expect(root).toMatchObject({ status: "completed", termination: "finish" });
    expect(root.definition?.capabilities).toContain("double");
    expect(
      root.turns.map((turn) => [
        turn.index,
        turn.decision,
        turn.stateVersion,
        turn.nextStateVersion,
        turn.callCount,
        turn.callsAdmitted,
      ])
    ).toEqual([
      [1, "continue", 0, 1, 4, 4],
      [2, "continue", 1, 2, 1, 5],
      [3, "finish", 2, undefined, 0, 5],
    ]);
    const first = root.turns[0]!;
    expect(first.calls.map((call) => [call.callId, call.tool, call.status])).toEqual([
      ["same", "double", "failed"],
      ["left", "left", "completed"],
      ["right", "right", "completed"],
      ["wrapped", "wrapped", "completed"],
    ]);
    expect(first.calls[0]!.error?.sourceCode).toBe("MISSING");
    const repeated = root.turns[1]!.calls[0]!;
    expect(repeated).toMatchObject({ callId: "same", tool: "double", status: "completed" });
    expect(repeated.runId).not.toBe(first.calls[0]!.runId);
    expect(agents).toHaveLength(4);
    for (const call of first.calls.slice(1)) {
      expect(call.childAgentRunIds).toHaveLength(1);
      const child = agents.find((agent) => agent.runId === call.childAgentRunIds[0])!;
      expect(child).toMatchObject({
        pipelineId: "history-child",
        termination: "finish",
        parentCall: {
          agentRunId: root.runId,
          turnRunId: first.runId,
          callId: call.callId,
          runId: call.runId,
        },
      });
    }
    expect(JSON.stringify(agents)).not.toContain("PRIVATE STATE");
  });

  it("folds short incremental pages without erasing earlier calls or changing earlier snapshots", async () => {
    const { events } = await record(fixture());
    const projector = createPipelineRunProjector();
    let early: ReturnType<typeof projector.snapshot> | undefined;
    let saved: string | undefined;
    for (const event of events) {
      projector.append([event]);
      const snapshot = projector.snapshot();
      if (!early && snapshot.runs.some((run) => run.agentTurn?.calls.length)) {
        early = snapshot;
        saved = JSON.stringify(snapshot);
      }
    }
    const actual = projectAgentHistory(projector.snapshot().runs);
    expect(actual).toEqual(projectAgentHistory(projectPipelineRunStore(events).runs));
    expect(JSON.stringify(early)).toBe(saved);
    projector.clear();
    expect(projectAgentHistory(projector.snapshot().runs)).toEqual({ agents: [] });
  });

  it("reads older recordings without dispatch attribution, and never guesses ambiguous aliases", async () => {
    const { events } = await record(fixture());
    const older = events.filter(
      (event) =>
        !(
          event.name === "step.attempted" &&
          event.stepId === "calls" &&
          event.payload.attributes["agent.callId"]
        )
    );
    const root = projectAgentHistory(projectPipelineRunStore(older).runs).agents.find(
      (agent) => agent.pipelineId === "history-agent"
    )!;
    expect(root.turns[0]!.calls.find((call) => call.callId === "same")?.tool).toBe("double");
    expect(root.turns[0]!.calls.find((call) => call.callId === "left")?.tool).toBeUndefined();
    expect(root.turns[0]!.calls.find((call) => call.callId === "right")?.tool).toBeUndefined();
    expect(root.termination).toBe("finish");
  });

  it("keeps missing calls unknown and missing terminal events running", async () => {
    const { events } = await record(fixture());
    const full = projectPipelineRunStore(events);
    const omitted = full.runs.find((run) => run.agentCall?.callId === "same")!.runId;
    const partial = events.filter(
      (event) => event.runId !== omitted && event.name !== "pipeline.completed"
    );
    const root = projectAgentHistory(projectPipelineRunStore(partial).runs).agents.find(
      (agent) => agent.pipelineId === "history-agent"
    )!;
    expect(root.termination).toBe("running");
    expect(root.turns.flatMap((turn) => turn.calls)).toContainEqual(
      expect.objectContaining({ callId: "same", tool: "double", status: "unknown" })
    );
  });

  it("joins partial dispatch records in order while retaining legacy and duplicate child runs", async () => {
    const { events, run } = await record(fixture());
    const { runs } = projectPipelineRunStore(events);
    const turn = runs.find(
      (entry) => entry.agentTurn?.agentRunId === run.runId && entry.agentTurn.index === 1
    )!;
    const call = runs.find(
      (entry) => entry.parentRunId === turn.runId && entry.itemKey === "left"
    )!;
    turn.agentTurn!.calls = turn.agentTurn!.calls.filter((entry) => entry.callId !== "same");
    const missing = runs.filter(
      (entry) => !(entry.parentRunId === turn.runId && entry.itemKey === "right")
    );
    const history = projectAgentHistory([
      ...missing.reverse(),
      { ...call, runId: "duplicate-child" },
    ]);
    const calls = history.agents.find((entry) => entry.runId === run.runId)!.turns[0]!.calls;
    expect(calls.map((entry) => [entry.callId, entry.tool, entry.status])).toEqual([
      ["same", "double", "failed"],
      ["left", "left", "completed"],
      ["left", "left", "completed"],
      ["right", "right", "unknown"],
      ["wrapped", "wrapped", "completed"],
    ]);
    expect(calls[2]!.runId).toBe("duplicate-child");
  });

  it("attributes nested runs to the step and call that started them, with planned edges", async () => {
    const { events, run } = await record(fixture());
    const { runs } = projectPipelineRunStore(events);
    const index = createRunHistoryIndex(runs);
    const byId = new Map(runs.map((entry) => [entry.runId, entry]));
    const origins = runs
      .filter((entry) => entry.parentRunId !== undefined)
      .map(
        (entry) =>
          [
            byId.get(entry.parentRunId!)!.pipelineId,
            entry.pipelineId,
            summarizeRun(entry, index).origin,
          ] as const
      );
    expect(origins).toEqual(
      expect.arrayContaining([
        ["history-agent", "history-agent/turn", { stepId: "agent", iteration: 1 }],
        ["history-agent", "history-agent/turn", { stepId: "agent", iteration: 3 }],
        ["history-agent/turn", "history-agent/tool/double", { stepId: "calls", itemKey: "same" }],
        ["history-agent/turn", "history-child", { stepId: "calls", itemKey: "left" }],
        ["history-agent/turn", "history-wrapper", { stepId: "calls", itemKey: "wrapped" }],
        // Descendants inherit the call's trace item key; it does not identify them.
        ["history-wrapper", "history-child", { stepId: "nested" }],
        ["history-child", "history-child/turn", { stepId: "agent", iteration: 1 }],
      ])
    );
    expect(origins.every(([, , origin]) => origin?.stepId !== undefined)).toBe(true);
    expect(summarizeRun(byId.get(run.runId)!, index).origin).toBeUndefined();
    const turn = runs.find((entry) => entry.agentTurn?.agentRunId === run.runId)!;
    expect(
      turn.steps.map((entry) => [entry.id, entry.dependencies, entry.skipAfterFailureOf])
    ).toEqual([
      ["decide", [], []],
      ["calls", ["decide"], []],
      ["reduce", ["decide", "calls"], []],
    ]);
  });

  it.each(["limit", "failed", "cancelled", "skipped"] as const)(
    "records %s termination without inventing a finish",
    async (expected) => {
      const controller = new AbortController();
      const agent = defineAgentLoop({
        id: "terminal-agent",
        inputSchema: emptyInput,
        resultSchema: numberSchema,
        initialState: () => 0,
        limits: { maxTurns: 1 },
        decide: () => {
          if (expected === "cancelled") controller.abort(new Error("Stop"));
          if (expected === "failed") throw new Error("Model failed");
          return {
            kind: "continue",
            calls: [{ id: "read", tool: "read", input: { path: "unused" } }],
          };
        },
      });
      const { events } = await record(agent, expected === "skipped", controller.signal);
      const history = projectAgentHistory(projectPipelineRunStore(events).runs);
      expect(history.agents[0]!.termination).toBe(expected);
      expect(history.agents[0]!.turns.flatMap((turn) => turn.calls)).toEqual([]);
    }
  );

  it("ignores malformed telemetry and ordinary iterations instead of inventing agent runs", async () => {
    const { events } = await record(fixture());
    const altered = events.map((event) =>
      event.name === "step.attempted"
        ? {
            ...event,
            payload: {
              ...event.payload,
              attributes: { ...event.payload.attributes, "agent.turn": -1 },
            },
          }
        : event
    );
    const root = projectAgentHistory(projectPipelineRunStore(altered).runs).agents.find(
      (agent) => agent.pipelineId === "history-agent"
    )!;
    expect(root.turns.every((turn) => turn.decision === undefined)).toBe(true);
    expect(root.termination).toBe("completed");
    const { step, iteratePipeline } = createSteps();
    const child = definePipeline({ id: "ordinary", steps: [step("value", { run: () => 1 })] });
    const repeat = iteratePipeline("repeat", {
      pipeline: child,
      maxIterations: 1,
      initialState: () => 0,
      mapOptions: () => ({}),
      transition: (result) => ({ kind: "finish", result }),
    });
    const ordinary = await record(definePipeline({ id: "ordinary-parent", steps: [repeat] }));
    expect(projectAgentHistory(projectPipelineRunStore(ordinary.events).runs)).toEqual({
      agents: [],
    });
  });
});
