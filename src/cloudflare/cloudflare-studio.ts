import type { PipelineRunControls } from "../core/pipeline.js";
import {
  hostedCommandContext,
  type HostedCommand,
  type HostedOutput,
} from "../hosting/hosting-commands.js";
import { createStudioHost, type StudioHost } from "../hosting/hosting-studio.js";
import type {
  PipelineRunStudioCancelResult,
  PipelineRunStudioLauncher,
  PipelineRunStudioLaunchRequest,
  PipelineRunStudioLaunchResult,
} from "../studio/run-store-ui-protocol.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import { LaunchRegistry } from "./cloudflare-launches.js";
import { openDurableRunStore, type DurableRunStore } from "./cloudflare-run-store.js";
import type { RunJob, StudioIngest } from "./cloudflare-run.js";
import type { DurableStorageLike } from "./cloudflare-storage.js";

const RECONCILE_GRACE_MS = 120_000;
const HOST_TERMINATED = "The Cloudflare run host stopped before the run finished.";
const START_FAILED = "The run host could not start the run.";
const START_UNCONFIRMED =
  "The run host could not confirm the run started. It may have started; check history before launching again.";
const formatDuration = (ms: number) =>
  ms === 1000 ? "1 second" : ms > 1000 && ms % 1000 === 0 ? `${ms / 1000} seconds` : `${ms} ms`;
const SILENT_OUTPUT: HostedOutput = {
  cwd: "/tmp",
  stdout: { write: () => {} },
  stderr: { write: () => {} },
};

export interface RunStubLike {
  start(job: RunJob): Promise<void>;
  cancel(): Promise<boolean> | boolean;
}

export interface StudioObjectDependencies {
  readonly storage: DurableStorageLike;
  readonly commands: ReadonlyMap<string, HostedCommand>;
  readonly clientScript: string;
  readonly maxRunDurationMs: number;
  runStub(launchId: string): RunStubLike;
  readonly now?: () => number;
  readonly startTimeoutMs?: number;
}

class DurableStudioLauncher implements PipelineRunStudioLauncher {
  readonly commands;
  readonly #waiters = new Map<string, (result: PipelineRunStudioLaunchResult) => void>();

  constructor(
    private readonly deps: StudioObjectDependencies,
    private readonly registry: LaunchRegistry,
    private readonly now: () => number
  ) {
    this.commands = [...deps.commands.values()].map((entry) => entry.descriptor);
  }

  plan(commandId: string, input: PipelineRunControls) {
    const entry = this.deps.commands.get(commandId);
    if (!entry) throw new Error("Pipeline planning is not available for this command.");
    return entry.command.plan(input);
  }

