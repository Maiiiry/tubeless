import { safeTerminalText } from "../../reporter/terminal-text.js";
import { createReporterTheme } from "../../reporter/reporter.js";
import { AGENT_REPL_HELP, parseAgentCommand } from "./commands.js";
import { AgentInput } from "./input.js";
import {
  createPromptSession,
  executeAgentPrompt,
  type AgentModelFactory,
  type AgentPromptOptions,
} from "./prompt.js";
import { TUBELESS_WORKBENCH_EXIT_CODE, type WorkbenchCliIo } from "../workbench-shared.js";

/** Own commands and session cancellation; single prompts use the same task loop. */
export async function runAgentSession(
  options: AgentPromptOptions & { readonly prompt?: string },
  factory: AgentModelFactory,
  io: WorkbenchCliIo
): Promise<number> {
  const session = new AbortController();
  let active: AbortController | undefined;
  let selectedModel = options.model;
  const chat = createPromptSession(options);
  let exitCode: number = TUBELESS_WORKBENCH_EXIT_CODE.success;
  const interrupt = () => {
    if (active) active.abort();
    else input?.close();
  };
  const prompts = options.prompt === undefined ? new AgentInput(io, interrupt) : [options.prompt];
  const input = prompts instanceof AgentInput ? prompts : undefined;
  const terminate = () => {
    session.abort();
    input?.close();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  io.signal?.addEventListener("abort", terminate, { once: true });
  try {
    if (input) {
      const theme = createReporterTheme({
        color: input.interactive ? "auto" : "never",
        terminal: { isTTY: input.interactive },
      });
      const title = theme.styled.pipeline(
        input.interactive ? "◯╱◯ Tubeless agent" : "Tubeless agent"
      );
      const model = theme.styled.description(`· ${safeTerminalText(selectedModel)}`);
      const hint =
        "Type a task · /help for commands" +
        (input.interactive ? " · Tab completes /commands" : "");
      io.stdout.write(
        `\n${title} ${model}\n${theme.styled.description(hint)}\nConversation continues across prompts · /clear to start fresh.\n\n`
      );
    }
    if (io.signal?.aborted) terminate();
    for await (const line of prompts) {
      if (session.signal.aborted) break;
      const task = line.trim();
      if (!task) continue;
      if (input && task.startsWith("/")) {
        const command = parseAgentCommand(task);
        if (command?.action === "quit") break;
        if (command?.action === "help") {
          io.stdout.write(AGENT_REPL_HELP);
          continue;
        }
        if (command?.action === "clear") {
          chat.session.clear();
          io.stdout.write("Conversation cleared.\n");
          continue;
        }
        if (command?.action === "model") {
          selectedModel = command.value || selectedModel;
          io.stdout.write(`Model: ${safeTerminalText(selectedModel)}\n`);
          continue;
        }
        io.stderr.write(`Unknown REPL command: ${safeTerminalText(task)}\n${AGENT_REPL_HELP}`);
        continue;
      }
      active = new AbortController();
      input?.setRunning(true);
      try {
        exitCode = await executeAgentPrompt(
          task,
          { ...options, model: selectedModel },
          factory,
          io,
          AbortSignal.any([session.signal, active.signal]),
          chat
        );
      } finally {
        active = undefined;
        input?.setRunning(false);
      }
    }
    return session.signal.aborted ? TUBELESS_WORKBENCH_EXIT_CODE.cancellation : exitCode;
  } catch (error) {
    if (session.signal.aborted) return TUBELESS_WORKBENCH_EXIT_CODE.cancellation;
    throw error;
  } finally {
    input?.close();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    io.signal?.removeEventListener("abort", terminate);
  }
}
