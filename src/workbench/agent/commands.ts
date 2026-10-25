import type { CompleterResult } from "node:readline";

const COMMANDS = [
  {
    name: "/model",
    arguments: " [name]",
    action: "model",
    description: "Show or change the model for the next task.",
  },
  { name: "/clear", arguments: "", action: "clear", description: "Start a fresh conversation." },
  { name: "/help", arguments: "", action: "help", description: "Show these commands." },
  { name: "/quit", arguments: "", action: "quit", description: "Exit the agent." },
  { name: "/exit", arguments: "", action: "quit", description: "Alias for /quit." },
] as const;

export const AGENT_REPL_HELP =
  "Conversation continues across prompts; /clear starts fresh.\n" +
  COMMANDS.map(
    (command) => `  ${`${command.name}${command.arguments}`.padEnd(16)}${command.description}`
  ).join("\n") +
  "\nTab completes /commands; press Tab twice to list matches.\nCtrl-C cancels active work; Ctrl-C at the prompt exits.\n";

/** Complete only the command token, leaving task text and command arguments untouched. */
export function completeAgentCommand(line: string): CompleterResult {
  const matches =
    line.startsWith("/") && !/\s/.test(line)
      ? COMMANDS.filter((command) => command.name.startsWith(line)).map(
          (command) => `${command.name}${command.action === "model" ? " " : ""}`
        )
      : [];
  return [matches, line];
}

export function parseAgentCommand(task: string) {
  const command = COMMANDS.find(
    (command) =>
      task === command.name || (command.action === "model" && task.startsWith(`${command.name} `))
  );
  return command && { action: command.action, value: task.slice(command.name.length).trim() };
}
