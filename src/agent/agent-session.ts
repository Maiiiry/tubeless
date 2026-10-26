import { PipelineExecutionError } from "../core/pipeline-execution-error.js";
import type {
  Pipeline,
  PipelineContext,
  PipelineRun,
  PipelineRunControls,
} from "../core/pipeline-types.js";
import { agentError, ownState } from "./agent-state.js";

/** Conversation hooks a session supplies to its own compiled copy of a model-backed agent. */
export interface SessionHooks {
  /** The committed conversation that seeds a fresh run. */
  seed(): unknown;
  /** Record the latest owned conversation, including a finish decision's. */
  observe(conversation: unknown): void;
}

type SessionAgent = Pipeline<object, unknown, "agent", "agent", string>;
const builders = new WeakMap<object, (hooks: SessionHooks) => SessionAgent>();

/** Let `createAgentSession` recompile this model-backed agent with session hooks. */
export function registerSessionAgent(
  agent: object,
  build: (hooks: SessionHooks) => SessionAgent
): void {
  builders.set(agent, build);
}

/** Sequential runs of one model-backed agent that continue a single conversation. */
export interface AgentSession<Input extends object, Result> {
  /** Run one prompt; the conversation advances only when the run completes and finalizes. */
  run(
    input: Input,
    controls?: PipelineRunControls<"agent", "agent">,
    context?: Partial<PipelineContext>
  ): Promise<PipelineRun<Result>>;
  /** Run one prompt and return its result, or throw the run's execution error. */
  runOrThrow(
    input: Input,
    controls?: PipelineRunControls<"agent", "agent">,
    context?: Partial<PipelineContext>
  ): Promise<Result>;
  /** Provider-owned plain data to persist; null before the first completed run or after clear(). */
  readonly conversation: unknown;
  /** Start the next run with a fresh conversation. */
  clear(): void;
}

/**
 * Continue one conversation across sequential runs of a `defineAgent` agent, such as chat
 * prompts. Failed and cancelled runs keep the previous conversation. Pass a persisted
 * `conversation` to resume from storage; it must come from the same model provider.
 */
export function createAgentSession<Input extends object, Result>(
  agent: Pipeline<Input, Result, "agent", "agent", string>,
  options: { readonly conversation?: unknown } = {}
): AgentSession<Input, Result> {
  const build = builders.get(agent);
  if (!build)
    throw agentError(
      "TUBELESS_AGENT_INVALID_DEFINITION",
      "createAgentSession requires an agent from defineAgent"
    );
  let committed: unknown = ownState(options.conversation ?? null);
  let latest: unknown;
  let running = false;
  // SAFETY: the builder recompiles the same definition, so its options and result types match.
  const compiled = build({
    seed: () => committed,
    observe: (conversation) => {
      latest = ownState(conversation);
    },
  }) as unknown as Pipeline<Input, Result, "agent", "agent", string>;
  const run: AgentSession<Input, Result>["run"] = async (input, controls, context) => {
    if (running)
      throw agentError("TUBELESS_AGENT_SESSION_BUSY", "Agent session is already running");
    running = true;
    latest = undefined;
    try {
      const result = await compiled.run(input, controls, context);
      if (result.status === "completed" && result.finalized && latest !== undefined)
        committed = latest;
      return result;
    } finally {
      running = false;
    }
  };
  return Object.freeze({
    run,
    async runOrThrow(
      input: Input,
      controls?: PipelineRunControls<"agent", "agent">,
      context?: Partial<PipelineContext>
    ) {
      const result = await run(input, controls, context);
      if (result.status !== "completed") throw new PipelineExecutionError(result);
      // SAFETY: a completed run always carries its result value, as in Pipeline.runOrThrow.
      return result.value as Result;
    },
    get conversation() {
      return committed;
    },
    clear() {
      committed = null;
    },
  });
}
