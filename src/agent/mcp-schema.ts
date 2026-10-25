import type { StandardSchemaV1 } from "../core/pipeline-types.js";
import { canonicalJsonValue } from "../utilities/canonical-json.js";
import { isRecord } from "./mcp-session.js";

type Json = Readonly<Record<string, unknown>>;

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

/** Inline references and rewrite supported schema positions in one traversal. */
function strict(
  schema: unknown,
  root: Json,
  optional: WeakSet<object>,
  seen: readonly string[] = []
): Json {
  if (!isRecord(schema)) throw new Error("MCP input schemas must be JSON Schema objects");
  for (const keyword of UNSUPPORTED)
    if (Object.hasOwn(schema, keyword))
      throw new Error(`Unsupported MCP schema keyword ${keyword}`);
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false)
    throw new Error("MCP input schemas do not support free-form objects");
  if (Array.isArray(schema.items)) throw new Error("MCP input schemas do not support tuple items");
  const { $ref, ...rest } = schema;
  if (typeof $ref === "string") {
    const match = /^#\/(\$defs|definitions)\/(.+)$/.exec($ref);
    let target: unknown = root;
    for (const part of $ref.slice(2).split("/")) {
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      target = isRecord(target) && Object.hasOwn(target, key) ? target[key] : undefined;
    }
    if (!match || !isRecord(target)) throw new Error(`Unsupported MCP schema reference ${$ref}`);
    if (seen.includes($ref)) throw new Error(`Recursive MCP schema reference ${$ref}`);
    return strict({ ...target, ...rest }, root, optional, [...seen, $ref]);
  }
  const { $defs: _defs, definitions: _definitions, $schema: _dialect, ...body } = rest;
  const result: Record<string, unknown> = { ...body };
  if (schema.items !== undefined) result.items = strict(schema.items, root, optional, seen);
  if (Array.isArray(schema.anyOf))
    result.anyOf = schema.anyOf.map((child) => strict(child, root, optional, seen));
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
      const field = strict(child, root, optional, seen);
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
  if (Array.isArray(schema.anyOf)) value = decodeAny(schema.anyOf, value, path, optional);
  if (Array.isArray(value))
    return value.map((item, index) => decode(schema.items, item, `${path}[${index}]`, optional));
  if (!isRecord(value) || !objectSchema(schema)) return value;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const name of Array.isArray(schema.required) ? schema.required : [])
    if (!Object.hasOwn(value, name)) throw new Error(`${path}.${name} is required`);
  const decoded: [string, unknown][] = [];
  for (const [name, child] of Object.entries(value)) {
    const property = properties[name];
    if (!Object.hasOwn(properties, name)) {
      if (schema.additionalProperties === false) throw new Error(`${path}.${name} is not allowed`);
      decoded.push([name, child]);
    } else if (!(child === null && isRecord(property) && optional.has(property)))
      decoded.push([name, decode(property, child, `${path}.${name}`, optional)]);
  }
  return Object.fromEntries(decoded);
}

function decodeAny(options: unknown[], value: unknown, path: string, optional: WeakSet<object>) {
  for (const option of options) {
    try {
      return decode(option, value, path, optional);
    } catch {
      // Try the next alternative.
    }
  }
  throw new Error(`${path} matches no allowed schema`);
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
  const descriptor = strict(inputSchema, inputSchema, optional);
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
