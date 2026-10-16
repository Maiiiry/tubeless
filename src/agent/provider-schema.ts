export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const SCHEMA_MAPS = [
  "$defs",
  "definitions",
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
] as const;
const SCHEMA_VALUES = [
  "items",
  "additionalItems",
  "additionalProperties",
  "contains",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
] as const;

/** Provider strict-mode rules checked locally before any request is sent. */
export interface StrictSchemaRules {
  readonly provider: string;
  /** Require additionalProperties: false on every object schema. */
  readonly closedObjects: boolean;
  /** OpenAI strict mode requires every property in `required`; Anthropic permits optional ones. */
  readonly requireEveryProperty: boolean;
}

// Wrapping changes the resource root. Only inspect schema positions, never literal
// values in const/enum/default/examples or property names that resemble keywords.
function assertParameterSchema(schema: unknown, path: string, rules: StrictSchemaRules): void {
  if (Array.isArray(schema)) {
    schema.forEach((child, index) => assertParameterSchema(child, `${path}[${index}]`, rules));
    return;
  }
  if (!record(schema)) return;
  for (const keyword of ["$ref", "$dynamicRef", "$recursiveRef"]) {
    if (Object.hasOwn(schema, keyword))
      throw new Error(
        `${rules.provider} function parameters require inline schemas; ${keyword} is unsupported at ${path}. Supply an inline inputJsonSchema descriptor.`
      );
  }
  for (const keyword of SCHEMA_MAPS) {
    const children = schema[keyword];
    if (record(children)) {
      for (const [name, child] of Object.entries(children))
        assertParameterSchema(child, `${path}.${keyword}[${JSON.stringify(name)}]`, rules);
    }
  }
  for (const keyword of SCHEMA_VALUES)
    assertParameterSchema(schema[keyword], `${path}.${keyword}`, rules);

  const object =
    schema.type === "object" ||
    (Array.isArray(schema.type) && schema.type.includes("object")) ||
    Object.hasOwn(schema, "properties");
  if (!object || !rules.closedObjects) return;
  if (schema.additionalProperties !== false)
    throw new Error(
      `${rules.provider} strict schema at ${path} requires additionalProperties: false`
    );
  if (schema.properties !== undefined && !record(schema.properties))
    throw new Error(`${rules.provider} strict schema at ${path} requires an object properties map`);
  if (!rules.requireEveryProperty) return;
  const fields = Object.keys(schema.properties ?? {});
  const required = schema.required;
  if (fields.length === 0 && required === undefined) return;
  if (
    !Array.isArray(required) ||
    required.length !== fields.length ||
    new Set(required).size !== fields.length ||
    fields.some((field) => !required.includes(field))
  )
    throw new Error(
      `${rules.provider} strict schema at ${path} must require every property exactly once`
    );
}

/** Wrap a tool schema as a single required field after checking provider strict rules. */
export function strictParameter(
  name: string,
  schema: Readonly<Record<string, unknown>>,
  label: string,
  rules: StrictSchemaRules
) {
  assertParameterSchema(schema, label, rules);
  return {
    type: "object",
    properties: { [name]: schema },
    required: [name],
    additionalProperties: false,
  };
}
