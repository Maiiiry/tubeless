import { record, strictParameter } from "./provider-schema.js";

export function outputItems(body: unknown): Record<string, unknown>[] {
  if (!record(body) || !Array.isArray(body.output) || !body.output.every(record))
    throw new Error("OpenAI returned invalid output items");
  return body.output;
}

export function openaiDecision(output: readonly Record<string, unknown>[]) {
  const calls: { id: string; tool: string; input: unknown }[] = [];
  for (const item of output) {
    if (item.type === "reasoning") continue;
    if (item.type === "message") {
      if (
        !Array.isArray(item.content) ||
        item.content.some((part: unknown) => !record(part) || part.type !== "output_text")
      )
        throw new Error("OpenAI refused the request or returned invalid message content");
      continue;
    }
    if (
      item.type !== "function_call" ||
      typeof item.call_id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.arguments !== "string"
    )
      throw new Error("Invalid OpenAI function call");
    let args: unknown;
    try {
      args = JSON.parse(item.arguments);
    } catch {
      throw new Error("OpenAI function arguments must be JSON");
    }
    const key = item.name === "_finish" ? "result" : "input";
    if (!record(args) || Object.keys(args).length !== 1 || !Object.hasOwn(args, key))
      throw new Error(`OpenAI function arguments require exactly one ${key} field`);
    calls.push({ id: item.call_id, tool: item.name, input: args[key] });
  }
  if (calls.length === 0) throw new Error("OpenAI returned no function calls");
  if (calls.some((call) => call.tool === "_finish")) {
    if (calls.length !== 1) throw new Error("OpenAI must finish without other calls");
    return { kind: "finish", result: calls[0]!.input };
  }
  return { kind: "continue", calls };
}

export function parameter(name: string, schema: Readonly<Record<string, unknown>>, label = name) {
  return strictParameter(name, schema, label, {
    provider: "OpenAI",
    closedObjects: true,
    requireEveryProperty: true,
  });
}
