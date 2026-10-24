import { describe, expect, it } from "vitest";
import { upgradeLegacyAttributeRow, type LegacyAttributeRow } from "./legacy-trace-event.js";

function row(
  overrides: Partial<LegacyAttributeRow> &
    Pick<LegacyAttributeRow, "attributes_json" | "event_name">
): LegacyAttributeRow {
  return {
    attempt_id: null,
    duration_ms: null,
    error_json: null,
    id: 1,
    item_key: null,
    parent_run_id: null,
    pipeline_id: "import",
    run_id: "run-1",
    step_id: null,
    timestamp_ms: 10,
    version: 1,
    ...overrides,
  };
}

describe("legacy attribute trace events", () => {
  it("upgrades scalar attributes to the current payload", () => {
    expect(
      upgradeLegacyAttributeRow(
        row({
          attributes_json: JSON.stringify({
            dry_run: false,
            plan_ok: false,
            step_count: 6,
            target_ids: '["sync-schema","seed-bible-content"]',
          }),
          event_name: "pipeline.started",
        })
      )
    ).toEqual({
      name: "pipeline.started",
      payload: {
        dryRun: false,
        planOk: false,
        stepCount: 6,
        targetIds: ["sync-schema", "seed-bible-content"],
      },
      pipelineId: "import",
      runId: "run-1",
      timestampMs: 10,
      version: 2,
    });
  });

  it("keeps nested plans, progress, and retired error codes", () => {
    const planned = upgradeLegacyAttributeRow(
      row({
        attributes_json: JSON.stringify({
          dependencies: '["resolve-selection"]',
          description: "Build selected Library editions with bounded concurrency",
          dry_run: "run",
          nested_pipeline: JSON.stringify({
            mode: "for-each",
            pipelineId: "library-edition",
            step_count: 2,
            stepIds: ["fetch-sources", "write-artifact"],
          }),
          optional_dependencies: "[]",
          runtime_skip_possible: false,
          selected: true,
          selection_reasons: '[{"kind":"all"}]',
          skip_after_failure_of: "[]",
        }),
        event_name: "step.planned",
        id: 2,
        step_id: "process-editions",
      })
    );
    expect(planned).toMatchObject({
      payload: {
        dependencies: ["resolve-selection"],
        dryRun: "run",
        nestedPipeline: {
          mode: "for-each",
          pipelineId: "library-edition",
          stepCount: 2,
          stepIds: ["fetch-sources", "write-artifact"],
        },
        selectionReasons: [{ kind: "all" }],
      },
      stepId: "process-editions",
      version: 2,
    });

    expect(
      upgradeLegacyAttributeRow(
        row({
          attempt_id: "attempt-1",
          attributes_json: JSON.stringify({
            completed: 0,
            detail_count: 1,
            details: '[{"id":"edition-1","label":"starting","status":"running"}]',
            message: "0/66 editions",
            total: 66,
          }),
          event_name: "step.running",
          id: 3,
          step_id: "process-editions",
        })
      ).payload
    ).toEqual({
      progress: {
        completed: 0,
        detailCount: 1,
        details: [{ id: "edition-1", label: "starting", status: "running" }],
        message: "0/66 editions",
        total: 66,
      },
    });

    const failed = upgradeLegacyAttributeRow(
      row({
        attempt_id: "attempt-1",
        attributes_json: JSON.stringify({ status: "failed" }),
        duration_ms: 4,
        error_json: JSON.stringify({
          cause: { message: "bad xml", name: "Error" },
          code: "PIPES_STEP_FAILED",
          kind: "step",
          message: "Invalid ThML XML",
          phase: "execution",
        }),
        event_name: "step.failed",
        id: 4,
        step_id: "inspect-source",
      })
    );
    expect(failed.error).toMatchObject({
      code: "TUBELESS_STEP_FAILED",
      message: "Invalid ThML XML",
    });
    expect(failed.payload).toEqual({ status: "failed" });

    expect(
      upgradeLegacyAttributeRow(
        row({
          attributes_json: JSON.stringify({ status: "complete" }),
          duration_ms: 3,
          event_name: "step.complete",
          id: 5,
          step_id: "sync-schema",
          attempt_id: "attempt-1",
        })
      ).payload
    ).toEqual({ status: "completed" });
  });

  it("reads a version 2 payload already stored in the attribute column", () => {
    expect(
      upgradeLegacyAttributeRow(
        row({
          attributes_json: JSON.stringify({
            dryRun: false,
            planOk: true,
            stepCount: 0,
            targetIds: [],
          }),
          correlation_id: "job-1",
          event_name: "pipeline.started",
          version: 2,
        })
      )
    ).toMatchObject({ correlationId: "job-1", version: 2, payload: { planOk: true } });
  });

  it("names the row when a legacy event cannot be upgraded", () => {
    expect(() =>
      upgradeLegacyAttributeRow(
        row({
          attributes_json: JSON.stringify({ status: "running" }),
          event_name: "pipeline.completed",
          id: 17,
        })
      )
    ).toThrow("Cannot upgrade pipeline run event 17 (pipeline.completed)");
  });
});
