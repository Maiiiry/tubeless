import { describe, expect, it } from "vitest";
import { defineCommand } from "./cli.js";

describe("defineCommand: number params", () => {
  it("coerces a numeric string", () => {
    const command = defineCommand({ params: { limit: { type: "number" } }, run: (v) => v });
    expect(command.parse(["--limit", "50"])).toMatchObject({
      kind: "values",
      values: { limit: 50 },
    });
  });

  it("rejects a non-numeric value", () => {
    const command = defineCommand({ params: { limit: { type: "number" } }, run: (v) => v });
    const result = command.parse(["--limit", "abc"]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors[0]).toContain('must be a number, got "abc"');
  });

  it("rejects blank, whitespace, hex, and exponent forms instead of coercing them", () => {
    const command = defineCommand({
      params: { limit: { type: "number", default: 5 } },
      run: (v) => v,
    });
    for (const argv of [
      ["--limit="],
      ["--limit", ""],
      ["--limit", " "],
      ["--limit", "0x10"],
      ["--limit", "1e2"],
    ]) {
      const result = command.parse(argv);
      expect(result.kind, argv.join(" ")).toBe("error");
      expect(result.kind === "error" && result.errors[0]).toContain("must be a number");
      expect(result.kind === "error" && result.errors[0]).not.toContain("got 0");
    }
    expect(command.parse(["--limit", "-2.5"])).toMatchObject({
      kind: "values",
      values: { limit: -2.5 },
    });
    expect(command.parse(["--limit", "+4"])).toMatchObject({
      kind: "values",
      values: { limit: 4 },
    });
    expect(command.parse(["--limit", ".5"])).toMatchObject({
      kind: "values",
      values: { limit: 0.5 },
    });
  });

  it("enforces integer, min, and max constraints", () => {
    const command = defineCommand({
      params: { limit: { type: "number", integer: true, min: 1, max: 10 } },
      run: (v) => v,
    });
    expect(command.parse(["--limit", "1.5"]).kind).toBe("error");
    expect(command.parse(["--limit", "0"]).kind).toBe("error");
    expect(command.parse(["--limit", "11"]).kind).toBe("error");
    expect(command.parse(["--limit", "5"])).toMatchObject({
      kind: "values",
      values: { limit: 5 },
    });
  });

  it("validates numeric defaults with the same constraints as argv values", () => {
    const invalidMinimum = defineCommand({
      params: { limit: { type: "number", default: 0, min: 1 } },
      run: (v) => v,
    });
    expect(invalidMinimum.parse([])).toMatchObject({
      kind: "error",
      errors: ["--limit must be >= 1, got 0"],
    });

    const invalidInteger = defineCommand({
      params: { limit: { type: "number", default: 1.5, integer: true } },
      run: (v) => v,
    });
    expect(invalidInteger.parse([])).toMatchObject({
      kind: "error",
      errors: ['--limit must be an integer, got "1.5"'],
    });
  });

  it("uses a default and supports optional absence", () => {
    const command = defineCommand({
      params: {
        withDefault: { type: "number", default: 40 },
        withoutDefault: { type: "number", optional: true },
      },
      run: (v) => v,
    });
    expect(command.parse([])).toMatchObject({
      kind: "values",
      values: { withDefault: 40, withoutDefault: undefined },
    });
  });
});

