import type { AgentDurability } from "./checkpoint-types.js";
import type { AgentEnvironmentProvider } from "./environment.js";
import type {
  Pipeline,
  PipelineDefinitionSnapshot,
  StandardSchemaV1,
} from "../core/pipeline-types.js";
import type {
  AgentLimits,
  AgentOutcome,
  DefaultAgentToolName,
  Input,
  Output,
  Tools,
} from "./agent-types.js";
import type { AgentModel } from "./model-types.js";
import { compileAgent } from "./compile-agent.js";
import { registerSessionAgent, type SessionHooks } from "./agent-session.js";
import { agentError } from "./agent-state.js";
import { modelInstructions } from "./model-prompt.js";
import { toolObject } from "./default-tool-schema.js";
import { wireString } from "../tracing/wire-schema.js";

interface ModelState {
  instructions?: string;
  conversation: unknown;
  outcomes: readonly AgentOutcome<Tools>[];
}

const MAX_TASK_BYTES = 16_384;
type TaskSchema = StandardSchemaV1<{ task: string }>;
type AnswerSchema = StandardSchemaV1<{ answer: string }>;
const taskInput: TaskSchema = toolObject({ task: wireString({ maxLength: MAX_TASK_BYTES }) });
const answer: AnswerSchema = toolObject({ answer: wireString() });

/** Settings shared by task-prompted and typed-input agents. */
interface AgentConfig<Id extends string, Result extends StandardSchemaV1, Registry extends Tools> {
  readonly id: Id;
  readonly name?: string;
  readonly description?: string;
  readonly implementationVersion?: string;
  /** Provider and model, such as `openaiModel()` or `anthropicModel()`. */
  readonly model: AgentModel;
  /** Append application instructions to the default prompt and project guidance. */
  readonly instructions?: string;
  /**
   * Work as a project-workspace agent: use the coding prompt and load AGENTS.md from the
   * repository root through cwd (outside a repo, cwd only). When false, use a task-neutral
   * prompt with no project guidance. Defaults to true for `{ task }` agents and false for
   * typed agents with an `inputSchema`.
   */
  readonly projectContext?: boolean;
  /** Final result schema the model finishes against. Defaults to `{ answer: string }`. */
  readonly resultSchema?: Result;
  readonly resultJsonSchema?: Readonly<Record<string, unknown>>;
  readonly tools?: Registry;
  /** Standard workspace tools this agent may use; defaults to all six. `[]` grants none. */
  readonly defaultTools?: readonly DefaultAgentToolName[];
  /** Advertise one `codemode` tool whose JavaScript calls every registered tool. Defaults to false. */
  readonly codemode?: boolean;
  readonly limits?: AgentLimits;
  readonly environment?: AgentEnvironmentProvider;
}

type AgentPipeline<
  Options extends StandardSchemaV1<object, object>,
  Result extends StandardSchemaV1,
  Id extends string,
> = Pipeline<Input<Options>, Output<Result>, "agent", "agent", Id> & {
  readonly optionsSchema: Options;
  readonly definition: PipelineDefinitionSnapshot;
};

/** Prompt a model with `{ task }` and finish with the result schema, `{ answer }` by default. */
export function defineAgent<
  const Id extends string,
  const Result extends StandardSchemaV1 = AnswerSchema,
  const Registry extends Tools = {},
>(
  config: AgentConfig<Id, Result, Registry> & {
    readonly inputSchema?: undefined;
    readonly task?: undefined;
    readonly durability?: AgentDurability<{ task: string }>;
  }
): AgentPipeline<TaskSchema, Result, Id>;

/** Validate typed options, such as an upstream step's output, and map them to the model's task. */
export function defineAgent<
  const Id extends string,
  const Options extends StandardSchemaV1<object, object>,
  const Result extends StandardSchemaV1 = AnswerSchema,
  const Registry extends Tools = {},
>(
  config: AgentConfig<Id, Result, Registry> & {
    readonly inputSchema: Options;
    /** Describe the work for these validated options, in at most 16 KiB of UTF-8. */
    task(options: Output<Options>): string;
    readonly durability?: AgentDurability<Output<Options>>;
  }
): AgentPipeline<Options, Result, Id>;

export function defineAgent<Options extends StandardSchemaV1<object, object>>(
  config: ModelAgentDefinition<Options>
): unknown {
  const agent = compileModelAgent(config);
  registerSessionAgent(agent, (hooks) => compileModelAgent(config, hooks));
  return agent;
}

type ModelAgentDefinition<Options extends StandardSchemaV1<object, object>> = AgentConfig<
  string,
  StandardSchemaV1,
  Tools
> & {
  readonly inputSchema?: Options;
  task?(options: Output<Options>): string;
  readonly durability?: AgentDurability<Output<Options>>;
};

/** Compile one copy of the agent; a session's copy seeds and observes its conversation. */
function compileModelAgent<Options extends StandardSchemaV1<object, object>>(
  config: ModelAgentDefinition<Options>,
  session?: SessionHooks
) {
  const typedInput = config.inputSchema !== undefined;
  const { model, instructions, projectContext = !typedInput, codemode = false, task } = config;
  if (
    typeof model !== "function" ||
    (instructions !== undefined && typeof instructions !== "string") ||
    typeof projectContext !== "boolean" ||
    typeof codemode !== "boolean" ||
    (typedInput ? typeof task !== "function" : task !== undefined)
  )
    throw agentError(
      "TUBELESS_AGENT_INVALID_DEFINITION",
      "Invalid agent configuration: supply a model, and a task mapper exactly when inputSchema is set"
    );
  // The mapper is application code over validated options; recheck its text at each decision.
  const describe = (options: object): string => {
    // SAFETY: compileAgent validated options with inputSchema, or with `{ task }` when it is absent.
    const text = typedInput
      ? task!(options as Output<Options>)
      : (options as { task: string }).task;
    if (typeof text !== "string" || !text.trim())
      throw new Error("Agent task must be nonblank text");
    if (new TextEncoder().encode(text).length > MAX_TASK_BYTES)
      throw new Error(`Task exceeds ${MAX_TASK_BYTES} UTF-8 bytes`);
    return text;
  };
  return compileAgent<
    string,
    StandardSchemaV1<object, object>,
    StandardSchemaV1,
    ModelState,
    Tools,
    boolean
  >(
    {
      ...config,
      // SAFETY: the key callback only receives options validated by this agent's input schema.
      durability: config.durability as AgentDurability<object> | undefined,
      codemode,
      inputSchema: config.inputSchema ?? taskInput,
      resultSchema: config.resultSchema ?? answer,
      initialState: (options): ModelState => {
        describe(options);
        return { conversation: session?.seed() ?? null, outcomes: [] };
      },
      decide: async (state, context) => {
        const prompt =
          state.instructions ??
          (await modelInstructions(
            context.cwd,
            instructions,
            projectContext,
            context.signal,
            context.environment,
            codemode
          ));
        const response = await model(
          {
            instructions: prompt,
            task: describe(context.options),
            conversation: state.conversation,
            outcomes: state.outcomes,
          },
          context
        );
        // Sessions keep the finish response's conversation, which is never reduced into state.
        session?.observe(response.conversation);
        return {
          decision: response.decision,
          state: {
            instructions: prompt,
            conversation: response.conversation,
            outcomes: [],
          },
        };
      },
      reduce: (state, outcomes) => ({ ...state, outcomes }),
    },
    true
  );
}
