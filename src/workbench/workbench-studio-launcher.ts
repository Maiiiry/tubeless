import type { PipelineRunControls } from "../core/pipeline.js";
import type {
  PipelineRunStudioCommand,
  PipelineRunStudioLauncher,
  PipelineRunStudioLaunchRequest,
  PipelineRunStudioLaunchResult,
  PipelineRunStudioCancelResult,
} from "../studio/shared/protocol.js";
import type { PipelineTraceExporter } from "../tracing/tracing.js";
import type { WorkbenchPipelineCommand } from "./pipeline-module.js";
import { executePipelineCommandValues } from "./workbench-command-execution.js";
import { WorkbenchLaunchSession } from "./workbench-launch-session.js";
import { commandContext, errorMessage, type WorkbenchCliIo } from "./workbench-shared.js";

/** Loaded and validated by the UI command before opening its store. */
export interface WorkbenchStudioRegistration {
  readonly command: Pick<WorkbenchPipelineCommand, "parseValues" | "execute" | "plan">;
  readonly commandIo: WorkbenchCliIo;
  readonly descriptor: PipelineRunStudioCommand;
}

/** Own live Studio executions; the caller owns the server and trace destination. */
export class WorkbenchStudioLauncher implements PipelineRunStudioLauncher {
  readonly commands: readonly PipelineRunStudioCommand[];
  readonly #commandById: ReadonlyMap<string, WorkbenchStudioRegistration>;
  readonly #sessions = new Map<string, WorkbenchLaunchSession>();
  readonly #active = new Set<Promise<void>>();
  readonly #controller = new AbortController();
  readonly #stopping: Promise<void>;
  #markStopping!: () => void;

  constructor(
    registrations: readonly WorkbenchStudioRegistration[],
    private readonly exporter: PipelineTraceExporter
  ) {
    this.commands = registrations.map(({ descriptor }) => descriptor);
    this.#commandById = new Map(registrations.map((entry) => [entry.descriptor.id, entry]));
    this.#stopping = new Promise((resolve) => {
      this.#markStopping = resolve;
    });
  }

  plan(commandId: string, input: PipelineRunControls) {
    const registration = this.#commandById.get(commandId);
    if (!registration?.command.plan) {
      throw new Error("Pipeline planning is not available for this command.");
    }
    return registration.command.plan(input);
  }

  async launch(
    commandId: string,
    values: PipelineRunStudioLaunchRequest["values"]
  ): Promise<PipelineRunStudioLaunchResult> {
    if (this.#controller.signal.aborted) {
      return { accepted: false, errors: ["The local studio is stopping."] };
    }
    const registration = this.#commandById.get(commandId);
    if (!registration) return { accepted: false, errors: ["Pipeline command not found."] };
    const session = new WorkbenchLaunchSession({
      onRunRecorded: (runId) => this.#sessions.set(runId, session),
      signal: this.#controller.signal,
      stopping: this.#stopping,
      store: this.exporter,
    });
    let parsed: ReturnType<WorkbenchPipelineCommand["parseValues"]>;
    try {
      parsed = registration.command.parseValues(
        values,
        commandContext(registration.commandIo, session.signal, session.pipelineContext)
      );
    } catch (error) {
      return { accepted: false, errors: [errorMessage(error)] };
    }
    if (parsed.kind === "error") return { accepted: false, errors: parsed.errors };
    if (parsed.kind === "help") {
      return { accepted: false, errors: ["Help is not a launchable value set."] };
    }
    const execution = executePipelineCommandValues(
      registration.command,
      parsed.values,
      registration.commandIo,
      session.signal,
      session.pipelineContext
    );
    const tracked = session.track(execution, (error) => {
      try {
        registration.commandIo.stderr.write(`Error: ${errorMessage(error)}\n`);
      } catch {
        console.error(error instanceof Error ? (error.stack ?? error.message) : error);
      }
    });
    this.#active.add(tracked.settled);
    void tracked.settled.then(() => {
      this.#active.delete(tracked.settled);
      const runId = session.runId;
      if (runId && this.#sessions.get(runId) === session) this.#sessions.delete(runId);
    });
    return tracked.acknowledgement;
  }

  cancel(runId: string): PipelineRunStudioCancelResult {
    const session = this.#sessions.get(runId);
    if (!session) return { cancelled: false };
    session.abort(new DOMException("The run was cancelled.", "AbortError"));
    return { cancelled: true, runId };
  }

  liveRunIds(): readonly string[] {
    return [...this.#sessions.keys()];
  }

  isBusy(): boolean {
    return this.#active.size > 0;
  }

  /** Release pending launch responses before closing the HTTP server. */
  stop(): void {
    this.#markStopping();
    this.#controller.abort(new DOMException("The local studio is stopping.", "AbortError"));
  }

  /** Wait for all admitted commands before the caller closes the trace destination. */
  async drain(): Promise<void> {
    await Promise.allSettled(this.#active);
  }
}
