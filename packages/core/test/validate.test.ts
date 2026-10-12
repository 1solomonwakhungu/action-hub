import assert from "node:assert/strict";
import { test } from "node:test";
import { validateArguments } from "../dist/router/validate.js";

const schema = {
  type: "object",
  properties: {
    owner: { type: "string", minLength: 1 },
    repo: { type: "string" },
    count: { type: "integer", minimum: 1, maximum: 100 },
    state: { type: "string", enum: ["open", "closed"] },
    labels: { type: "array", items: { type: "string" } },
  },
  required: ["owner", "repo"],
};

test("accepts a valid payload", () => {
  const result = validateArguments(schema, {
    owner: "octocat",
    repo: "hello",
    count: 5,
    state: "open",
    labels: ["bug"],
  });
  assert.equal(result.valid, true);
});

test("reports a missing required property", () => {
  const result = validateArguments(schema, { owner: "octocat" });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /arguments\.repo: required/);
});

test("reports a type mismatch", () => {
  const result = validateArguments(schema, { owner: "octocat", repo: 42 });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /expected string, received number/);
});

test("enforces enum membership", () => {
  const result = validateArguments(schema, { owner: "o", repo: "r", state: "merged" });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /must be one of/);
});

test("enforces numeric bounds", () => {
  const result = validateArguments(schema, { owner: "o", repo: "r", count: 0 });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /must be >= 1/);
});

test("validates array item types", () => {
  const result = validateArguments(schema, { owner: "o", repo: "r", labels: ["ok", 7] });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /labels\[1\]: expected string/);
});

test("validates nested objects", () => {
  const nested = {
    type: "object",
    properties: {
      page: {
        type: "object",
        properties: { size: { type: "integer" } },
        required: ["size"],
      },
    },
  };
  assert.equal(validateArguments(nested, { page: { size: 10 } }).valid, true);
  assert.equal(validateArguments(nested, { page: {} }).valid, false);
});

test("rejects unexpected properties only when additionalProperties is false", () => {
  const strict = { type: "object", properties: { a: { type: "string" } }, additionalProperties: false };
  assert.equal(validateArguments(strict, { a: "x", b: "y" }).valid, false);

  const loose = { type: "object", properties: { a: { type: "string" } } };
  assert.equal(validateArguments(loose, { a: "x", b: "y" }).valid, true);
});

test("an absent or empty schema accepts anything", () => {
  assert.equal(validateArguments(undefined, { anything: true }).valid, true);
  assert.equal(validateArguments({}, { anything: true }).valid, true);
});

test("an invalid upstream regex does not fail the call", () => {
  const bad = { type: "object", properties: { s: { type: "string", pattern: "([" } } };
  assert.equal(validateArguments(bad, { s: "whatever" }).valid, true);
});

test("Object.prototype names are neither supplied nor declared properties", () => {
  const strict = { type: "object", properties: { a: { type: "string" } }, additionalProperties: false };
  // Keys that happen to exist on Object.prototype are still unexpected properties.
  const smuggled = validateArguments(
    strict,
    JSON.parse('{"a":"x","constructor":"evil","__proto__":{"polluted":true},"toString":1}'),
  );
  assert.equal(smuggled.valid, false);
  assert.match(smuggled.errors.join(" "), /arguments\.constructor: unexpected property/);
  assert.match(smuggled.errors.join(" "), /arguments\.__proto__: unexpected property/);
  assert.match(smuggled.errors.join(" "), /arguments\.toString: unexpected property/);

  // A required property is not satisfied by an inherited prototype member.
  const required = validateArguments({ type: "object", required: ["constructor"] }, {});
  assert.equal(required.valid, false);
  assert.match(required.errors.join(" "), /arguments\.constructor: required property is missing/);

  // A declared-but-absent property named like a prototype member is simply absent.
  const declared = { type: "object", properties: { constructor: { type: "string" } } };
  assert.equal(validateArguments(declared, {}).valid, true);
  assert.equal(validateArguments(declared, { constructor: "fine" }).valid, true);
  assert.equal(validateArguments(declared, { constructor: 7 }).valid, false);
});

