import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createPipelineTestRuntime } from "../testing/testing.js";
import { decodeStoredTraceEvent } from "../run-store/run-store-event-decoder.js";
import { projectPipelineRunStore, type StoredPipelineEvent } from "../run-store/run-store.js";
import {
  createMemoryAgentCheckpointStore,
  defineAgentLoop,
  defineAgent,
  defineTool,
  ToolError,
  type AgentCall,
  type AgentDecision,
  type AgentDecisionContext,
  type AgentModelRequest,
  type AgentOutcome,
  type AgentState,
  type CodemodeResult,
  type DefaultAgentTools,
} from "./agent.js";
import { emptyInput, schema, textSchema } from "./agent.test-support.js";
import { runCodemodeScript } from "./codemode-sandbox.js";
import { remote } from "./environment.test-support.js";

const word = schema<{ word: string }>(
  (value) =>
    typeof (value as { word?: unknown })?.word === "string"
      ? { value: value as { word: string } }
      : { issues: [{ message: "Expected word" }] },
  {
    type: "object",
    properties: { word: { type: "string", description: "Word to transform" } },
    required: ["word"],
    additionalProperties: false,
  }
);
const upperResult = schema<{ upper: string }>((value) => ({ value: value as { upper: string } }), {
  type: "object",
  properties: { upper: { type: "string" } },
  required: ["upper"],
});

function upperTool(run: (word: string) => { upper: string } | Promise<{ upper: string }>) {
  return defineTool({
    description: "Uppercase one word",
    replay: "safe",
    inputSchema: word,
    outputSchema: upperResult,
    run: ({ word }) => run(word),
  });
}

const upper = upperTool((value) => {
  if (value === "missing") throw new ToolError("NOT_FOUND", `No word ${value}`);
  return { upper: value.toUpperCase() };
});

/** A scripted model: run each script in its own turn, then finish with the observed outcomes. */
function scripted(...scripts: string[]) {
  const requests: AgentModelRequest[] = [];
  const contexts: AgentDecisionContext<object>[] = [];
  const observed: unknown[] = [];
  const model = vi.fn((request: AgentModelRequest, context: AgentDecisionContext<object>) => {
    requests.push(request);
    contexts.push(context);
    observed.push(...request.outcomes);
    const code = scripts[context.turn - 1];
    return code === undefined
      ? {
          decision: { kind: "finish", result: { answer: JSON.stringify(observed) } },
          conversation: null,
        }
      : {
          decision: {
            kind: "continue",
            calls: [{ id: `s${context.turn}`, tool: "codemode", input: { code } }],
          },
          conversation: null,
        };
  });
  return { model, requests, contexts };
}

function outcomes(answer: string) {
  return JSON.parse(answer) as {
    ok: boolean;
    value?: { result: unknown; logs: string[]; logsTruncated: boolean };
    error?: { code: string; message: string };
  }[];
}

