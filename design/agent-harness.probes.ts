/** Compile-only public API probes: fixture schemas are declared. */
import { expectTypeOf } from "vitest";
import {
  createSteps,
  definePipeline,
  type IterationDecision,
  type PipelineInput,
  type PipelineResult,
  type StandardSchemaV1,
} from "tubeless";
import { definePipelineCommand } from "tubeless/cli";
import { defineProject } from "tubeless/project";
import {
  defineAgentLoop,
  defineTool,
  pipelineTool,
  ToolError,
  type AgentCall,
  type AgentDecision,
  type AgentOutcome,
} from "tubeless/agent";

// These declared schemas represent application-owned validators, not fake runtime validators.
// Their implementations must supply JSON Schema metadata or use the explicit descriptor fallback.
declare const questionSchema: StandardSchemaV1<
  { question: string },
  { question: string; limit: number }
>;
declare const answerSchema: StandardSchemaV1<string, { answer: string; checked: true }>;
declare const searchInputSchema: StandardSchemaV1<
  { query: string },
  { query: string; limit: number }
>;
declare const searchResultSchema: StandardSchemaV1<readonly string[], { hits: readonly string[] }>;
declare const pageInputSchema: StandardSchemaV1<{ url: string }>;
declare const textSchema: StandardSchemaV1<string>;
declare const optionalInputSchema: StandardSchemaV1<{ question?: string }, { question: string }>;

// 1. Finish immediately; schema transformations distinguish model data from public results.
const immediate = defineAgentLoop({
  id: "immediate",
  inputSchema: questionSchema,
  resultSchema: answerSchema,
  initialState(options) {
    expectTypeOf(options).toEqualTypeOf<{ question: string; limit: number }>();
    return { question: options.question };
  },
  decide(state) {
    return { kind: "finish", result: state.question } satisfies AgentDecision<{}, string>;
  },
});

expectTypeOf<PipelineInput<typeof immediate>>().toEqualTypeOf<{ question: string }>();
expectTypeOf<PipelineResult<typeof immediate>>().toEqualTypeOf<{ answer: string; checked: true }>();
expectTypeOf(immediate.id).toEqualTypeOf<"immediate">();
immediate.runOrThrow({ question: "What changed?" });
// @ts-expect-error The input schema's required raw question is preserved.
immediate.runOrThrow({});
// @ts-expect-error Schema-transformed fields are not caller options.
immediate.runOrThrow({ question: "What changed?", limit: 10 });
// @ts-expect-error Runtime calls are not declared static step IDs.
immediate.plan({ stepIds: ["turn-1/search"] });

const optional = defineAgentLoop({
  id: "optional",
  inputSchema: optionalInputSchema,
  resultSchema: textSchema,
  initialState: (options) => options.question,
  decide: (state) => ({ kind: "finish", result: state }),
});
optional.runOrThrow();

// 2. Two tools, ordered outcomes, one reducer, then finish.
const search = defineTool({
  description: "Search a query.",
  inputSchema: searchInputSchema,
  outputSchema: searchResultSchema,
  inputJsonSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  run(input, context) {
    expectTypeOf(input).toEqualTypeOf<{ query: string; limit: number }>();
    expectTypeOf(context.signal).toEqualTypeOf<AbortSignal | undefined>();
    return [input.query].slice(0, input.limit);
  },
  dryRun: () => ["preview hit"],
});
const readPage = defineTool({
  description: "Read a page.",
  inputSchema: pageInputSchema,
  outputSchema: textSchema,
  run: ({ url }) => `Text from ${url}`,
  dryRun: ({ url }) => `Preview of ${url}`,
});
const tools = { search, readPage };
const firstDecision = {
  kind: "continue",
  calls: [
    { id: "search-1", tool: "search", input: { query: "tubeless" } },
    { id: "page-1", tool: "readPage", input: { url: "https://example.test/known-page" } },
  ],
} satisfies AgentDecision<typeof tools, string>;

interface ResearchState {
  readonly question: string;
  readonly observations: readonly string[];
}

const researcher = defineAgentLoop({
  id: "researcher",
  inputSchema: questionSchema,
  resultSchema: answerSchema,
  tools,
  limits: { maxTurns: 3, maxCalls: 4, maxDecisions: 3, maxConcurrency: 2 },
  initialState: ({ question }): ResearchState => ({ question, observations: [] }),
  decide(state, context) {
    expectTypeOf(context.options.limit).toEqualTypeOf<number>();
    // @ts-expect-error State snapshots are deeply read-only.
    state.observations.push("mutation");
    return state.observations.length === 0
      ? firstDecision
      : ({ kind: "finish", result: state.observations.join("\n") } satisfies AgentDecision<
          typeof tools,
          string
        >);
  },
  reduce(state, outcomes) {
    const observations = outcomes.map((outcome) => {
      if (!outcome.ok) return outcome.error.message;
      if (outcome.tool === "search") {
        expectTypeOf(outcome.value).toEqualTypeOf<{ hits: readonly string[] }>();
        return outcome.value.hits.join("\n");
      }
      if (outcome.tool === "readPage") {
        expectTypeOf(outcome.value).toEqualTypeOf<string>();
        return outcome.value;
      }
      return JSON.stringify(outcome.value);
    });
    return { ...state, observations: [...state.observations, ...observations] };
  },
  dryRun: (_state, context) =>
    context.turn === 1 ? firstDecision : { kind: "finish", result: "preview" },
});

