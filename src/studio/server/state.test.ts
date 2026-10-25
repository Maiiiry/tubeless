import { describe, expect, it, vi } from "vitest";
import type { PipelineRunEventQuery } from "../../run-store/run-store.js";
import { memoryStore, recordedRun } from "./events.test-support.js";
import { PipelineRunStudioEventState, PipelineRunStudioHistoryBusyError } from "./state.js";

describe("Studio state coordination", () => {
  it("finishes an in-flight detail before clearing and resets every cache before the next read", async () => {
    const events = recordedRun();
    const store = memoryStore(events);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let block = true;
    const reader = {
      listEvents: vi.fn(async (query: PipelineRunEventQuery = {}) => {
        if (query.runId && block) {
          block = false;
          await gate;
        }
        return store.listEvents(query);
      }),
    };
    const state = new PipelineRunStudioEventState(reader);
    const detail = state.detail("run");
    await vi.waitFor(() =>
      expect(reader.listEvents.mock.calls.some(([query]) => query?.runId === "run")).toBe(true)
    );
    const maintenance = {
      clear: vi.fn(() => {
        events.length = 0;
      }),
    };
    const cleared = state.clear(maintenance);
    const workspace = state.workspace();
    await Promise.resolve();
    expect(maintenance.clear).not.toHaveBeenCalled();
    release();

    expect((await detail)?.run.logs.map((log) => log.message)).toEqual(["original"]);
    expect(await cleared).toEqual({ eventCount: 2, runCount: 1 });
    expect(await workspace).toMatchObject({ runCount: 0, runs: [] });
    expect(await state.detail("run")).toBeUndefined();

    // A cleared store can restart IDs and reuse a run ID without inheriting old detail.
    events.push(...recordedRun("replacement"));
    expect((await state.detail("run"))?.run.logs.map((log) => log.message)).toEqual([
      "replacement",
    ]);
    expect(await state.workspace()).toMatchObject({ runCount: 1, eventCount: 2 });
  });

  it("keeps projection and detail cursors when storage rejects a clear", async () => {
    const events = recordedRun();
    const store = memoryStore(events);
    const reader = { listEvents: vi.fn(store.listEvents) };
    const state = new PipelineRunStudioEventState(reader);
    await state.detail("run");
    const before = await state.workspace();
    const failure = new Error("clear failed");
    await expect(
      state.clear({
        clear: () => {
          throw failure;
        },
      })
    ).rejects.toBe(failure);
    expect(await state.workspace()).toEqual(before);

    reader.listEvents.mockClear();
    expect((await state.detail("run"))?.run.logs).toHaveLength(1);
    expect(reader.listEvents.mock.calls.every(([query]) => query?.afterId === 2)).toBe(true);
  });

  it("rejects a busy clear and continues serving reads through the same queue", async () => {
    const state = new PipelineRunStudioEventState(memoryStore(recordedRun()));
    const clear = vi.fn();
    await expect(state.clear({ isBusy: () => true, clear })).rejects.toBeInstanceOf(
      PipelineRunStudioHistoryBusyError
    );
    expect(clear).not.toHaveBeenCalled();
    expect(await state.workspace()).toMatchObject({ runCount: 1, eventCount: 2 });
  });

  it("recovers the queue after a reader fails while later work is already queued", async () => {
    const store = memoryStore(recordedRun());
    const failure = new Error("read failed");
    const reader = { listEvents: vi.fn(store.listEvents).mockRejectedValueOnce(failure) };
    const state = new PipelineRunStudioEventState(reader);
    const failed = state.workspace();
    const next = state.detail("run");
    await expect(failed).rejects.toBe(failure);
    expect((await next)?.run.logs).toHaveLength(1);
    expect(await state.workspace()).toMatchObject({ runCount: 1, eventCount: 2 });
  });
});
