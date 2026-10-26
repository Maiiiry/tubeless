import type { PipelineStepContext, StandardSchemaV1 } from "../core/pipeline-types.js";
import type { AgentEnvironment, AgentEnvironmentProvider } from "./environment.js";
import type { AgentDurability, AgentExecutionIdentity } from "./checkpoint-types.js";
import type { DefaultAgentTools } from "./default-tools.js";

export type Awaitable<T> = T | Promise<T>;
export type Input<S extends StandardSchemaV1> = NonNullable<S["~standard"]["types"]>["input"];
export type Output<S extends StandardSchemaV1> = NonNullable<S["~standard"]["types"]>["output"];
/** Deeply read-only view of the owned plain-data state supplied to agent callbacks. */
export type AgentState<T> = { readonly [K in keyof T]: AgentState<T[K]> };
declare const capabilityTypes: unique symbol;

/** Opaque capability created by defineTool or pipelineTool; model decisions contain data only. */
export interface AgentTool<Arguments, Result> {
  readonly [capabilityTypes]: { readonly input: Arguments; readonly output: Result };
}

export type Tools = Readonly<Record<string, AgentTool<unknown, unknown>>>;
/** A standard workspace tool an agent's setup may select. */
export type DefaultAgentToolName = keyof DefaultAgentTools;
type RegisteredTools<Custom extends Tools, Defaults extends DefaultAgentToolName> = Omit<
  Pick<DefaultAgentTools, Defaults>,
  keyof Custom
> &
  Custom;

type ToolCall<Registry extends Tools> = {
  [Name in keyof Registry & string]: {
    readonly id: string;
    readonly tool: Name;
    readonly input: Registry[Name][typeof capabilityTypes]["input"];
  };
}[keyof Registry & string];

/** A code-mode script's JSON return value and bounded console lines. */
export interface CodemodeResult {
  readonly result: unknown;
  readonly logs: readonly string[];
  readonly logsTruncated: boolean;
}

/** The only capability a code-mode agent advertises; its scripts reach the registry. */
type CodemodeTools = {
  readonly codemode: AgentTool<{ readonly code: string }, CodemodeResult>;
};

/**
 * One selected default or custom call with raw model arguments; custom names replace
 * defaults. With code mode, the only callable tool is `codemode`.
 */
export type AgentCall<
  Registry extends Tools = {},
  Codemode extends boolean = false,
  Defaults extends DefaultAgentToolName = DefaultAgentToolName,
> = Codemode extends true ? ToolCall<CodemodeTools> : ToolCall<RegisteredTools<Registry, Defaults>>;

type ToolOutcome<Registry extends Tools> = {
  [Name in keyof Registry & string]: {
    readonly id: string;
    readonly tool: Name;
  } & (
    | {
        readonly ok: true;
        readonly value: Registry[Name][typeof capabilityTypes]["output"];
      }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
  );
}[keyof Registry & string];

/** Input-order result or deliberately recoverable handler failure, including selected defaults. */
export type AgentOutcome<
  Registry extends Tools = {},
  Codemode extends boolean = false,
  Defaults extends DefaultAgentToolName = DefaultAgentToolName,
> = Codemode extends true
  ? ToolOutcome<CodemodeTools>
  : ToolOutcome<RegisteredTools<Registry, Defaults>>;

/** A nonempty batch of independent calls, or the raw input to the final-result schema. */
export type AgentDecision<
  Registry extends Tools,
  Result,
  Codemode extends boolean = false,
  Defaults extends DefaultAgentToolName = DefaultAgentToolName,
> =
  | {
      readonly kind: "continue";
      readonly calls: readonly [
        AgentCall<Registry, Codemode, Defaults>,
        ...AgentCall<Registry, Codemode, Defaults>[],
      ];
      readonly result?: never;
    }
  | { readonly kind: "finish"; readonly result: Result; readonly calls?: never };

/** Finite limits for this agent and its descendants; child limits may only tighten them. */
export interface AgentLimits {
  /** Decision callbacks, including finish. Defaults to 20. */
  readonly maxTurns?: number;
  /** Admitted subtree calls, including calls stopped before dispatch. Defaults to 100. */
  readonly maxCalls?: number;
  /** Subtree decision callback admissions. Defaults to 100; provider retries are application-owned. */
  readonly maxDecisions?: number;
  /** Pipeline-tool delegation edges below this agent. Defaults to 4; zero allows leaf tools only. */
  readonly maxDepth?: number;
  /** Active decision callbacks and leaf handlers across the subtree. Defaults to 1. */
  readonly maxConcurrency?: number;
}

/** Step services and the workspace capability available to a registered tool. */
export interface AgentToolContext extends PipelineStepContext<{}> {
  readonly environment: AgentEnvironment;
  readonly execution?: AgentExecutionIdentity;
}

/** Model-facing descriptors and ordinary step services, without executable tools. */
export interface AgentDecisionContext<Options extends object> extends PipelineStepContext<Options> {
  readonly environment: AgentEnvironment;
  readonly execution?: AgentExecutionIdentity;
  readonly turn: number;
  readonly stateVersion: number;
  readonly capabilities: readonly {
    readonly name: string;
    readonly description: string;
    readonly inputJsonSchema: Readonly<Record<string, unknown>>;
  }[];
  readonly resultJsonSchema: Readonly<Record<string, unknown>>;
}

export interface AgentDefinition<
  Id extends string,
  Options extends StandardSchemaV1<object, object>,
  Result extends StandardSchemaV1,
  State,
  Registry extends Tools,
  Codemode extends boolean = false,
  Defaults extends DefaultAgentToolName = DefaultAgentToolName,
> {
  readonly id: Id;
  readonly name?: string;
  readonly description?: string;
  /** Semantic revision; required when this agent uses or inherits durable recovery. */
  readonly implementationVersion?: string;
  readonly inputSchema: Options;
  readonly resultSchema: Result;
  readonly resultJsonSchema?: Readonly<Record<string, unknown>>;
  /** Extend the selected standard tools; a custom tool with the same name replaces that default. */
  readonly tools?: Registry;
  /**
   * Standard workspace tools this agent may use. Defaults to all of read, write, edit, bash,
   * list and search; `[]` grants none, so only custom tools remain.
   */
  readonly defaultTools?: readonly Defaults[];
  /**
   * Advertise one `codemode` tool instead of the registry. Its JavaScript scripts call every
   * registered tool; decisions and outcomes then name only `codemode`. Defaults to false.
   */
  readonly codemode?: Codemode;
  readonly limits?: AgentLimits;
  /** Workspace capabilities; descendants inherit them unless explicitly replaced. */
  readonly environment?: AgentEnvironmentProvider;
  /** Acknowledged recovery checkpoints; requires an explicit implementationVersion. */
  readonly durability?: AgentDurability<Output<Options>>;
  initialState(options: Output<Options>): State;
  decide(
    state: AgentState<NoInfer<State>>,
    context: AgentDecisionContext<Output<Options>>
  ): Awaitable<unknown>;
  reduce?(
    state: AgentState<NoInfer<State>>,
    outcomes: readonly AgentOutcome<Registry, Codemode, Defaults>[]
  ): NoInfer<State>;
  dryRun?(
    state: AgentState<NoInfer<State>>,
    context: AgentDecisionContext<Output<Options>>
  ): Awaitable<unknown>;
}
