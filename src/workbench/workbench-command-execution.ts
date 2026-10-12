import type { PipelineContext } from "../core/pipeline.js";
import {
  executeHostedCommandOperation,
  hostedCommandContext,
} from "../hosting/hosting-commands.js";
import type { WorkbenchPipelineCommand } from "./pipeline-module.js";
import type { WorkbenchCliIo } from "./workbench-shared.js";

export async function executePipelineCommand(
  command: Pick<WorkbenchPipelineCommand, "run">,
  args: readonly string[],
  io: WorkbenchCliIo,
  signal: AbortSignal,
  pipelineContext?: Omit<PipelineContext, "cwd" | "log" | "signal">
): Promise<number> {
  return executeHostedCommandOperation(
    async () => {
      await command.run(args, hostedCommandContext(io, signal, pipelineContext));
    },
    io,
    signal
  );
}

/** Execute already validated structured command values through the normal workbench errors. */
export { executeHostedCommand as executePipelineCommandValues } from "../hosting/hosting-commands.js";
