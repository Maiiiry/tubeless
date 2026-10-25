import { renderToString } from "preact-render-to-string";
import { describe, expect, it, vi } from "vitest";
import { createSteps, definePipeline, type StandardSchemaV1 } from "../../../core/pipeline.js";
import {
  projectPipelineRunStore,
  type StoredPipelineLog,
  type StoredPipelineRun,
} from "../../../run-store/run-store.js";
import type { PipelineTraceEvent } from "../../../tracing/tracing.js";
import { ErrorDiagnostics, filterRunLogs, formatValidationPath, RunLogs } from "./debugging.js";

type RunError = NonNullable<StoredPipelineRun["error"]>;

describe("Studio run debugging", () => {
  it("renders the recorded validation paths and nested causes safely", () => {
    const error: RunError = {
      code: "TUBELESS_STEP_OUTPUT_VALIDATION_FAILED",
      kind: "validation",
      phase: "execution",
      message: "Invalid output",
      issues: [
        { message: "Required", path: ["items", 2, "display name"] },
        { message: "Missing path" },
      ],
      cause: {
        name: "RemoteError",
        message: "<remote failure>",
        sourceCode: "E_REMOTE",
        cause: { message: "socket closed" },
      },
    };
    const markup = renderToString(<ErrorDiagnostics error={error} />);
    expect(markup).toContain("$.items[2][&quot;display name&quot;]");
    expect(markup).toContain("Path unavailable");
    expect(markup).toContain("RemoteError:");
    expect(markup).toContain("socket closed");
    expect(markup).toContain("Source code: E_REMOTE");
    expect(markup).not.toContain("<remote failure>");
    expect(formatValidationPath([])).toBe("$");
  });

  it("preserves root validation paths from the schema through the recorded run", async () => {
    const schema: StandardSchemaV1<object, object> = {
      "~standard": {
        vendor: "test",
        version: 1,
        validate: () => ({
          issues: [{ message: "Invalid root", path: [] }, { message: "No location supplied" }],
        }),
      },
    };
    const { step } = createSteps(schema);
    const pipeline = definePipeline({
      id: "root-validation-diagnostics",
      steps: [step("never", { run: () => true })],
    });
    const events: PipelineTraceEvent[] = [];

    await pipeline.run({}, undefined, {
      tracing: { exporter: { export: (event) => void events.push(event) } },
    });

    const error = projectPipelineRunStore(events.map((event, id) => ({ ...event, id }))).runs[0]
      ?.error;
    expect(error?.issues).toEqual([
      { message: "Invalid root", path: [] },
      { message: "No location supplied" },
    ]);
    if (!error) throw new Error("Missing recorded validation error");
    const markup = renderToString(<ErrorDiagnostics error={error} />);
    expect(markup).toContain("$</code><span>Invalid root");
    expect(markup).toContain("Path unavailable</code><span>No location supplied");
  });

  it("shows failed fan-out items, scheduler errors, and omitted diagnostics", () => {
    const error: RunError = {
      code: "TUBELESS_CHILD_FAILED",
      kind: "child",
      phase: "execution",
      message: "Three items failed",
      fanOut: {
        failureCount: 3,
        omittedFailureCount: 2,
        failures: [
          {
            index: 4,
            key: "user-5",
            keyTruncated: true,
            cancelled: false,
            error: { message: "request failed", cause: { message: "connection refused" } },
          },
        ],
        schedulerError: { message: "scheduler stopped" },
      },
    };
    const markup = renderToString(<ErrorDiagnostics error={error} />);
    expect(markup).toContain("Failed fan-out items · 3");
    expect(markup).toContain("#5 · user-5");
    expect(markup).toContain("key truncated");
    expect(markup).toContain("connection refused");
    expect(markup).toContain("2 more failures omitted");
    expect(markup).toContain("Scheduler error");
  });

  it("combines text, level, and step filters without confusing step IDs with controls", () => {
    const logs: StoredPipelineLog[] = [
      { id: 1, level: "error", message: "Timeout", stepId: "all", timestampMs: 1000 },
      { id: 2, level: "warn", message: "TIMEOUT soon", stepId: "fetch", timestampMs: 2000 },
      { id: 3, level: "error", message: "timeout again", timestampMs: 3000 },
    ];
    expect(filterRunLogs(logs, " TIMEOUT ", "error", "step:all").map((log) => log.id)).toEqual([1]);
    expect(filterRunLogs(logs, "timeout", "all", "unattributed").map((log) => log.id)).toEqual([3]);
    expect(filterRunLogs(logs, "missing", "all", "all")).toEqual([]);
    const markup = renderToString(<RunLogs logs={logs} />);
    expect(markup).toContain("Search log messages");
    expect(markup).toContain("All levels");
    expect(markup).toContain("No step");
    expect(markup).toContain('value="step:all"');
  });

  it("searches uppercase ASCII logs consistently under a Turkish browser locale", () => {
    const localeLower = String.prototype.toLocaleLowerCase;
    const spy = vi.spyOn(String.prototype, "toLocaleLowerCase").mockImplementation(function (
      this: string
    ) {
      return localeLower.call(this, "tr");
    });
    try {
      const logs: StoredPipelineLog[] = [
        { id: 1, level: "log", message: "TIMEOUT", timestampMs: 1000 },
      ];
      expect(filterRunLogs(logs, "timeout", "all", "all")).toEqual(logs);
    } finally {
      spy.mockRestore();
    }
  });
});
