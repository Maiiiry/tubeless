import { describe, expect, it, vi } from "vitest";
import { defineCommand } from "./cli.js";

describe("defineCommand: string params", () => {
  it("exposes immutable structured parameter metadata", () => {
    const command = defineCommand({
      name: "import-rows",
      description: "Import source rows.",
      params: {
        source: {
          type: "path",
          description: "Input file.",
          flag: "input",
          kind: "file",
          mustExist: true,
        },
        format: { type: "string", choices: ["json", "csv"], default: "json" },
        limit: { type: "number", optional: true, integer: true, min: 1, max: 100 },
      },
      positionals: ["source"],
      run: (values) => values,
    });

    expect(command.descriptor).toMatchObject({
      description: "Import source rows.",
      name: "import-rows",
      parameters: [
        { default: false, flag: "dry-run", key: "dryRun", type: "boolean" },
        {
          description: "Input file.",
          flag: "input",
          key: "source",
          mustExist: true,
          pathKind: "file",
          positional: true,
          required: true,
          type: "path",
        },
        { choices: ["json", "csv"], default: "json", flag: "format", type: "string" },
        { flag: "limit", integer: true, max: 100, min: 1, required: false, type: "number" },
      ],
    });
    expect(Object.isFrozen(command.descriptor)).toBe(true);
    expect(Object.isFrozen(command.descriptor.parameters)).toBe(true);
    expect(Object.isFrozen(command.descriptor.parameters[1])).toBe(true);
    expect(Object.isFrozen(command.descriptor.parameters[2]?.choices)).toBe(true);
  });

  it("describes positional parameters in their declared argument order", () => {
    const command = defineCommand({
      params: { file: { type: "path" }, format: { type: "string" } },
      positionals: ["format", "file"],
      run: (values) => values,
    });
    expect(
      command.descriptor.parameters.filter(({ positional }) => positional).map(({ key }) => key)
    ).toEqual(["format", "file"]);
    expect(command.parse(["csv", "rows.csv"], { cwd: "/tmp" })).toMatchObject({
      kind: "values",
      values: { format: "csv", file: "/tmp/rows.csv" },
    });
  });

  it("parses a provided value", () => {
    const command = defineCommand({
      params: { version: { type: "string" } },
      run: (values) => values,
    });
    const result = command.parse(["--version", "json"]);
    expect(result).toEqual({
      kind: "values",
      values: { version: "json", dryRun: false, resume: false },
    });
  });

  it("validates and executes structured values without argv tokenization", async () => {
    const run = vi.fn(
      (values: {
        attempts: readonly number[];
        count: number;
        dryRun: boolean;
        resume: boolean;
        tags: readonly string[];
      }) => `${values.count}:${values.attempts.join(",")}:${values.tags.join(",")}:${values.dryRun}`
    );
    const command = defineCommand({
      params: {
        attempts: { type: "number", multiple: true },
        count: { type: "number", integer: true, min: 1 },
        tags: { type: "string", multiple: true },
      },
      run,
    });

    const parsed = command.parseValues({
      attempts: [1, 2],
      count: 2,
      dryRun: true,
      tags: ["one", "two"],
    });

    expect(parsed).toEqual({
      kind: "values",
      values: { attempts: [1, 2], count: 2, dryRun: true, resume: false, tags: ["one", "two"] },
    });
    if (parsed.kind !== "values") throw new Error("Expected structured values to validate.");
    await expect(command.execute(parsed.values)).resolves.toBe("2:1,2:one,two:true");
    expect(run).toHaveBeenCalledTimes(1);
    expect(command.parseValues({ count: "2", tags: [] })).toMatchObject({
      kind: "error",
      errors: ["--count must be a finite number."],
    });
  });

  it("does not fall back to env or validate domain values after malformed structured input", () => {
    const validate = vi.fn();
    const command = defineCommand({
      params: { count: { type: "number", env: "TUBELESS_COUNT" } },
      validate,
      run: (values) => values,
    });
    expect(
      command.parseValues({ count: "bad" }, { env: { TUBELESS_COUNT: "private-invalid" } })
    ).toMatchObject({
      kind: "error",
      errors: ["--count must be a finite number."],
    });
    expect(validate).not.toHaveBeenCalled();
  });

  it("keeps boolean environment fallbacks when structured values omit the control", () => {
    const command = defineCommand({
      params: { enabled: { type: "boolean", env: "TUBELESS_ENABLED" } },
      run: (values) => values,
    });
    const context = { env: { TUBELESS_ENABLED: "true" } };

    expect(command.parseValues({}, context)).toMatchObject({
      kind: "values",
      values: { enabled: true },
    });
    expect(command.parseValues({ enabled: false }, context)).toMatchObject({
      kind: "values",
      values: { enabled: false },
    });
  });

  it("supports the --flag=value form", () => {
    const command = defineCommand({
      params: { version: { type: "string" } },
      run: (values) => values,
    });
    const result = command.parse(["--version=json"]);
    expect(result).toMatchObject({ kind: "values", values: { version: "json" } });
  });

  it("errors when a required string is missing", () => {
    const command = defineCommand({ params: { version: { type: "string" } }, run: (v) => v });
    const result = command.parse([]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors).toEqual(["Missing required option --version"]);
  });

  it("returns undefined for an optional string that is absent", () => {
    const command = defineCommand({
      params: { label: { type: "string", optional: true } },
      run: (v) => v,
    });
    const result = command.parse([]);
    expect(result).toMatchObject({ kind: "values", values: { label: undefined } });
  });

  it("falls back to a default when absent", () => {
    const command = defineCommand({
      params: { version: { type: "string", default: "yaml" } },
      run: (v) => v,
    });
    expect(command.parse([])).toMatchObject({ kind: "values", values: { version: "yaml" } });
  });

  it("rejects a value outside of choices", () => {
    const command = defineCommand({
      params: { version: { type: "string", choices: ["json", "yaml"] } },
      run: (v) => v,
    });
    const result = command.parse(["--version", "xml"]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors[0]).toContain("one of: json, yaml");
  });
});
