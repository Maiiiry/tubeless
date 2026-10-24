import { stat } from "node:fs/promises";
import * as path from "node:path";
import { upgradeSqlitePipelineRunStore } from "../run-store/run-store-sqlite.js";
import {
  DEFAULT_PIPELINE_RUN_STORE,
  errorMessage,
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeCliChunk,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";
import { parseSubcommandArgs, runWorkbenchSubcommand } from "./workbench-subcommand.js";

const UPGRADE_USAGE = `Usage: tubeless upgrade [options]

Rewrite an older SQLite run store to the current schema.

The upgrade rewrites the history file in place and cannot be undone. Versions 1
and 2 rebuild the event table, keep event ids, and rename retired PIPES_ error
codes to TUBELESS_. Version 3 adds a column. Run this before an unattended
\`tubeless run --store\` or \`tubeless ui\` so that job does not stop on an older store.

Options:
      --store <path>    SQLite database (default: .tubeless/runs.sqlite)
      --yes             Confirm the rewrite; there is no interactive prompt
  -h, --help            Show this help
`;

function parseUpgradeArgs(argv: readonly string[]) {
  return parseSubcommandArgs(argv, {
    store: { type: "string" },
    yes: { type: "boolean" },
  });
}

/** Confirm and apply a SQLite run-store schema upgrade. */
export async function runUpgrade(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      usage: UPGRADE_USAGE,
      parse: parseUpgradeArgs,
      async run(parsed, commandIo) {
        if (parsed.positionals.length > 0) {
          return writeUsageError(
            commandIo,
            "upgrade does not take a positional argument.",
            UPGRADE_USAGE
          );
        }
        const filename = path.resolve(
          commandIo.cwd,
          parsed.values.store ?? DEFAULT_PIPELINE_RUN_STORE
        );
        try {
          await stat(filename);
        } catch {
          commandIo.stderr.write(`Error: Run store not found at ${filename}\n`);
          return TUBELESS_WORKBENCH_EXIT_CODE.load;
        }
        if (parsed.values.yes !== true) {
          return writeUsageError(
            commandIo,
            `Refusing to upgrade ${filename}. This rewrites the history file in place and cannot be undone. Pass --yes to continue.`,
            UPGRADE_USAGE
          );
        }
        try {
          const result = await upgradeSqlitePipelineRunStore(filename);
          const message =
            result.from === result.to
              ? `${filename} is already schema version ${result.to}.\n`
              : `Upgraded ${filename} from schema version ${result.from} to ${result.to}.\n`;
          await writeCliChunk(commandIo.stdout, message);
          return TUBELESS_WORKBENCH_EXIT_CODE.success;
        } catch (error) {
          commandIo.stderr.write(`Error: ${errorMessage(error)}\n`);
          return TUBELESS_WORKBENCH_EXIT_CODE.load;
        }
      },
    },
    argv,
    io
  );
}
