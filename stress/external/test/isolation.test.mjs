import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIsolatedEnv, assertFinalEnv, SANDBOX_KEYS } from "../isolation.mjs";

test("hostile inherited ACTION_HUB_CONFIG is replaced, never forwarded", () => {
  const hostile = process.env["HOME"]; // any owner path; we assert replacement, not identity
  const previous = process.env["ACTION_HUB_CONFIG"];
  process.env["ACTION_HUB_CONFIG"] = hostile;
  try {
    const { env, root } = buildIsolatedEnv({ ACTION_HUB_HTTP_TOKEN: "tok" });
    assert.notEqual(env["ACTION_HUB_CONFIG"], hostile);
    assert.ok(env["ACTION_HUB_CONFIG"].startsWith(root), "sandbox config must live in the run root");
  } finally {
    if (previous === undefined) delete process.env["ACTION_HUB_CONFIG"];
    else process.env["ACTION_HUB_CONFIG"] = previous;
  }
});

test("the replacement map covers exactly SANDBOX_KEYS (set equality)", () => {
  const { env, root } = buildIsolatedEnv({ ACTION_HUB_HTTP_TOKEN: "tok" });
  // ACTION_HUB_HTTP_TOKEN is an override (not a sandbox var) — exclude extras.
  const envKeys = Object.keys(env).filter((key) => SANDBOX_KEYS.includes(key));
  assert.deepEqual(
    [...envKeys].sort(),
    [...SANDBOX_KEYS].sort(),
    "the built env must contain every isolation var",
  );
  assert.ok(env["ACTION_HUB_CONFIG"].startsWith(root));
  assertFinalEnv(env, root); // must pass with no input overrides
});

test("assertFinalEnv rejects late re-pointing outside the run root", async () => {
  const { env, root } = buildIsolatedEnv({});
  const bad = { ...env, ACTION_HUB_SKILLS_DIR: "/" };
  assert.throws(() => assertFinalEnv(bad, root), /escapes the run root/);
  // Owner app-state refusal still applies.
  const { userInfo } = await import("node:os");
  const ownerState = `${userInfo().homedir}/.cache/action-hub`;
  assert.throws(() => assertFinalEnv({ ...env, ACTION_HUB_SKILLS_DIR: ownerState }, root), /owner app state/);
});
