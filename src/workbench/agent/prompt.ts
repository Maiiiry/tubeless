import {
  createAgentSession,
  defineAgent,
  type AgentLimits,
  type AgentModel,
  type AgentSession,
  type DefaultAgentToolName,
} from "../../agent/agent.js";
import type { PipelineLogger } from "../../core/pipeline.js";
import { createPipelineReporter } from "../../reporter/interactive-reporter.js";
import { safeTerminalLog, safeTerminalText } from "../../reporter/terminal-text.js";
import { awaitWithAbort, throwIfAborted } from "../../utilities/abort.js";
import {
  commandContext,
  errorMessage,
  TUBELESS_WORKBENCH_EXIT_CODE,
  type WorkbenchCliIo,
} from "../workbench-shared.js";

export type AgentModelFactory = (options: {
  readonly model: string;
  readonly signal: AbortSignal;
  readonly env: Readonly<NodeJS.ProcessEnv>;
}) => AgentModel | Promise<AgentModel>;

export interface AgentPromptOptions {
  readonly model: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly instructions?: string;
  readonly limits: AgentLimits;
  readonly defaultTools?: readonly DefaultAgentToolName[];
  readonly codemode?: boolean;
  readonly graph: boolean;
}

type PromptOutcome =
  | { readonly status: "completed"; readonly answer: string }
  | { readonly status: "failed" | "cancelled"; readonly message: string };

/** One REPL conversation; each prompt selects the provider its factory returned. */
export interface AgentPromptSession {
  readonly session: AgentSession<{ task: string }, { answer: string }>;
  use(model: AgentModel): void;
}

export function createPromptSession(options: AgentPromptOptions): AgentPromptSession {
  let provider: AgentModel | undefined;
  const agent = defineAgent({
    id: "tubeless-agent",
    model: (request, context) => {
      if (!provider) throw new Error("No model is selected for this prompt.");
      return provider(request, context);
    },
    instructions: options.instructions,
    limits: options.limits,
    defaultTools: options.defaultTools,
    codemode: options.codemode,
  });
  return {
    session: createAgentSession(agent),
    use: (model) => {
      provider = model;
    },
  };
}

function promptLogger(io: WorkbenchCliIo): PipelineLogger {
  const write = (output: WorkbenchCliIo["stdout"], values: unknown[]) =>
    output.write(`${safeTerminalLog(values.map(String).join(" "))}\n`);
  return {
    log: (...values) => {
      write(io.stdout, values);
    },
    warn: (...values) => {
      write(io.stderr, values);
    },
    error: (...values) => {
      write(io.stderr, values);
    },
  };
}

/** Run an ordinary pipeline reporter, disposing it before the answer or next prompt. */
export async function executeAgentPrompt(
  task: string,
  options: AgentPromptOptions,
  factory: AgentModelFactory,
  io: WorkbenchCliIo,
  signal: AbortSignal,
  chat: AgentPromptSession
): Promise<number> {
  io.stdout.write(`\nagent · ${safeTerminalText(options.model)}\n`);
  const context = commandContext(io, signal);
  const reporter = options.graph
    ? createPipelineReporter<{ answer: string }>({
        log: context.log,
        output: context.reporterOutput,
      })
    : undefined;
  let outcome: PromptOutcome;
  try {
    throwIfAborted(signal, "Model initialization");
    const model: unknown = await awaitWithAbort(
      Promise.resolve(factory({ model: options.model, signal, env: options.env })),
      signal,
      "Model initialization"
    );
    if (typeof model !== "function")
      throw new Error("Model factory must return an AgentModel function.");
    // SAFETY: the plugin is trusted code; the agent validates every returned decision.
    chat.use(model as AgentModel);
    // The session commits the conversation only after this run completes and finalizes.
    const run = await chat.session.run({ task }, undefined, {
      cwd: io.cwd,
      signal,
      // Interactive reporting sanitizes and scopes logs itself. Plain model/tool
      // logs are sanitized separately from the reporter's trusted styling.
      log: reporter?.mode === "interactive" ? reporter.log : promptLogger(io),
      hooks: reporter?.hooks,
    });
    if (run.status === "completed" && run.finalized) {
      outcome = { status: "completed", answer: run.value.answer };
    } else {
      const failedStatus = run.status === "cancelled" ? "cancelled" : "failed";
      outcome = {
        status: failedStatus,
        message: `${failedStatus === "cancelled" ? "Cancelled" : "Agent failed"}: ${run.errors.map((error) => safeTerminalText(error.message)).join("; ")}`,
      };
    }
  } catch (error) {
    const status = signal.aborted ? "cancelled" : "failed";
    outcome = {
      status,
      message: `${status === "cancelled" ? "Cancelled" : "Error"}: ${safeTerminalText(errorMessage(error))}`,
    };
  } finally {
    reporter?.dispose();
  }
  if (outcome.status === "completed") {
    io.stdout.write(`\n${safeTerminalLog(outcome.answer)}\n\n`);
    return TUBELESS_WORKBENCH_EXIT_CODE.success;
  }
  io.stderr.write(`${outcome.message}\n`);
  return outcome.status === "cancelled"
    ? TUBELESS_WORKBENCH_EXIT_CODE.cancellation
    : TUBELESS_WORKBENCH_EXIT_CODE.execution;
}
