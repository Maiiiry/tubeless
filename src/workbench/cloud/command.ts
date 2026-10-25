import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { awaitWithAbort } from "../../utilities/abort.js";
import { createCloudClient, CloudClientError, isCloudTransportError } from "./client.js";
import { resolveCloudHost } from "./config.js";
import { resolveCloudCredential } from "./credentials.js";
import {
  CLOUD_INPUT_MAX_DEPTH,
  isCloudJsonValue,
  type CliRun,
  type CloudJsonValue,
} from "./protocol.js";
import { runWorkbenchSubcommand } from "../workbench-subcommand.js";
import {
  type WorkbenchCliIo,
  writeUsageError,
  writeCliChunk,
  terminalSafeText,
} from "../workbench-shared.js";
import {
  cloudErrorExit,
  cloudSignal,
  cloudSleep,
  type CloudCommandDependencies,
} from "./shared.js";

const CLOUD_USAGE = `Usage: tubeless cloud <list|run|logs> [options]

  list [--json]
  run <pipeline-name-or-slug> [--input-file <path|->] [--detach] [--json]
  run --id <cloud-pipeline-id> [--input-file <path|->] [--detach] [--json]
  logs <run-id> [--follow] [--json]

All commands accept --workspace <id>, --host <origin>, and --help.
Use a listed slug or an exact name. Quote names containing spaces.
Run watches logs by default; --detach returns after printing the run ID.
Remote runs use deployed code. Local edits and modules are never loaded.
Set up and load pipelines in the Cloud dashboard.
`;
const COMMON_OPTIONS = ["host", "workspace", "help"];
const COMMAND_OPTIONS: Record<string, string[]> = {
  list: ["json"],
  run: ["id", "input-file", "detach", "json"],
  logs: ["follow", "json"],
};
const INPUT_LIMIT = 64 * 1024;

async function boundedInput(
  file: string,
  cwd: string,
  dependencies: CloudCommandDependencies,
  signal: AbortSignal
): Promise<Record<string, CloudJsonValue>> {
  let text: string;
  if (file === "-") {
    if (dependencies.readStdin)
      text = await awaitWithAbort(dependencies.readStdin(), signal, "Input read");
    else {
      text = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const cleanup = () => {
          process.stdin.off("data", onData);
          process.stdin.off("end", onEnd);
          process.stdin.off("error", onError);
          signal.removeEventListener("abort", onAbort);
          process.stdin.pause();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onAbort = () => onError(new Error("Input read interrupted."));
        const onData = (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > INPUT_LIMIT) {
            onError(new CloudClientError("Input JSON must be at most 64 KB.", "invalid_request"));
            return;
          }
          chunks.push(bytes);
        };
        const onEnd = () => {
          cleanup();
          resolve(Buffer.concat(chunks).toString("utf8"));
        };
        process.stdin.on("data", onData);
        process.stdin.once("end", onEnd);
        process.stdin.once("error", onError);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        else process.stdin.resume();
      });
    }
  } else {
    const fileHandle = await open(
      path.resolve(cwd, file),
      constants.O_RDONLY | constants.O_NONBLOCK
    );
    try {
      if (!(await fileHandle.stat()).isFile())
        throw new CloudClientError("Input file must be a regular file.", "invalid_request");
      const buffer = Buffer.alloc(INPUT_LIMIT + 1);
      let size = 0;
      while (size < buffer.length) {
        if (signal.aborted) throw new Error("Input read interrupted.");
        const read = await fileHandle.read(buffer, size, buffer.length - size, null);
        if (read.bytesRead === 0) break;
        size += read.bytesRead;
      }
      text = buffer.subarray(0, size).toString("utf8");
    } finally {
      await fileHandle.close();
    }
  }
  if (Buffer.byteLength(text) > INPUT_LIMIT)
    throw new CloudClientError("Input JSON must be at most 64 KB.", "invalid_request");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CloudClientError("Input must be valid JSON.", "invalid_request");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new CloudClientError("Input must be a JSON object.", "invalid_request");
  if (!isCloudJsonValue(value))
    throw new CloudClientError(
      `Input must contain JSON data with finite numbers and at most ${CLOUD_INPUT_MAX_DEPTH} levels of objects and arrays.`,
      "invalid_request"
    );
  // SAFETY: The object shape and every JSON value were checked above.
  return value as Record<string, CloudJsonValue>;
}

