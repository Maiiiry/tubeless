import { describe, expect, it, vi } from "vitest";
import type { PipelineRunEventQuery } from "../../run-store/run-store.js";
import { memoryStore, recordedRun, storedEvent } from "./events.test-support.js";
import { StudioRunDetails } from "./run-details.js";

describe("Studio run detail retention", () => {
  it("resumes an interrupted cached refresh without losing or duplicating appended pages", async () => {
    const events = recordedRun();
    const store = memoryStore(events);
    const listEvents = vi.fn(store.listEvents);
    const details = new StudioRunDetails({ listEvents });
    await details.read("run");
    events.push(
      storedEvent({
        id: 3,
        name: "pipeline.log",
        pipelineId: "fixture",
        runId: "run",
        timestampMs: 3,
        version: 2,
        payload: { level: "log", message: "new page" },
      })
    );
    const failure = new Error("tail unavailable");
    listEvents
      .mockImplementationOnce((query) => store.listEvents(query))
      .mockRejectedValueOnce(failure);
    await expect(details.read("run")).rejects.toBe(failure);

    listEvents.mockClear();
    const resumed = await details.read("run");
    expect(resumed?.logs.map((log) => log.message)).toEqual(["original", "new page"]);
    expect(listEvents.mock.calls[0][0]).toMatchObject({ afterId: 3, runId: "run" });
  });

  it("rebuilds a failed initial read instead of retaining an incomplete new run", async () => {
    const store = memoryStore(recordedRun());
    const failure = new Error("second page failed");
    let fail = true;
    const listEvents = vi.fn(async (query: PipelineRunEventQuery = {}) => {
      if (fail && query.afterId === 1) throw failure;
      return (await store.listEvents(query)).slice(0, 1);
    });
    const details = new StudioRunDetails({ listEvents });
    await expect(details.read("run")).rejects.toBe(failure);
    fail = false;
    listEvents.mockClear();
    expect((await details.read("run"))?.logs.map((log) => log.message)).toEqual(["original"]);
    expect(listEvents.mock.calls[0][0]?.afterId).toBeUndefined();
  });
});
