import type { JsonSchema } from "../types.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates arguments against the upstream JSON Schema.
 *
 * This covers the subset of JSON Schema that MCP tool definitions actually
 * use in practice: object shape, required properties, primitive types and
 * type unions (`["string", "null"]`), enums, numeric and length bounds,
 * arrays, and nested objects. Anything unrecognized — `$ref`, `oneOf` /
 * `anyOf` / `allOf`, `const`, formats — is passed through rather than
 * rejected (fail open) — Action Hub's job is to catch obvious model mistakes
 * early, not to re-litigate the upstream contract.
 */
export function validateArguments(schema: JsonSchema | undefined, args: unknown): ValidationResult {
  if (!schema || Object.keys(schema).length === 0) {
    return { valid: true, errors: [] };
  }
  const errors: string[] = [];
  validateNode(schema, args, "arguments", errors);
  return { valid: errors.length === 0, errors };
}

function validateNode(schema: JsonSchema, value: unknown, path: string, errors: string[]): void {
  const declared = schema["type"];
  // `type` may be a union (`["string", "null"]` is the common nullable form).
  // A union is resolved to the member the value matches, so the rest of the
  // checks run against a concrete type instead of being skipped.
  const union = Array.isArray(declared)
    ? declared.filter((candidate): candidate is string => typeof candidate === "string")
    : undefined;

  if (value === undefined || value === null) {
    // Presence is enforced by the parent's `required` list; a null here is
    // only an error when the schema names a concrete type.
    if (typeof declared === "string" && declared !== "null" && value === null) {
      errors.push(`${path}: expected ${declared}, received null`);
    } else if (union && union.length > 0 && !union.includes("null") && value === null) {
      errors.push(`${path}: expected ${union.join(" | ")}, received null`);
    }
    return;
  }

  let type: string | undefined;
  if (typeof declared === "string") {
    type = declared;
    if (!matchesType(type, value)) {
      errors.push(`${path}: expected ${type}, received ${describe(value)}`);
      return;
    }
  } else if (union && union.length > 0) {
    type = union.find((candidate) => matchesType(candidate, value));
    if (type === undefined) {
      errors.push(`${path}: expected ${union.join(" | ")}, received ${describe(value)}`);
      return;
    }
  }

  const enumValues = schema["enum"];
  if (Array.isArray(enumValues) && !enumValues.some((candidate) => candidate === value)) {
    errors.push(`${path}: must be one of ${enumValues.map((v) => JSON.stringify(v)).join(", ")}`);
  }

  if (type === "object" || (!type && isPlainObject(value))) {
    validateObject(schema, value, path, errors);
  }

  if (type === "array" && Array.isArray(value)) {
    validateArray(schema, value, path, errors);
  }

  if ((type === "number" || type === "integer") && typeof value === "number") {
    validateNumber(schema, value, path, errors);
  }

  if (type === "string" && typeof value === "string") {
    validateString(schema, value, path, errors);
  }
}

function validateObject(schema: JsonSchema, value: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`${path}: expected object, received ${describe(value)}`);
    return;
  }

  // Own-property lookups throughout: arguments arrive as plain objects, so a
  // bare `value[key]` / `key in` would see `constructor`, `toString`, ... on
  // Object.prototype and mistake them for supplied (or declared) properties.
  const required = schema["required"];
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key === "string" && !hasOwnValue(value, key)) {
        errors.push(`${path}.${key}: required property is missing`);
      }
    }
  }

  const properties = schema["properties"];
  if (isPlainObject(properties)) {
    for (const [key, child] of Object.entries(properties)) {
      if (!hasOwnValue(value, key)) continue;
      if (isPlainObject(child)) {
        validateNode(child as JsonSchema, value[key], `${path}.${key}`, errors);
      }
    }
  }

  // `additionalProperties: false` applies whether or not `properties` is
  // declared (no `properties` means no property is allowed), and never to a
  // key that `patternProperties` accepts.
  if (schema["additionalProperties"] === false) {
    const patterns = compilePatternProperties(schema["patternProperties"]);
    for (const key of Object.keys(value)) {
      if (isPlainObject(properties) && Object.hasOwn(properties, key)) continue;
      if (patterns.some((pattern) => pattern.test(key))) continue;
      errors.push(`${path}.${key}: unexpected property`);
    }
  }
}

function hasOwnValue(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key) && value[key] !== undefined;
}

function compilePatternProperties(patternProperties: unknown): RegExp[] {
  if (!isPlainObject(patternProperties)) return [];
  const compiled: RegExp[] = [];
  for (const pattern of Object.keys(patternProperties)) {
    const regex = compilePattern(pattern);
    if (regex) compiled.push(regex);
  }
  return compiled;
}

function validateArray(schema: JsonSchema, value: unknown[], path: string, errors: string[]): void {
  const minItems = schema["minItems"];
  if (typeof minItems === "number" && value.length < minItems) {
    errors.push(`${path}: expected at least ${minItems} item(s), received ${value.length}`);
  }
  const maxItems = schema["maxItems"];
  if (typeof maxItems === "number" && value.length > maxItems) {
    errors.push(`${path}: expected at most ${maxItems} item(s), received ${value.length}`);
  }
  const items = schema["items"];
  if (isPlainObject(items)) {
    value.forEach((entry, index) => {
      validateNode(items as JsonSchema, entry, `${path}[${index}]`, errors);
    });
  }
}

function validateNumber(schema: JsonSchema, value: number, path: string, errors: string[]): void {
  const minimum = schema["minimum"];
  if (typeof minimum === "number" && value < minimum) {
    errors.push(`${path}: must be >= ${minimum}`);
  }
  const maximum = schema["maximum"];
  if (typeof maximum === "number" && value > maximum) {
    errors.push(`${path}: must be <= ${maximum}`);
  }
}

function validateString(schema: JsonSchema, value: string, path: string, errors: string[]): void {
  // JSON Schema measures string length in Unicode code points, not UTF-16
  // code units: a single emoji is one character.
  const length = codePointLength(value);
  const minLength = schema["minLength"];
  if (typeof minLength === "number" && length < minLength) {
    errors.push(`${path}: must be at least ${minLength} character(s)`);
  }
  const maxLength = schema["maxLength"];
  if (typeof maxLength === "number" && length > maxLength) {
    errors.push(`${path}: must be at most ${maxLength} character(s)`);
  }
  const pattern = schema["pattern"];
  if (typeof pattern === "string") {
    const regex = compilePattern(pattern);
    if (regex && !regex.test(value)) {
      errors.push(`${path}: must match pattern ${pattern}`);
    }
  }
}

function codePointLength(value: string): number {
  let length = 0;
  for (const _ of value) length += 1;
  return length;
}

/**
 * JSON Schema patterns are ECMA-262 regular expressions interpreted in
 * Unicode mode, so `\p{L}` is a property escape rather than the literal text
 * "p{L}". Patterns that are only valid without the flag (legacy identity
 * escapes) fall back to the default mode. An upstream schema with an invalid
 * pattern should not fail the call.
 */
function compilePattern(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern, "u");
  } catch {
    try {
      return new RegExp(pattern);
    } catch {
      return undefined;
    }
  }
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
