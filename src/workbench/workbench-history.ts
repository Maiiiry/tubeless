import { didYouMean } from "../utilities/suggest.js";
import { cacheArtifactMetadata } from "../run-store/cache-artifact.js";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import {
  createPipelineRunProjector,
  type PipelineRunEventQuery,
  type PipelineRunEventReader,
  type StoredPipelineRun,
} from "../run-store/run-store.js";
import { readPipelineEventPages, readPipelineRunTree } from "../run-store/run-store-reader.js";
import { projectAgentHistory } from "../run-store/agent-history.js";
import { formatAgentHistory } from "./workbench-agent-history.js";
import {
  DEFAULT_PIPELINE_RUN_STORE,
  terminalSafeText,
  errorMessage,
  shellWord,
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeCliChunk,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";
import {
  parseSubcommandArgs,
  RUN_HISTORY_OPTIONS,
  runWorkbenchSubcommand,
} from "./workbench-subcommand.js";

const HISTORY_USAGE = `Usage: tubeless history [options] [run-id]

Show recorded pipeline runs from SQLite or an NDJSON trace.
Run details include recorded agent turns, tool calls, and child agents.

Options:
      --store <path>    SQLite database (default: .tubeless/runs.sqlite)
      --trace <path>    Read a finished NDJSON trace artifact
      --pipeline <id>   Filter by recorded pipeline ID
      --json            Emit the projected run list or run as JSON
      --events          Emit raw store events as NDJSON
      --clear           Delete all recorded history from a SQLite store (requires --yes)
      --yes             Confirm --clear; there is no interactive prompt
  -h, --help            Show this help
`;

function parseHistoryArgs(argv: readonly string[]) {
  return parseSubcommandArgs(argv, {
    clear: { type: "boolean" },
    events: { type: "boolean" },
    json: { type: "boolean" },
    pipeline: { type: "string" },
    ...RUN_HISTORY_OPTIONS,
    yes: { type: "boolean" },
  });
}

interface HistoryRunSummary {
  correlationId?: string;
  durationMs?: number;
  pipelineId: string;
  runId: string;
  startedAtMs: number;
  status: StoredPipelineRun["status"];
}

function summarizeRun(run: StoredPipelineRun): HistoryRunSummary {
  const summary: HistoryRunSummary = {
    pipelineId: run.pipelineId,
    runId: run.runId,
    startedAtMs: run.startedAtMs,
    status: run.status,
  };
  if (run.correlationId) summary.correlationId = run.correlationId;
  if (run.durationMs !== undefined) summary.durationMs = run.durationMs;
  return summary;
}

function formatRunList(runs: readonly StoredPipelineRun[]): string {
  const rows = runs.map((run) => [
    terminalSafeText(run.runId),
    terminalSafeText(run.pipelineId),
    run.status,
    run.correlationId ? `correlation ${terminalSafeText(run.correlationId)}` : "",
    `started ${new Date(run.startedAtMs).toISOString()}`,
    run.durationMs === undefined ? "" : `${run.durationMs}ms`,
  ]);
  const widths = (rows[0] ?? []).map((_, column) =>
    rows.reduce((width, row) => Math.max(width, row[column]!.length), 0)
  );
  // Columns no run fills are dropped; the trailing columns are tool-generated, so trimEnd only
  // removes padding.
  const lines = rows.map((row) =>
    row
      .flatMap((cell, column) => (widths[column] ? [cell.padEnd(widths[column])] : []))
      .join("  ")
      .trimEnd()
  );
  return `${lines.join("\n")}\n`;
}

/** Shortest fragment `history <run-id>` resolves by prefix; shorter input must match exactly. */
const MIN_RUN_ID_PREFIX_LENGTH = 4;
const MAX_AMBIGUOUS_RUN_IDS = 5;

/** The part after a run id's final `:` (the generated UUID), or the whole id without one. */
function runIdSuffix(runId: string): string {
  return runId.slice(runId.lastIndexOf(":") + 1);
}

type RunIdResolution = { runId: string } | { error: string };

/**
 * Resolve a run id that matched nothing exactly as a unique prefix of a full run id or of
 * its UUID part. `listCommand` is the history invocation that lists the searched runs.
 */
function resolveRunIdPrefix(
  input: string,
  runs: readonly StoredPipelineRun[],
  listCommand: string
): RunIdResolution {
  const matches =
    input.length < MIN_RUN_ID_PREFIX_LENGTH
      ? []
      : runs.filter(
          (run) => run.runId.startsWith(input) || runIdSuffix(run.runId).startsWith(input)
        );
  if (matches.length === 1) return { runId: matches[0]!.runId };
  if (matches.length > 1) {
    const shown = matches.slice(0, MAX_AMBIGUOUS_RUN_IDS);
    const hidden = matches.length - shown.length;
    return {
      error: [
        `Run id ${JSON.stringify(input)} is ambiguous; it matches ${matches.length} runs:`,
        ...shown.map((run) => `  ${terminalSafeText(run.runId)}`),
        ...(hidden > 0 ? [`  …and ${hidden} more`] : []),
      ].join("\n"),
    };
  }
  // Compare full ids against full ids and bare UUIDs against UUIDs; always suggest full ids.
  const candidates = new Map(
    runs.map((run) => [input.includes(":") ? run.runId : runIdSuffix(run.runId), run.runId])
  );
  const suggestion = didYouMean(input, candidates.keys(), (candidate) =>
    JSON.stringify(candidates.get(candidate))
  );
  return {
    error: [
      `Unknown run ${JSON.stringify(input)}.${suggestion ? ` ${suggestion}` : ""}`,
      terminalSafeText(`Run "${listCommand}" to list recorded runs.`),
    ].join("\n"),
  };
}

function historyListCommand(values: { pipeline?: string; store?: string; trace?: string }): string {
  const words = ["tubeless", "history"];
  if (values.store !== undefined) words.push("--store", shellWord(values.store));
  if (values.trace !== undefined) words.push("--trace", shellWord(values.trace));
  if (values.pipeline !== undefined) words.push("--pipeline", shellWord(values.pipeline));
  return words.join(" ");
}

function formatRunDetail(run: StoredPipelineRun): string {
  const lines = [
    `Run ${terminalSafeText(run.runId)}`,
    `Pipeline ${terminalSafeText(run.pipelineId)}`,
    `Status ${run.status}`,
    `Started ${new Date(run.startedAtMs).toISOString()}`,
  ];
  if (run.correlationId) lines.splice(1, 0, `Correlation ${terminalSafeText(run.correlationId)}`);
  if (run.durationMs !== undefined) lines.push(`Duration ${run.durationMs}ms`);
  lines.push("", "Steps:");
  const stepIds = run.steps.map((step) => terminalSafeText(step.id));
  const idWidth = stepIds.reduce((width, id) => Math.max(width, id.length), 0);
  const statusWidth = run.steps.reduce((width, step) => Math.max(width, step.status.length), 0);
  for (const [index, step] of run.steps.entries()) {
    const columns = [stepIds[index]!.padEnd(idWidth), step.status.padEnd(statusWidth)];
    if (step.durationMs !== undefined) columns.push(`${step.durationMs}ms`);
    lines.push(`  ${columns.join("  ").trimEnd()}`);
    for (const entry of step.artifacts ?? []) {
      lines.push(
        `    ${entry.preview ? "preview " : ""}${cacheArtifactMetadata(entry.artifact) ? "Cached output " : ""}${entry.operation}  ${terminalSafeText(JSON.stringify(entry.artifact))}`
      );
    }
  }
  if (run.logs.length > 0) {
    lines.push("", "Logs:");
    for (const log of run.logs) {
      lines.push(`  [${log.level}] ${terminalSafeText(log.message)}`);
    }
  }
  if (run.error) {
    lines.push("", "Error:", `  ${run.error.code}  ${terminalSafeText(run.error.message)}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runHistory(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      usage: HISTORY_USAGE,
      parse: parseHistoryArgs,
      async run(parsed, commandIo) {
        if (parsed.values.json && parsed.values.events) {
          return writeUsageError(commandIo, "Use --json or --events, not both.", HISTORY_USAGE);
        }
        if (parsed.values.store && parsed.values.trace) {
          return writeUsageError(commandIo, "Use --store or --trace, not both.", HISTORY_USAGE);
        }
        if (parsed.positionals.length > 1) {
          return writeUsageError(commandIo, "Pass at most one run id.", HISTORY_USAGE);
        }
        if (parsed.values.clear) {
          if (parsed.values.trace) {
            return writeUsageError(
              commandIo,
              "--clear requires --store, not --trace.",
              HISTORY_USAGE
            );
          }
          if (parsed.values.json || parsed.values.events) {
            return writeUsageError(
              commandIo,
              "--clear cannot combine with --json or --events.",
              HISTORY_USAGE
            );
          }
          if (parsed.positionals.length > 0) {
            return writeUsageError(commandIo, "--clear does not take a run id.", HISTORY_USAGE);
          }
          if (!parsed.values.yes) {
            return writeUsageError(
              commandIo,
              "--clear requires --yes to confirm deleting all recorded history.",
              HISTORY_USAGE
            );
          }
        }

        const runId = parsed.positionals[0];
        const usingDefaultStore =
          parsed.values.store === undefined && parsed.values.trace === undefined;
        const filename = path.resolve(
          commandIo.cwd,
          parsed.values.trace ?? parsed.values.store ?? DEFAULT_PIPELINE_RUN_STORE
        );
        try {
          await stat(filename);
        } catch {
          commandIo.stderr.write(
            `Error: ${parsed.values.trace ? "Trace artifact" : "Run store"} not found at ${filename}\n` +
              (usingDefaultStore
                ? `Record runs with: tubeless run --store ${DEFAULT_PIPELINE_RUN_STORE} <pipeline> [-- <args>]\n`
                : "")
          );
          return TUBELESS_WORKBENCH_EXIT_CODE.load;
        }

        if (parsed.values.clear) {
          let writableStore;
          try {
            const { openSqlitePipelineRunStore } = await import("../run-store/run-store-sqlite.js");
            writableStore = await openSqlitePipelineRunStore(filename, { initialize: false });
          } catch (error) {
            commandIo.stderr.write(`Error: ${errorMessage(error)}\n`);
            return TUBELESS_WORKBENCH_EXIT_CODE.load;
          }
          try {
            await writableStore.clearHistory();
            await writeCliChunk(commandIo.stdout, `Cleared all recorded history in ${filename}\n`);
            return TUBELESS_WORKBENCH_EXIT_CODE.success;
          } catch (error) {
            commandIo.stderr.write(`Error: ${errorMessage(error)}\n`);
            return TUBELESS_WORKBENCH_EXIT_CODE.load;
          } finally {
            await writableStore.close();
          }
        }

        let store: PipelineRunEventReader;
        try {
          if (parsed.values.trace) {
            const { openNdjsonPipelineRunStore } = await import("../run-store/run-store-ndjson.js");
            store = await openNdjsonPipelineRunStore(filename);
          } else {
            const { openSqlitePipelineRunStore } = await import("../run-store/run-store-sqlite.js");
            store = await openSqlitePipelineRunStore(filename, {
              initialize: false,
              readOnly: true,
            });
          }
        } catch (error) {
          commandIo.stderr.write(`Error: ${errorMessage(error)}\n`);
          return TUBELESS_WORKBENCH_EXIT_CODE.load;
        }
        const scope: PipelineRunEventQuery =
          parsed.values.pipeline === undefined ? {} : { pipelineId: parsed.values.pipeline };
        const writeEvents = async (query: PipelineRunEventQuery): Promise<number> => {
          let eventCount = 0;
          for await (const page of readPipelineEventPages(store, query)) {
            for (const event of page) {
              await writeCliChunk(commandIo.stdout, `${JSON.stringify(event)}\n`);
            }
            eventCount += page.length;
          }
          return eventCount;
        };
        const projectRuns = async (
          query: PipelineRunEventQuery,
          retainLogs: boolean
        ): Promise<StoredPipelineRun[]> => {
          const projector = createPipelineRunProjector({ retainLogs, retainArtifacts: retainLogs });
          for await (const page of readPipelineEventPages(store, query)) projector.append(page);
          return projector.snapshot().runs;
        };
        const projectRun = async (id: string): Promise<StoredPipelineRun | undefined> =>
          (await projectRuns({ ...scope, runId: id }, true)).find((run) => run.runId === id);
        // Exact ids read only that run's events; only a miss scans every run for a prefix match.
        const resolveRunId = async (input: string): Promise<string | undefined> => {
          const resolution = resolveRunIdPrefix(
            input,
            await projectRuns(scope, false),
            historyListCommand(parsed.values)
          );
          if ("runId" in resolution) return resolution.runId;
          commandIo.stderr.write(`Error: ${resolution.error}\n`);
          return undefined;
        };
        try {
          if (parsed.values.events) {
            if (runId === undefined) {
              await writeEvents(scope);
              return TUBELESS_WORKBENCH_EXIT_CODE.success;
            }
            if ((await writeEvents({ ...scope, runId })) === 0) {
              const resolved = await resolveRunId(runId);
              if (resolved === undefined) return TUBELESS_WORKBENCH_EXIT_CODE.usage;
              await writeEvents({ ...scope, runId: resolved });
            }
            return TUBELESS_WORKBENCH_EXIT_CODE.success;
          }

          if (runId !== undefined) {
            let run = await projectRun(runId);
            if (!run) {
              const resolved = await resolveRunId(runId);
              if (resolved === undefined) return TUBELESS_WORKBENCH_EXIT_CODE.usage;
              run = await projectRun(resolved);
              if (!run) throw new Error(`Run ${JSON.stringify(resolved)} left the store mid-read.`);
            }
            const agentHistory = projectAgentHistory(await readPipelineRunTree(store, run));
            const detail = agentHistory.agents.length ? { ...run, agentHistory } : run;
            await writeCliChunk(
              commandIo.stdout,
              parsed.values.json
                ? `${JSON.stringify(detail, null, 2)}\n`
                : formatRunDetail(run) +
                    (agentHistory.agents.length ? `\n${formatAgentHistory(agentHistory)}` : "")
            );
            return TUBELESS_WORKBENCH_EXIT_CODE.success;
          }

          const runs = await projectRuns(scope, false);
          if (parsed.values.json) {
            await writeCliChunk(
              commandIo.stdout,
              `${JSON.stringify({ runs: runs.map(summarizeRun) }, null, 2)}\n`
            );
            return TUBELESS_WORKBENCH_EXIT_CODE.success;
          }
          if (runs.length > 0) await writeCliChunk(commandIo.stdout, formatRunList(runs));
          return TUBELESS_WORKBENCH_EXIT_CODE.success;
        } catch (error) {
          commandIo.stderr.write(`Error: ${errorMessage(error)}\n`);
          return TUBELESS_WORKBENCH_EXIT_CODE.load;
        } finally {
          await store.close();
        }
      },
    },
    argv,
    io
  );
}
