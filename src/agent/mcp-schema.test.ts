import { describe, expect, it } from "vitest";
import { mcpInputSchema } from "./mcp-schema.js";
import { parameter } from "./openai-protocol.js";

describe("MCP input schemas", () => {
  it("preserves keyword-shaped field names and inlines their references", async () => {
    const names = [
      "$ref",
      "$defs",
      "definitions",
      "$schema",
      "enum",
      "const",
      "default",
      "examples",
      "__proto__",
    ];
    const schema = mcpInputSchema({
      type: "object",
      properties: Object.fromEntries(names.map((name) => [name, { $ref: "#/$defs/text~1value" }])),
      required: names,
      $defs: { "text/value": { type: "string", default: { $ref: "literal data" } } },
    });
    const descriptor = schema["~standard"].jsonSchema!.input({ target: "draft-2020-12" });
    expect(descriptor.properties).toEqual(
      Object.fromEntries(
        names.map((name) => [
          name,
          {
            type: "string",
            default: { $ref: "literal data" },
          },
        ])
      )
    );
    expect(() => parameter("input", descriptor)).not.toThrow();
    const value = Object.fromEntries(names.map((name) => [name, "value"]));
    expect(await schema["~standard"].validate(value)).toEqual({ value });
  });

  it("decodes nested alternatives and array items while preserving required nulls", async () => {
    const schema = mcpInputSchema({
      type: "object",
      properties: {
        entries: {
          type: "array",
          items: {
            anyOf: [
              {
                type: "object",
                properties: { kind: { const: "item" }, label: { type: "string" } },
                required: ["kind"],
              },
              { type: "string" },
            ],
          },
        },
        requiredNull: { type: ["string", "null"] },
      },
      required: ["entries", "requiredNull"],
    });
    expect(
      await schema["~standard"].validate({
        entries: [{ kind: "item", label: null }, "plain"],
        requiredNull: null,
      })
    ).toEqual({ value: { entries: [{ kind: "item" }, "plain"], requiredNull: null } });
    expect(
      await schema["~standard"].validate({
        entries: [{ kind: "wrong", label: null }],
        requiredNull: null,
      })
    ).toHaveProperty("issues");
  });

  it.each([
    { type: ["string", "null"] },
    { anyOf: [{ type: "string" }, { type: "null" }] },
    { enum: ["value", null] },
    { const: null },
    {},
    { $ref: "#/$defs/nullable" },
  ])("rejects optional fields that already accept null: %j", async (field) => {
    const input = {
      type: "object",
      properties: { value: field },
      $defs: { nullable: { type: ["string", "null"] } },
    };
    expect(() => mcpInputSchema(input)).toThrow("Optional MCP property value already accepts null");
    const required = mcpInputSchema({ ...input, required: ["value"] });
    expect(await required["~standard"].validate({ value: null })).toEqual({
      value: { value: null },
    });
  });

  it("uses null placeholders for non-nullable optional enums and constants", async () => {
    const schema = mcpInputSchema({
      type: "object",
      properties: {
        color: { enum: ["red", "blue"] },
        value: { const: "fixed" },
      },
    });
    expect(await schema["~standard"].validate({ color: null, value: null })).toEqual({ value: {} });
    expect(await schema["~standard"].validate({ color: "blue", value: "fixed" })).toEqual({
      value: { color: "blue", value: "fixed" },
    });
  });

  it.each([
    { type: "object", required: ["query"] },
    { type: "object", properties: { nested: { type: "object", required: ["query"] } } },
    { type: "object", properties: { query: { type: "string" } }, required: ["query", "missing"] },
  ])("rejects required names absent from properties: %j", (input) => {
    expect(() => mcpInputSchema(input)).toThrow(
      "MCP required names must be declared in properties"
    );
  });

  it.each(["enum", "const"])("compares JSON-valued %s entries structurally", async (keyword) => {
    const object = { count: 1, nested: { label: "ok", values: [1, 2] } };
    const array = [{ label: "ok", count: 1 }, 2];
    const constraint = (value: unknown) => ({ [keyword]: keyword === "enum" ? [value] : value });
    const schema = mcpInputSchema({
      type: "object",
      properties: {
        object: {
          type: "object",
          properties: {
            count: { type: "integer" },
            nested: {
              type: "object",
              properties: {
                label: { type: "string" },
                values: { type: "array", items: { type: "integer" } },
              },
              required: ["label", "values"],
            },
          },
          required: ["count", "nested"],
          ...constraint(object),
        },
        array: { type: "array", ...constraint(array) },
      },
      required: ["object", "array"],
    });
    const value = {
      object: { nested: { values: [1, 2], label: "ok" }, count: 1 },
      array: [{ count: 1, label: "ok" }, 2],
    };
    expect(await schema["~standard"].validate(value)).toEqual({ value });
    expect(
      await schema["~standard"].validate({ ...value, array: [2, { count: 1, label: "ok" }] })
    ).toHaveProperty("issues");
    expect(
      await schema["~standard"].validate({ ...value, object: { ...value.object, count: 2 } })
    ).toHaveProperty("issues");
  });

  it.each(["oneOf", "allOf", "prefixItems", "not", "if", "dependentSchemas", "patternProperties"])(
    "rejects %s before advertising a tool with an unsupported descriptor",
    (keyword) => {
      expect(() =>
        mcpInputSchema({
          type: "object",
          properties: {
            value: { [keyword]: [{ type: "object", properties: { label: { type: "string" } } }] },
          },
        })
      ).toThrow(`Unsupported MCP schema keyword ${keyword}`);
    }
  );

  it("rejects free-form objects, tuple items and recursive references", () => {
    expect(() =>
      mcpInputSchema({ type: "object", additionalProperties: { type: "string" } })
    ).toThrow("free-form objects");
    expect(() =>
      mcpInputSchema({
        type: "object",
        properties: { entries: { type: "array", items: [{ type: "string" }] } },
      })
    ).toThrow("tuple items");
    expect(() =>
      mcpInputSchema({
        type: "object",
        properties: { value: { $ref: "#/$defs/loop" } },
        $defs: { loop: { $ref: "#/$defs/loop" } },
      })
    ).toThrow("Recursive MCP schema reference");
  });
});