function runUrl(host: string, workspace: string, id: string): string {
  const url = new URL(`/app/runs/${encodeURIComponent(id)}`, host);
  url.searchParams.set("workspace", workspace);
  return url.href;
}
function terminal(run: CliRun): boolean {
  return ["completed", "failed", "cancelled"].includes(run.status);
}
function runExit(run: CliRun): number {
  return run.status === "completed" ? 0 : run.status === "cancelled" ? 7 : 6;
}

function admissionUncertain(error: unknown): boolean {
  if (!(error instanceof CloudClientError)) return true;
  if (error.status === undefined && error.code === "invalid_request") return false;
  return error.status === undefined || error.status < 400 || error.status >= 500;
}

async function followRun(
  initial: CliRun,
  getRun: () => Promise<CliRun>,
  output: WorkbenchCliIo["stdout"],
  signal: AbortSignal,
  dependencies: CloudCommandDependencies,
  human: boolean
): Promise<CliRun> {
  let current = initial;
  let printed = 0;
  let failures = 0;
  while (true) {
    if (human) {
      for (const log of current.logs.slice(printed))
        await writeCliChunk(
          output,
          `${new Date(log.time).toISOString()} ${log.level}: ${terminalSafeText(log.message)}\n`,
          signal
        );
      printed = Math.max(printed, current.logs.length);
    }
    if (terminal(current)) return current;
    await (dependencies.sleep ?? cloudSleep)(2000 * Math.max(failures, 1), signal);
    try {
      current = await getRun();
      failures = 0;
    } catch (error) {
      if (!isCloudTransportError(error) || ++failures >= 3) throw error;
    }
  }
}