describe("code mode", () => {
  it("advertises one declared tool and runs scripts that chain registered tools", async () => {
    const { model, requests, contexts } = scripted(`
      const words = [];
      for (const word of ["red", "blue"]) words.push((await tools.upper({ word })).upper);
      const listing = await tools.list({ path: null });
      console.log("listed", listing.entries.length);
      return { words, first: listing.entries[0].name };
    `);
    const agent = defineAgent({
      id: "codemode-agent",
      projectContext: false,
      codemode: true,
      environment: remote(),
      tools: { upper },
      model,
    });
    const { answer } = await agent.runOrThrow({ task: "go" });
    expect(outcomes(answer)).toEqual([
      {
        id: "s1",
        tool: "codemode",
        ok: true,
        value: {
          result: { words: ["RED", "BLUE"], first: "a" },
          logs: ["listed 1"],
          logsTruncated: false,
        },
      },
    ]);
    const capabilities = contexts[0]!.capabilities;
    expect(capabilities.map(({ name }) => name)).toEqual(["codemode"]);
    const description = capabilities[0]!.description;
    expect(description).toContain("declare const tools: {");
    expect(description).toContain("/** Word to transform */");
    expect(description).toContain(
      "upper(input: {\n    /** Word to transform */\n    word: string;\n  }): Promise<{\n    upper: string;\n  }>;"
    );
    expect(description).toContain("read(input: {");
    expect(requests[0]!.instructions).toContain("Code mode: your only tool is codemode.");
  });

  it("records nested calls as child runs of the script with their own call identities", async () => {
    const { model } = scripted(
      `return await Promise.all(["a", "b"].map((word) => tools.upper({ word })));`
    );
    const agent = defineAgent({
      id: "codemode-trace",
      projectContext: false,
      codemode: true,
      environment: remote(),
      tools: { upper },
      model,
    });
    const events: StoredPipelineEvent[] = [];
    const runtime = createPipelineTestRuntime();
    const run = await agent.run({ task: "go" }, undefined, {
      ...runtime.context,
      tracing: {
        exporter: {
          export: (event) => {
            events.push({
              ...decodeStoredTraceEvent(JSON.parse(JSON.stringify(event))),
              id: events.length + 1,
            });
          },
        },
      },
    });
    expect(run.status).toBe("completed");
    const runs = projectPipelineRunStore(events).runs;
    const script = runs.find(({ pipelineId }) => pipelineId === "codemode-trace/tool/codemode")!;
    const nested = runs.filter(({ pipelineId }) => pipelineId === "codemode-trace/tool/upper");
    expect(nested).toHaveLength(2);
    for (const child of nested) expect(child.parentRunId).toBe(script.runId);
    expect(
      runtime.logs.some(({ message }) => String(message).includes("Run script (1 line)"))
    ).toBe(true);
    expect(
      runtime.logs.some(({ message }) =>
        String(message).includes(`["a", "b"].map((word) => tools.upper`)
      )
    ).toBe(true);
  });

  it("returns recoverable tool, input, script, syntax and size failures as observations", async () => {
    const { model } = scripted(
      `try { await tools.upper({ word: "missing" }); } catch (error) { return [error.name, error.code, error.message]; }`,
      `try { await tools.upper({ nope: 1 }); } catch (error) { return error.code; }`,
      `try { await tools.nope({}); } catch (error) { return error.name; }`,
      `console.log("before"); await tools.upper({ word: "missing" });`,
      `const value: string = "typed";`,
      `return "x".repeat(20000);`,
      `return () => 1;`
    );
    const agent = defineAgent({
      id: "codemode-failures",
      projectContext: false,
      codemode: true,
      environment: remote(),
      tools: { upper },
      model,
    });
    const results = outcomes((await agent.runOrThrow({ task: "go" })).answer);
    expect(results[0]!.value!.result).toEqual(["ToolError", "NOT_FOUND", "No word missing"]);
    expect(results[1]!.value!.result).toBe("CODEMODE_INVALID_CALL");
    expect(results[2]!.value!.result).toBe("TypeError");
    expect(results[3]!.error).toEqual({
      code: "CODEMODE_SCRIPT_ERROR",
      message: "NOT_FOUND: No word missing (line 1, column 24)\nLogs:\nbefore",
    });
    expect(results[4]!.error!.code).toBe("CODEMODE_SCRIPT_ERROR");
    expect(results[4]!.error!.message).toContain("SyntaxError");
    expect(results[5]!.error!.code).toBe("CODEMODE_RESULT_TOO_LARGE");
    expect(results[6]!.value!.result).toBeNull();
  });

  it("exposes only realm-local objects without host globals or code generation", async () => {
    const { model } = scripted(`
      const probes = {
        process: () => process,
        require: () => require,
        timers: () => setTimeout,
        fetch: () => fetch,
        eval: () => eval("1"),
        constructor: () => tools.read.constructor("return process")(),
        consoleConstructor: () => console.log.constructor("return 1")(),
      };
      const blocked = {};
      for (const [name, probe] of Object.entries(probes)) {
        try { probe(); blocked[name] = false; } catch (error) { blocked[name] = error.name; }
      }
      return blocked;
    `);
    const agent = defineAgent({
      id: "codemode-isolation",
      projectContext: false,
      codemode: true,
      environment: remote(),
      model,
    });
    expect(outcomes((await agent.runOrThrow({ task: "go" })).answer)[0]!.value!.result).toEqual({
      process: "ReferenceError",
      require: "ReferenceError",
      timers: "ReferenceError",
      fetch: "ReferenceError",
      eval: "EvalError",
      constructor: "EvalError",
      consoleConstructor: "EvalError",
    });
  });

  it("charges nested calls against maxCalls and fails fatally on handler exceptions", async () => {
    const limited = defineAgent({
      id: "codemode-limit",
      projectContext: false,
      codemode: true,
      environment: remote(),
      tools: { upper },
      limits: { maxCalls: 3 },
      model: scripted(`for (const word of ["a", "b", "c"]) await tools.upper({ word }); return 1;`)
        .model,
    });
    const run = await limited.run({ task: "go" });
    expect(run.status).toBe("failed");
    expect(run.errors[0]!.message).toContain("maxCalls");

    const broken = defineAgent({
      id: "codemode-fatal",
      projectContext: false,
      codemode: true,
      environment: remote(),
      tools: {
        upper: upperTool(() => {
          throw new Error("handler bug");
        }),
      },
      model: scripted(`try { await tools.upper({ word: "a" }); } catch { return "swallowed"; }`)
        .model,
    });
    const failed = await broken.run({ task: "go" });
    expect(failed.status).toBe("failed");
    expect(failed.errors.map(({ message }) => message).join("\n")).toContain("handler bug");
  });

  it("admits concurrent script calls through the shared leaf queue without holding a permit", async () => {
    let active = 0;
    let peak = 0;
    const slow = upperTool(async (value) => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return { upper: value.toUpperCase() };
    });
    for (const maxConcurrency of [1, 2]) {
      peak = 0;
      const agent = defineAgent({
        id: "codemode-concurrency",
        projectContext: false,
        codemode: true,
        environment: remote(),
        tools: { upper: slow },
        limits: { maxConcurrency },
        model: scripted(
          `return (await Promise.all(["a", "b", "c"].map((word) => tools.upper({ word })))).map((r) => r.upper);`
        ).model,
      });
      const [result] = outcomes((await agent.runOrThrow({ task: "go" })).answer);
      expect(result!.value!.result).toEqual(["A", "B", "C"]);
      expect(peak).toBe(maxConcurrency);
    }
  });

  it("runs scripts as single checkpointed calls in durable agents", async () => {
    const store = createMemoryAgentCheckpointStore();
    const calls = vi.fn();
    const define = (id: string, tools: Parameters<typeof defineAgent>[0]["tools"]) =>
      defineAgent({
        id,
        projectContext: false,
        codemode: true,
        implementationVersion: "1",
        environment: remote(),
        durability: { store, key: id },
        tools,
        model: (request, context) => {
          calls();
          return context.turn === 1
            ? {
                decision: {
                  kind: "continue",
                  calls: [{ id: "s1", tool: "codemode", input: { code: "return 1;" } }],
                },
                conversation: null,
              }
            : { decision: { kind: "finish", result: { answer: "done" } }, conversation: null };
        },
      });
    expect(await define("durable-codemode", { upper }).runOrThrow({ task: "go" })).toEqual({
      answer: "done",
    });
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it("rejects a custom tool that claims the reserved name", () => {
    expect(() =>
      defineAgent({
        id: "codemode-reserved",
        codemode: true,
        model: scripted().model,
        tools: { codemode: upper },
      })
    ).toThrow("Code mode reserves the codemode tool name");
  });
});

describe("code mode on defineAgentLoop", () => {
  /** Run one script per decision, then finish with every observed outcome. */
  function autonomous(scripts: readonly string[], dryRun = false) {
    const reduced: AgentOutcome<{ upper: typeof upper }, true>[] = [];
    const capabilities: string[][] = [];
    const decide = (
      state: AgentState<{ turn: number }>,
      context: AgentDecisionContext<{}>
    ): AgentDecision<{ upper: typeof upper }, string, true> => {
      capabilities.push(context.capabilities.map(({ name }) => name));
      const code = scripts[state.turn];
      return code === undefined
        ? { kind: "finish", result: JSON.stringify(reduced) }
        : {
            kind: "continue",
            calls: [{ id: `s${state.turn}`, tool: "codemode", input: { code } }],
          };
    };
    const agent = defineAgentLoop({
      id: "autonomous-codemode",
      codemode: true,
      environment: remote(),
      inputSchema: emptyInput,
      resultSchema: textSchema,
      tools: { upper },
      initialState: () => ({ turn: 0 }),
      decide,
      dryRun: dryRun ? decide : undefined,
      reduce: (state, outcomes) => {
        expectTypeOf(outcomes[0]!.tool).toEqualTypeOf<"codemode">();
        if (outcomes[0]!.ok) expectTypeOf(outcomes[0]!.value).toEqualTypeOf<CodemodeResult>();
        reduced.push(...outcomes);
        return { turn: state.turn + 1 };
      },
    });
    return { agent, capabilities };
  }

  it("types calls and outcomes as the codemode tool and runs registered tools from scripts", async () => {
    expectTypeOf<AgentCall<{ upper: typeof upper }, true>["tool"]>().toEqualTypeOf<"codemode">();
    expectTypeOf<AgentCall<{ upper: typeof upper }, true>["input"]>().toEqualTypeOf<{
      readonly code: string;
    }>();
    // @ts-expect-error code-mode decisions cannot call registered tools directly
    const direct: AgentCall<{ upper: typeof upper }, true> = { id: "d", tool: "upper", input: {} };
    void direct;
    expectTypeOf<AgentCall<{ upper: typeof upper }>["tool"]>().toEqualTypeOf<
      "upper" | keyof DefaultAgentTools
    >();
    const { agent, capabilities } = autonomous([
      `return (await tools.upper({ word: "pipeline" })).upper;`,
      `return (await tools.read({ path: "a", startLine: null, maxLines: null })).content;`,
    ]);
    const result = JSON.parse(await agent.runOrThrow({}));
    expect(result.map(({ value }: { value: CodemodeResult }) => value.result)).toEqual([
      "PIPELINE",
      "before",
    ]);
    expect(capabilities).toEqual([["codemode"], ["codemode"], ["codemode"]]);
  });

  it("previews scripts in dry runs with each tool's own dry-run policy", async () => {
    const preview = autonomous([`return (await tools.list({ path: null })).entries.length;`], true);
    expect(JSON.parse(await preview.agent.runOrThrow({}, { dryRun: true }))[0].value.result).toBe(
      1
    );
    const write = autonomous(
      [`await tools.write({ path: "a", content: "x" }); return "written";`],
      true
    );
    const run = await write.agent.run({}, { dryRun: true });
    expect(run.status).toBe("failed");
    expect(run.errors[0]!.message).toContain("Required pipeline outputs missing");
  });

  it("rejects a non-boolean codemode flag", () => {
    expect(() =>
      defineAgentLoop({
        id: "bad-codemode",
        // @ts-expect-error codemode accepts only booleans
        codemode: "yes",
        inputSchema: emptyInput,
        resultSchema: textSchema,
        initialState: () => null,
        decide: () => ({ kind: "finish", result: "" }),
      })
    ).toThrow("boolean codemode");
  });
});

describe("code-mode sandbox", () => {
  const base = { tools: ["echo"], maxLogLines: 200, maxLogCharacters: 4096 };

  it("terminates scripts that exceed their deadline and aborts their calls", async () => {
    const aborted = vi.fn();
    const outcome = await runCodemodeScript({
      ...base,
      code: `tools.echo({}); while (true) {}`,
      timeoutMs: 200,
      call: (_name, _input, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => {
            aborted();
            reject(new Error("aborted"));
          })
        ),
    });
    expect(outcome).toMatchObject({ ok: false, code: "CODEMODE_TIMEOUT" });
    expect(aborted).toHaveBeenCalledOnce();
  });

  it("propagates cancellation after terminating the worker", async () => {
    const controller = new AbortController();
    const running = runCodemodeScript({
      ...base,
      code: `while (true) {}`,
      timeoutMs: 10_000,
      signal: controller.signal,
      call: () => Promise.resolve({ ok: true, value: null }),
    });
    setTimeout(() => controller.abort(new Error("stop")), 50);
    await expect(running).rejects.toThrow("stop");
  });

  it("drains calls a script did not await, and fails fatally when one rejects", async () => {
    const settled = vi.fn();
    const outcome = await runCodemodeScript({
      ...base,
      code: `tools.echo({ late: true }); return "early";`,
      timeoutMs: 5000,
      call: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        settled();
        return { ok: true, value: null };
      },
    });
    expect(outcome).toMatchObject({ ok: true, result: '"early"' });
    expect(settled).toHaveBeenCalledOnce();
    await expect(
      runCodemodeScript({
        ...base,
        code: `await tools.echo({});`,
        timeoutMs: 5000,
        call: () => Promise.reject(new Error("transport closed")),
      })
    ).rejects.toThrow("transport closed");
  });

  it("bounds console output in the realm", async () => {
    const outcome = await runCodemodeScript({
      ...base,
      maxLogLines: 2,
      code: `for (let i = 0; i < 5; i++) console.log("line", i, { i }); return null;`,
      timeoutMs: 5000,
      call: () => Promise.resolve({ ok: true, value: null }),
    });
    expect(outcome).toEqual({
      ok: true,
      result: "null",
      logs: ['line 0 {"i":0}', 'line 1 {"i":1}'],
      logsTruncated: true,
    });
  });
});