describe("defineCommand: multiple/repeatable params", () => {
  it("accumulates repeated string flags in order", () => {
    const command = defineCommand({
      params: { step: { type: "string", multiple: true } },
      run: (v) => v,
    });
    const result = command.parse(["--step", "a", "--step", "b"]);
    expect(result).toMatchObject({ kind: "values", values: { step: ["a", "b"] } });
  });

  it("resolves to [] when absent, for both string and number", () => {
    const command = defineCommand({
      params: {
        step: { type: "string", multiple: true },
        limit: { type: "number", multiple: true },
      },
      run: (v) => v,
    });
    expect(command.parse([])).toMatchObject({ kind: "values", values: { step: [], limit: [] } });
  });

  it("accumulates repeated --flag=value inline forms too", () => {
    const command = defineCommand({
      params: { step: { type: "string", multiple: true } },
      run: (v) => v,
    });
    const result = command.parse(["--step=a", "--step=b"]);
    expect(result).toMatchObject({ kind: "values", values: { step: ["a", "b"] } });
  });

  it("reports a choices violation for any repeated occurrence", () => {
    const command = defineCommand({
      params: { step: { type: "string", multiple: true, choices: ["a", "b"] } },
      run: (v) => v,
    });
    const result = command.parse(["--step", "a", "--step", "bogus", "--step", "b"]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors[0]).toContain('got "bogus"');
  });

  it("reports every invalid occurrence, not just the first", () => {
    const command = defineCommand({
      params: { step: { type: "string", multiple: true, choices: ["a", "b"] } },
      run: (v) => v,
    });
    const result = command.parse(["--step", "bogus1", "--step", "bogus2"]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors).toHaveLength(2);
    expect(result.kind === "error" && result.errors[0]).toContain('"bogus1"');
    expect(result.kind === "error" && result.errors[1]).toContain('"bogus2"');
  });

  it("reports a missing value at the end of argv", () => {
    const command = defineCommand({
      params: { step: { type: "string", multiple: true } },
      run: (v) => v,
    });
    const result = command.parse(["--step", "a", "--step"]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors).toContain("Missing value for --step");
  });

  it("reports a missing value immediately followed by another flag", () => {
    const command = defineCommand({
      params: {
        step: { type: "string", multiple: true },
        other: { type: "boolean" },
      },
      run: (v) => v,
    });
    const result = command.parse(["--step", "--other"]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors).toContain("Missing value for --step");
  });

  it("accumulates and validates repeated number flags", () => {
    const command = defineCommand({
      params: { limit: { type: "number", multiple: true, integer: true, min: 1 } },
      run: (v) => v,
    });
    expect(command.parse(["--limit", "1", "--limit", "2", "--limit", "3"])).toMatchObject({
      kind: "values",
      values: { limit: [1, 2, 3] },
    });

    const result = command.parse(["--limit", "1", "--limit", "abc"]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.errors[0]).toContain("must be a number");
  });

  it("describes a multiple param as repeatable, never required", () => {
    const command = defineCommand({
      params: { step: { type: "string", multiple: true } },
      run: () => undefined,
    });
    const result = command.parse(["--help"]);
    expect(result.kind === "help" && result.helpText).toContain("repeatable");
    expect(result.kind === "help" && result.helpText).not.toContain("required");
  });

  it("throws at definition time when multiple is combined with a default", () => {
    expect(() =>
      defineCommand({
        params: { step: { type: "string", multiple: true, default: ["a"] } as never },
        run: () => undefined,
      })
    ).toThrow(/combines multiple: true with a default/);
  });

  it("throws at definition time when multiple is combined with optional", () => {
    expect(() =>
      defineCommand({
        params: { step: { type: "string", multiple: true, optional: true } },
        run: () => undefined,
      })
    ).toThrow(/combines multiple: true with optional/);
  });
});

describe("defineCommand: boolean params", () => {
  it("defaults to false", () => {
    const command = defineCommand({ params: { verbose: { type: "boolean" } }, run: (v) => v });
    expect(command.parse([])).toMatchObject({ kind: "values", values: { verbose: false } });
  });

  it("a bare flag sets true; --no-flag sets false", () => {
    const command = defineCommand({ params: { verbose: { type: "boolean" } }, run: (v) => v });
    expect(command.parse(["--verbose"])).toMatchObject({
      kind: "values",
      values: { verbose: true },
    });
    expect(command.parse(["--no-verbose"])).toMatchObject({
      kind: "values",
      values: { verbose: false },
    });
  });

  it("accepts explicit --flag=true/false", () => {
    const command = defineCommand({ params: { verbose: { type: "boolean" } }, run: (v) => v });
    expect(command.parse(["--verbose=true"])).toMatchObject({
      kind: "values",
      values: { verbose: true },
    });
    expect(command.parse(["--verbose=false"])).toMatchObject({
      kind: "values",
      values: { verbose: false },
    });
  });

  it("rejects a non-boolean inline value", () => {
    const command = defineCommand({ params: { verbose: { type: "boolean" } }, run: (v) => v });
    const result = command.parse(["--verbose=maybe"]);
    expect(result.kind).toBe("error");
  });

  it("rejects combining --no- with an inline value", () => {
    const command = defineCommand({ params: { verbose: { type: "boolean" } }, run: (v) => v });
    const result = command.parse(["--no-verbose=true"]);
    expect(result.kind).toBe("error");
  });

  it("derives the kebab-case flag name from a camelCase key", () => {
    const command = defineCommand({
      params: { allowAmbiguousUnscoped: { type: "boolean" } },
      run: (v) => v,
    });
    expect(command.parse(["--allow-ambiguous-unscoped"])).toMatchObject({
      kind: "values",
      values: { allowAmbiguousUnscoped: true },
    });
  });

  it("supports an explicit flag name override", () => {
    const command = defineCommand({
      params: { verbose: { type: "boolean", flag: "loud" } },
      run: (v) => v,
    });
    expect(command.parse(["--loud"])).toMatchObject({
      kind: "values",
      values: { verbose: true },
    });
  });

  it("matches a real flag literally named no-* exactly, instead of treating it as negation", () => {
    const command = defineCommand({
      params: { noCache: { type: "boolean" } },
      run: (v) => v,
    });
    expect(command.parse(["--no-cache"])).toMatchObject({
      kind: "values",
      values: { noCache: true },
    });
  });

  it("still negates an unrelated flag when the exact no-* name isn't registered", () => {
    const command = defineCommand({
      params: { verbose: { type: "boolean" } },
      run: (v) => v,
    });
    expect(command.parse(["--no-verbose"])).toMatchObject({
      kind: "values",
      values: { verbose: false },
    });
  });
});