test("additionalProperties: false applies without `properties` and respects patternProperties", () => {
  // No `properties` means no property is allowed.
  const closed = { type: "object", additionalProperties: false };
  assert.equal(validateArguments(closed, {}).valid, true);
  const extra = validateArguments(closed, { x: 1 });
  assert.equal(extra.valid, false);
  assert.match(extra.errors.join(" "), /arguments\.x: unexpected property/);

  // Keys accepted by patternProperties are not "additional".
  const patterned = {
    type: "object",
    properties: { a: { type: "string" } },
    patternProperties: { "^x-": { type: "string" } },
    additionalProperties: false,
  };
  assert.equal(validateArguments(patterned, { a: "ok", "x-foo": "bar" }).valid, true);
  const stray = validateArguments(patterned, { a: "ok", "y-foo": "bar" });
  assert.equal(stray.valid, false);
  assert.match(stray.errors.join(" "), /arguments\.y-foo: unexpected property/);
});

test("string length is measured in code points and patterns run in unicode mode", () => {
  const one = { type: "object", properties: { s: { type: "string", maxLength: 1 } } };
  // A single emoji is one character, not two UTF-16 code units.
  assert.equal(validateArguments(one, { s: "\u{1F600}" }).valid, true);
  assert.equal(validateArguments(one, { s: "ab" }).valid, false);

  const two = { type: "object", properties: { s: { type: "string", minLength: 2 } } };
  assert.equal(validateArguments(two, { s: "\u{1F600}" }).valid, false);
  assert.equal(validateArguments(two, { s: "\u{1F600}\u{1F600}" }).valid, true);

  // `\p{L}` is a property escape, not the literal text "p{L}".
  const letters = { type: "object", properties: { s: { type: "string", pattern: "^\\p{L}+$" } } };
  assert.equal(validateArguments(letters, { s: "abc" }).valid, true);
  assert.equal(validateArguments(letters, { s: "ab1" }).valid, false);

  // A pattern that is only valid outside unicode mode still works.
  const legacy = { type: "object", properties: { s: { type: "string", pattern: "^[\\-a-z]+$" } } };
  assert.equal(validateArguments(legacy, { s: "a-b" }).valid, true);
  assert.equal(validateArguments(legacy, { s: "A" }).valid, false);
});

test("type unions are enforced, including the nullable form", () => {
  const nullable = { type: "object", properties: { s: { type: ["string", "null"] } } };
  assert.equal(validateArguments(nullable, { s: "ok" }).valid, true);
  assert.equal(validateArguments(nullable, { s: null }).valid, true);
  assert.equal(validateArguments(nullable, {}).valid, true);
  const wrong = validateArguments(nullable, { s: 42 });
  assert.equal(wrong.valid, false);
  assert.match(wrong.errors.join(" "), /arguments\.s: expected string \| null, received number/);

  // null is rejected when the union does not include it.
  const numeric = { type: "object", properties: { n: { type: ["integer", "string"] } } };
  assert.equal(validateArguments(numeric, { n: 3 }).valid, true);
  assert.equal(validateArguments(numeric, { n: "3" }).valid, true);
  assert.equal(validateArguments(numeric, { n: 1.5 }).valid, false);
  assert.equal(validateArguments(numeric, { n: null }).valid, false);

  // The matched member's own constraints apply: a nullable object still has required keys.
  const nested = {
    type: "object",
    properties: {
      page: { type: ["object", "null"], properties: { size: { type: "integer" } }, required: ["size"] },
    },
  };
  assert.equal(validateArguments(nested, { page: null }).valid, true);
  assert.equal(validateArguments(nested, { page: { size: 1 } }).valid, true);
  const missing = validateArguments(nested, { page: {} });
  assert.equal(missing.valid, false);
  assert.match(missing.errors.join(" "), /arguments\.page\.size: required property is missing/);

  // Array items with a union type.
  const items = { type: "object", properties: { m: { type: "array", items: { type: ["string", "null"] } } } };
  assert.equal(validateArguments(items, { m: ["a", null] }).valid, true);
  assert.equal(validateArguments(items, { m: ["a", 1] }).valid, false);
});
