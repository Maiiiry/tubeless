type Json = Readonly<Record<string, unknown>>;

/** One script-callable tool, described by its model-facing descriptors. */
export interface CodemodeDeclaration {
  readonly name: string;
  readonly description: string;
  readonly inputJsonSchema: Json;
  readonly outputJsonSchema?: Json;
}

const MAX_DEPTH = 12;
const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const isRecord = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const key = (name: string) => (identifier.test(name) ? name : JSON.stringify(name));

/** Keep comments single-purpose: no early terminators, bounded and trimmed. */
function comment(text: string, indent: string): string[] {
  const lines = text.replaceAll("*/", "*\\/").trim().split(/\r?\n/);
  if (lines.length === 1 && lines[0]!.length <= 100) return [`${indent}/** ${lines[0]} */`];
  return [`${indent}/**`, ...lines.map((line) => `${indent} * ${line}`.trimEnd()), `${indent} */`];
}

function union(types: readonly string[]): string {
  const unique = [...new Set(types)];
  if (unique.includes("unknown")) return "unknown";
  return unique.length === 0 ? "never" : unique.join(" | ");
}

/** Parenthesize only top-level unions and intersections; nested object members need none. */
function wrap(type: string): string {
  let depth = 0;
  for (const character of type) {
    if ("{[(<".includes(character)) depth++;
    else if ("}])>".includes(character)) depth--;
    else if (depth === 0 && (character === "|" || character === "&")) return `(${type})`;
  }
  return type;
}

/** Render a JSON Schema fragment as a TypeScript type; unsupported constructs become unknown. */
function render(schema: unknown, root: Json, indent: string, depth: number): string {
  if (schema === false) return "never";
  if (!isRecord(schema) || depth > MAX_DEPTH) return "unknown";
  if (typeof schema.$ref === "string") {
    const match = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(schema.$ref);
    const definitions = match ? root[match[1]!] : undefined;
    const target = isRecord(definitions) ? definitions[match![2]!] : undefined;
    return target === undefined ? "unknown" : render(target, root, indent, depth + 1);
  }
  if (Object.hasOwn(schema, "const")) return JSON.stringify(schema.const) ?? "unknown";
  if (Array.isArray(schema.enum)) return union(schema.enum.map((value) => JSON.stringify(value)));
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (Array.isArray(branches))
      return union(branches.map((branch) => render(branch, root, indent, depth + 1)));
  }
  if (Array.isArray(schema.allOf))
    return schema.allOf.map((part) => wrap(render(part, root, indent, depth + 1))).join(" & ");
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length > 1)
    return union(types.map((type) => render({ ...schema, type }, root, indent, depth)));
  switch (types[0]) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return Array.isArray(schema.prefixItems)
        ? `[${schema.prefixItems.map((item) => render(item, root, indent, depth + 1)).join(", ")}]`
        : `${wrap(render(schema.items ?? true, root, indent, depth + 1))}[]`;
    case "object":
      return object(schema, root, indent, depth);
    default:
      return isRecord(schema.properties) ? object(schema, root, indent, depth) : "unknown";
  }
}

function object(schema: Json, root: Json, indent: string, depth: number): string {
  const properties = isRecord(schema.properties) ? Object.entries(schema.properties) : [];
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const extra = schema.additionalProperties;
  if (properties.length === 0)
    return extra === false
      ? "{}"
      : `Record<string, ${isRecord(extra) ? render(extra, root, indent, depth + 1) : "unknown"}>`;
  const inner = `${indent}  `;
  const lines = ["{"];
  for (const [name, property] of properties) {
    if (
      isRecord(property) &&
      typeof property.description === "string" &&
      property.description.trim()
    )
      lines.push(...comment(property.description, inner));
    const optional = required.has(name) ? "" : "?";
    lines.push(`${inner}${key(name)}${optional}: ${render(property, root, inner, depth + 1)};`);
  }
  if (isRecord(extra))
    lines.push(`${inner}[key: string]: ${render(extra, root, inner, depth + 1)};`);
  lines.push(`${indent}}`);
  return lines.join("\n");
}

/** Render `declare const tools` for script-callable capabilities in registry order. */
export function codemodeDeclarations(tools: readonly CodemodeDeclaration[]): string {
  const lines = ["declare const tools: {"];
  for (const tool of tools) {
    lines.push(...comment(tool.description, "  "));
    const input = render(tool.inputJsonSchema, tool.inputJsonSchema, "  ", 0);
    const output = tool.outputJsonSchema
      ? render(tool.outputJsonSchema, tool.outputJsonSchema, "  ", 0)
      : "unknown";
    lines.push(`  ${key(tool.name)}(input: ${input}): Promise<${output}>;`);
  }
  lines.push("};");
  return lines.join("\n");
}
