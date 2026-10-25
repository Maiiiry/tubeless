import type { AgentHistory } from "../../run-store/agent-history.js";
import { terminalSafeText } from "../workbench-shared.js";

export function formatAgentHistory(history: AgentHistory): string {
  if (!history.agents.length) return "";
  const lines = ["Agent history:"];
  const byId = new Map(history.agents.map((agent) => [agent.runId, agent]));
  type Row = string | { agent: AgentHistory["agents"][number]; depth: number };
  // Include disconnected/cyclic records too; identity guards prevent duplicate expansion.
  const pending: Row[] = [
    ...history.agents.filter((agent) => !agent.parentCall),
    ...history.agents.filter((agent) => agent.parentCall),
  ]
    .reverse()
    .map((agent) => ({ agent, depth: 1 }));
  const seen = new Set<string>();
  while (pending.length) {
    const row = pending.pop()!;
    if (typeof row === "string") {
      lines.push(row);
      continue;
    }
    const { agent, depth } = row;
    if (seen.has(agent.runId)) continue;
    seen.add(agent.runId);
    const indent = "  ".repeat(Math.min(depth, 16));
    lines.push(
      `${indent}Agent ${terminalSafeText(agent.pipelineId)}  ${agent.status}  termination ${agent.termination}  run ${terminalSafeText(agent.runId)}`
    );
    const rows: Row[] = [];
    for (const turn of agent.turns) {
      const state = turn.stateVersion === undefined ? "unknown" : String(turn.stateVersion);
      const next = turn.nextStateVersion === undefined ? "" : ` -> ${turn.nextStateVersion}`;
      const count = turn.callCount === undefined ? "unknown" : String(turn.callCount);
      const admitted = turn.callsAdmitted === undefined ? "" : `  admitted ${turn.callsAdmitted}`;
      rows.push(
        `${indent}  Turn ${turn.index}  ${turn.status}  decision ${turn.decision ?? "unknown"}  state ${state}${next}  calls ${turn.calls.length}/${count}${admitted}  run ${terminalSafeText(turn.runId)}`
      );
      for (const call of turn.calls) {
        rows.push(
          `${indent}    Call ${terminalSafeText(call.callId)}  tool ${terminalSafeText(call.tool ?? "unknown")}  ${call.status}  run ${terminalSafeText(call.runId ?? "not recorded")}`
        );
        if (call.error)
          rows.push(
            `${indent}      ${terminalSafeText(call.error.sourceCode ?? call.error.code)}: ${terminalSafeText(call.error.message)}`
          );
        for (const id of call.childAgentRunIds) {
          const child = byId.get(id);
          if (child) rows.push({ agent: child, depth: depth + 3 });
        }
      }
      if (turn.error)
        rows.push(
          `${indent}    Error ${terminalSafeText(turn.error.sourceCode ?? turn.error.code)}: ${terminalSafeText(turn.error.message)}`
        );
    }
    pending.push(...rows.reverse());
  }
  return `${lines.join("\n")}\n`;
}
