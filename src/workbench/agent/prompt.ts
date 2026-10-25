import { defineModelAgent, type AgentLimits, type AgentModel } from "../../agent/agent.js";
import { ownState } from "../../agent/agent-state.js";
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
  readonly graph: boolean;
}

type PromptOutcome =
  | { readonly status: "completed"; readonly answer: string; readonly conversation: unknown }
  | { readonly status: "failed" | "cancelled"; readonly message: string };

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
  conversation: unknown
): Promise<{ readonly exitCode: number; readonly conversation: unknown }> {
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
    let nextConversation = conversation;
    const provider = model as AgentModel;
    const agent = defineModelAgent({
      id: "tubeless-agent",
      model: async (request, context) => {
        const response = await provider(
          context.turn === 1 ? { ...request, conversation } : request,
          context
        );
        // Include the finish response, which is not reduced into another decision.
        nextConversation = ownState(response.conversation);
        return { ...response, conversation: nextConversation };
      },
      instructions: options.instructions,
      limits: options.limits,
    });
    const run = await agent.run({ task }, undefined, {
      cwd: io.cwd,
      signal,
      // Interactive reporting sanitizes and scopes logs itself. Plain model/tool
      // logs are sanitized separately from the reporter's trusted styling.
      log: reporter?.mode === "interactive" ? reporter.log : promptLogger(io),
      hooks: reporter?.hooks,
    });
    if (run.status === "completed" && run.finalized) {
      outcome = { status: "completed", answer: run.value.answer, conversation: nextConversation };
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
    return { exitCode: TUBELESS_WORKBENCH_EXIT_CODE.success, conversation: outcome.conversation };
  }
  io.stderr.write(`${outcome.message}\n`);
  return {
    exitCode:
      outcome.status === "cancelled"
        ? TUBELESS_WORKBENCH_EXIT_CODE.cancellation
        : TUBELESS_WORKBENCH_EXIT_CODE.execution,
    conversation,
  };
}
