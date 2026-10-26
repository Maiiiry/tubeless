import { STEP_ORCHESTRATION } from "../core/pipeline-step-metadata.js";
import { agentScope } from "./execution-scope.js";
import { expectedToolFailure } from "./tool-failure.js";
import { createSteps, definePipeline, type IterationDecision } from "../core/pipeline.js";
import { invokeChildPipeline } from "../core/child-execution.js";
import { createMappedChildProgress } from "../core/child-progress.js";
import { formatMappedChildProgressMessage } from "../core/mapped-child-progress.js";
import {
  PipelineExecutionError,
  isPipelineCancellation,
} from "../core/pipeline-execution-error.js";
import type { StandardSchemaV1 } from "../core/pipeline-types.js";
import { validateStandardSchema } from "../core/pipeline-validation.js";
import { throwIfAborted } from "../utilities/abort.js";
import { runConcurrentPartial } from "../utilities/batch.js";
import { ownState, limit } from "./agent-state.js";
import { callInvocation, decisionEnvelope, prepareCalls, type PreparedCall } from "./decision.js";
import { restoreCalls, saveCalls } from "./checkpoint-calls.js";
import type {
  AgentDecisionContext,
  AgentLimits,
  AgentOutcome,
  AgentState,
  DefaultAgentToolName,
  Output,
  Tools,
} from "./agent-types.js";
import type { CallOutcome } from "./checkpoint-format.js";
import type { RuntimeAgentDefinition } from "./compile-agent.js";
import type { CompiledTool } from "./tools.js";
import type { ToolActivity } from "./tool-progress.js";

export interface TurnState<State> {
  state: AgentState<State>;
  turn: number;
  stateVersion: number;
  calls: number;
}

export function createAgentTurn<
  Options extends StandardSchemaV1<object, object>,
  Result extends StandardSchemaV1,
  State,
  Registry extends Tools,
  Codemode extends boolean,
  Defaults extends DefaultAgentToolName,