  async launch(
    commandId: string,
    values: PipelineRunStudioLaunchRequest["values"]
  ): Promise<PipelineRunStudioLaunchResult> {
    const entry = this.deps.commands.get(commandId);
    if (!entry) return { accepted: false, errors: ["Pipeline command not found."] };
    let parsed: ReturnType<HostedCommand["command"]["parseValues"]>;
    try {
      parsed = entry.command.parseValues(
        values,
        hostedCommandContext(SILENT_OUTPUT, new AbortController().signal)
      );
    } catch (error) {
      return { accepted: false, errors: [error instanceof Error ? error.message : String(error)] };
    }
    if (parsed.kind === "error") return { accepted: false, errors: parsed.errors };
    if (parsed.kind === "help")
      return { accepted: false, errors: ["Help is not a launchable value set."] };
    const launchId = crypto.randomUUID();
    this.registry.create(launchId, commandId, this.now());
    const acknowledged = new Promise<PipelineRunStudioLaunchResult>((resolve) =>
      this.#waiters.set(launchId, resolve)
    );
    const timeoutMs = this.deps.startTimeoutMs ?? 30_000;
    const timeout = setTimeout(
      () =>
        this.settle(launchId, {
          accepted: false,
          errors: [
            `The run did not record a start within ${formatDuration(timeoutMs)}. It may still start; check history before launching again.`,
          ],
        }),
      timeoutMs
    );
    try {
      // Schedule the reconciler before the run can exist so a started run is never unreconciled.
      await this.#scheduleReconcile();
    } catch (error) {
      clearTimeout(timeout);
      this.#failStart(launchId, error, START_FAILED);
      return await acknowledged;
    }
    void Promise.resolve()
      .then(() =>
        this.deps
          .runStub(launchId)
          .start({ launchId, commandId, values, maxRunDurationMs: this.deps.maxRunDurationMs })
      )
      .catch((error: unknown) => this.#failStart(launchId, error, START_UNCONFIRMED));
    try {
      return await acknowledged;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Keep the earliest pending reconcile so steady launches cannot postpone it. */
  async #scheduleReconcile(): Promise<void> {
    const target = this.now() + this.deps.maxRunDurationMs + RECONCILE_GRACE_MS;
    const pending = await this.deps.storage.getAlarm();
    if (pending === null || pending > target) await this.deps.storage.setAlarm(target);
  }

  /** Runs inside a voided promise chain, so it must never throw. */
  #failStart(launchId: string, error: unknown, message: string): void {
    console.error(error);
    try {
      // An admitted run is executing user code; it records its own outcome or is reconciled.
      if (!this.registry.get(launchId)?.admitted) this.registry.fail(launchId, message, this.now());
    } catch (failError) {
      // The reconcile alarm fails the launch later.
      console.error(failError);
    }
    this.settle(launchId, { accepted: false, errors: [message] });
  }

  settle(launchId: string, result: PipelineRunStudioLaunchResult): void {
    const resolve = this.#waiters.get(launchId);
    if (!resolve) return;
    this.#waiters.delete(launchId);
    resolve(result);
  }

  async cancel(runId: string): Promise<PipelineRunStudioCancelResult> {
    const launchId = this.registry.launchIdForRun(runId);
    if (!launchId) return { cancelled: false };
    return (await this.deps.runStub(launchId).cancel())
      ? { cancelled: true, runId }
      : { cancelled: false };
  }

  liveRunIds(): readonly string[] {
    return this.registry.liveRunIds();
  }
}

/** Singleton Studio object: event store, Studio API and launch registry. */
export class StudioObjectCore implements StudioIngest {
  readonly #store: DurableRunStore;
  readonly #registry: LaunchRegistry;
  readonly #launcher: DurableStudioLauncher;
  readonly #now: () => number;
  #host: Promise<StudioHost> | undefined;

  constructor(private readonly deps: StudioObjectDependencies) {
    this.#now = deps.now ?? Date.now;
    this.#store = openDurableRunStore(deps.storage);
    this.#registry = new LaunchRegistry(deps.storage, this.#store);
    this.#launcher = new DurableStudioLauncher(deps, this.#registry, this.#now);
  }

  async fetch(request: Request): Promise<Response> {
    this.#host ??= createStudioHost({
      store: this.#store,
      launcher: this.#launcher,
      clientScript: this.deps.clientScript,
    });
    return (await this.#host).fetch(request);
  }

  async admit(launchId: string): Promise<{ admitted: boolean }> {
    return { admitted: this.#registry.admit(launchId) };
  }

  async appendEvents(
    launchId: string,
    sequence: number,
    events: PipelineTraceEvent[]
  ): Promise<{ accepted: boolean }> {
    const outcome = this.#registry.acceptBatch(launchId, sequence, events);
    if (outcome.boundRunId)
      this.#launcher.settle(launchId, { accepted: true, runId: outcome.boundRunId });
    return { accepted: !outcome.dropped };
  }

  async reportFailure(launchId: string, message: string): Promise<void> {
    this.#registry.fail(launchId, message, this.#now());
    this.#launcher.settle(launchId, { accepted: false, errors: [message] });
  }

  async alarm(): Promise<void> {
    const now = this.#now();
    for (const launchId of this.#registry.stale(
      now - this.deps.maxRunDurationMs - RECONCILE_GRACE_MS
    )) {
      await this.reportFailure(launchId, HOST_TERMINATED);
    }
    if (this.#registry.hasActive()) {
      await this.deps.storage.setAlarm(now + this.deps.maxRunDurationMs + RECONCILE_GRACE_MS);
    }
  }
}
