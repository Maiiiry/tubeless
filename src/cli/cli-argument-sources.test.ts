import { describe, expect, it } from "vitest";
import { createSteps, definePipeline } from "../core/pipeline.js";
import { renderPipelinePlan } from "../render/render.js";
import { defineCommand, definePipelineCommand } from "./cli.js";

describe("defineCommand: aliases, positionals, and environment fallbacks", () => {
  it("supports short aliases and includes them in generated help", () => {
    const command = defineCommand({
      params: {
        version: { type: "string", short: "v" },
        verbose: { type: "boolean", short: "V" },
      },
      run: (values) => values,
    });

    expect(command.parse(["-v", "json", "-V"])).toMatchObject({
      kind: "values",
      values: { version: "json", verbose: true },
    });
    const help = command.parse(["--help"]);
    expect(help.kind === "help" && help.helpText).toContain("-v, --version <string>");
  });

  it("rejects digit aliases so numeric positionals remain unambiguous", () => {
    expect(() =>
      defineCommand({
        params: { verbose: { type: "boolean", short: "3" } },
        run: () => undefined,
      })
    ).toThrow(/aliases must be one letter other than "h"/);
  });

  it("maps declared positional arguments and keeps negative numeric values valid", () => {
    const command = defineCommand({
      params: {
        source: { type: "string" },
        offset: { type: "number" },
      },
      positionals: ["source", "offset"],
      run: (values) => values,
    });

    expect(command.parse(["input", "-3"])).toMatchObject({
      kind: "values",
      values: { source: "input", offset: -3 },
    });
    expect(command.parse(["input", "-10"])).toMatchObject({
      kind: "values",
      values: { source: "input", offset: -10 },
    });
    expect(command.parse(["input", "-3.5"])).toMatchObject({
      kind: "values",
      values: { source: "input", offset: -3.5 },
    });
    expect(command.parse(["--source", "input", "3"])).toMatchObject({
      kind: "values",
      values: { source: "input", offset: 3 },
    });
  });

  it("keeps a repeatable positional active for every trailing token", () => {
    const command = defineCommand({
      params: { files: { type: "string", multiple: true } },
      positionals: ["files"],
      run: (values) => values,
    });

    expect(command.parse(["a.txt", "b.txt", "c.txt"])).toMatchObject({
      kind: "values",
      values: { files: ["a.txt", "b.txt", "c.txt"] },
    });
  });

  it("treats help-looking values as positionals after the end-of-options delimiter", () => {
    const command = defineCommand({
      params: { value: { type: "string" } },
      positionals: ["value"],
      run: (values) => values,
    });

    expect(command.parse(["--", "--help"])).toMatchObject({
      kind: "values",
      values: { value: "--help" },
    });
    expect(command.parse(["--", "-h"])).toMatchObject({
      kind: "values",
      values: { value: "-h" },
    });
  });

  it("uses environment fallbacks after argv, before defaults", () => {
    const command = defineCommand({
      params: { version: { type: "string", default: "yaml", env: "TUBELESS_VERSION" } },
      run: (values) => values,
    });
    const context = { env: { TUBELESS_VERSION: "json" } };

    expect(command.parse([], context)).toMatchObject({
      kind: "values",
      values: { version: "json" },
    });
    expect(command.parse(["--version", "toml"], context)).toMatchObject({
      kind: "values",
      values: { version: "toml" },
    });
  });

  it("validates environment fallbacks without exposing their values", () => {
    const command = defineCommand({
      params: { limit: { type: "number", integer: true, env: "TUBELESS_LIMIT" } },
      run: (values) => values,
    });
    const result = command.parse([], { env: { TUBELESS_LIMIT: "not-for-output" } });

    expect(result).toMatchObject({
      kind: "error",
      errors: ["environment variable TUBELESS_LIMIT must be a number"],
    });
    expect(result.kind === "error" && result.errors.join(" ")).not.toContain("not-for-output");
  });

  it("rejects a blank numeric environment fallback instead of using zero or the default", () => {
    const command = defineCommand({
      params: { limit: { type: "number", integer: true, default: 5, env: "TUBELESS_LIMIT" } },
      run: (values) => values,
    });
    expect(command.parse([], { env: { TUBELESS_LIMIT: "" } })).toMatchObject({
      kind: "error",
      errors: ["environment variable TUBELESS_LIMIT must be a number"],
    });
    expect(command.parse([], { env: { TUBELESS_LIMIT: " " } })).toMatchObject({
      kind: "error",
      errors: ["environment variable TUBELESS_LIMIT must be a number"],
    });
  });

  it("rejects ambiguous positional and environment declarations", () => {
    expect(() =>
      defineCommand({
        params: {
          names: { type: "string", multiple: true },
          version: { type: "string" },
        },
        positionals: ["names", "version"],
        run: () => undefined,
      })
    ).toThrow(/Repeatable positional parameter "names" must be last/);

    expect(() =>
      defineCommand({
        params: { names: { type: "string", multiple: true, env: "TUBELESS_NAMES" } },
        run: () => undefined,
      })
    ).toThrow(/combines multiple: true with env/);
  });

  it("marks runtime policy skips as conditional in a pipeline plan", async () => {
    const { step } = createSteps();
    const conditional = step("conditional", {
      skip: () => "disabled by configuration",
      run: () => undefined,
    });
    const pipeline = definePipeline({
      id: "conditional-plan",
      steps: [conditional],
      finalize: () => undefined,
    });
    const command = definePipelineCommand(pipeline, {
      mapOptions: () => ({}),
      reporter: false,
    });
    const plan = command.plan();

    expect(renderPipelinePlan(plan)).toContain("  - conditional: run (policy may skip)");
  });
});
