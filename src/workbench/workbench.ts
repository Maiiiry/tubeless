import { didYouMean } from "../utilities/suggest.js";
import { runGraph, runInspect, runList, runPlan, runValidate } from "./workbench-commands.js";
import { runComplete, runCompletion } from "./workbench-completion.js";
import { runHistory } from "./workbench-history.js";
import { runCommand } from "./workbench-run.js";
import { runUpgrade } from "./workbench-upgrade.js";
import {
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";
import { runUi } from "./workbench-ui.js";

export { TUBELESS_WORKBENCH_EXIT_CODE, type WorkbenchCliIo } from "./workbench-shared.js";

/** Public subcommands in usage order; dispatch, typo suggestions, and completion share it. */
const WORKBENCH_COMMANDS = [
  { name: "list", description: "List pipelines or commands in the project file", run: runList },
  {
    name: "validate",
    description: "Check a YAML or JSON pipeline document without loading handlers",
    run: runValidate,
  },
  {
    name: "inspect",
    description: "Show pipeline identity and the default structural plan",
    run: runInspect,
  },
  {
    name: "plan",
    description: "Preview step selection without executing the pipeline",
    run: runPlan,
  },
  { name: "graph", description: "Generate Mermaid flowchart source", run: runGraph },
  {
    name: "run",
    description: "Execute a project pipeline or a pipeline or command file",
    run: runCommand,
  },
  {
    name: "history",
    description: "Show recorded runs from the local SQLite store",
    run: runHistory,
  },
  { name: "upgrade", description: "Rewrite an older SQLite run store before writing to it", run: runUpgrade },
  { name: "agent", description: "Prompt a workspace agent with a live execution DAG", run: async (argv, io) => (await import("./workbench-agent.js")).runAgent(argv, io) },
  { name: "init", description: "Scaffold a deployment (cloudflare)", run: async (argv, io) => (await import("./workbench-init.js")).runInit(argv, io) },
  { name: "auth", description: "Sign in to Tubeless Cloud", run: async (argv, io) => (await import("./workbench-auth.js")).runAuth(argv, io) },
  { name: "cloud", description: "List and run deployed Cloud pipelines", run: async (argv, io) => (await import("./workbench-cloud.js")).runCloud(argv, io) },
  { name: "ui", description: "Open the optional local run studio", run: runUi },
  {
    name: "completion",
    description: "Print a shell completion script (bash, zsh, fish)",
    run: runCompletion,
  },
] as const satisfies readonly {
  name: string;
  description: string;
  run(argv: readonly string[], io: WorkbenchCliIo): Promise<number>;
}[];

const WORKBENCH_USAGE = `Usage: tubeless <command> [options] <registered-id|pipeline-or-command-file>

Inspect, plan, visualize, or safely run exported tubeless workflows.

Commands:
${WORKBENCH_COMMANDS.map(({ name, description }) => `  tubeless ${name.padEnd(10)}  ${description}\n`).join("")}
Run tubeless <command> --help for command-specific options.
`;

/** Run the `tubeless` development workbench. */
export async function runWorkbenchCli(
  argv: readonly string[],
  io: WorkbenchCliIo
): Promise<number> {
  const [command, ...commandArgs] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    io.stdout.write(WORKBENCH_USAGE);
    return TUBELESS_WORKBENCH_EXIT_CODE.success;
  }
  if (command === undefined) {
    return writeUsageError(io, "Pass a command.", WORKBENCH_USAGE);
  }
  // Hidden protocol command behind the generated shell completion scripts.
  if (command === "__complete") return runComplete(commandArgs, io, WORKBENCH_COMMANDS);
  const entry = WORKBENCH_COMMANDS.find(({ name }) => name === command);
  if (entry) return entry.run(commandArgs, io);
  const suggestion = didYouMean(command, [...WORKBENCH_COMMANDS.map(({ name }) => name), "help"]);
  return writeUsageError(
    io,
    suggestion === undefined
      ? `Unknown command ${JSON.stringify(command)}.`
      : `Unknown command ${JSON.stringify(command)}. ${suggestion}`,
    WORKBENCH_USAGE
  );
}
