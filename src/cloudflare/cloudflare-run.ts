import {
  executeHostedCommand,
  hostedCommandContext,
  type HostedCommand,
  type HostedOutput,
} from "../hosting/hosting-commands.js";
import type { PipelineTraceEvent, PipelineTraceExporter } from "../tracing/tracing.js";
import type { DurableStorageLike } from "./cloudflare-storage.js";

/** Alarm wall time is 15 minutes; abort earlier so the run records its own outcome. */
export const MAX_RUN_DURATION_MS = 840_000;
const HOST_TERMINATED = "The Cloudflare run host stopped before the run finished.";

export interface RunJob {
  readonly launchId: string;
  readonly commandId: string;
  readonly values: Record<string, unknown>;
  readonly maxRunDurationMs: number;
}

export interface StudioIngest {
  /** Studio's consent to execute; false when the launch is unknown or already closed. */
  admit(launchId: string): Promise<{ readonly admitted: boolean }>;
  /** `accepted` is false when Studio already closed the launch and refused the batch. */
  appendEvents(
    launchId: string,
    sequence: number,
    events: PipelineTraceEvent[]
  ): Promise<{ readonly accepted: boolean }>;
  reportFailure(launchId: string, message: string): Promise<void>;
}

export interface BatchingOptions {
  readonly maxEvents: number;
  readonly maxDelayMs: number;
  readonly retries: number;
  readonly retryDelayMs: number;
  onFailure(error: unknown): void;
  readonly sleep?: (ms: number) => Promise<void>;
}

const boundedDuration = (job: RunJob) => Math.min(job.maxRunDurationMs, MAX_RUN_DURATION_MS);

const isTopLevelStart = (event: PipelineTraceEvent) =>
  event.name === "pipeline.started" && event.parentRunId === undefined;

/** Deliver numbered batches in order; a numbered batch is applied at most once by the Studio object. */
export class BatchingTraceExporter implements PipelineTraceExporter {
  #pending: PipelineTraceEvent[] = [];
  #sequence = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #chain: Promise<void> = Promise.resolve();
  #failed = false;

  constructor(
    private readonly send: (sequence: number, events: PipelineTraceEvent[]) => Promise<void>,
    private readonly options: BatchingOptions
  ) {}

  export(event: PipelineTraceEvent): void | Promise<void> {
    this.#pending.push(event);
    if (isTopLevelStart(event) || this.#pending.length >= this.options.maxEvents) {
      return this.flush();
    }
    this.#timer ??= setTimeout(() => void this.flush().catch(() => {}), this.options.maxDelayMs);
  }

  flush(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const events = this.#pending.splice(0);
    if (events.length > 0) {
      const sequence = this.#sequence++;
      this.#chain = this.#chain.then(() => this.#deliver(sequence, events));
    }
    return this.#chain;
  }

  async #deliver(sequence: number, events: PipelineTraceEvent[]): Promise<void> {
    const sleep =
      this.options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.send(sequence, events);
        return;
      } catch (error) {
        if (attempt >= this.options.retries) {
          if (!this.#failed) {
            this.#failed = true;
            this.options.onFailure(error);
          }
          throw error;
        }
        await sleep(this.options.retryDelayMs * 2 ** attempt);
      }
    }
  }
}

function capturingOutput(): HostedOutput & { tail(): string } {
  const lines: string[] = [];
  const keep = (chunk: string) => {
    lines.push(chunk);
    if (lines.length > 20) lines.shift();
  };
  return {
    cwd: "/tmp",
    stdout: { write: (chunk) => void console.log(chunk.trimEnd()) },
    stderr: {
      write: (chunk) => {
        keep(chunk);
        console.error(chunk.trimEnd());
      },
    },
    tail: () => lines.join("").trim().slice(-2_000),
  };
}

/** Ask Studio to admit the launch; any failure to confirm admission means do not execute. */
async function admitted(ingest: StudioIngest, launchId: string): Promise<boolean> {
  try {
    return (await ingest.admit(launchId)).admitted;
  } catch (error) {
    console.error(error);
    return false;
  }
}