// Untrusted provider output remains unknown until runtime validation, even when a SDK is typed.
declare const modelResponse: unknown;
defineAgentLoop({
  id: "untrusted-model",
  inputSchema: questionSchema,
  resultSchema: textSchema,
  tools,
  initialState: ({ question }) => ({ question }),
  decide: () => modelResponse,
});

// @ts-expect-error Decisions cannot finish and schedule work simultaneously.
const mixed: AgentDecision<typeof tools, string> = {
  kind: "finish",
  result: "done",
  calls: firstDecision.calls,
};
// @ts-expect-error A continuing turn must contain at least one call.
const empty: AgentDecision<typeof tools, string> = { kind: "continue", calls: [] };
// @ts-expect-error Unknown tools cannot enter a typed decision.
const unknownTool: AgentCall<typeof tools> = { id: "x", tool: "shell", input: {} };
const transformedInput: AgentCall<typeof tools> = {
  id: "x",
  tool: "search",
  // @ts-expect-error Search takes raw model arguments, not the schema's transformed shape.
  input: { query: "q", limit: 1 },
};
// @ts-expect-error Input shapes remain correlated with tool names.
const wrongInput: AgentCall<typeof tools> = { id: "x", tool: "readPage", input: { query: "q" } };
const wrongFinish: AgentDecision<typeof tools, string> = {
  kind: "finish",
  // @ts-expect-error Finish receives the raw result schema input, not its transformed output.
  result: { answer: "x", checked: true },
};
const wrongOutcome: AgentOutcome<typeof tools> = {
  id: "x",
  tool: "search",
  ok: true,
  // @ts-expect-error Successful outputs remain correlated with tool names.
  value: "text",
};
void [mixed, empty, unknownTool, transformedInput, wrongInput, wrongFinish, wrongOutcome];

const noCustomTools: AgentDecision<{}, string> = {
  kind: "continue",
  calls: [{ id: "read", tool: "read", input: { path: "README.md" } }],
};
const unknownCustomTool: AgentCall = {
  id: "x",
  // @ts-expect-error An agent without custom tools cannot call an unregistered name.
  tool: "privateTool",
  input: {},
};
void [noCustomTools, unknownCustomTool];
defineTool({
  description: "Invalid transformed output.",
  inputSchema: searchInputSchema,
  outputSchema: searchResultSchema,
  // @ts-expect-error Handlers return schema input; output transformation belongs to validation.
  run: () => ({ hits: ["already transformed"] }),
});
defineAgentLoop({
  id: "wrong-state",
  inputSchema: questionSchema,
  resultSchema: textSchema,
  initialState: () => ({ attempts: 0 }),
  decide: () => ({ kind: "finish", result: "done" }),
  // @ts-expect-error A reducer must preserve the inferred state contract.
  reduce: () => ({ attempts: "one" }),
});

// 3. An ordinary parent pipeline calls an agent and consumes its precise final result.
const { fromPipeline, step } = createSteps<{ prompt: string }>();
const research = fromPipeline("research", {
  pipeline: researcher,
  mapOptions: (_inputs, context) => ({ question: context.options.prompt }),
});
const present = step("present", {
  dependsOn: [research],
  run: ({ research: result }) => {
    expectTypeOf(result).toEqualTypeOf<{ answer: string; checked: true }>();
    return result.answer;
  },
});
const parent = definePipeline({ id: "parent", steps: [research, present], finalize: present });
expectTypeOf<PipelineResult<typeof parent>>().toEqualTypeOf<string>();

const command = definePipelineCommand(researcher);
expectTypeOf(command.pipeline).toEqualTypeOf<typeof researcher>();
const project = defineProject("agents", [command, parent]);
expectTypeOf(project.get("researcher")).toEqualTypeOf<typeof researcher>();
expectTypeOf(project.get("researcher").runOrThrow).returns.resolves.toEqualTypeOf<{
  answer: string;
  checked: true;
}>();
// @ts-expect-error Project lookup preserves literal pipeline IDs.
project.get("researchre");

