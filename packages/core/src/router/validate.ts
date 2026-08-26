import type { JsonSchema } from "../types.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates arguments against the upstream JSON Schema.
 *
 * This covers the subset of JSON Schema that MCP tool definitions actually
 * use in practice: object shape, required properties, primitive types, enums,
 * numeric and length bounds, arrays, and nested objects. Anything unrecognized
 * is passed through rather than rejected — Action Hub's job is to catch
 * obvious model mistakes early, not to re-litigate the upstream contract.
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
  const type = schema["type"];

  if (value === undefined || value === null) {
    // Presence is enforced by the parent's `required` list; a null here is
    // only an error when the schema names a concrete type.
    if (typeof type === "string" && type !== "null" && value === null) {
      errors.push(`${path}: expected ${type}, received null`);
    }
    return;
  }

  if (typeof type === "string" && !matchesType(type, value)) {
    errors.push(`${path}: expected ${type}, received ${describe(value)}`);
    return;
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

  const required = schema["required"];
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key === "string" && value[key] === undefined) {
        errors.push(`${path}.${key}: required property is missing`);
      }
    }
  }

  const properties = schema["properties"];
  if (isPlainObject(properties)) {
    for (const [key, child] of Object.entries(properties)) {
      if (value[key] === undefined) continue;
      if (isPlainObject(child)) {
        validateNode(child as JsonSchema, value[key], `${path}.${key}`, errors);
      }
    }

    if (schema["additionalProperties"] === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          errors.push(`${path}.${key}: unexpected property`);
        }
      }
    }
  }
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
  const minLength = schema["minLength"];
  if (typeof minLength === "number" && value.length < minLength) {
    errors.push(`${path}: must be at least ${minLength} character(s)`);
  }
  const maxLength = schema["maxLength"];
  if (typeof maxLength === "number" && value.length > maxLength) {
    errors.push(`${path}: must be at most ${maxLength} character(s)`);
  }
  const pattern = schema["pattern"];
  if (typeof pattern === "string") {
    let regex: RegExp | undefined;
    try {
      regex = new RegExp(pattern);
    } catch {
      // An upstream schema with an invalid pattern should not fail the call.
      regex = undefined;
    }
    if (regex && !regex.test(value)) {
      errors.push(`${path}: must match pattern ${pattern}`);
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