/** Execute one admitted job; report failures that never produced a recorded run. */
export async function runHostedJob(options: {
  readonly job: RunJob;
  readonly commands: ReadonlyMap<string, HostedCommand>;
  readonly ingest: StudioIngest;
  readonly controller: AbortController;
}): Promise<void> {
  const { job, ingest, controller } = options;
  const entry = options.commands.get(job.commandId);
  if (!entry) {
    await ingest.reportFailure(job.launchId, "Pipeline command not found.");
    return;
  }
  const output = capturingOutput();
  const parsed = entry.command.parseValues(
    job.values,
    hostedCommandContext(output, controller.signal)
  );
  if (parsed.kind !== "values") {
    await ingest.reportFailure(
      job.launchId,
      parsed.kind === "error" ? parsed.errors.join("\n") : "Help is not a launchable value set."
    );
    return;
  }
  // Core does not await exporters, so a refused batch could arrive after a step's side effects.
  // Admission happens before any user code runs; a refused launch was already closed by Studio.
  if (!(await admitted(ingest, job.launchId))) return;
  let recorded = false;
  let deliveryFailure: { readonly error: unknown } | undefined;
  const batches = new BatchingTraceExporter(
    async (sequence, events) => {
      const { accepted } = await ingest.appendEvents(job.launchId, sequence, events);
      // Studio already failed this launch (for example, after an unconfirmed start), so
      // nothing more would be recorded and the run could not be cancelled.
      if (!accepted) controller.abort(new Error("Studio closed this launch; stopping the run."));
    },
    {
      maxEvents: 50,
      maxDelayMs: 250,
      retries: 4,
      retryDelayMs: 250,
      onFailure: (error) => {
        deliveryFailure = { error };
        controller.abort(error);
      },
    }
  );
  const exporter: PipelineTraceExporter = {
    export(event) {
      if (isTopLevelStart(event)) recorded = true;
      return batches.export(event);
    },
    flush: () => batches.flush(),
  };
  const deadline = setTimeout(
    () =>
      controller.abort(new DOMException("The run exceeded its maximum duration.", "TimeoutError")),
    boundedDuration(job)
  );
  let exitCode: number;
  try {
    exitCode = await executeHostedCommand(entry.command, parsed.values, output, controller.signal, {
      tracing: { exporter },
    });
  } finally {
    clearTimeout(deadline);
    // Drain pending events so no timer can deliver after the job's cleanup.
    await batches.flush().catch(() => {});
  }
  if (deliveryFailure) {
    // The run may be fully recorded locally yet unknown to Studio; tell it, best effort.
    const { error } = deliveryFailure;
    const message = error instanceof Error ? error.message : String(error);
    await ingest
      .reportFailure(job.launchId, `Run events could not be delivered to Studio: ${message}`)
      .catch((reportError: unknown) => {
        console.error(reportError);
      });
  } else if (!recorded) {
    const detail = output.tail();
    await ingest.reportFailure(
      job.launchId,
      `Pipeline command exited (${exitCode}) before recording a run.${detail ? `\n${detail}` : ""}`
    );
  }
}

/** Alarm-driven execution state machine for one launch. Never rethrows from alarm(). */
export class RunObjectCore {
  #controller: AbortController | undefined;
  readonly #now: () => number;

  constructor(
    private readonly deps: {
      readonly storage: DurableStorageLike;
      readonly commands: ReadonlyMap<string, HostedCommand>;
      readonly ingest: () => StudioIngest;
      readonly now?: () => number;
    }
  ) {
    this.#now = deps.now ?? Date.now;
  }

  async start(job: RunJob): Promise<void> {
    const { storage } = this.deps;
    if ((await storage.get("job")) !== undefined) return;
    await storage.put("job", job);
    await storage.put("state", "pending");
    await storage.setAlarm(this.#now());
  }

  cancel(): boolean {
    const controller = this.#controller;
    if (!controller || controller.signal.aborted) return false;
    controller.abort(new DOMException("The run was cancelled.", "AbortError"));
    return true;
  }

  async alarm(): Promise<void> {
    try {
      await this.#runAlarm();
    } catch (error) {
      // Workers retries a throwing alarm up to 6 times; never re-run user code.
      console.error(error);
    }
  }

  async #runAlarm(): Promise<void> {
    const { storage } = this.deps;
    const job = await storage.get<RunJob>("job");
    if (!job) return;
    const ingest = this.deps.ingest();
    if ((await storage.get("state")) === "running") {
      // Alarms never overlap, so a running state here means an earlier attempt died.
      await ingest.reportFailure(job.launchId, HOST_TERMINATED).catch((error: unknown) => {
        console.error(error);
      });
      await storage.deleteAlarm();
      await storage.deleteAll();
      return;
    }
    await storage.put("state", "running");
    // Post-mortem watchdog: fires only if this invocation is killed before clearing it.
    await storage.setAlarm(this.#now() + boundedDuration(job) + 60_000);
    const controller = new AbortController();
    this.#controller = controller;
    try {
      await runHostedJob({ job, commands: this.deps.commands, ingest, controller });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ingest.reportFailure(job.launchId, `Run host error: ${message}`).catch(() => {});
    } finally {
      this.#controller = undefined;
      await storage.deleteAlarm();
      await storage.deleteAll();
    }
  }
}