export async function runCloud(
  argv: readonly string[],
  io: WorkbenchCliIo,
  dependencies: CloudCommandDependencies = {}
): Promise<number> {
  return runWorkbenchSubcommand(
    {
      usage: CLOUD_USAGE,
      parse: (args) =>
        parseArgs({
          args: [...args],
          allowPositionals: true,
          strict: true,
          options: {
            help: { type: "boolean", short: "h" },
            host: { type: "string" },
            workspace: { type: "string" },
            id: { type: "string" },
            "input-file": { type: "string" },
            detach: { type: "boolean" },
            json: { type: "boolean" },
            follow: { type: "boolean" },
          },
        }),
      run: async ({ values, positionals }) => {
        const [command, selector] = positionals;
        if (!command || !COMMAND_OPTIONS[command])
          return writeUsageError(io, "Pass list, run, or logs.", CLOUD_USAGE);
        for (const option of Object.keys(values)) {
          if (![...COMMON_OPTIONS, ...COMMAND_OPTIONS[command]!].includes(option))
            return writeUsageError(
              io,
              `--${option} is not supported by cloud ${command}.`,
              CLOUD_USAGE
            );
        }
        const wanted = command === "logs" || (command === "run" && !values.id) ? 2 : 1;
        if (positionals.length !== wanted)
          return writeUsageError(io, "Pass exactly the required command arguments.", CLOUD_USAGE);
        if (values.id && selector)
          return writeUsageError(io, "--id cannot be combined with a pipeline name.", CLOUD_USAGE);
        if (values.workspace !== undefined && !values.workspace.trim())
          return writeUsageError(io, "Pass a nonempty workspace ID.", CLOUD_USAGE);
        if (values.id !== undefined && !values.id.trim())
          return writeUsageError(io, "Pass a nonempty pipeline ID.", CLOUD_USAGE);
        if (values["input-file"] === "")
          return writeUsageError(
            io,
            "Pass a nonempty --input-file path, or - for stdin.",
            CLOUD_USAGE
          );
        const managed = cloudSignal(io);
        let admitted: { id: string; url: string } | undefined;
        try {
          const host = resolveCloudHost(values.host);
          const credential = await resolveCloudCredential(host, {
            store: dependencies.store,
            env: dependencies.env,
            now: dependencies.now,
          });
          if (!credential)
            throw new Error(
              "No active Cloud credential. Run tubeless auth login or supply TUBELESS_TOKEN."
            );
          const client = createCloudClient({
            host,
            token: credential.token,
            fetch: dependencies.fetch,
            signal: managed.signal,
          });
          let workspace = values.workspace;
          if (!workspace) {
            const session = await client.session();
            if (session.workspaces.length === 0)
              throw new Error(
                "No Cloud workspaces are available. Create or join a workspace in the Cloud dashboard, then try again."
              );
            if (session.workspaces.length !== 1)
              throw new Error(
                `Choose a workspace with --workspace <id>:\n${session.workspaces.map((item) => `${item.name} (${item.id})`).join("\n")}`
              );
            workspace = session.workspaces[0]!.id;
          }
          if (command === "list") {
            const pipelines = await client.pipelines(workspace);
            if (values.json) io.stdout.write(`${JSON.stringify(pipelines)}\n`);
            else
              for (const pipeline of pipelines)
                io.stdout.write(
                  `${terminalSafeText(pipeline.slug)}: ${terminalSafeText(pipeline.name)} (${terminalSafeText(pipeline.id)}) ${pipeline.available ? "available" : "unavailable"} commit=${terminalSafeText(pipeline.commit)} branch=${terminalSafeText(pipeline.branch)}\n`
                );
            return 0;
          }
          if (command === "logs") {
            let run = await client.getRun(workspace, selector!);
            admitted = { id: run.id, url: runUrl(host, workspace, run.id) };
            if (values.follow)
              run = await followRun(
                run,
                () => client.getRun(workspace, run.id),
                io.stdout,
                managed.signal,
                dependencies,
                !values.json
              );
            else if (!values.json)
              for (const log of run.logs)
                await writeCliChunk(
                  io.stdout,
                  `${new Date(log.time).toISOString()} ${log.level}: ${terminalSafeText(log.message)}\n`,
                  managed.signal
                );
            if (values.json)
              io.stdout.write(
                `${JSON.stringify({ id: run.id, pipelineId: run.pipelineId, status: run.status, logs: run.logs })}\n`
              );
            else
              io.stdout.write(
                `Run ${terminalSafeText(run.id)}: ${run.status}\n${terminalSafeText(admitted.url)}\n`
              );
            return values.follow ? runExit(run) : 0;
          }
          const pipelines = await client.pipelines(workspace);
          const matches = pipelines.filter((item) =>
            values.id ? item.id === values.id : item.name === selector || item.slug === selector
          );
          if (matches.length === 0)
            throw new Error(
              "Cloud pipeline not found in this workspace. Use tubeless cloud list or the Cloud dashboard to select a loaded pipeline."
            );
          if (matches.length !== 1)
            throw new Error(
              `Multiple pipelines match ${JSON.stringify(selector)}. Choose --id <id>:\n${matches.map((item) => `${item.slug}: ${item.name} (${item.id})`).join("\n")}`
            );
          const pipeline = matches[0]!;
          const input =
            values["input-file"] !== undefined
              ? await boundedInput(values["input-file"], io.cwd, dependencies, managed.signal)
              : {};
          if (managed.signal.aborted) throw new Error("Run admission interrupted.");
          const key = randomUUID();
          let run: CliRun;
          try {
            try {
              run = await client.run(workspace, { pipelineId: pipeline.id, input }, key);
            } catch (error) {
              if (!isCloudTransportError(error) || managed.signal.aborted) throw error;
              run = await client.run(workspace, { pipelineId: pipeline.id, input }, key);
            }
          } catch (error) {
            // Local validation and explicit 4xx responses establish rejection.
            // A 5xx, unusable response or interrupted POST can follow admission.
            if (admissionUncertain(error)) {
              io.stderr.write(
                `Admission could not be confirmed. Workspace: ${terminalSafeText(workspace)}; idempotency key: ${key}. Retry only with this same key through the API.\n`
              );
            }
            throw error;
          }
          admitted = { id: run.id, url: runUrl(host, workspace, run.id) };
          const progress = values.json ? io.stderr : io.stdout;
          progress.write(
            `Run ${terminalSafeText(run.id)}: ${terminalSafeText(run.pipelineName)}\nWorkspace: ${terminalSafeText(workspace)}\nDeployed commit: ${terminalSafeText(run.commit)}\n${terminalSafeText(admitted.url)}\nLocal changes are not used.\n`
          );
          if (values.detach) {
            if (values.json) io.stdout.write(`${JSON.stringify(run)}\n`);
            return 0;
          }
          run = await followRun(
            run,
            () => client.getRun(workspace, run.id),
            io.stdout,
            managed.signal,
            dependencies,
            !values.json
          );
          if (values.json) io.stdout.write(`${JSON.stringify(run)}\n`);
          else {
            io.stdout.write(`Run ${terminalSafeText(run.id)}: ${run.status}\n`);
            if (run.result !== undefined)
              io.stdout.write(`${terminalSafeText(JSON.stringify(run.result))}\n`);
            if (run.error) io.stderr.write(`${terminalSafeText(run.error)}\n`);
          }
          return runExit(run);
        } catch (error) {
          if (admitted)
            io.stderr.write(
              `Run ${terminalSafeText(admitted.id)}\n${terminalSafeText(admitted.url)}\n`
            );
          return cloudErrorExit(error, io, managed.signal);
        } finally {
          managed.cleanup();
        }
      },
    },
    argv,
    io
  );
}
