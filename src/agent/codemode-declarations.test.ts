import { describe, expect, it } from "vitest";
import { codemodeDeclarations } from "./codemode-declarations.js";

describe("code-mode declarations", () => {
  it("renders JSON Schema inputs and outputs as TypeScript declarations", () => {
    const text = codemodeDeclarations([
      {
        name: "docs__search-pages",
        description: "Search */ pages",
        inputJsonSchema: {
          type: "object",
          $defs: { mode: { enum: ["fast", "deep"] } },
          properties: {
            query: { type: "string", description: "Query text" },
            limit: { anyOf: [{ type: "integer" }, { type: "null" }] },
            mode: { $ref: "#/$defs/mode" },
            tags: { type: "array", items: { type: ["string", "number"] } },
            pair: { type: "array", prefixItems: [{ type: "string" }, { const: 1 }] },
            meta: { type: "object", additionalProperties: { type: "boolean" } },
            external: { $ref: "https://example.com/schema" },
          },
          required: ["query", "limit", "mode"],
          additionalProperties: false,
        },
      },
      {
        name: "ping",
        description: "Ping",
        inputJsonSchema: {},
        outputJsonSchema: { type: "null" },
      },
    ]);
    expect(text).toBe(`declare const tools: {
  /** Search *\\/ pages */
  "docs__search-pages"(input: {
    /** Query text */
    query: string;
    limit: number | null;
    mode: "fast" | "deep";
    tags?: (string | number)[];
    pair?: [string, 1];
    meta?: Record<string, boolean>;
    external?: unknown;
  }): Promise<unknown>;
  /** Ping */
  ping(input: unknown): Promise<null>;
};`);
  });

  it("bounds recursion and keeps unknown branches permissive", () => {
    const recursive = {
      $defs: { node: { type: "array", items: { $ref: "#/$defs/node" } } },
      $ref: "#/$defs/node",
    };
    const text = codemodeDeclarations([
      { name: "tree", description: "Tree", inputJsonSchema: recursive },
      { name: "any", description: "Any", inputJsonSchema: { anyOf: [{ type: "string" }, true] } },
    ]);
    expect(text).toContain("tree(input: unknown[][][][][][]): Promise<unknown>;");
    expect(text).toContain("any(input: unknown): Promise<unknown>;");
  });
});
