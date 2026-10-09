import type { StandardSchemaV1 } from "../core/pipeline-types.js";
import { isRecord } from "./mcp-session.js";

type Json = Readonly<Record<string, unknown>>;

const mapValues = (value: Json, map: (child: unknown, key: string) => unknown) =>
  Object.fromEntries(Object.entries(value).map(([key, child]) => [key, map(child, key)]));

const objectSchema = (schema: Json) =>
  schema.type === "object" ||
  (Array.isArray(schema.type) && schema.type.includes("object")) ||
  Object.hasOwn(schema, "properties");

/** Inline local `#/$defs` and `#/definitions` references; recursive schemas are unsupported. */
function inline(schema: unknown, root: Json, seen: readonly string[] = []): unknown {
  if (Array.isArray(schema)) return schema.map((child) => inline(child, root, seen));
  if (!isRecord(schema)) return schema;
  const { $ref, ...rest } = schema;
  if (typeof $ref === "string") {
    const match = /^#\/(\$defs|definitions)\/([^/]+)$/.exec($ref);
    const target =
      match && isRecord(root[match[1]!]) ? (root[match[1]!] as Json)[match[2]!] : undefined;
    if (!match || target === undefined) throw new Error(`Unsupported MCP schema reference ${$ref}`);
    if (seen.includes($ref)) throw new Error(`Recursive MCP schema reference ${$ref}`);
    return inline({ ...(target as Json), ...rest }, root, [...seen, $ref]);
  }
  const { $defs: _defs, definitions: _definitions, $schema: _dialect, ...body } = rest;
  return mapValues(body, (child, key) =>
    // Literal values are data, not schemas.
    ["const", "enum", "default", "examples"].includes(key) ? child : inline(child, root, seen)
  );
}

const SUBSCHEMAS = ["items", "not", "if", "then", "else", "contains", "additionalItems"];
const SCHEMA_LISTS = ["anyOf", "oneOf", "allOf", "prefixItems"];

/**
 * Require every property, admitting null for optional ones, and close every object.
 * Each nullable wrapper is recorded so decoding can recognize an omitted property.
 */
function strict(schema: unknown, optional: WeakSet<object>): unknown {
  if (!isRecord(schema)) return schema;
  const result: Record<string, unknown> = { ...schema };
  for (const key of SUBSCHEMAS)
    if (isRecord(schema[key])) result[key] = strict(schema[key], optional);
  for (const key of SCHEMA_LISTS)
    if (Array.isArray(schema[key]))
      result[key] = (schema[key] as unknown[]).map((child) => strict(child, optional));
  if (!objectSchema(schema)) return result;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  result.properties = mapValues(properties, (child, name) => {
    if (required.includes(name)) return strict(child, optional);
    const wrapper = { anyOf: [strict(child, optional), { type: "null" }] };
    optional.add(wrapper);
    return wrapper;
  });
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
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => Object.is(option, value)))
    throw new Error(`${path} must be one of ${JSON.stringify(schema.enum)}`);
  if (Object.hasOwn(schema, "const") && !Object.is(schema.const, value))
    throw new Error(`${path} must be ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.anyOf)) value = decodeAny(schema.anyOf, value, path, optional);
  if (Array.isArray(value))
    return value.map((item, index) => decode(schema.items, item, `${path}[${index}]`, optional));
  if (!isRecord(value) || !objectSchema(schema)) return value;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const name of Array.isArray(schema.required) ? schema.required : [])
    if (!Object.hasOwn(value, name)) throw new Error(`${path}.${name} is required`);
  const decoded: Record<string, unknown> = {};
  for (const [name, child] of Object.entries(value)) {
    const property = properties[name];
    if (!Object.hasOwn(properties, name)) {
      if (schema.additionalProperties === false) throw new Error(`${path}.${name} is not allowed`);
      decoded[name] = child;
    } else if (!(child === null && isRecord(property) && optional.has(property)))
      decoded[name] = decode(property, child, `${path}.${name}`, optional);
  }
  return decoded;
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

/** Adapt an MCP tool input schema to a strict model descriptor and an argument decoder. */
export function mcpInputSchema(inputSchema: unknown): StandardSchemaV1<Record<string, unknown>> {
  if (!isRecord(inputSchema) || !objectSchema(inputSchema))
    throw new Error("MCP tool inputSchema must be a JSON Schema object");
  const optional = new WeakSet<object>();
  const descriptor = strict(inline(inputSchema, inputSchema), optional) as Json;
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