>(
  definition: RuntimeAgentDefinition<string, Options, Result, State, Registry, Codemode, Defaults>,
  registry: ReadonlyMap<string, CompiledTool>,
  limits: Required<AgentLimits>,
  descriptors: Pick<AgentDecisionContext<Output<Options>>, "capabilities" | "resultJsonSchema">
) {
  type TurnOptions = { execution: TurnState<State>; options: Output<Options>; agentRunId: string };
  type Decision =
    | { kind: "finish"; result: Output<Result> }
    | { kind: "continue"; calls: PreparedCall[]; state: AgentState<State> };
  const { step } = createSteps<TurnOptions>();
  const decide = step("decide", {
    name: "Plan next action",
    description: "Request and validate one decision, including the complete call batch.",
    run: async (_inputs, context): Promise<Decision> => {
      const { execution, options, agentRunId } = context.options;
      const { turn, stateVersion, state, calls } = execution;
      throwIfAborted(context.signal, "Agent decision");
      const scope = agentScope(context)!;
      const saved = scope.journal?.agent(scope.agentKey);
      if (saved?.phase === "calls")
        return {
          kind: "continue",
          calls: restoreCalls(saved.decision.calls, registry, scope, turn, context),
          state: ownState(saved.decision.state) as AgentState<State>,
        };
      await scope.beginDecision(context.signal);
      const callback = context.dryRun ? definition.dryRun! : definition.decide;
      const attributes = {
        "agent.runId": agentRunId,
        "agent.turn": turn,
        "agent.stateVersion": stateVersion,
        "agent.callsAdmitted": calls,
      };
      const response = await scope.run(
        async () =>
          callback(state, {
            ...context,
            options,
            turn,
            environment: scope.environment,
            execution: scope.identity(turn),
            stateVersion,
            ...descriptors,
          }),
        context.signal
      );
      throwIfAborted(context.signal, "Agent decision");
      const decision = decisionEnvelope(response.decision);
      context.reportAttempt(1, {
        ...attributes,
        "agent.decision": decision.kind,
        "agent.callCount": decision.kind === "continue" ? decision.calls.length : 0,
      });
      if (decision.kind === "finish") {
        const result = await validateStandardSchema(
          definition.resultSchema,
          decision.result,
          "Agent finish result"
        );
        throwIfAborted(context.signal, "Agent finish");
        await scope.journal?.finish(scope.agentKey, result);
        return { kind: "finish", result };
      }
      if (turn === limits.maxTurns) limit("maxTurns", limits.maxTurns, turn, 1, agentRunId);
      scope.check("maxCalls", decision.calls.length);
      const stateAfterDecision = ownState(response.state);
      const prepared = await prepareCalls(decision.calls, registry, context, turn);
      await scope.journal?.acceptDecision(scope.agentKey, stateAfterDecision, saveCalls(prepared));
      return {
        kind: "continue",
        calls: prepared,
        state: stateAfterDecision,
      };
    },
  });
  const calls = step("calls", {
    name: "Tool calls",
    dependsOn: [decide],
    description: "Dispatch validated calls and drain active work before advancing state.",
    run: async ({ decide: decision }, context): Promise<readonly CallOutcome[]> => {
      if (decision.kind === "finish") return [];
      const { execution, agentRunId } = context.options;
      throwIfAborted(context.signal, "Agent call admission");
      const scope = agentScope(context)!;
      const journal = scope.journal;
      await scope.admitCalls(decision.calls.length, context.signal);
      const admitted = execution.calls + decision.calls.length;
      context.reportAttempt(1, {
        "agent.runId": agentRunId,
        "agent.turn": execution.turn,
        "agent.callsAdmitted": admitted,
        "agent.callCount": decision.calls.length,
      });
      const toolNames = new Map(decision.calls.map((call) => [call.id, call.tool.name]));
      const progress = createMappedChildProgress(
        decision.calls.map(({ id }) => id),
        limits.maxConcurrency,
        {
          detailLimit: 32,
          formatMessage: (snapshot) =>
            formatMappedChildProgressMessage(
              { ...snapshot, spotlight: undefined },
              { itemNoun: "tool calls" }
            ),
        },
        (snapshot) =>
          context.reportProgress({
            ...snapshot,
            details: snapshot.details?.map((row) =>
              (row.depth ?? 0) === 0 && toolNames.has(row.id)
                ? { ...row, name: toolNames.get(row.id) }
                : row
            ),
          })
      );
      progress.publish();
      const partial = await runConcurrentPartial(
        decision.calls,
        { concurrency: limits.maxConcurrency, signal: context.signal },
        async (call) => {
          progress.start(call.id);
          let activity: ToolActivity | undefined;
          try {
            const attributes = {
              "agent.runId": agentRunId,
              "agent.turn": execution.turn,
              "agent.callId": call.id,
              "agent.tool": call.tool.name,
              "agent.parentAttemptId": context.attemptId,
            };
            // Record the selected alias for pipeline tools as well as handlers.
            context.reportAttempt(1, attributes);
            const complete = async (outcome: CallOutcome, label?: string) => {
              await journal?.completeCall(scope.agentKey, call.id, outcome);
              if (outcome.ok) progress.complete(call.id, label);
              return outcome;
            };
            const admission = await journal?.startCall(scope.agentKey, call.id, call.tool.replay);
            if (admission?.kind === "outcome") {
              if (admission.reused)
                context.reportAttempt(1, { ...attributes, "agent.checkpointReused": true });
              const { outcome } = admission;
              if (outcome.ok) progress.complete(call.id);
              else progress.fail(call.id, new Error(outcome.error.message), false);
              return outcome;
            }
            const invocation = callInvocation(call, context, {
              turn: execution.turn,
              attributes,
              execution: scope.identity(execution.turn, call.id),
              onActivity: (started) => {
                activity = started;
              },
            });
            const result = await invokeChildPipeline(
              call.tool.pipeline,
              invocation.options,
              invocation.context,
              {
                stepId: calls.id,
                plan: call.plan,
                hooks: progress.plan(call.id, call.plan),
                itemKey: call.id,
                preparedOptions: invocation.preparedOptions,
              }
            );
            if (result.status === "completed" && result.finalized) {
              const label = activity?.complete(result.value);
              if (label !== undefined) context.log.log(label);
              activity = undefined;
              progress.childCompleted(call.id);
              return complete(
                {
                  id: call.id,
                  tool: call.tool.name,
                  ok: true,
                  value: result.value,
                },
                label
              );
            }
            const failure = new PipelineExecutionError(result);
            const expected = !context.signal?.aborted && expectedToolFailure(result);
            if (expected) {
              if (activity) context.log.warn(`${activity.action}: failed`);
              activity = undefined;
              progress.fail(call.id, failure, false);
              return complete({
                id: call.id,
                tool: call.tool.name,
                ok: false,
                error: expected,
              });
            }
            throw failure;
          } catch (error) {
            const cancelled = isPipelineCancellation(error, context);
            if (activity)
              context.log.warn(`${activity.action}: ${cancelled ? "cancelled" : "failed"}`);
            progress.fail(
              call.id,
              error instanceof Error ? error : new Error(String(error)),
              cancelled
            );
            throw error;
          }
        }
      );
      progress.finish();
      if (!partial.ok) throw partial.failure;
      throwIfAborted(context.signal, "Agent batch");
      return partial.results;
    },
  });
  const reduce = step("reduce", {
    name: "Update context",
    dependsOn: [decide, calls],
    description: "Commit one owned state snapshot, or publish the validated finish result.",
    run: async (
      { decide: decision, calls: outcomes },
      context
    ): Promise<IterationDecision<TurnState<State>, Output<Result>>> => {
      if (decision.kind === "finish") return { kind: "finish", result: decision.result };
      const { execution } = context.options;
      throwIfAborted(context.signal, "Agent reduction");
      // SAFETY: registered tools validated outcomes before persistence; recovery matched their definitions.
      const typedOutcomes = outcomes as readonly AgentOutcome<Registry, Codemode, Defaults>[];
      const state = definition.reduce
        ? ownState(definition.reduce(decision.state, typedOutcomes))
        : decision.state;
      throwIfAborted(context.signal, "Agent reduction");
      context.reportAttempt(1, {
        "agent.runId": context.options.agentRunId,
        "agent.turn": execution.turn,
        "agent.stateVersion": execution.stateVersion + 1,
        "agent.callsAdmitted": execution.calls + decision.calls.length,
      });
      const next = {
        kind: "next",
        state: {
          state,
          turn: execution.turn + 1,
          stateVersion: execution.stateVersion + 1,
          calls: execution.calls + decision.calls.length,
        },
      } as const;
      const scope = agentScope(context)!;
      await scope.journal?.advance(scope.agentKey, next.state);
      return next;
    },
  });
  for (const step of [decide, calls, reduce])
    Object.defineProperty(step, STEP_ORCHESTRATION, { value: true });
  return definePipeline({
    id: `${definition.id}/turn`,
    name: "Turn",
    steps: [decide, calls, reduce],
    finalize: reduce,
  });
}
