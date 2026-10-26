import { describe, expect, it } from "vitest";
import { defineAgentLoop, defineTool, type AgentTool } from "./agent.js";
import { emptyInput, numberSchema } from "./agent.test-support.js";

describe("agent capability definitions", () => {
  const missingMetadata = { "~standard": { ...numberSchema["~standard"], jsonSchema: undefined } };
  it("requires a model descriptor, with an explicit fallback for validators without conversion", () => {
    expect(() =>
      defineTool({
        description: "Number",
        inputSchema: missingMetadata,
        outputSchema: numberSchema,
        run: (value) => value,
      })
    ).toThrow("descriptor");
    expect(() =>
      defineTool({
        description: "Number",
        inputSchema: missingMetadata,
        inputJsonSchema: { type: "number" },
        outputSchema: numberSchema,
        run: (value) => value,
      })
    ).not.toThrow();
    expect(() =>
      defineAgentLoop({
        id: "missing-result-metadata",
        inputSchema: emptyInput,
        resultSchema: missingMetadata,
        initialState: () => 0,
        decide: () => ({ kind: "finish", result: 1 }),
      })
    ).toThrow("descriptor");
  });
  it.each([undefined, null, [], { value: () => 1 }, { value: Infinity }])(
    "rejects missing or non-JSON descriptors %j",
    (descriptor) => {
      expect(() =>
        defineTool({
          description: "Number",
          inputSchema: missingMetadata,
          outputSchema: numberSchema,
          inputJsonSchema: descriptor as unknown as Record<string, unknown>,
          run: (value) => value,
        })
      ).toThrow("descriptor");
    }
  );
  it("rejects blank descriptions, unregistered descriptors, and invalid tool names", () => {
    expect(() =>
      defineTool({
        description: " ",
        inputSchema: numberSchema,
        outputSchema: numberSchema,
        run: (value) => value,
      })
    ).toThrow("description");
    const base = {
      id: "registry",
      inputSchema: emptyInput,
      resultSchema: numberSchema,
      initialState: () => 0,
      decide: () => ({ kind: "finish", result: 1 }),
    };
    expect(() =>
      defineAgentLoop({ ...base, tools: { fake: {} as AgentTool<unknown, unknown> } })
    ).toThrow("defineTool");
    const tool = defineTool({
      description: "Number",
      inputSchema: numberSchema,
      outputSchema: numberSchema,
      run: (value) => value,
    });
    expect(() => defineAgentLoop({ ...base, tools: { "invalid name": tool } })).toThrow(
      "tool name"
    );
  });
});
