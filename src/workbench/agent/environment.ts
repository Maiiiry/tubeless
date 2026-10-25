import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { parseEnv } from "node:util";
import { TUBELESS_WORKBENCH_EXIT_CODE, type WorkbenchCliIo } from "../workbench-shared.js";

/** Parse an explicitly selected dotenv file without executing it or changing process.env. */
export async function loadAgentEnvironment(
  file: string | undefined,
  io: WorkbenchCliIo
): Promise<{ env: Readonly<NodeJS.ProcessEnv> } | { exitCode: number }> {
  let fileEnv: NodeJS.ProcessEnv = {};
  if (file !== undefined) {
    try {
      const text = await readFile(path.resolve(io.cwd, file), {
        encoding: "utf8",
        signal: io.signal,
      });
      fileEnv = parseEnv(text);
    } catch {
      if (io.signal?.aborted) return { exitCode: TUBELESS_WORKBENCH_EXIT_CODE.cancellation };
      // Filesystem and parser errors may include secret contents. Report only the action.
      io.stderr.write("Error: Cannot read --env-file. Supply a readable dotenv file.\n");
      return { exitCode: TUBELESS_WORKBENCH_EXIT_CODE.load };
    }
  }
  return { env: Object.freeze({ ...fileEnv, ...process.env }) };
}
