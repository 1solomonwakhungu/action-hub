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
