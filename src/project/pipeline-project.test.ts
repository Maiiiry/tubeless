import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createSteps,
  definePipeline,
  type PipelineInput,
  type PipelineResult,
  type StandardSchemaV1,
} from "../core/pipeline.js";
import { definePipelineCommand } from "../cli/cli-pipeline-command.js";
import { defineCommand } from "../cli/cli.js";
import { defineProject, isPipelineProject, type AnyProjectPipeline } from "./pipeline-project.js";
import { compilePipelineDocument } from "./project-compiler.js";

const { step: alphaStep } = createSteps<{ value: string }>();
const alpha = definePipeline({
  id: "alpha",
  steps: [alphaStep("read-alpha", { run: (_inputs, context) => context.options.value })],
});

const { step: betaStep } = createSteps<{ value: number }>();
const beta = definePipeline({
  id: "beta",
  steps: [betaStep("read-beta", { run: (_inputs, context) => context.options.value })],
});

describe("pipeline project", () => {
  it("preserves transformed inputs and results without executing or inferring commands", async () => {
    const validate = vi.fn((value: unknown) => {
      if (
        typeof value !== "object" ||
        value === null ||
        !("text" in value) ||
        typeof value.text !== "string"
      ) {
        return { issues: [{ message: "Expected text" }] };
      }
      return { value: { length: value.text.length } };
    });
    const infer = vi.fn(() => {
      throw new Error("must remain lazy");
    });
    const schema: StandardSchemaV1<{ text: string }, { length: number }> = {
      "~standard": { version: 1, vendor: "test", validate, jsonSchema: { input: infer } },
    };
    const { step } = createSteps(schema);
    const run = vi.fn();
    const pipeline = definePipeline({
      id: "transformed",
      name: "Transformed input",
      description: "Measure the input.",
      steps: [
        step("measure", {
          run: (_inputs, context) => {
            run();
            return context.options.length;
          },
        }),
      ],
      finalize: (outputs): number => outputs.measure ?? 0,
    });
    const command = definePipelineCommand(pipeline, {
      params: { text: { type: "string" } },
      reporter: false,
    });
    const project = defineProject("transformed-project", [command]);
    expect(defineProject("bare", [pipeline]).get("transformed")).toBe(pipeline);
    expect(validate).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(infer).not.toHaveBeenCalled();
    expect(project.commands[0]?.descriptor).toMatchObject({
      name: "Transformed input",
      description: "Measure the input.",
    });
    const selected = project.get("transformed");
    expectTypeOf(selected).toEqualTypeOf<typeof pipeline>();
    expectTypeOf<PipelineInput<typeof selected>>().toEqualTypeOf<{ text: string }>();
    expectTypeOf<PipelineResult<typeof selected>>().toEqualTypeOf<number>();
    await expect(selected.runOrThrow({ text: "abc" })).resolves.toBe(3);
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it("registers only the parent when a command wraps a composed pipeline", () => {
    const { fromPipeline } = createSteps<{ value: string }>();
    const parent = definePipeline({
      id: "parent",
      steps: [
        fromPipeline("child", {
          pipeline: alpha,
          mapOptions: (_inputs, context) => context.options,
        }),
      ],
    });
    const project = defineProject("parents", [
      definePipelineCommand(parent, { params: { value: { type: "string" } } }),
    ]);
    expect(project.pipelineIds).toEqual(["parent"]);
    expect(project.get("parent").plan().steps[0]?.nestedPipeline?.pipelineId).toBe("alpha");
    expect(() => {
      // @ts-expect-error Child pipelines are not registered implicitly.
      project.get("alpha");
    }).toThrow('does not define pipeline "alpha"');
  });

  it("suggests a registered id for a near-miss lookup", () => {
    const project = defineProject("pair", [alpha, beta] as readonly AnyProjectPipeline[]);
    expect(() => project.get("alpah")).toThrow(
      'Project does not define pipeline "alpah". Did you mean "alpha"?'
    );
    expect(() => project.get("gamma")).toThrow(/^Project does not define pipeline "gamma"\.$/);
  });

  it("snapshots explicit adapters without changing typed pipeline lookup", async () => {
    const command = definePipelineCommand(alpha, {
      params: { text: { type: "string" } },
      mapOptions: ({ text }) => ({ value: text.toUpperCase() }),
      reporter: false,
    });
    const entries = [command, beta];
    const project = defineProject("adapters", entries, { cwd: "./work" });
    entries.pop();
    entries.reverse();

    expect(project.commands).toEqual([command]);
    expect(project.pipelines).toEqual([alpha, beta]);
    expect(project.pipelineIds).toEqual(["alpha", "beta"]);
    expect(Object.isFrozen(project.pipelineIds)).toBe(true);
    expect(Object.isFrozen(project.commands)).toBe(true);
    expect(project.cwd).toBe("./work");
    expectTypeOf(project.get("alpha")).toEqualTypeOf<typeof alpha>();
    await expect(command.run(["--text", "hello"])).resolves.toBe("HELLO");
    await expect(project.get("alpha").runOrThrow({ value: "hello" })).resolves.toBe("hello");
    const otherAlpha = definePipeline({
      id: "alpha",
      steps: [alphaStep("other", { run: () => "other" })],
    });
    const otherCommand = definePipelineCommand(otherAlpha, {
      params: { value: { type: "string" } },
    });
    for (const duplicates of [
      [alpha, alpha],
      [command, command],
      [command, otherCommand],
      [alpha, command],
      [command, alpha],
      [otherAlpha, command],
    ] as const) {
      expect(() => defineProject("duplicate", duplicates)).toThrow(
        'Project pipeline id "alpha" is declared more than once'
      );
    }
    expect(() => defineProject("unmarked", [{ ...command }])).toThrow(
      "Project entries must be pipelines or definePipelineCommand adapters"
    );
  });

  it("registers decorated pipelines with an unrelated pipeline property", async () => {
    const decorated = { ...alpha, pipeline: beta };
    const project = defineProject("decorated", [decorated]);

    expect(project.pipelineIds).toEqual(["alpha"]);
    expect(project.pipelines).toEqual([decorated]);
    expect(project.commands).toEqual([]);
    expect(project.get("alpha")).toBe(decorated);
    expectTypeOf(project.get("alpha")).toEqualTypeOf<typeof decorated>();
    await expect(project.get("alpha").runOrThrow({ value: "hello" })).resolves.toBe("hello");
  });

  it("preserves exact pipeline contracts through command-only tuples", () => {
    const alphaCommand = definePipelineCommand(alpha, { params: { value: { type: "string" } } });
    const betaCommand = definePipelineCommand(beta, { params: { value: { type: "number" } } });
    const project = defineProject("commands", [alphaCommand, betaCommand]);
    const selected = project.get("alpha");
    expect(selected).toBe(alpha);
    expect(project.commands).toEqual([alphaCommand, betaCommand]);
    expectTypeOf(project.pipelines).toEqualTypeOf<readonly [typeof alpha, typeof beta]>();
    expectTypeOf(project.pipelineIds).toEqualTypeOf<readonly ["alpha", "beta"]>();
    expectTypeOf(selected).toEqualTypeOf<typeof alpha>();
    expectTypeOf<PipelineInput<typeof selected>>().toEqualTypeOf<{ value: string }>();
    expectTypeOf<PipelineResult<typeof selected>>().toEqualTypeOf<string | undefined>();
    expectTypeOf(selected.stepIds).toEqualTypeOf<readonly "read-alpha"[]>();
    expectTypeOf(selected.targetIds).toEqualTypeOf<readonly "read-alpha"[]>();
    function invalidCallsForTypechecking() {
      // @ts-expect-error Commands preserve literal pipeline ids.
      project.get("missing");
      // @ts-expect-error Commands preserve domain input requirements.
      selected.runOrThrow({ value: 1 });
      // @ts-expect-error Commands preserve target ids.
      selected.plan({ targets: ["read-beta"] });
      // @ts-expect-error Commands are entries, not a project option.
      defineProject("removed", [alpha], { commands: [alphaCommand] });
      // @ts-expect-error Command factories are no longer a project option.
      defineProject("removed-factory", [alpha], { commands: () => [alphaCommand] });
    }
    void invalidCallsForTypechecking;
  });

  it("rejects standalone commands and malformed entries", () => {
    const standalone = defineCommand({ params: {}, run: () => undefined });
    expect(() => {
      // @ts-expect-error Standalone commands do not adapt a pipeline.
      defineProject("standalone", [standalone]);
    }).toThrow("Project entries must be pipelines or definePipelineCommand adapters");
    for (const entry of [null, undefined, {}, { pipeline: alpha }]) {
      expect(() => {
        // @ts-expect-error Invalid entries are also rejected for JavaScript callers.
        defineProject("invalid", [entry]);
      }).toThrow();
    }
  });

  it("keeps pipelines discoverable by their literal ids", async () => {
    const project = defineProject("example", [alpha, beta]);

    expect(project.id).toBe("example");
    expect(project.name).toBe("example");
    expect(project.description).toBeUndefined();
    expect(project.pipelineIds).toEqual(["alpha", "beta"]);
    expect(project.get("alpha")).toBe(alpha);
    await expect(project.get("beta").runOrThrow({ value: 42 })).resolves.toBe(42);
    expectTypeOf(project.pipelineIds).toEqualTypeOf<readonly ["alpha", "beta"]>();
    expectTypeOf(project.id).toEqualTypeOf<"example">();
    expectTypeOf(project.get("alpha")).toEqualTypeOf<typeof alpha>();
    expectTypeOf(project.get("beta").runOrThrow).parameter(0).toEqualTypeOf<{ value: number }>();
  });

  it("snapshots optional presentation without changing identity or pipeline types", () => {
    const metadata = { name: "Example jobs", description: "Read alpha and beta values." };
    const project = defineProject("example", [alpha, beta], metadata);
    metadata.name = "Changed";
    metadata.description = "Changed";

    expect(project).toMatchObject({
      id: "example",
      name: "Example jobs",
      description: "Read alpha and beta values.",
    });
    expect(Object.isFrozen(project)).toBe(true);
    expectTypeOf(project.id).toEqualTypeOf<"example">();
    expectTypeOf(project.get("alpha")).toEqualTypeOf<typeof alpha>();
    expect(defineProject("example", [alpha], { description: "Read a value." }).name).toBe(
      "example"
    );
  });

  it.each([false, true])(
    "selects pipelines whose union or widened ids overlap the lookup (commands: %s)",
    async (commands) => {
      function variant(id: "union-alpha" | "union-beta") {
        return definePipeline({
          id,
          steps: [alphaStep("read", { run: (_inputs, context) => context.options.value })],
        });
      }
      const unionPipeline = variant("union-alpha");
      const project = defineProject("unions", [
        commands
          ? definePipelineCommand(unionPipeline, { params: { value: { type: "string" } } })
          : unionPipeline,
        beta,
      ]);
      const selected = project.get("union-alpha");
      expectTypeOf(selected).toEqualTypeOf<typeof unionPipeline>();
      expectTypeOf(project.get("beta")).toEqualTypeOf<typeof beta>();
      await expect(selected.runOrThrow({ value: "hello" })).resolves.toBe("hello");
      const selectEither = (id: "union-alpha" | "beta") => project.get(id);
      expectTypeOf(selectEither).returns.toEqualTypeOf<typeof unionPipeline | typeof beta>();

      const widePipeline = definePipeline({
        id: String("dynamic"),
        steps: [alphaStep("read", { run: (_inputs, context) => context.options.value })],
      });
      const mixed = defineProject("mixed", [
        commands
          ? definePipelineCommand(widePipeline, { params: { value: { type: "string" } } })
          : widePipeline,
        beta,
      ]);
      expectTypeOf(mixed.get("dynamic")).toEqualTypeOf<typeof widePipeline>();
      expectTypeOf(mixed.get("beta")).toEqualTypeOf<typeof widePipeline | typeof beta>();
      const selectUnknown = (id: string) => mixed.get(id);
      expectTypeOf(selectUnknown).returns.toEqualTypeOf<typeof widePipeline | typeof beta>();
    }
  );

  it("accepts only existing pipelines, not document compilation arguments", () => {
    const document: unknown = { version: 1, pipelines: {} };
    const registry = { steps: {}, finalizers: {} };
    expect(() => {
      // @ts-expect-error Parsed documents must be compiled before registration.
      defineProject("invalid-document", document, registry);
    }).toThrow("defineProject expects an array of pipelines or pipeline commands.");
    expect(() => {
      // @ts-expect-error The document/registry/fourth-options overload was removed.
      defineProject("invalid-document", document, registry, { name: "Document jobs" });
    }).toThrow("defineProject expects an array of pipelines or pipeline commands.");
    expect(defineProject("empty-typed", [], { name: "Typed jobs" }).name).toBe("Typed jobs");
  });

  it.each(["", " ", null, 42])("rejects invalid presentation text %j", (value) => {
    for (const field of ["name", "description", "cwd"] as const) {
      expect(() => defineProject("example", [alpha], { [field]: value })).toThrow(
        `Project ${field} must be a non-empty string.`
      );
    }
  });

  it("takes an immutable snapshot and rejects duplicate ids", () => {
    const pipelines = [alpha];
    const project = defineProject("example", pipelines);
    pipelines.push(alpha);

    expect(project.pipelines).toEqual([alpha]);
    expect(Object.isFrozen(project)).toBe(true);
    expect(Object.isFrozen(project.pipelines)).toBe(true);
    expect(isPipelineProject(project)).toBe(true);
    expect(isPipelineProject({ ...project })).toBe(false);
    expect(() => defineProject("duplicate", [alpha, alpha])).toThrow(
      'pipeline id "alpha" is declared more than once'
    );
    expect(() => defineProject("", [alpha])).toThrow("Project id must be a non-empty string");
  });

  it("registers compiled pipelines with ordinary metadata reuse and overrides", async () => {
    const document = {
      version: 1,
      metadata: { name: "Greeting jobs", description: "Say hello." },
      pipelines: {
        greeting: {
          steps: [{ id: "greet", run: "greet" }],
          finalize: { run: "result", requireOutputs: ["greet"] },
        },
      },
    };
    const registry = {
      steps: { greet: () => "hello" },
      finalizers: { result: ({ greet }: Record<string, unknown>) => greet },
    };
    const compiled = compilePipelineDocument(document, registry);
    const project = defineProject("declarative-example", compiled.pipelines, {
      name: compiled.metadata?.name,
      description: compiled.metadata?.description,
    });

    expect(project).toMatchObject({
      id: "declarative-example",
      name: "Greeting jobs",
      description: "Say hello.",
      pipelineIds: ["greeting"],
    });
    await expect(project.get("greeting").runOrThrow({})).resolves.toBe("hello");
    expect(
      defineProject("override", compiled.pipelines, {
        ...compiled.metadata,
        name: "Custom name",
      })
    ).toMatchObject({
      name: "Custom name",
      description: "Say hello.",
    });
    expect(
      defineProject("override", compiled.pipelines, {
        ...compiled.metadata,
        description: "Custom purpose",
      })
    ).toMatchObject({
      name: "Greeting jobs",
      description: "Custom purpose",
    });
    const fallback = defineProject("fallback", compiled.pipelines);
    expect(fallback.name).toBe("fallback");
    expect(fallback.description).toBeUndefined();
    const cleared = defineProject("cleared", compiled.pipelines, {
      ...compiled.metadata,
      name: undefined,
      description: undefined,
    });
    expect(cleared.name).toBe("cleared");
    expect(cleared.description).toBeUndefined();
    expect(() => defineProject("invalid", compiled.pipelines, { name: " " })).toThrow(
      "Project name must be a non-empty string."
    );
    const executable = defineProject("yaml-cli", [
      definePipelineCommand(compiled.get("greeting"), { params: {}, reporter: false }),
    ]);
    expect(project.get("greeting")).toBe(compiled.get("greeting"));
    await expect(executable.commands[0]?.run([])).resolves.toBe("hello");
  });
});
