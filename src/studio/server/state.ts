import {
  createPipelineRunProjector,
  type PipelineRunEventReader,
  type StoredPipelineDefinition,
} from "../../run-store/run-store.js";
import { readPipelineEventPages } from "../../run-store/run-store-reader.js";
import type {
  StudioSnapshot,
  StudioRunDetail,
  StudioChildRuns,
  StudioDefinitionRuns,
} from "../shared/schema.js";
import { StudioHistory } from "./history.js";
import { StudioRunDetails } from "./run-details.js";

export interface PipelineRunStudioHistoryMaintenance {
  clear(): void | Promise<void>;
  isBusy?(): boolean | Promise<boolean>;
}

export class PipelineRunStudioHistoryBusyError extends Error {
  constructor() {
    super("Wait for active runs to finish before clearing history.");
    this.name = "PipelineRunStudioHistoryBusyError";
  }
}

/** Serializes incremental store reads and history clearing for one studio server. */
export class PipelineRunStudioEventState {
  #lastEventId: number | undefined;
  #operation: Promise<void> = Promise.resolve();
  #projector = createPipelineRunProjector({ retainLogs: false, retainArtifacts: false });
  readonly #details: StudioRunDetails;
  #revision = 0;
  #history: StudioHistory | undefined;

  constructor(private readonly store: Pick<PipelineRunEventReader, "listEvents">) {
    this.#details = new StudioRunDetails(store);
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async #appendNewEvents(): Promise<void> {
    for await (const page of readPipelineEventPages(this.store, {
      afterId: this.#lastEventId,
      limit: 100_000,
    })) {
      this.#projector.append(page);
      this.#lastEventId = page.at(-1)!.id;
      this.#revision += 1;
    }
  }

  #indexedHistory(): StudioHistory {
    const source = this.#projector.snapshot();
    if (!this.#history?.matches(source)) this.#history = new StudioHistory(source);
    return this.#history;
  }

  workspace(
    query = "",
    offset = 0,
    selectedRunId?: string | null,
    pipelineId = ""
  ): Promise<StudioSnapshot> {
    return this.#serialize(async () => {
      await this.#appendNewEvents();
      return this.#indexedHistory().workspace(
        this.#revision,
        query,
        offset,
        selectedRunId,
        pipelineId
      );
    });
  }

  detail(runId: string): Promise<StudioRunDetail | undefined> {
    return this.#serialize(async () => {
      await this.#appendNewEvents();
      const history = this.#indexedHistory();
      const run = await this.#details.read(runId);
      return run ? history.detail(run) : undefined;
    });
  }

  childRuns(runId: string, page: number): Promise<StudioChildRuns | undefined> {
    return this.#serialize(async () => {
      await this.#appendNewEvents();
      return this.#indexedHistory().childRuns(runId, page);
    });
  }

  definition(
    pipelineId: string,
    definitionId?: string
  ): Promise<StoredPipelineDefinition | undefined> {
    return this.#serialize(async () => {
      await this.#appendNewEvents();
      return this.#indexedHistory().definition(pipelineId, definitionId);
    });
  }

  definitionRuns(
    pipelineId: string,
    definitionId?: string,
    offset = 0
  ): Promise<StudioDefinitionRuns | undefined> {
    return this.#serialize(async () => {
      await this.#appendNewEvents();
      return this.#indexedHistory().definitionRuns(pipelineId, definitionId, offset);
    });
  }

  clear(
    history: PipelineRunStudioHistoryMaintenance
  ): Promise<{ eventCount: number; runCount: number }> {
    return this.#serialize(async () => {
      if (await history.isBusy?.()) throw new PipelineRunStudioHistoryBusyError();
      await this.#appendNewEvents();
      const snapshot = this.#projector.snapshot();
      await history.clear();
      this.#lastEventId = undefined;
      this.#projector.clear();
      this.#details.clear();
      this.#history = undefined;
      this.#revision += 1;
      return {
        eventCount: snapshot.runs.reduce((n, run) => n + run.eventCount, 0),
        runCount: snapshot.runs.length,
      };
    });
  }
}
