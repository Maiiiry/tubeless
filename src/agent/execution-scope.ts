import { executionScope, type ExecutionScope } from "../core/execution-scope.js";
import { createAbortError, throwIfAborted } from "../utilities/abort.js";
import { agentError, limit } from "./agent-state.js";
import type { AgentCheckpointSession } from "./checkpoint-session.js";
import type { AgentExecutionIdentity } from "./checkpoint-types.js";
import type { AgentEnvironment } from "./environment.js";
import type { AgentLimits } from "./agent-types.js";

export function resolvedLimits(limits: AgentLimits = {}): Required<AgentLimits> {
  const defaults = {
    maxTurns: 20,
    maxCalls: 100,
    maxDecisions: 100,
    maxDepth: 4,
    maxConcurrency: 1,
  };
  for (const key of Object.keys(limits)) {
    if (!Object.hasOwn(defaults, key))
      throw agentError("TUBELESS_AGENT_INVALID_DEFINITION", `Unsupported agent limit: ${key}`);
  }
  const result = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof AgentLimits)[]) {
    const value = limits[key] === undefined ? defaults[key] : limits[key];
    const minimum = key === "maxCalls" || key === "maxDepth" ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum)
      throw agentError(
        "TUBELESS_AGENT_INVALID_DEFINITION",
        `Agent ${key} must be a ${minimum === 0 ? "nonnegative" : "positive"} safe integer`
      );
    result[key] = value;
  }
  return Object.freeze(result);
}

interface Budget {
  id: string;
  key: string;
  journal?: AgentCheckpointSession;
  depth: number;
  limits: Required<AgentLimits>;
  maxCalls: number;
  maxDecisions: number;
  active: number;
}

interface Waiting {
  budgets: readonly Budget[];
  signal?: AbortSignal;
  cancel(error: Error): void;
  start(): void;
}

/** One queue per root, admitting all ancestor/local permits together. */
class LeafQueue {
  private readonly waiting = new Set<Waiting>();
  private readonly aborts = new Map<AbortSignal, { jobs: Set<Waiting>; cancel(): void }>();

  private watch(job: Waiting): void {
    const { signal } = job;
    if (!signal) return;
    let group = this.aborts.get(signal);
    if (!group) {
      const jobs = new Set<Waiting>();
      const cancel = () => {
        this.aborts.delete(signal);
        for (const pending of jobs) {
          this.waiting.delete(pending);
          pending.cancel(createAbortError(signal, "Agent execution"));
        }
      };
      group = { jobs, cancel };
      this.aborts.set(signal, group);
      signal.addEventListener("abort", cancel, { once: true });
    }
    group.jobs.add(job);
  }

  private unwatch(job: Waiting): void {
    const { signal } = job;
    const group = signal && this.aborts.get(signal);
    if (!group) return;
    group.jobs.delete(job);
    if (group.jobs.size === 0) {
      signal.removeEventListener("abort", group.cancel);
      this.aborts.delete(signal);
    }
  }

  private drain(): void {
    for (const job of this.waiting) {
      if (job.budgets.some((budget) => budget.active >= budget.limits.maxConcurrency)) continue;
      this.waiting.delete(job);
      for (const budget of job.budgets) budget.active++;
      job.start();
    }
  }

  async run<T>(
    budgets: readonly Budget[],
    work: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    throwIfAborted(signal, "Agent execution");
    await new Promise<void>((resolve, reject) => {
      const job: Waiting = {
        budgets,
        signal,
        cancel: reject,
        start: () => {
          this.unwatch(job);
          resolve();
        },
      };
      this.watch(job);
      this.waiting.add(job);
      this.drain();
    });
    try {
      throwIfAborted(signal, "Agent execution");
      return await work();
    } finally {
      for (const budget of budgets) budget.active--;
      this.drain();
    }
  }
}

/** Invocation-local admission, workspace authority and durable subtree ownership. */
export class AgentExecutionScope implements ExecutionScope {
  private constructor(
    private readonly budgets: readonly Budget[],
    private readonly queue: LeafQueue,
    readonly depth: number,
    readonly environment: AgentEnvironment,
    readonly route: readonly string[],
    private readonly agentRoute: readonly string[],
    readonly journal?: AgentCheckpointSession
  ) {}

