import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LOAD_DESCRIPTION_MAX_BYTES,
  LOAD_SCHEMA_MAX_BYTES,
  SEARCH_SUMMARY_MAX_BYTES,
  SKILL_INSTRUCTIONS_MAX_BYTES,
  hardenSchema,
  hardenText,
} from "../dist/output-hardening.js";

test("search summaries are capped, marked, and secret-redacted", () => {
  const hostile = `use key sk-proj-abc123def456ghi789 to connect ${"x".repeat(SEARCH_SUMMARY_MAX_BYTES + 5000)}`;
  const out = hardenText(hostile, SEARCH_SUMMARY_MAX_BYTES);
  assert.ok(Buffer.byteLength(out, "utf8") <= SEARCH_SUMMARY_MAX_BYTES + 100); // marker overhead
  assert.match(out, /\[truncated by action_hub: dropped \d+ bytes\]/);
  assert.doesNotMatch(out, /sk-proj-abc123def456ghi789/);
  assert.match(out, /\[redacted\]/);
  // Non-secret text and hashes survive.
  const ordinary = hardenText(`sha256 digest ${"a3f9c2".repeat(8)} end`, SEARCH_SUMMARY_MAX_BYTES);
  assert.match(ordinary, /a3f9c2a3f9c2/);
});

test("load output caps description, serialized schema, and skill instructions", () => {
  const bigDescription = "d".repeat(LOAD_DESCRIPTION_MAX_BYTES + 4096);
  const out = hardenText(bigDescription, LOAD_DESCRIPTION_MAX_BYTES);
  assert.match(out, /\[truncated by action_hub: dropped 40\d\d bytes\]/);
  assert.ok(Buffer.byteLength(out, "utf8") <= LOAD_DESCRIPTION_MAX_BYTES + 100);

  const skillBody = "s".repeat(SKILL_INSTRUCTIONS_MAX_BYTES + 4096);
  const skillOut = hardenText(skillBody, SKILL_INSTRUCTIONS_MAX_BYTES);
  assert.match(skillOut, /\[truncated by action_hub: dropped 40\d\d bytes\]/);

  // Schemas below the limit stay objects; hostile ones become marked JSON strings.
  const small = { type: "object", properties: { a: { type: "string" } } };
  assert.equal(hardenSchema(small, LOAD_SCHEMA_MAX_BYTES), small);
  const hostile = {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 5000 }, (_, i) => [`prop_${i}`, { type: "string", description: "y".repeat(64) }]),
    ),
  };
  const serialized = hardenSchema(hostile, LOAD_SCHEMA_MAX_BYTES);
  assert.equal(typeof serialized, "string");
  assert.match(serialized as string, /\[truncated by action_hub: dropped \d+ bytes\]/);
  assert.ok(Buffer.byteLength(serialized as string, "utf8") <= LOAD_SCHEMA_MAX_BYTES + 100);
});
