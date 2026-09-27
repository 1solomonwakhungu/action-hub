import assert from "node:assert/strict";
import { test } from "node:test";
import { userInfo } from "node:os";
import { existsSync, readdirSync } from "node:fs";
import { buildIsolatedEnv, assertFinalEnv, SANDBOX_KEYS } from "../isolation.mjs";

// Independent literal checklist (R7): NOT derived from SANDBOX_KEYS, so a key
// dropped from the builder fails this test even if SANDBOX_KEYS is edited to
// match.
const LITERAL_CHECKLIST = [
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TMP", "TEMP",
  "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME",
  "ACTION_HUB_CONFIG", "ACTION_HUB_CACHE", "ACTION_HUB_SKILLS_DIR",
  "ACTION_HUB_DAEMON_DIR", "ACTION_HUB_CREDENTIALS", "ACTION_HUB_CONTROL",
  "PI_CODING_AGENT_DIR", "CODEX_HOME", "CLAUDE_CONFIG_DIR",
];

test("literal isolation checklist: every var replaced and inside the run root", () => {
  const previous = { ...process.env };
  try {
    // Hostile inherited values everywhere; none may survive. The temp-base
    // trio is excluded: a hostile temp base inside owner state is refused
    // PRE-WRITE by the shared lib (stricter than the pre-MIG2 module, which
    // allowed a whole-home base) — that refusal is test 4's subject.
    for (const key of LITERAL_CHECKLIST) {
      if (key === "TMPDIR" || key === "TMP" || key === "TEMP") continue;
      process.env[key] = previous["HOME"];
    }
    const { env, root } = buildIsolatedEnv({ ACTION_HUB_HTTP_TOKEN: "tok" });
    for (const key of LITERAL_CHECKLIST) {
      assert.ok(typeof env[key] === "string" && env[key].length > 0, `${key} must be replaced`);
      assert.notEqual(env[key], previous["HOME"], `${key} must not forward the hostile value`);
      assert.ok(
        env[key].startsWith(root),
        `${key}=${env[key]} must live inside the run root ${root}`,
      );
    }
    assert.notEqual(env["ACTION_HUB_CONFIG"], env["ACTION_HUB_SKILLS_DIR"]);
  } finally {
    for (const key of LITERAL_CHECKLIST) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("hostile inherited ACTION_HUB_CONFIG is replaced, never forwarded", () => {
  const hostile = process.env["HOME"];
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

test("the built env covers SANDBOX_KEYS exactly and passes assertFinalEnv", () => {
  const { env, root } = buildIsolatedEnv({ ACTION_HUB_HTTP_TOKEN: "tok" });
  const envKeys = Object.keys(env).filter((key) => SANDBOX_KEYS.includes(key));
  assert.deepEqual([...envKeys].sort(), [...SANDBOX_KEYS].sort());
  assertFinalEnv(env, root); // must pass with no input overrides
});

test("hostile temp base is refused BEFORE any write", () => {
  const { homedir } = userInfo();
  const hostileTmp = `${homedir}/.cache/action-hub/tmp`;
  const previous = process.env["TMPDIR"];
  process.env["TMPDIR"] = hostileTmp;
  try {
    assert.throws(() => buildIsolatedEnv({}), /owner app state/);
    // Pre-write guarantee: the refused base must not gain a sandbox dir.
    // F36 fix: a literal existsSync("<base>/ah-stress-iso-") misses the
    // mkdtemp-SUFFIXED directory names — scan the base for the prefix.
    if (existsSync(hostileTmp)) {
      const litter = readdirSync(hostileTmp).filter((name) => name.startsWith("ah-stress-iso-"));
      assert.deepEqual(litter, [], "no sandbox dir (prefixed or suffixed) may be created inside the hostile temp base");
    }
  } finally {
    if (previous === undefined) delete process.env["TMPDIR"];
    else process.env["TMPDIR"] = previous;
  }
});

test("dotted descendants of owner app state are refused (segment-safe containment)", async () => {
  const { homedir } = userInfo();
  // An ordinary segment containing '..' is NOT a traversal; containment must
  // treat it as a normal name and REFUSE the path as owner state.
  const dotted = `${homedir}/.cache/action-hub/foo..bar/servers.json`;
  const { env, root } = buildIsolatedEnv({ ACTION_HUB_HTTP_TOKEN: "tok" });
  assert.throws(
    () => assertFinalEnv({ ...env, ACTION_HUB_CONFIG: dotted }, root, new Set(["ACTION_HUB_CONFIG"])),
    /owner app state/,
  );
});

test("assertFinalEnv rejects late re-pointing outside the run root", async () => {
  const { env, root } = buildIsolatedEnv({});
  const bad = { ...env, ACTION_HUB_SKILLS_DIR: "/" };
  assert.throws(() => assertFinalEnv(bad, root), /escapes the run root/);
  const ownerState = `${userInfo().homedir}/.cache/action-hub`;
  assert.throws(() => assertFinalEnv({ ...env, ACTION_HUB_SKILLS_DIR: ownerState }, root), /owner app state/);
});
