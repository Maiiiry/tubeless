import { runGraph, runInspect, runList, runPlan, runValidate } from "./workbench-commands.js";
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

const WORKBENCH_USAGE = `Usage: tubeless <command> [options] <registered-id|pipeline-or-command-file>

Inspect, plan, visualize, or safely run exported tubeless workflows.

Commands:
  tubeless list      List pipelines or commands in the project file
  tubeless validate  Check a YAML or JSON pipeline document without loading handlers
  tubeless inspect   Show pipeline identity and the default structural plan
  tubeless plan      Preview step selection without executing the pipeline
  tubeless graph     Generate Mermaid flowchart source
  tubeless run       Execute a project pipeline or a pipeline or command file
  tubeless agent     Prompt a workspace agent with a live execution DAG
  tubeless history   Show recorded runs from the local SQLite store
  tubeless upgrade   Rewrite an older SQLite run store before writing to it
  tubeless ui        Open the optional local run studio
  tubeless init      Scaffold a deployment (cloudflare)
  tubeless auth      Sign in to Tubeless Cloud
  tubeless cloud     List and run deployed Cloud pipelines

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
  if (command === "auth") {
    const { runAuth } = await import("./workbench-auth.js");
    return runAuth(commandArgs, io);
  }
  if (command === "init") {
    const { runInit } = await import("./workbench-init.js");
    return runInit(commandArgs, io);
  }
  if (command === "cloud") {
    const { runCloud } = await import("./workbench-cloud.js");
    return runCloud(commandArgs, io);
  }
  if (command === "agent") {
    const { runAgent } = await import("./workbench-agent.js");
    return runAgent(commandArgs, io);
  }
  if (command === "list") return runList(commandArgs, io);
  if (command === "validate") return runValidate(commandArgs, io);
  if (command === "inspect") return runInspect(commandArgs, io);
  if (command === "plan") return runPlan(commandArgs, io);
  if (command === "graph") return runGraph(commandArgs, io);
  if (command === "run") return runCommand(commandArgs, io);
  if (command === "history") return runHistory(commandArgs, io);
  if (command === "upgrade") return runUpgrade(commandArgs, io);
  if (command === "ui") return runUi(commandArgs, io);
  return writeUsageError(io, `Unknown command ${JSON.stringify(command)}.`, WORKBENCH_USAGE);
}
