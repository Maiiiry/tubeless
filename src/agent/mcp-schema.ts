import type { StandardSchemaV1 } from "../core/pipeline-types.js";
import { canonicalJsonValue } from "../utilities/canonical-json.js";
import { isRecord } from "./mcp-session.js";

type Json = Readonly<Record<string, unknown>>;

interface SchemaContext {
  readonly root: Json;
  readonly optional: WeakSet<object>;
  charge(value: unknown, depth: number): void;
}

/** Charge source data and every expanded copy before retaining its descriptor. */
function expansionBudget() {
  let nodes = 0;
  let characters = 0;
  const charge = (value: unknown, depth: number): void => {
    if (++nodes > 10_000 || depth > 64)
      throw new Error("MCP input schema exceeds expansion limits");
    if (typeof value === "string") {
      characters += value.length;
      if (characters > 1_048_576) throw new Error("MCP input schema exceeds expansion limits");
    } else if (Array.isArray(value)) {
      for (const child of value) charge(child, depth + 1);
    } else if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        charge(key, depth + 1);
        charge(child, depth + 1);
      }
    }
  };
  return charge;
}

const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right));

const objectSchema = (schema: Json) =>
  schema.type === "object" ||
  (Array.isArray(schema.type) && schema.type.includes("object")) ||
  Object.hasOwn(schema, "properties");

// These constructs cannot be rewritten and decoded with the same structural rules.
const UNSUPPORTED = [
  "oneOf",
  "allOf",
  "prefixItems",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "additionalItems",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
  "unevaluatedProperties",
  "unevaluatedItems",
  "$dynamicRef",
  "$recursiveRef",
];

const REFERENCE_ANNOTATIONS = [
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "$comment",
  "$schema",
  "$defs",
  "definitions",
];

/** Inline references and rewrite supported schema positions in one traversal. */
function strict(
  schema: unknown,
  context: SchemaContext,
  seen: readonly string[] = [],
  depth = 0
): Json {
  const { root, optional, charge } = context;
  charge(null, depth);
  if (!isRecord(schema)) throw new Error("MCP input schemas must be JSON Schema objects");
  for (const keyword of UNSUPPORTED)
    if (Object.hasOwn(schema, keyword))
      throw new Error(`Unsupported MCP schema keyword ${keyword}`);
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false)
    throw new Error("MCP input schemas do not support free-form objects");
  if (Array.isArray(schema.items)) throw new Error("MCP input schemas do not support tuple items");
  const { $ref, ...rest } = schema;
  if (typeof $ref === "string") {
    if (Object.keys(rest).some((key) => !REFERENCE_ANNOTATIONS.includes(key)))
      throw new Error("MCP schema references do not support validation siblings");
    const match = /^#\/(\$defs|definitions)\/(.+)$/.exec($ref);
    let target: unknown = root;
    for (const part of $ref.slice(2).split("/")) {
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      target = isRecord(target) && Object.hasOwn(target, key) ? target[key] : undefined;
    }
    if (!match || !isRecord(target)) throw new Error(`Unsupported MCP schema reference ${$ref}`);
    if (seen.includes($ref)) throw new Error(`Recursive MCP schema reference ${$ref}`);
    return strict({ ...target, ...rest }, context, [...seen, $ref], depth + 1);
  }
  const { $defs: _defs, definitions: _definitions, $schema: _dialect, ...body } = rest;
  const { properties: _properties, items: _items, anyOf: _anyOf, ...literals } = body;
  charge(literals, depth);
  const result: Record<string, unknown> = { ...body };
  if (schema.items !== undefined) result.items = strict(schema.items, context, seen, depth + 1);
  if (Array.isArray(schema.anyOf))
    result.anyOf = schema.anyOf.map((child) => strict(child, context, seen, depth + 1));
  if (!objectSchema(schema)) return result;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = schema.required ?? [];
  if (
    !Array.isArray(required) ||
    required.some((name) => typeof name !== "string" || !Object.hasOwn(properties, name))
  )
    throw new Error("MCP required names must be declared in properties");
  result.properties = Object.fromEntries(
    Object.entries(properties).map(([name, child]) => {
      charge(name, depth + 1);
      const field = strict(child, context, seen, depth + 1);
      if (required.includes(name)) return [name, field];
      if (acceptsNull(field, optional))
        throw new Error(
          `Optional MCP property ${name} already accepts null; omission would be ambiguous`
        );
      const wrapper = { anyOf: [field, { type: "null" }] };
      optional.add(wrapper);
      return [name, wrapper];
    })
  );
  result.required = Object.keys(properties);
  result.additionalProperties = false;
  return result;
}

