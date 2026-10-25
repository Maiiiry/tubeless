import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { PipelineDefinitionError, type Pipeline, type StandardSchemaV1 } from "tubeless";
import { createPipelineTestRuntime } from "../testing/testing.js";
import {
  compilePipelineDocument,
  PipelineDocumentError,
  type CompiledPipelineDocument,
  type PipelineDocumentMetadata,
  type ProjectRegistry,
} from "tubeless/project";
import type { PipelineDocument } from "./project-document.js";

function document(): PipelineDocument {
  return {
    version: 1,
    pipelines: {
      import: {
        targets: ["normalize"],
        steps: [
          { id: "normalize", run: "normalize", dependsOn: ["load"] },
          { id: "load", run: "load" },
        ],
        finalize: { run: "result", requireOutputs: ["normalize"] },
      },
    },
  };
}

function registry(): ProjectRegistry {
  return {
    steps: {
      load: vi.fn(() => "hello"),
      normalize: vi.fn(({ load }) => String(load).toUpperCase()),
    },
    finalizers: { result: vi.fn(({ normalize }) => normalize) },
  };
}

function standardSchema<TInput, TOutput>(
  validate: StandardSchemaV1<TInput, TOutput>["~standard"]["validate"]
): StandardSchemaV1<TInput, TOutput> {
  return { "~standard": { version: 1, vendor: "test", validate } };
}

