import type { PipelineContext } from "../core/pipeline.js";
import type { PipelineRunStudioLaunchResult } from "../studio/server/listener.js";
import type { PipelineTraceEvent, PipelineTraceExporter } from "../tracing/tracing.js";

type ExecutionSettlement =
  | { readonly kind: "exited"; readonly exitCode: number }
  | { readonly error: unknown; readonly kind: "failed" };

type StartSettlement =
  | { readonly kind: "recorded"; readonly runId: string }
  | { readonly error: unknown; readonly kind: "recording-failed" };

interface WorkbenchLaunchSessionOptions {
  readonly onRunRecorded: (runId: string) => void;
  readonly signal: AbortSignal;
  readonly stopping: Promise<void>;
  readonly store: PipelineTraceExporter;
}

interface TrackedWorkbenchLaunch {
  readonly acknowledgement: Promise<PipelineRunStudioLaunchResult>;
  /** Always fulfills after the launched command exits or rejects. */
  readonly settled: Promise<void>;
}

/** Own one Studio launch from pre-execution parsing through recorded completion. */
export class WorkbenchLaunchSession {
  readonly #controller = new AbortController();
  readonly #onRunRecorded: (runId: string) => void;
  readonly #recordedStart: Promise<StartSettlement>;
  readonly #signal: AbortSignal;
  readonly #stopping: Promise<void>;
  readonly #store: PipelineTraceExporter;
  #recordStart!: (settlement: StartSettlement) => void;
  #runId: string | undefined;
  #startObserved = false;

  constructor(options: WorkbenchLaunchSessionOptions) {
    this.#onRunRecorded = options.onRunRecorded;
    this.#signal = AbortSignal.any([options.signal, this.#controller.signal]);
    this.#stopping = options.stopping;
    this.#store = options.store;
    this.#recordedStart = new Promise((resolve) => {
      this.#recordStart = resolve;
    });
  }

  get pipelineContext(): Omit<PipelineContext, "cwd" | "log" | "signal"> {
    const exporter: PipelineTraceExporter = {
      export: (event) => this.#record(event),
      flush: () => this.#store.flush?.(),
    };
    return { tracing: { exporter } };
  }

  get runId(): string | undefined {
    return this.#runId;
  }

  get signal(): AbortSignal {
    return this.#signal;
  }

  abort(reason: unknown): void {
    this.#controller.abort(reason);
  }

  track(
    execution: Promise<number>,
    reportLateFailure: (error: unknown) => void
  ): TrackedWorkbenchLaunch {
    const executionSettlement = execution.then<ExecutionSettlement, ExecutionSettlement>(
      (exitCode) => ({ exitCode, kind: "exited" }),
      (error: unknown) => ({ error, kind: "failed" })
    );
    const acknowledgement = this.#acknowledge(executionSettlement, reportLateFailure);
    return {
      acknowledgement,
      settled: executionSettlement.then(() => undefined),
    };
  }

  async #acknowledge(
    execution: Promise<ExecutionSettlement>,
    reportLateFailure: (error: unknown) => void
  ): Promise<PipelineRunStudioLaunchResult> {
    const outcome = await Promise.race([
      this.#recordedStart,
      execution,
      this.#stopping.then(() => ({ kind: "stopping" }) as const),
    ]);
    if (outcome.kind !== "failed") {
      void execution.then((settlement) => {
        if (settlement.kind === "failed") reportLateFailure(settlement.error);
      });
    }
    switch (outcome.kind) {
      case "recorded":
        return { accepted: true, runId: outcome.runId };
      case "recording-failed":
      case "failed":
        throw outcome.error;
      case "stopping":
        return { accepted: false, errors: ["The local studio is stopping."] };
      case "exited":
        return {
          accepted: false,
          errors: [`Pipeline command exited (${outcome.exitCode}) before recording a run.`],
        };
    }
  }

  async #record(event: PipelineTraceEvent): Promise<void> {
    if (event.name !== "pipeline.started" || this.#startObserved) {
      await this.#store.export(event);
      return;
    }
    this.#startObserved = true;
    try {
      await this.#store.export(event);
      await this.#store.flush?.();
    } catch (error) {
      this.#recordStart({ error, kind: "recording-failed" });
      throw error;
    }
    this.#runId = event.runId;
    this.#onRunRecorded(event.runId);
    this.#recordStart({ kind: "recorded", runId: event.runId });
  }
}