  get agentKey(): string {
    return JSON.stringify(this.agentRoute);
  }

  static enter(
    context: object,
    limits: Required<AgentLimits>,
    id: string,
    environment: AgentEnvironment,
    definitionId: string,
    journal?: AgentCheckpointSession
  ): AgentExecutionScope {
    const parent = agentScope(context);
    const depth = parent?.depth ?? 0;
    const route = [...(parent?.route ?? []), JSON.stringify(["agent", definitionId])];
    const key = JSON.stringify(route);
    const budget: Budget = {
      id,
      key,
      journal,
      depth,
      limits,
      maxCalls: 0,
      maxDecisions: 0,
      active: 0,
    };
    return new AgentExecutionScope(
      [...(parent?.budgets ?? []), budget],
      parent?.queue ?? new LeafQueue(),
      depth,
      environment,
      route,
      route,
      journal
    );
  }

  identity(turn: number, call?: string): AgentExecutionIdentity | undefined {
    return this.journal
      ? Object.freeze({
          id: this.journal.key,
          agent: this.agentKey,
          turn,
          ...(call === undefined ? {} : { call }),
        })
      : undefined;
  }

  check(kind: "maxCalls" | "maxDecisions", count: number): void {
    for (const budget of this.budgets) {
      const usage = budget.journal?.budget(budget.key) ?? budget;
      if (count > budget.limits[kind] - usage[kind])
        limit(kind, budget.limits[kind], usage[kind], count, budget.id);
    }
  }

  private chargeLocal(
    kind: "maxCalls" | "maxDecisions",
    count: number,
    signal?: AbortSignal
  ): void {
    throwIfAborted(signal, "Agent admission");
    this.check(kind, count);
    for (const budget of this.budgets) if (!budget.journal) budget[kind] += count;
  }

  private get admissionJournal(): AgentCheckpointSession | undefined {
    return this.budgets.find((budget) => budget.journal)?.journal;
  }

  private get durableBudgets() {
    return this.budgets.filter((budget) => budget.journal);
  }

  async beginDecision(signal?: AbortSignal): Promise<void> {
    this.chargeLocal("maxDecisions", 1, signal);
    await this.admissionJournal?.reserve(this.durableBudgets, "maxDecisions", 1);
  }

  async admitCalls(count: number, signal?: AbortSignal): Promise<void> {
    if (this.journal?.decision(this.agentKey)?.admitted) return;
    this.chargeLocal("maxCalls", count, signal);
    if (this.journal) await this.journal.admitCalls(this.agentKey, this.durableBudgets, count);
    else await this.admissionJournal?.reserve(this.durableBudgets, "maxCalls", count);
  }

  /** Charge one script-issued call; it is admitted individually rather than with a decision. */
  async admitNestedCall(signal?: AbortSignal): Promise<void> {
    this.chargeLocal("maxCalls", 1, signal);
    await this.admissionJournal?.reserve(this.durableBudgets, "maxCalls", 1);
  }

  child(identity: { pipelineId: string; stepId: string; itemKey?: string }): AgentExecutionScope {
    const route = [
      ...this.route,
      JSON.stringify(["pipeline", identity.pipelineId, identity.stepId, identity.itemKey ?? null]),
    ];
    return new AgentExecutionScope(
      this.budgets,
      this.queue,
      this.depth,
      this.environment,
      route,
      this.agentRoute,
      this.journal
    );
  }

  delegate(turn: number, call: string): AgentExecutionScope {
    for (const budget of this.budgets) {
      const consumed = this.depth - budget.depth;
      if (consumed >= budget.limits.maxDepth)
        limit("maxDepth", budget.limits.maxDepth, consumed, 1, budget.id);
    }
    const route = [...this.agentRoute, JSON.stringify(["call", turn, call])];
    return new AgentExecutionScope(
      this.budgets,
      this.queue,
      this.depth + 1,
      this.environment,
      route,
      this.agentRoute,
      this.journal
    );
  }

  run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.queue.run(this.budgets, work, signal);
  }
}

export function agentScope(context: object): AgentExecutionScope | undefined {
  const scope = executionScope(context);
  return scope instanceof AgentExecutionScope ? scope : undefined;
}