describe("declarative pipelines", () => {
  it("exposes immutable collection and metadata snapshots with honest dynamic types", () => {
    const metadata = {
      name: "Import jobs",
      description: "Normalize rows.",
      authors: ["Maintainer"],
      date: "2026-09-21",
    };
    const source = { ...document(), metadata };
    const compiled: CompiledPipelineDocument = compilePipelineDocument(source, registry());
    const snapshot: PipelineDocumentMetadata | undefined = compiled.metadata;
    const pipeline = compiled.get("import");
    expectTypeOf(pipeline).toEqualTypeOf<Pipeline<object, unknown>>();
    expectTypeOf(pipeline.id).toEqualTypeOf<string>();
    expectTypeOf(pipeline.runOrThrow).returns.toEqualTypeOf<Promise<unknown>>();
    expectTypeOf(pipeline.runOrThrow).parameter(0).toEqualTypeOf<object | undefined>();
    expect(compiled.get("import")).toBe(pipeline);
    expect(compiled.pipelines).toEqual([pipeline]);
    expect(compiled.pipelines[0]).toBe(pipeline);
    const { get } = compiled;
    expect(get("import")).toBe(pipeline);
    expect(() => get("missing")).toThrow('Compiled document does not define pipeline "missing".');
    expect(() => get("toString")).toThrow('Compiled document does not define pipeline "toString".');
    expect(() => get("imprt")).toThrow(
      'Compiled document does not define pipeline "imprt". Did you mean "import"?'
    );
    metadata.name = "Changed";
    metadata.authors.push("Another author");
    source.pipelines.preview = source.pipelines.import;
    expect(snapshot).toEqual({
      name: "Import jobs",
      description: "Normalize rows.",
      authors: ["Maintainer"],
      date: "2026-09-21",
    });
    expect(compiled.pipelines).toHaveLength(1);
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.pipelines)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.authors)).toBe(true);
    expect(() => {
      // @ts-expect-error Compiled collections cannot be mutated.
      compiled.pipelines.push(pipeline);
    }).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error Document metadata cannot be mutated.
      compiled.metadata!.name = "Changed";
    }).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error Author snapshots cannot be mutated.
      compiled.metadata!.authors!.push("Changed");
    }).toThrow(TypeError);
    expect(compilePipelineDocument(document(), registry()).metadata).toBeUndefined();
    expect(
      compilePipelineDocument({ ...document(), metadata: {} }, registry()).metadata
    ).toBeDefined();
  });

  it("composes a forward-referenced pipeline once and maps its result", async () => {
    const runChild = vi.fn((_inputs, context) =>
      "value" in context.options ? context.options.value : "missing"
    );
    const mapOptions = vi.fn((_inputs, context) => ({
      value: "value" in context.options ? context.options.value : "missing",
    }));
    const controls = vi.fn(() => ({ maxConcurrency: 2 }));
    const mapResult = vi.fn(async (value) => ({ childValue: value }));
    const skipChild = vi.fn((_inputs, context) =>
      "cached" in context.options && context.options.cached
        ? { reason: "already cached", value: { childValue: "cached" } }
        : false
    );
    const source: PipelineDocument = {
      version: 1,
      pipelines: {
        parent: {
          steps: [
            {
              id: "child-stage",
              fromPipeline: { pipeline: "child", adapter: "single" },
              skip: "cached",
            },
          ],
          finalize: { run: "parentResult", requireOutputs: ["child-stage"] },
        },
        child: {
          steps: [{ id: "work", run: "work" }],
          finalize: { run: "childResult", requireOutputs: ["work"] },
        },
      },
    };
    const pipelines = compilePipelineDocument(source, {
      steps: { work: runChild },
      finalizers: {
        childResult: ({ work }) => work,
        parentResult: ({ "child-stage": childStage }) => childStage,
      },
      skipPredicates: { cached: skipChild },
      fromPipelineAdapters: { single: { controls, mapOptions, mapResult } },
    });
    expect(pipelines.pipelines.map(({ id }) => id)).toEqual(["parent", "child"]);
    expect(pipelines.get("parent").plan().steps[0]?.nestedPipeline).toEqual({
      identity: pipelines.get("child").definition!.identity,
      mode: "single",
      pipelineId: "child",
      stepIds: ["work"],
    });
    expect(runChild).not.toHaveBeenCalled();
    expect(mapOptions).not.toHaveBeenCalled();
    const childPlan = vi.spyOn(pipelines.get("child"), "plan");
    await expect(
      pipelines
        .get("parent")
        .runOrThrow({ value: "mapped" }, {}, createPipelineTestRuntime().context)
    ).resolves.toEqual({ childValue: "mapped" });
    expect(childPlan).toHaveBeenCalledOnce();
    expect(controls).toHaveBeenCalledOnce();
    expect(mapResult).toHaveBeenCalledOnce();
    await expect(
      pipelines
        .get("parent")
        .runOrThrow({ cached: true, value: "ignored" }, {}, createPipelineTestRuntime().context)
    ).resolves.toEqual({ childValue: "cached" });
    expect(runChild).toHaveBeenCalledOnce();
  });

  it("fans out a child pipeline with registered item wiring, controls, and policy skip", async () => {
    const items = vi.fn(({ source }) => source as readonly { id: string; value: number }[]);
    const runChild = vi.fn((_inputs, context) =>
      "value" in context.options ? context.options.value : -1
    );
    const runAlternate = vi.fn((_inputs, context) =>
      "value" in context.options ? context.options.value + 10 : -1
    );
    const controls = vi.fn((_item, index) => ({
      stepIds: [index === 0 ? "work" : "alternate"],
    }));
    const source: PipelineDocument = {
      version: 1,
      pipelines: {
        child: {
          steps: [
            { id: "work", run: "work" },
            { id: "alternate", run: "alternate" },
          ],
          finalize: { run: "childResult" },
        },
        parent: {
          steps: [
            { id: "source", run: "source" },
            {
              id: "children",
              forEachPipeline: { pipeline: "child", adapter: "many" },
              dependsOn: ["source"],
              skip: "skipChildren",
            },
          ],
          finalize: { run: "parentResult", requireOutputs: ["children"] },
        },
      },
    };
    const pipelines = compilePipelineDocument(source, {
      steps: {
        source: (_inputs, context) => ("values" in context.options ? context.options.values : []),
        work: runChild,
        alternate: runAlternate,
      },
      finalizers: {
        childResult: ({ work, alternate }) => ({ value: work ?? alternate }),
        parentResult: ({ children }) => children,
      },
      skipPredicates: {
        skipChildren: (_inputs, context) =>
          "skip" in context.options && context.options.skip
            ? { reason: "no children requested", value: [] }
            : false,
      },
      forEachPipelineAdapters: {
        many: {
          items,
          key: (item) => String((item as { id: string }).id),
          concurrency: 2,
          controls,
          progress: { itemNoun: "records" },
          mapOptions: (item) => ({ value: (item as { value: number }).value }),
          mapResult: (value) => (value as { value: number }).value * 2,
        },
      },
    });
    const parent = pipelines.get("parent");
    expect(parent.plan().steps[1]?.nestedPipeline).toMatchObject({
      mode: "for-each",
      pipelineId: "child",
    });
    const values = [
      { id: "a", value: 2 },
      { id: "b", value: 3 },
    ];
    const runOptions = { values };
    await expect(
      parent.runOrThrow(runOptions, {}, createPipelineTestRuntime().context)
    ).resolves.toEqual([4, 26]);
    await expect(
      parent.runOrThrow({ skip: true, values: [] }, {}, createPipelineTestRuntime().context)
    ).resolves.toEqual([]);
    expect(items).toHaveBeenCalledOnce();
    expect(controls).toHaveBeenNthCalledWith(
      1,
      values[0],
      0,
      { source: values },
      expect.objectContaining({ options: runOptions })
    );
    expect(controls).toHaveBeenNthCalledWith(
      2,
      values[1],
      1,
      { source: values },
      expect.objectContaining({ options: runOptions })
    );
    expect(runChild).toHaveBeenCalledOnce();
    expect(runAlternate).toHaveBeenCalledOnce();
  });

  it("validates an ordinary valued skip before publishing it to a required dependent", async () => {
    const runCached = vi.fn(() => "live");
    const consume = vi.fn(({ cached }) => cached);
    const validateCached = vi.fn((value: unknown) => ({ value: `${String(value)}-validated` }));
    const pipeline = compilePipelineDocument(
      {
        version: 1,
        pipelines: {
          parent: {
            steps: [
              {
                id: "cached",
                run: "cached",
                skip: "useCached",
                outputSchema: "cachedValue",
              },
              { id: "consume", run: "consume", dependsOn: ["cached"] },
            ],
            finalize: { run: "result", requireOutputs: ["consume"] },
          },
        },
      },
      {
        steps: { cached: runCached, consume },
        finalizers: { result: ({ consume: value }) => value },
        skipPredicates: {
          useCached: () => ({ reason: "cache hit", value: "saved" }),
        },
        schemas: {
          cachedValue: standardSchema(validateCached),
        },
      }
    ).get("parent");

    const result = await pipeline.run({}, {}, createPipelineTestRuntime().context);

    expect(result.status).toBe("completed");
    expect(result.value).toBe("saved-validated");
    expect(result.steps).toMatchObject([
      { id: "cached", status: "skipped", reason: "policy", message: "cache hit" },
      { id: "consume", status: "completed" },
    ]);
    expect(runCached).not.toHaveBeenCalled();
    expect(validateCached).toHaveBeenCalledWith("saved");
    expect(consume).toHaveBeenCalledWith(
      { cached: "saved-validated" },
      expect.objectContaining({ dryRun: false })
    );
  });

  it.each([
    [
      "single child pipeline",
      { id: "child", fromPipeline: { pipeline: "missing", adapter: "single" } },
      { fromPipelineAdapters: { single: { mapOptions: () => ({}) } } },
      '.fromPipeline.pipeline: Unknown pipeline "missing"',
    ],
    [
      "single child adapter",
      { id: "child", fromPipeline: { pipeline: "leaf", adapter: "missing" } },
      {},
      '.fromPipeline.adapter: Unknown registered name "missing"',
    ],
    [
      "fan-out adapter",
      { id: "children", forEachPipeline: { pipeline: "leaf", adapter: "missing" } },
      {},
      '.forEachPipeline.adapter: Unknown registered name "missing"',
    ],
    [
      "skip predicate",
      { id: "work", run: "work", skip: "missing" },
      {},
      '.skip: Unknown registered name "missing"',
    ],
  ])("rejects an unknown %s reference", (_label, step, additions, message) => {
    const source = {
      version: 1,
      pipelines: {
        parent: { steps: [step], finalize: { run: "result" } },
        leaf: { steps: [{ id: "work", run: "work" }], finalize: { run: "result" } },
      },
    };
    expect(() =>
      compilePipelineDocument(source, {
        steps: { work: () => undefined },
        finalizers: { result: () => undefined },
        ...additions,
      })
    ).toThrow(message);
  });

  it("rejects cross-pipeline composition cycles at the reference path", () => {
    const source = {
      version: 1,
      pipelines: {
        first: {
          steps: [{ id: "second", fromPipeline: { pipeline: "second", adapter: "child" } }],
          finalize: { run: "result" },
        },
        second: {
          steps: [{ id: "first", fromPipeline: { pipeline: "first", adapter: "child" } }],
          finalize: { run: "result" },
        },
      },
    };
    expect(() =>
      compilePipelineDocument(source, {
        steps: {},
        finalizers: { result: () => undefined },
        fromPipelineAdapters: { child: { mapOptions: () => ({}) } },
      })
    ).toThrow(
      '$.pipelines["second"].steps[0].fromPipeline.pipeline: Pipeline composition cycle through "first"'
    );
  });

  it("compiles multiple pipelines and forward references without invoking application code", async () => {
    const source = document();
    source.pipelines.preview = { ...source.pipelines.import };
    const handlers = registry();
    const pipelines = compilePipelineDocument(source, handlers);
    expect(pipelines.pipelines.map(({ id }) => id)).toEqual(["import", "preview"]);
    const pipeline = pipelines.get("import");
    expect(pipeline.plan({ targets: ["normalize"] }).steps).toMatchObject([
      { id: "load", selected: true },
      { id: "normalize", selected: true, dependencies: ["load"] },
    ]);
    expect(pipeline.toMermaid()).toContain("normalize");
    expect(handlers.steps.load).not.toHaveBeenCalled();
    expect(handlers.finalizers.result).not.toHaveBeenCalled();
    const runtime = createPipelineTestRuntime();
    await expect(pipeline.runOrThrow({}, {}, runtime.context)).resolves.toBe("HELLO");
    expect(handlers.steps.load).toHaveBeenCalledOnce();
  });

  it("snapshots wiring and resolved handlers at compilation", async () => {
    const source = document();
    const handlers = registry();
    const pipeline = compilePipelineDocument(source, handlers).get("import");
    source.pipelines.import.steps = [];
    handlers.steps = {
      load: () => {
        throw new Error("replacement");
      },
    };
    await expect(pipeline.runOrThrow({}, {}, createPipelineTestRuntime().context)).resolves.toBe(
      "HELLO"
    );
  });

  describe.each(["fromPipeline", "forEachPipeline"] as const)("%s registry boundary", (mode) => {
    function source(): PipelineDocument {
      const reference = { pipeline: "leaf", adapter: "child" };
      return {
        version: 1,
        pipelines: {
          parent: {
            steps: [
              mode === "fromPipeline"
                ? { id: "child", fromPipeline: reference }
                : { id: "child", forEachPipeline: reference },
            ],
            finalize: { run: "result", requireOutputs: ["child"] },
          },
          leaf: { steps: [{ id: "work", run: "work" }], finalize: { run: "result" } },
        },
      };
    }

    function wiring(adapter: unknown): ProjectRegistry {
      return {
        steps: { work: () => "leaf" },
        finalizers: { result: ({ child, work }) => child ?? work },
        [`${mode}Adapters`]: { child: adapter },
      };
    }

    it("retains resolved callbacks when the application replaces adapter fields", async () => {
      const adapter = {
        items: vi.fn(() => ["item"]),
        key: vi.fn(() => "key"),
        concurrency: vi.fn(() => 1),
        controls: vi.fn(() => ({})),
        mapOptions: vi.fn(() => ({})),
        mapResult: vi.fn(() => "original"),
      };
      const callbacks = Object.values(adapter);
      const pipeline = compilePipelineDocument(source(), wiring(adapter)).get("parent");
      for (const callback of callbacks) expect(callback).not.toHaveBeenCalled();
      const replacement = vi.fn(() => {
        throw new Error("replacement callback must not be used");
      });
      Object.assign(adapter, {
        items: replacement,
        key: replacement,
        concurrency: replacement,
        controls: replacement,
        mapOptions: replacement,
        mapResult: replacement,
      });
      await expect(
        pipeline.runOrThrow({}, {}, createPipelineTestRuntime().context)
      ).resolves.toEqual(mode === "fromPipeline" ? "original" : ["original"]);
      expect(replacement).not.toHaveBeenCalled();
    });

    it.each<[unknown, string]>([
      [null, "Expected a registered adapter object"],
      [[], "Expected a registered adapter object"],
      [
        { items: () => [], key: () => "key", mapOptions: () => ({}), controls: null },
        "Expected adapter controls to be an object or function",
      ],
      [
        { items: () => [], key: () => "key", mapOptions: () => ({}), mapResult: "invalid" },
        "Expected adapter mapResult to be a function",
      ],
    ])("rejects invalid adapter %j at its document reference", (adapter, message) => {
      expect(() => compilePipelineDocument(source(), wiring(adapter))).toThrow(
        new PipelineDocumentError(`$.pipelines["parent"].steps[0].${mode}.adapter`, message)
      );
    });
  });

  it("rejects a static fan-out adapter concurrency that is not a positive integer", () => {
    const source: PipelineDocument = {
      version: 1,
      pipelines: {
        parent: {
          steps: [{ id: "child", forEachPipeline: { pipeline: "leaf", adapter: "child" } }],
          finalize: { run: "result", requireOutputs: ["child"] },
        },
        leaf: { steps: [{ id: "work", run: "work" }], finalize: { run: "result" } },
      },
    };
    const wiring: ProjectRegistry = {
      steps: { work: () => "leaf" },
      finalizers: { result: ({ child, work }) => child ?? work },
      forEachPipelineAdapters: {
        child: { items: () => ["item"], key: () => "key", mapOptions: () => ({}), concurrency: 0 },
      },
    };

    expect(() => compilePipelineDocument(source, wiring)).toThrow(
      new PipelineDocumentError(
        '$.pipelines["parent"].steps[0].forEachPipeline.adapter',
        "Expected adapter concurrency to be a positive finite integer when it is a number"
      )
    );
  });

  it("uses core dry-run skips, dependency blocking, and required finalizers", async () => {
    const source = document();
    source.pipelines.import.steps[1].dryRun = "skip";
    const handlers = registry();
    const pipeline = compilePipelineDocument(source, handlers).get("import");
    const result = await pipeline.run({}, { dryRun: true }, createPipelineTestRuntime().context);
    expect(result.status).toBe("failed");
    expect(result.steps).toMatchObject([
      { id: "load", status: "skipped", reason: "dry-run" },
      { id: "normalize", status: "skipped", reason: "unmet-dependency" },
    ]);
    expect(handlers.steps.load).not.toHaveBeenCalled();
    expect(handlers.steps.normalize).not.toHaveBeenCalled();
    expect(handlers.finalizers.result).not.toHaveBeenCalled();
  });

  it("resolves a custom dry-run handler with the normal step context", async () => {
    const source = document();
    source.pipelines.import.steps[1].dryRun = { run: "preview" };
    const handlers = registry();
    const preview = vi.fn((_inputs, context) => (context.dryRun ? "preview" : "wrong"));
    handlers.steps = { ...handlers.steps, preview };
    const pipeline = compilePipelineDocument(source, handlers).get("import");
    await expect(
      pipeline.runOrThrow({}, { dryRun: true }, createPipelineTestRuntime().context)
    ).resolves.toBe("PREVIEW");
    expect(handlers.steps.load).not.toHaveBeenCalled();
    expect(preview).toHaveBeenCalledOnce();
  });

  it("preserves optional dependencies and failure gates under target selection", async () => {
    const source: PipelineDocument = {
      version: 1,
      pipelines: {
        publish: {
          steps: [
            { id: "check", run: "check" },
            { id: "extra", run: "extra" },
            {
              id: "publish",
              run: "publish",
              optionalDependsOn: ["extra"],
              skipAfterFailureOf: ["check"],
            },
          ],
          targets: ["publish"],
          finalize: { run: "result" },
        },
      },
    };
    const publish = vi.fn(() => "published");
    const extra = vi.fn();
    const pipeline = compilePipelineDocument(source, {
      steps: {
        check: () => {
          throw new Error("invalid");
        },
        publish,
        extra,
      },
      finalizers: { result: (outputs) => outputs },
    }).get("publish");
    const plan = pipeline.plan({ targets: ["publish"] });
    expect(plan.steps.find(({ id }) => id === "check")?.selected).toBe(true);
    expect(plan.steps.find(({ id }) => id === "extra")?.selected).toBe(false);
    const result = await pipeline.run(
      {},
      { targets: ["publish"], continueOnError: true },
      createPipelineTestRuntime().context
    );
    expect(result.status).toBe("failed");
    expect(publish).not.toHaveBeenCalled();
    expect(extra).not.toHaveBeenCalled();
  });

  it("runs asynchronous schemas only during execution and passes transformed options and outputs", async () => {
    const source = document();
    source.pipelines.import.optionsSchema = "options";
    source.pipelines.import.steps[1].outputSchema = "output";
    source.pipelines.import.resultSchema = "result";
    const validateOptions = vi.fn(async () => ({ value: { greeting: "options" } }));
    const validateOutput = vi.fn(async (value: unknown) => ({ value: `${value}-output` }));
    const validateResult = vi.fn(async (value: unknown) => ({ value: `${value}-result` }));
    const handlers = registry();
    handlers.steps = {
      ...handlers.steps,
      load: (_inputs, context) =>
        "greeting" in context.options ? context.options.greeting : "missing",
    };
    handlers.optionsSchemas = { options: standardSchema(validateOptions) };
    handlers.schemas = {
      output: standardSchema(validateOutput),
      result: standardSchema(validateResult),
    };
    const pipeline = compilePipelineDocument(source, handlers).get("import");
    pipeline.plan();
    expect(validateOptions).not.toHaveBeenCalled();
    expect(validateOutput).not.toHaveBeenCalled();
    expect(validateResult).not.toHaveBeenCalled();
    await expect(pipeline.runOrThrow({}, {}, createPipelineTestRuntime().context)).resolves.toBe(
      "OPTIONS-OUTPUT-result"
    );
  });

  it.each(["options", "output", "result"] as const)(
    "retains core %s validation failures",
    async (boundary) => {
      const source = document();
      const handlers = registry();
      const invalid = standardSchema<object, object>(() => ({ issues: [{ message: "invalid" }] }));
      if (boundary === "options") {
        source.pipelines.import.optionsSchema = "invalid";
        handlers.optionsSchemas = { invalid };
      } else {
        handlers.schemas = { invalid };
        if (boundary === "output") source.pipelines.import.steps[1].outputSchema = "invalid";
        else source.pipelines.import.resultSchema = "invalid";
      }
      const pipeline = compilePipelineDocument(source, handlers).get("import");
      const result = await pipeline.run({}, {}, createPipelineTestRuntime().context);
      expect(result.status).toBe("failed");
      expect(result.errors.some((error) => error.kind === "validation")).toBe(true);
    }
  );

  it.each([
    [null, "$"],
    [{ version: 2, pipelines: {} }, "$.version"],
    [{ version: 1, pipelines: {} }, "$.pipelines"],
    [{ ...document(), imports: {} }, "$.imports"],
    [
      { version: 1, pipelines: { p: { steps: [], finalize: { run: "result" } } } },
      '$.pipelines["p"].steps',
    ],
  ])("rejects malformed documents with a document path", (value, path) => {
    expect(() => compilePipelineDocument(value, registry())).toThrow(
      expect.objectContaining({ name: "PipelineDocumentError", path })
    );
  });

  it.each([
    "run",
    "dependsOn",
    "optionalDependsOn",
    "skipAfterFailureOf",
    "outputSchema",
    "dryRun",
  ] as const)("rejects unknown %s references", (field) => {
    const source = document();
    const step = source.pipelines.import.steps[0];
    if (field === "run" || field === "outputSchema") step[field] = "missing";
    else if (field === "dryRun") step.dryRun = { run: "missing" };
    else step[field] = ["missing"];
    expect(() => compilePipelineDocument(source, registry())).toThrow(PipelineDocumentError);
  });

  it("does not resolve inherited registry names", () => {
    const source = document();
    source.pipelines.import.steps[0].run = "toString";
    expect(() => compilePipelineDocument(source, registry())).toThrow(
      'Unknown registered name "toString"'
    );
  });

  it.each(["optionsSchema", "resultSchema", "targets", "finalizer", "requireOutputs"])(
    "rejects unknown pipeline %s references",
    (field) => {
      const source = document();
      const definition = source.pipelines.import;
      if (field === "optionsSchema" || field === "resultSchema") definition[field] = "missing";
      if (field === "targets") definition.targets = ["missing"];
      if (field === "finalizer") definition.finalize.run = "missing";
      if (field === "requireOutputs") definition.finalize.requireOutputs = ["missing"];
      expect(() => compilePipelineDocument(source, registry())).toThrow(PipelineDocumentError);
    }
  );

  it.each([
    { id: "load", run: "load", dependsOn: "other" },
    { id: "load", run: "load", dryRun: "preview" },
    { id: "load", run: "load", dryRun: { run: "load", typo: true } },
    { id: "load", run: "load", dependsOn: [5] },
    { id: "load", run: "load", typo: true },
    { id: "load", run: "load", name: " " },
    { id: "load", run: null },
  ])("rejects invalid step fields before graph construction: %j", (step) => {
    const value = { version: 1, pipelines: { p: { steps: [step], finalize: { run: "result" } } } };
    expect(() => compilePipelineDocument(value, registry())).toThrow(PipelineDocumentError);
  });

  it("allows absent optional inputs and partial finalization", async () => {
    const source = document();
    source.pipelines.import.steps = [
      { id: "normalize", run: "normalize", optionalDependsOn: ["load"] },
      source.pipelines.import.steps[1],
    ];
    source.pipelines.import.finalize = { run: "result" };
    const handlers = registry();
    handlers.steps = { ...handlers.steps, normalize: ({ load }) => load ?? "absent" };
    const pipeline = compilePipelineDocument(source, handlers).get("import");
    await expect(
      pipeline.runOrThrow({}, { targets: ["normalize"] }, createPipelineTestRuntime().context)
    ).resolves.toBe("absent");
    expect(handlers.steps.load).not.toHaveBeenCalled();
  });

  it.each(["duplicate", "cycle", "self", "contradiction", "target-finalizer"])(
    "delegates %s errors to the existing engine",
    (kind) => {
      const source = document();
      const definition = source.pipelines.import;
      if (kind === "duplicate") definition.steps = [...definition.steps, definition.steps[1]];
      if (kind === "cycle") definition.steps[1].dependsOn = ["normalize"];
      if (kind === "self") definition.steps[1].dependsOn = ["load"];
      if (kind === "contradiction") definition.steps[0].optionalDependsOn = ["load"];
      if (kind === "target-finalizer") definition.targets = ["load"];
      expect(() => compilePipelineDocument(source, registry())).toThrow(PipelineDefinitionError);
    }
  );
});
