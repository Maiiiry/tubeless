import { studioSnapshot, studioRunDetail } from "./run-store-ui.test-support.js";
import { storedPipelineRunSchema } from "../run-store/run-store-schema.js";
import { parseStudioPayload } from "./run-store-ui-schema.js";
import { describe, expect, it, vi } from "vitest";
import { RUN_MODEL_VERSION } from "../core/pipeline.js";
import type { StoredPipelineRun } from "../run-store/run-store.js";
import {
  createStudioApi,
  parseStudioCommands,
  parseStudioSnapshot,
} from "./run-store-ui-client-transport.js";

function run(overrides: Partial<StoredPipelineRun> = {}): StoredPipelineRun {
  return {
    dryRun: false,
    eventCount: 1,
    logCount: 0,
    logs: [],
    pipelineId: "fixture",
    runId: "run-1",
    startedAtMs: 1,
    status: "completed",
    steps: [],
    version: RUN_MODEL_VERSION,
    ...overrides,
  };
}

function snapshot(runs: readonly StoredPipelineRun[] = [run()]) {
  return studioSnapshot(runs);
}
function parseRun(value: unknown) {
  return parseStudioPayload(storedPipelineRunSchema, value);
}

function jsonResponse(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("Studio API response parsing", () => {
  it("validates artifact metadata and operation fields on recorded steps", () => {
    const entry = {
      operation: "read" as const,
      preview: false,
      attemptId: "attempt",
      timestampMs: 1,
      artifact: { id: "input" },
    };
    const read = (artifact: unknown) =>
      parseRun(
        run({ steps: [{ id: "load", status: "completed", artifacts: [artifact as never] }] })
      );
    expect(read(entry)).toBeDefined();
    expect(read({ ...entry, operation: "reuse" })).toBeDefined();
    for (const invalid of [
      { ...entry, preview: "false" },
      { ...entry, operation: "delete" },
      { ...entry, artifact: {} },
      { ...entry, artifact: { id: "input", metadata: { value: Infinity } } },
      { ...entry, artifact: { id: "input", metadata: { value: "a".repeat(17000) } } },
    ])
      expect(read(invalid)).toBeUndefined();
  });

  it("accepts a complete snapshot and rejects malformed nested run data", () => {
    expect(parseStudioSnapshot(snapshot())?.runs[0]?.runId).toBe("run-1");
    expect(parseRun(run({ correlationId: 42 as never }))).toBeUndefined();
    expect(
      parseRun(
        run({
          steps: [
            {
              id: "step",
              status: "completed",
              attempt: {
                attemptId: "attempt",
                retries: undefined as never,
                startedAtMs: 1,
                status: "completed",
              },
            },
          ],
        })
      )
    ).toBeUndefined();
  });

  it("validates command descriptors before returning them", () => {
    const valid = {
      commands: [
        {
          canPlan: true,
          id: "fixture",
          name: "Fixture",
          parameters: [
            {
              flag: "--name",
              key: "name",
              multiple: false,
              positional: false,
              required: true,
              type: "string",
            },
          ],
        },
      ],
    };
    expect(parseStudioCommands(valid)?.[0]?.id).toBe("fixture");
    expect(
      parseStudioCommands({
        commands: [{ ...valid.commands[0], parameters: [{ key: "name" }] }],
      })
    ).toBeUndefined();
    for (const field of [
      "min",
      "max",
      "integer",
      "mustExist",
      "pathKind",
      "short",
      "environment",
      "description",
    ]) {
      expect(
        parseStudioCommands({
          commands: [
            {
              ...valid.commands[0],
              parameters: [{ ...valid.commands[0]!.parameters[0], [field]: { invalid: true } }],
            },
          ],
        })
      ).toBeUndefined();
    }
  });

  it("rejects incomplete plans before they reach rendering", async () => {
    const step = {
      id: "work",
      dependencies: [],
      optionalDependencies: [],
      skipAfterFailureOf: [],
      selectionReasons: [{ kind: "all" }],
      selected: true,
      dryRun: "run",
      runtimeSkipPossible: false,
    };
    const plan = { pipelineId: "fixture", dryRun: false, errors: [], ok: true, steps: [step] };
    const preview = (value: unknown) =>
      createStudioApi(vi.fn(async () => jsonResponse({ plan: value }))).previewPlan("fixture", {});
    await expect(preview(plan)).resolves.toEqual(plan);
    for (const field of [
      "selectionReasons",
      "optionalDependencies",
      "skipAfterFailureOf",
      "dryRun",
      "runtimeSkipPossible",
    ]) {
      const invalid = { ...step, [field]: undefined };
      await expect(preview({ ...plan, steps: [invalid] })).rejects.toThrow(
        /invalid response for plan/
      );
    }
    await expect(preview({ ...plan, errors: [{ message: "only a message" }] })).rejects.toThrow(
      /invalid response for plan/
    );
    await expect(
      preview({ ...plan, steps: [{ ...step, selectionReasons: [{ kind: "target" }] }] })
    ).rejects.toThrow(/invalid response for plan/);
  });

  it("validates full progress details, agent metadata and the literal run version", () => {
    const recorded = run({
      steps: [
        {
          id: "work",
          status: "running",
          progress: {
            completed: 1,
            details: [
              { id: "item", name: "Item", depth: 1, completed: 1, total: 2, status: "running" },
            ],
          },
        },
      ],
    });
    const decoded = parseRun(recorded);
    expect(decoded).toBeDefined();
    expect(decoded?.steps[0]?.progress?.details).not.toBe(recorded.steps[0]?.progress?.details);
    for (const field of ["name", "depth", "completed", "total", "status"]) {
      const invalid = structuredClone(recorded);
      Object.assign(invalid.steps[0]!.progress!.details![0]!, { [field]: { invalid: true } });
      expect(parseRun(invalid)).toBeUndefined();
    }
    expect(parseRun({ ...recorded, version: 999 })).toBeUndefined();
    expect(
      parseRun({ ...recorded, agentTurn: { agentRunId: "agent", index: 1, calls: [{}] } })
    ).toBeUndefined();
  });

  it("rejects incomplete definition summaries and preserves unknown-field compatibility", () => {
    expect(
      parseStudioSnapshot({ ...snapshot(), definitions: [{ pipelineId: "fixture", runCount: 1 }] })
    ).toBeUndefined();
    expect(parseStudioSnapshot({ ...snapshot(), future: true })?.runs[0]?.runId).toBe("run-1");
  });

  it("validates definition metadata independently of its run page", async () => {
    const definition = {
      pipelineId: "fixture",
      activeRuns: 0,
      firstSeenAtMs: 1,
      lastSeenAtMs: 1,
      runCount: 1,
      steps: [],
      targetIds: [],
    };
    const page = { runs: snapshot().runs, offset: 0, runCount: 1 };
    const fetcher: typeof fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ definition }))
      .mockResolvedValueOnce(jsonResponse(page))
      .mockResolvedValueOnce(jsonResponse({ definition: { ...definition, steps: "invalid" } }))
      .mockResolvedValueOnce(jsonResponse({ ...page, offset: -1 }));
    const api = createStudioApi(fetcher);
    expect(await api.loadDefinition("fixture")).toEqual(definition);
    expect(await api.loadDefinitionRuns("fixture")).toEqual(page);
    await expect(api.loadDefinition("fixture")).rejects.toThrow("invalid response for definition.");
    await expect(api.loadDefinitionRuns("fixture")).rejects.toThrow(
      "invalid response for definition runs."
    );
  });

  it("reuses the validated snapshot on a conditional 304 response", async () => {
    const fetcher: typeof fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(snapshot(), { headers: { etag: '"revision"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const api = createStudioApi(fetcher);
    const first = await api.loadSnapshot({ query: "child", selectedRunId: "nested", offset: 50 });
    expect(await api.loadSnapshot({ query: "child", selectedRunId: "nested", offset: 50 })).toBe(
      first
    );
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/snapshot?query=child&offset=50&run=nested",
      expect.objectContaining({ headers: { "if-none-match": '"revision"' } })
    );
  });

  it("accepts iteration metadata and rejects invalid bounds or relationships", () => {
    const iteration = { runId: "parent", stepId: "repeat", attemptId: "attempt", index: 1 };
    const nestedPipeline = {
      mode: "iterate" as const,
      pipelineId: "child",
      maxIterations: 3,
      stepCount: 1,
      stepIds: ["work"],
    };
    const recorded = run({
      iteration,
      steps: [{ id: "repeat", status: "completed", nestedPipeline }],
    });
    expect(parseRun(recorded)?.iteration).toEqual(iteration);
    expect(parseRun({ ...recorded, iteration: { ...iteration, index: 0 } })).toBeUndefined();
    expect(
      parseRun(
        run({
          steps: [
            {
              id: "repeat",
              status: "completed",
              nestedPipeline: { ...nestedPipeline, maxIterations: 0 },
            },
          ],
        })
      )
    ).toBeUndefined();
  });

  it("rejects invalid successful payloads instead of exposing them to client state", async () => {
    const fetcher: typeof fetch = vi.fn(async () => jsonResponse({ runs: "not-an-array" }));
    const api = createStudioApi(fetcher);
    await expect(api.loadSnapshot()).rejects.toThrow(/invalid response for snapshot/);
  });

  it("validates projected run details without requiring raw events", async () => {
    const validFetcher: typeof fetch = vi.fn(async () => jsonResponse(studioRunDetail(run())));
    await expect(createStudioApi(validFetcher).loadRunDetail("run-1")).resolves.toEqual(
      studioRunDetail(run())
    );

    const invalidFetcher: typeof fetch = vi.fn(async () =>
      jsonResponse({ run: { ...run(), logs: 1 } })
    );
    await expect(createStudioApi(invalidFetcher).loadRunDetail("run-1")).rejects.toThrow(
      /invalid response for run detail/
    );
  });

  it("keeps launch requests same-origin guarded and returns only a validated run id", async () => {
    const fetcher: typeof fetch = vi.fn(async () =>
      jsonResponse({ accepted: true, runId: "run-accepted" }, { status: 202 })
    );
    const api = createStudioApi(fetcher);
    await expect(api.launch("fixture/id", { name: "Ada" })).resolves.toBe("run-accepted");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/commands/fixture%2Fid/runs",
      expect.objectContaining({
        headers: {
          "content-type": "application/json",
          "x-tubeless-studio-launch": "1",
        },
        method: "POST",
      })
    );
  });
});

