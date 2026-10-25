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