function typeMatches(type: unknown, value: unknown): boolean {
  if (Array.isArray(type)) return type.some((option) => typeMatches(option, value));
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return Number.isSafeInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

/**
 * Check structure against the strict descriptor and drop the nulls it substitutes for
 * omitted optional properties. The MCP server remains the authority for its full schema.
 */
function decode(schema: unknown, value: unknown, path: string, optional: WeakSet<object>): unknown {
  if (!isRecord(schema)) return value;
  if (schema.type !== undefined && !typeMatches(schema.type, value))
    throw new Error(`${path} must be ${JSON.stringify(schema.type)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => jsonEqual(option, value)))
    throw new Error(`${path} must be one of ${JSON.stringify(schema.enum)}`);
  if (Object.hasOwn(schema, "const") && !jsonEqual(schema.const, value))
    throw new Error(`${path} must be ${JSON.stringify(schema.const)}`);
  // Sibling constraints must see the original input, before any branch removes placeholders.
  let decoded: unknown = value;
  if (Array.isArray(value)) {
    decoded = value.map((item, index) => decode(schema.items, item, `${path}[${index}]`, optional));
  } else if (isRecord(value) && objectSchema(schema)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const name of Array.isArray(schema.required) ? schema.required : [])
      if (!Object.hasOwn(value, name)) throw new Error(`${path}.${name} is required`);
    const entries: [string, unknown][] = [];
    for (const [name, child] of Object.entries(value)) {
      const property = properties[name];
      if (!Object.hasOwn(properties, name)) {
        if (schema.additionalProperties === false)
          throw new Error(`${path}.${name} is not allowed`);
        entries.push([name, child]);
      } else if (!(child === null && isRecord(property) && optional.has(property)))
        entries.push([name, decode(property, child, `${path}.${name}`, optional)]);
    }
    decoded = Object.fromEntries(entries);
  }
  if (!Array.isArray(schema.anyOf)) return decoded;
  const alternative = decodeAny(schema.anyOf, value, path, optional);
  if (objectSchema(schema) || (Array.isArray(value) && schema.items !== undefined)) {
    if (!jsonEqual(decoded, alternative)) throw new Error(`${path} has conflicting anyOf decoding`);
    return decoded;
  }
  return alternative;
}

function decodeAny(options: unknown[], value: unknown, path: string, optional: WeakSet<object>) {
  const matches: unknown[] = [];
  for (const option of options) {
    try {
      const decoded = decode(option, value, path, optional);
      matches.push(decoded);
    } catch {
      // Try the next alternative.
    }
  }
  if (matches.length === 0) throw new Error(`${path} matches no allowed schema`);
  if (matches.some((match) => !jsonEqual(match, matches[0])))
    throw new Error(`${path} has ambiguous anyOf decoding`);
  return matches[0];
}

function acceptsNull(schema: Json, optional: WeakSet<object>): boolean {
  try {
    decode(schema, null, "input", optional);
    return true;
  } catch {
    return false;
  }
}

/** Adapt an MCP tool input schema to a strict model descriptor and an argument decoder. */
export function mcpInputSchema(inputSchema: unknown): StandardSchemaV1<Record<string, unknown>> {
  if (!isRecord(inputSchema) || inputSchema.type !== "object")
    throw new Error("MCP tool inputSchema must be a JSON Schema object");
  const optional = new WeakSet<object>();
  const charge = expansionBudget();
  charge(inputSchema, 0);
  const descriptor = strict(inputSchema, { root: inputSchema, optional, charge });
  return {
    "~standard": {
      version: 1,
      vendor: "tubeless-mcp",
      jsonSchema: { input: () => descriptor },
      validate(value) {
        try {
          // SAFETY: the descriptor's root is an object schema, so decoding yields a record.
          return { value: decode(descriptor, value, "input", optional) as Record<string, unknown> };
        } catch (error) {
          return { issues: [{ message: error instanceof Error ? error.message : String(error) }] };
        }
      },
    },
  };
}

/** Content and optional structured data returned by an MCP tool call. */
export interface McpToolResult {
  readonly content: readonly Readonly<Record<string, unknown> & { type: string }>[];
  readonly structuredContent?: Readonly<Record<string, unknown>>;
}

/** Validate a raw `tools/call` result into the content the agent observes. */
export const mcpResultSchema: StandardSchemaV1<unknown, McpToolResult> = {
  "~standard": {
    version: 1,
    vendor: "tubeless-mcp",
    // Describes the generic result shape for code-mode declarations.
    jsonSchema: {
      input: () => ({
        type: "object",
        properties: {
          content: {
            type: "array",
            items: {
              type: "object",
              properties: { type: { type: "string" }, text: { type: "string" } },
              required: ["type"],
            },
          },
          structuredContent: { type: "object" },
        },
        required: ["content"],
      }),
    },
    validate(value) {
      if (
        !isRecord(value) ||
        !Array.isArray(value.content) ||
        !value.content.every((item) => isRecord(item) && typeof item.type === "string") ||
        (value.structuredContent !== undefined && !isRecord(value.structuredContent))
      )
        return { issues: [{ message: "MCP tool returned an invalid result" }] };
      return {
        value: {
          content: value.content as McpToolResult["content"],
          ...(value.structuredContent === undefined
            ? {}
            : { structuredContent: value.structuredContent as Json }),
        },
      };
    },
  },
};
