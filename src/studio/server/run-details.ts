import {
  createPipelineRunProjector,
  type PipelineRunEventReader,
  type PipelineRunProjector,
  type StoredPipelineRun,
} from "../../run-store/run-store.js";
import { readPipelineEventPages } from "../../run-store/run-store-reader.js";

/**
 * Detail projectors retain log and artifact bodies. This keeps the selected run
 * and the expanded children touched most recently; an older open is rebuilt on demand.
 */
export const STUDIO_OPEN_RUN_LIMIT = 32;

/** Run detail retention; the server state serializes reads and clearing. */
export class StudioRunDetails {
  #runs = new Map<string, { lastEventId: number | undefined; projector: PipelineRunProjector }>();

  constructor(private readonly store: Pick<PipelineRunEventReader, "listEvents">) {}

  clear(): void {
    this.#runs.clear();
  }

  /** Fold one run from its last event id. The first open reads the run; later polls read the tail. */
  async read(runId: string): Promise<StoredPipelineRun | undefined> {
    const cached = this.#runs.get(runId) ?? {
      lastEventId: undefined,
      projector: createPipelineRunProjector(),
    };
    let seen = cached.lastEventId !== undefined;
    for await (const page of readPipelineEventPages(this.store, {
      afterId: cached.lastEventId,
      limit: 100_000,
      runId,
    })) {
      cached.projector.append(page);
      cached.lastEventId = page.at(-1)!.id;
      seen = true;
    }
    if (!seen) return undefined;
    this.#retainRun(runId, cached);
    return cached.projector.snapshot().runs.find((entry) => entry.runId === runId);
  }

  /** Remember a run and drop the oldest projector once retention is full. */
  #retainRun(
    runId: string,
    cached: { lastEventId: number | undefined; projector: PipelineRunProjector }
  ): void {
    this.#runs.delete(runId);
    this.#runs.set(runId, cached);
    while (this.#runs.size > STUDIO_OPEN_RUN_LIMIT) {
      const oldest = this.#runs.keys().next().value;
      if (oldest === undefined) return;
      this.#runs.delete(oldest);
    }
  }
}
