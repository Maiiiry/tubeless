import { studioDescriptor } from "../hosting/hosting-commands.js";
import { parseStudioHosting } from "../studio/run-store-ui-hosting.js";
import * as path from "node:path";
import type { SqlitePipelineRunStore } from "../run-store/run-store-sqlite.js";
import { loadPipelineProjectFile, createModuleRegistration } from "./workbench-project-loader.js";
import type { PipelineRunEventReader } from "../run-store/run-store.js";
import {
  WorkbenchStudioLauncher,
  type WorkbenchStudioRegistration,
} from "./workbench-studio-launcher.js";
import {
  DEFAULT_PIPELINE_RUN_STORE,
  errorMessage,
  onFirstProcessSignal,
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";
import {
  EXPORT_OPTION,
  parseSubcommandArgs,
  RUN_HISTORY_OPTIONS,
  runWorkbenchSubcommand,
} from "./workbench-subcommand.js";

const UI_USAGE = `Usage: tubeless ui [options] [project-file]

Serve the local pipeline studio from an append-only SQLite run store or a
finished NDJSON trace. Load pipelines from a project, or register
pipeline or definePipelineCommand modules directly, and only with a writable SQLite store.

Options:
      --command <path> Register a launchable pipeline or command (repeatable)
  -e, --export <name>  Select the export when registering exactly one command
      --store <path>    SQLite database (default: .tubeless/runs.sqlite)
      --trace <path>    Read a finished NDJSON trace artifact (history-only)
      --host <value>    Bind address (default: 127.0.0.1)
      --port <number>   HTTP port (default: 4317)
      --public-url <url> Host behind an authenticated gateway (requires TUBELESS_STUDIO_GATEWAY_TOKEN)
  -h, --help            Show this help
`;

function parseUiArgs(argv: readonly string[]) {
  return parseSubcommandArgs(argv, {
    command: { type: "string", multiple: true },
    ...EXPORT_OPTION,
    host: { type: "string" },
    port: { type: "string" },
    "public-url": { type: "string" },
    ...RUN_HISTORY_OPTIONS,
  });
}

export async function runUi(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      usage: UI_USAGE,
      parse: parseUiArgs,
      async run(parsed, commandIo) {
        if (parsed.positionals.length > 1) {
          return writeUsageError(commandIo, "Pass at most one project file.", UI_USAGE);
        }
        const directCommandFiles = parsed.values.command ?? [];
        const projectFile = parsed.positionals[0];
        if (parsed.values.store && parsed.values.trace) {
          return writeUsageError(io, "Use --store or --trace, not both.", UI_USAGE);
        }
        if (parsed.values.trace && (directCommandFiles.length > 0 || projectFile)) {
          return writeUsageError(
            io,
            "An NDJSON trace is read-only and cannot register launchable commands.",
            UI_USAGE
          );
        }
        if (parsed.values.export && (directCommandFiles.length !== 1 || projectFile)) {
          return writeUsageError(
            io,
            "--export requires exactly one registered --command.",
            UI_USAGE
          );
        }
        const port = Number(parsed.values.port ?? "4317");
        if (!Number.isInteger(port) || port < 0 || port > 65_535) {
          return writeUsageError(io, "--port must be an integer from 0 to 65535.", UI_USAGE);
        }

        let hosting: ReturnType<typeof parseStudioHosting>;
        const gatewayToken = process.env.TUBELESS_STUDIO_GATEWAY_TOKEN;
        // Launched commands and their child processes inherit this environment;
        // keep the backend token only in the parsed hosting configuration.
        delete process.env.TUBELESS_STUDIO_GATEWAY_TOKEN;
        try {
          hosting = parseStudioHosting(parsed.values["public-url"], gatewayToken);
        } catch (error) {
          return writeUsageError(io, errorMessage(error), UI_USAGE);
        }
        const host = (parsed.values.host ?? "127.0.0.1").toLowerCase();
        const isLoopbackHost = host === "127.0.0.1" || host === "::1" || host === "localhost";
        if ((directCommandFiles.length > 0 || projectFile) && !isLoopbackHost && !hosting) {
          return writeUsageError(
            io,
            "Browser-triggered execution requires a loopback --host or authenticated --public-url.",
            UI_USAGE
          );
        }
        const sources = directCommandFiles.map((file) =>
          createModuleRegistration(file, io.cwd, parsed.values.export)
        );
        if (projectFile) {
          const loaded = await loadPipelineProjectFile(projectFile, io);
          if ("exitCode" in loaded) return loaded.exitCode;
          sources.push(...loaded.registrations);
        }
        const identities = new Set<string>();
        for (const source of sources) {
          if (identities.has(source.identity)) {
            return writeUsageError(
              io,
              `Studio command source ${JSON.stringify(source.source)} is duplicated.`,
              UI_USAGE
            );
          }
          identities.add(source.identity);
        }

        const registrations: WorkbenchStudioRegistration[] = [];
        for (const source of sources) {
          const loaded = await source.loadCommand(io);
          if ("exitCode" in loaded) return loaded.exitCode;
          registrations.push({
            command: loaded.command,
            commandIo: loaded.commandIo,
            descriptor: studioDescriptor(loaded.command),
          });
        }
        const registrationIds = new Set<string>();
        for (const registration of registrations) {
          if (registrationIds.has(registration.descriptor.id)) {
            return writeUsageError(
              io,
              `Studio command id ${JSON.stringify(registration.descriptor.id)} is duplicated.`,
              UI_USAGE
            );
          }
          registrationIds.add(registration.descriptor.id);
        }

        const filename = path.resolve(
          io.cwd,
          parsed.values.trace ?? parsed.values.store ?? DEFAULT_PIPELINE_RUN_STORE
        );
        let store: PipelineRunEventReader | undefined;
        let writableStore: SqlitePipelineRunStore | undefined;
        let server:
          | Awaited<ReturnType<typeof import("../studio/run-store-ui.js").startPipelineRunStudio>>
          | undefined;
        let disposeProcessSignals: (() => void) | undefined;
        let launcher: WorkbenchStudioLauncher | undefined;
        let storeOpened = false;
        try {
          const { startPipelineRunStudio } = await import("../studio/run-store-ui.js");
          if (parsed.values.trace) {
            const { openNdjsonPipelineRunStore } = await import("../run-store/run-store-ndjson.js");
            store = await openNdjsonPipelineRunStore(filename);
          } else {
            const { openSqlitePipelineRunStore } = await import("../run-store/run-store-sqlite.js");
            writableStore = await openSqlitePipelineRunStore(filename);
            store = writableStore;
          }
          storeOpened = true;
          if (registrations.length > 0 && writableStore) {
            launcher = new WorkbenchStudioLauncher(registrations, writableStore);
          }
          const studioOptions: Parameters<typeof startPipelineRunStudio>[0] = {
            host,
            hosting,
            launcher,
            port,
            store,
          };
          if (isLoopbackHost && writableStore && !hosting) {
            studioOptions.history = {
              clear: () => writableStore!.clearHistory(),
              isBusy: () => launcher?.isBusy() ?? false,
            };
          }
          server = await startPipelineRunStudio(studioOptions);
          io.stdout.write(`Tubeless ${hosting ? "gateway" : "local"} studio: ${server.url}\n`);
          io.stdout.write(`${parsed.values.trace ? "Trace artifact" : "Run store"}: ${filename}\n`);
          if (registrations.length > 0) {
            io.stdout.write(
              `Launchable commands: ${registrations.map(({ descriptor }) => descriptor.name).join(", ")}\n`
            );
          }
          io.stdout.write("Press Ctrl-C to stop.\n");

          await new Promise<void>((resolve) => {
            const stop = (): void => {
              launcher?.stop();
              resolve();
            };
            if (io.signal?.aborted) {
              stop();
              return;
            }
            if (io.signal) {
              io.signal.addEventListener("abort", stop, { once: true });
              return;
            }
            disposeProcessSignals = onFirstProcessSignal(["SIGINT", "SIGTERM"], () => stop());
          });
          return TUBELESS_WORKBENCH_EXIT_CODE.success;
        } catch (error) {
          io.stderr.write(`Error: ${errorMessage(error)}\n`);
          return parsed.values.trace && !storeOpened
            ? TUBELESS_WORKBENCH_EXIT_CODE.load
            : TUBELESS_WORKBENCH_EXIT_CODE.execution;
        } finally {
          launcher?.stop();
          await server?.close();
          await launcher?.drain();
          await store?.close();
          disposeProcessSignals?.();
        }
      },
    },
    argv,
    io
  );
}