it.each(["override", "cache"] as const)(
  "accepts %s steps and attempts in recorded Studio runs",
  (outputSource) => {
    const recorded = run({
      steps: [
        {
          id: "load",
          status: "completed",
          outputSource,
          attempt: {
            attemptId: "override-1",
            startedAtMs: 1,
            finishedAtMs: 2,
            retries: [],
            status: "completed",
            outputSource,
          },
        },
      ],
    });
    expect(parseRun(recorded)?.steps[0]).toMatchObject({ status: "completed", outputSource });
    recorded.steps[0]!.outputSource = "invalid" as never;
    expect(parseRun(recorded)).toBeUndefined();
  }
);

describe("mounted transport and access expiry", () => {
  const calls = [
    (api: ReturnType<typeof createStudioApi>) => api.loadSnapshot(),
    (api: ReturnType<typeof createStudioApi>) => api.loadCommands(),
    (api: ReturnType<typeof createStudioApi>) => api.loadCapabilities(),
    (api: ReturnType<typeof createStudioApi>) => api.loadRunDetail("run/id"),
    (api: ReturnType<typeof createStudioApi>) => api.loadChildRuns("run/id", 1),
    (api: ReturnType<typeof createStudioApi>) => api.loadDefinition("pipeline/id", "definition:id"),
    (api: ReturnType<typeof createStudioApi>) =>
      api.loadDefinitionRuns("pipeline/id", "definition:id", 50),
    (api: ReturnType<typeof createStudioApi>) => api.launch("fixture/id", {}),
    (api: ReturnType<typeof createStudioApi>) => api.previewPlan("fixture/id", {}),
    (api: ReturnType<typeof createStudioApi>) => api.cancelRun("run/id"),
    (api: ReturnType<typeof createStudioApi>) => api.clearHistory(),
  ];
  it("prefixes every endpoint and encodes IDs once without browser credentials", async () => {
    const fetcher: typeof fetch = vi.fn(async () =>
      jsonResponse({ message: "fixture" }, { status: 500 })
    );
    const api = createStudioApi(fetcher, "/admin/pipelines");
    for (const call of calls) await expect(call(api)).rejects.toThrow("fixture");
    expect(vi.mocked(fetcher).mock.calls.map(([url]) => url)).toEqual([
      "/admin/pipelines/api/snapshot",
      "/admin/pipelines/api/commands",
      "/admin/pipelines/api/capabilities",
      "/admin/pipelines/api/runs/run%2Fid",
      "/admin/pipelines/api/runs/run%2Fid/children?page=1",
      "/admin/pipelines/api/definitions?pipelineId=pipeline%2Fid&definitionId=definition%3Aid",
      "/admin/pipelines/api/definitions/runs?pipelineId=pipeline%2Fid&offset=50&definitionId=definition%3Aid",
      "/admin/pipelines/api/commands/fixture%2Fid/runs",
      "/admin/pipelines/api/commands/fixture%2Fid/plan",
      "/admin/pipelines/api/runs/run%2Fid/cancel",
      "/admin/pipelines/api/history",
    ]);
    for (const [, init] of vi.mocked(fetcher).mock.calls)
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
  });
  it.each([401, 403])(
    "retires every API after %s before parsing a login HTML body",
    async (status) => {
      for (const call of calls) {
        const fetcher: typeof fetch = vi.fn(
          async () => new Response("<html>login</html>", { status })
        );
        const api = createStudioApi(fetcher);
        const denied = vi.fn();
        api.subscribeAccessDenied!(denied);
        await expect(call(api)).rejects.toMatchObject({ status });
        expect(denied).toHaveBeenCalledExactlyOnceWith(status);
        for (const later of calls) await expect(later(api)).rejects.toMatchObject({ status });
        expect(fetcher).toHaveBeenCalledTimes(1);
      }
    }
  );
  it("retires pending launch, command and snapshot responses when another request denies access", async () => {
    const resolvers: ((value: Response) => void)[] = [];
    const fetcher: typeof fetch = vi.fn(
      () => new Promise<Response>((resolve) => resolvers.push(resolve))
    );
    const api = createStudioApi(fetcher);
    const launch = api.launch("fixture", {});
    const commands = api.loadCommands();
    const snapshotPromise = api.loadSnapshot();
    const denied = api.cancelRun("run");
    const settled = Promise.allSettled([launch, commands, snapshotPromise, denied]);
    resolvers[3]!(new Response("", { status: 401 }));
    await Promise.resolve();
    await Promise.resolve();
    resolvers[0]!(jsonResponse({ accepted: true, runId: "late" }));
    resolvers[1]!(jsonResponse({ commands: [] }));
    resolvers[2]!(jsonResponse(snapshot()));
    expect(await settled).toEqual(
      Array.from({ length: 4 }, () => ({
        status: "rejected",
        reason: expect.objectContaining({ status: 401 }),
      }))
    );
  });
  it("does not mistake bad gateway responses or connection failures for logout", async () => {
    for (const response of [
      new Response("Bad gateway", { status: 502 }),
      jsonResponse({ message: "broken" }, { status: 500 }),
      new Response("bad JSON", { status: 200 }),
    ]) {
      const api = createStudioApi(vi.fn(async () => response));
      const denied = vi.fn();
      api.subscribeAccessDenied!(denied);
      await expect(api.loadSnapshot()).rejects.toThrow();
      expect(denied).not.toHaveBeenCalled();
    }
    const api = createStudioApi(
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );
    const denied = vi.fn();
    api.subscribeAccessDenied!(denied);
    await expect(api.loadSnapshot()).rejects.toThrow("fetch failed");
    expect(denied).not.toHaveBeenCalled();
  });
});
