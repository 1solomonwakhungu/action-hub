import assert from "node:assert/strict";
import test from "node:test";
import { validateMutationRequest } from "./request-security.mjs";

const token = "a".repeat(64);
const valid = {
  host: "127.0.0.1:43210",
  origin: "http://127.0.0.1:43210",
  "content-type": "application/json",
  "x-action-hub-canvas-token": token,
};

test("rejects a mutation with no canvas token", () => {
  assert.equal(validateMutationRequest({ headers: { ...valid, "x-action-hub-canvas-token": undefined } }, token)?.status, 401);
});

test("rejects a mutation with the wrong canvas token", () => {
  assert.equal(validateMutationRequest({ headers: { ...valid, "x-action-hub-canvas-token": "b".repeat(64) } }, token)?.status, 401);
});

test("rejects a mutation from a foreign origin", () => {
  assert.equal(validateMutationRequest({ headers: { ...valid, origin: "https://attacker.example" } }, token)?.status, 403);
});

test("rejects a text/plain mutation", () => {
  assert.equal(validateMutationRequest({ headers: { ...valid, "content-type": "text/plain" } }, token)?.status, 415);
});

test("accepts an authorized same-origin JSON mutation", () => {
  assert.equal(validateMutationRequest({ headers: valid }, token), null);
});
