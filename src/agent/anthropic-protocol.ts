import { record, strictParameter } from "./provider-schema.js";

export const COMPACTION_BETA = "compact-2026-09-04";

const FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);
// Annotations with no model-facing meaning; references are rejected, so definitions are unused.
const DROPPED = new Set(["$schema", "$id", "$comment", "$defs", "definitions"]);
const KEPT = new Set([
  "type",
  "title",
  "description",
  "default",
  "required",
  "additionalProperties",
  // Kept so strictParameter rejects them instead of hiding them in a description.
  "$ref",
  "$dynamicRef",
  "$recursiveRef",
]);
const scalar = (value: unknown) => value === null || typeof value !== "object";

function jsonType(
  value: unknown
): "null" | "boolean" | "integer" | "number" | "string" | undefined {
  if (value === null) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  if (typeof value === "number" && Number.isFinite(value))
    return Number.isInteger(value) ? "integer" : "number";
  return undefined;
}

/** Anthropic's grammar requires a type unless a combinator is present. */
function withStrictType(schema: Record<string, unknown>): Record<string, unknown> {
  if (
    schema.type !== undefined ||
    schema.anyOf !== undefined ||
    schema.allOf !== undefined ||
    // Leave references in place so the shared checker rejects them before I/O.
    ["$ref", "$dynamicRef", "$recursiveRef"].some((keyword) => Object.hasOwn(schema, keyword))
  )
    return schema;
  if (Object.hasOwn(schema, "const")) {
    const type = jsonType(schema.const);
    if (type !== undefined) return { type, ...schema };
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const types = schema.enum.map(jsonType);
    if (types.every((type) => type !== undefined)) {
      const unique = [...new Set(types)];
      if (unique.length === 1 || unique.every((type) => type === "integer" || type === "number"))
        return { type: unique.length === 1 ? unique[0] : "number", ...schema };
      const groups = new Map<string, unknown[]>();
      for (const [index, type] of types.entries()) {
        const values = groups.get(type!) ?? [];
        values.push(schema.enum[index]);
        groups.set(type!, values);
      }
      const { enum: _enum, ...rest } = schema;
      return { ...rest, anyOf: [...groups].map(([type, values]) => ({ type, enum: values })) };
    }
  }
  throw new Error("Anthropic strict schema requires a type when anyOf and allOf are absent");
}

// Strict tool use compiles only a subset of JSON Schema. The harness still validates the
// original schema, so every other keyword moves into the description instead.
function strictSubset(schema: unknown): unknown {
  if (!record(schema)) return schema;
  const kept: Record<string, unknown> = {};
  const moved: Record<string, unknown> = {};
  for (const [keyword, value] of Object.entries(schema)) {
    if (DROPPED.has(keyword)) continue;
    if (keyword === "properties" && record(value))
      kept.properties = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, strictSubset(child)])
      );
    else if (keyword === "items" && record(value)) kept.items = strictSubset(value);
    else if ((keyword === "anyOf" || keyword === "allOf") && Array.isArray(value))
      kept[keyword] = value.map(strictSubset);
    else if (keyword === "oneOf" && Array.isArray(value) && !Array.isArray(schema.anyOf))
      kept.anyOf = value.map(strictSubset);
    else if (
      KEPT.has(keyword) ||
      (keyword === "minItems" && (value === 0 || value === 1)) ||
      (keyword === "format" && FORMATS.has(value as string)) ||
      (keyword === "const" && scalar(value)) ||
      (keyword === "enum" && Array.isArray(value) && value.every(scalar))
    )
      kept[keyword] = value;
    else moved[keyword] = value;
  }
  if (Object.keys(moved).length > 0) {
    const note = `Constraints: ${JSON.stringify(moved)}`;
    kept.description =
      typeof kept.description === "string" && kept.description
        ? `${kept.description}\n${note}`
        : note;
  }
  return withStrictType(kept);
}

/** Build a Messages API tool whose arguments carry the value in one wrapped field. */
export function anthropicTool(
  name: string,
  description: string,
  field: "input" | "result",
  schema: Readonly<Record<string, unknown>>,
  strict: boolean
) {
  // The Messages API accepts at most 64 characters. The harness allows 128.
  if (name.length > 64) throw new Error(`Anthropic tool name exceeds 64 characters: ${name}`);
  if (!strict) {
    // Wrapping still relocates the reference root, so references stay rejected.
    return {
      name,
      description,
      input_schema: strictParameter(field, schema, `tool ${name}`, {
        provider: "Anthropic",
        closedObjects: false,
        requireEveryProperty: false,
      }),
    };
  }
  // Check the schema the provider will see: stripped constraints are enforced only by
  // the harness, so their subschemas need not meet strict-mode object rules.
  // SAFETY: strictSubset returns a record when given a record.
  const visible = strictSubset(schema) as Record<string, unknown>;
  return {
    name,
    description,
    input_schema: strictParameter(field, visible, `tool ${name}`, {
      provider: "Anthropic",
      closedObjects: true,
      requireEveryProperty: false,
    }),
    strict: true,
  };
}

/** Validate a Messages API response and return its stop reason and content blocks. */
export function anthropicMessage(body: unknown) {
  if (
    !record(body) ||
    body.type !== "message" ||
    typeof body.stop_reason !== "string" ||
    !Array.isArray(body.content) ||
    !body.content.every(record)
  )
    throw new Error("Anthropic returned an invalid message");
  return { stopReason: body.stop_reason, content: body.content };
}

/** Map tool_use blocks to a harness decision; null when the model replied without tools. */
export function anthropicDecision(content: readonly Record<string, unknown>[]) {
  const calls: { id: string; tool: string; input: unknown }[] = [];
  for (const block of content) {
    if (block.type !== "tool_use") continue;
    if (typeof block.id !== "string" || typeof block.name !== "string" || !record(block.input))
      throw new Error("Invalid Anthropic tool call");
    const key = block.name === "_finish" ? "result" : "input";
    if (Object.keys(block.input).length !== 1 || !Object.hasOwn(block.input, key))
      throw new Error(`Anthropic tool arguments require exactly one ${key} field`);
    calls.push({ id: block.id, tool: block.name, input: block.input[key] });
  }
  if (calls.length === 0) return null;
  if (calls.some((call) => call.tool === "_finish")) {
    if (calls.length !== 1) throw new Error("Anthropic must finish without other calls");
    return { kind: "finish", result: calls[0]!.input };
  }
  return { kind: "continue", calls };
}

/** Whether a message list carries a compaction block, which requires the beta header. */
export function carriesCompaction(messages: readonly unknown[]): boolean {
  const first = messages[0];
  return (
    record(first) &&
    Array.isArray(first.content) &&
    record(first.content[0]) &&
    first.content[0].type === "compaction"
  );
}