// 4. The same registry can call a schema-backed agent or an explicitly mapped ordinary child.
const { step: countStep } = createSteps<{ text: string }>();
const count = countStep("count", { run: (_inputs, context) => context.options.text.length });
const counter = definePipeline({ id: "counter", steps: [count], finalize: count });
const delegatedTools = {
  investigate: pipelineTool(researcher, { description: "Research one question." }),
  count: pipelineTool(counter, {
    description: "Count characters in a question.",
    inputSchema: questionSchema,
    mapOptions: ({ question, limit }) => ({ text: question.slice(0, limit) }),
  }),
};
defineAgentLoop({
  id: "coordinator",
  inputSchema: questionSchema,
  resultSchema: textSchema,
  tools: delegatedTools,
  initialState: (): { answer?: string } => ({}),
  decide(state, context) {
    return state.answer === undefined
      ? ({
          kind: "continue",
          calls: [
            { id: "child-1", tool: "investigate", input: { question: context.options.question } },
          ],
        } satisfies AgentDecision<typeof delegatedTools, string>)
      : { kind: "finish", result: state.answer };
  },
  reduce(state, outcomes) {
    const child = outcomes.find((outcome) => outcome.tool === "investigate");
    if (child?.ok) {
      expectTypeOf(child.value).toEqualTypeOf<{ answer: string; checked: true }>();
      return { answer: child.value.answer };
    }
    return state;
  },
});
// @ts-expect-error A type-only child requires a model input schema and explicit mapping.
pipelineTool(counter, { description: "Missing model argument boundary." });
pipelineTool(counter, {
  description: "Incorrectly mapped child input.",
  inputSchema: questionSchema,
  // @ts-expect-error Child mappings produce the child's accepted domain input.
  mapOptions: () => ({ text: 12 }),
});

// 5. A deliberately classified tool error becomes an observation for the next decision.
const recoverableTools = {
  read: defineTool({
    description: "Read an available page.",
    inputSchema: pageInputSchema,
    outputSchema: textSchema,
    run: ({ url }) => {
      if (url.endsWith("/missing")) throw new ToolError("NOT_FOUND", "Page unavailable");
      return "Available content";
    },
  }),
};
defineAgentLoop({
  id: "recovery",
  inputSchema: questionSchema,
  resultSchema: textSchema,
  tools: recoverableTools,
  initialState: (): { observation?: string } => ({}),
  decide(state) {
    return state.observation === undefined
      ? ({
          kind: "continue",
          calls: [{ id: "read-1", tool: "read", input: { url: "https://example.test/missing" } }],
        } satisfies AgentDecision<typeof recoverableTools, string>)
      : { kind: "finish", result: `Observed: ${state.observation}` };
  },
  reduce: (_state, outcomes) => ({
    observation: outcomes
      .map((outcome) => (outcome.ok ? outcome.value : outcome.error.code))
      .join(", "),
  }),
});

// Generic iteration: ordinary child output is translated to next(state) or finish(result).
const proposed = createSteps(questionSchema);
const seed = createSteps(questionSchema).step("seed", {
  run: (_inputs, context) => context.options.limit,
});
const sources = createSteps(questionSchema).step("sources", {
  outputSchema: searchResultSchema,
  run: () => ["one source"],
});
const bounded = proposed.iteratePipeline("bounded", {
  pipeline: counter,
  dependsOn: [seed, sources],
  maxIterations: 3,
  initialState: ({ seed: limit, sources }) => {
    expectTypeOf(sources).toEqualTypeOf<{ hits: readonly string[] }>();
    return { remaining: limit + sources.hits.length };
  },
  mapOptions: (state, _inputs, context) => ({
    text: context.options.question.slice(0, state.remaining),
  }),
  transition: (count, state): IterationDecision<{ remaining: number }, number> =>
    count === 0
      ? { kind: "finish", result: count }
      : { kind: "next", state: { remaining: state.remaining - 1 } },
});
const iterated = definePipeline({
  id: "iterated",
  steps: [seed, sources, bounded],
  finalize: bounded,
});
expectTypeOf<PipelineInput<typeof iterated>>().toEqualTypeOf<{ question: string }>();
expectTypeOf<PipelineResult<typeof iterated>>().toEqualTypeOf<number>();
definePipelineCommand(iterated);
// @ts-expect-error Finish does not update state and continue simultaneously.
const mixedTransition: IterationDecision<number, string> = {
  kind: "finish",
  result: "done",
  state: 1,
};
void mixedTransition;

const { iteratePipeline } = createSteps<{ text: string }>();
const finishWithoutValue = iteratePipeline("finish-without-value", {
  pipeline: counter,
  maxIterations: 1,
  initialState: () => 0,
  mapOptions: (_state, _inputs, context) => ({ text: context.options.text }),
  transition: () => ({ kind: "finish", result: undefined }),
});
const noValue = definePipeline({
  id: "no-value",
  steps: [finishWithoutValue],
  finalize: finishWithoutValue,
});
expectTypeOf<PipelineResult<typeof noValue>>().toEqualTypeOf<undefined>();
// @ts-expect-error A type-only factory does not gain automatic CLI schema inference.
definePipelineCommand(noValue);
definePipelineCommand(noValue, { params: { text: { type: "string", required: true } } });
