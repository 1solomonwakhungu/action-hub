/**
 * Shared isolation for external stress runners — DELEGATED to the shared lib
 * (packet MIG2: one isolation implementation, single source of truth).
 *
 * The previous standalone implementation (20-var replace-under-fresh-root,
 * owner app-state refusal, hostile-temp-base pre-write refusal, final-env
 * validation) is now provided by stress/lib/harness.mjs. This module keeps
 * the EXACT public API the runners and tests already import:
 *   SANDBOX_KEYS, containedIn(dir, candidate),
 *   buildIsolatedEnv(overrides) -> { env, root, assertFinal },
 *   assertFinalEnv(env, root, inputKeys)
 * so no runner call site changes shape.
 *
 * Message contract (test regexes depend on it): refusals say
 * "lies inside owner app state".
 */
import { mkdirSync } from "node:fs";
import {
  ISOLATION_VARS,
  createSandbox,
  pathContains,
  refusedInsideOwnerState,
} from "../lib/harness.mjs";

/** Every isolation var the builder replaces — derived from the lib table. */
export const SANDBOX_KEYS = ISOLATION_VARS.map((v) => v.name);

/** Segment-safe containment (path.relative, no string prefixes) — lib impl. */
export function containedIn(dir, candidate) {
  return pathContains(dir, candidate);
}

/**
 * Builds the isolated env for a run: every SANDBOX_KEY REPLACED (never
 * inherited) under a fresh lib run root; the hostile temp base is refused
 * pre-write by the lib; owner app-state refusals cover sandbox vars AND the
 * caller's overrides (fixture inputs like the generated config or skills
 * dir: never owner state, may live outside the root).
 *
 * Every directory the final env declares is pre-created so children (and
 * their own mkdtemp calls under TMPDIR/TMP/TEMP) never hit ENOENT.
 *
 * @param {Record<string, string|undefined>} overrides fixture inputs
 * @returns {{ env: Record<string,string>, root: string, assertFinal: (e) => void }}
 */
export function buildIsolatedEnv(overrides = {}) {
  // Refuse overrides inside owner app state BEFORE creating anything.
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (refusedInsideOwnerState(String(value))) {
      throw new Error(`isolation: ${key}=${value} lies inside owner app state; refusing`);
    }
  }
  let sandboxResult;
  try {
    sandboxResult = createSandbox({ prefix: "ah-stress-iso-" });
  } catch (err) {
    // Message contract (test regexes): the lib's hostile-temp-base refusal
    // says "inside owner state dir"; re-wrap as "owner app state" so the
    // external suite's assertions keep their wording. Behavior unchanged:
    // the lib refuses the base BEFORE any filesystem write.
    const msg = String((err && err.message) || err);
    if (msg.includes("inside owner state")) {
      throw new Error(msg.replace(" is inside owner state dir", " lies inside owner app state"));
    }
    throw err;
  }
  const { root, env: sandboxEnv } = sandboxResult;

  // Pre-create every directory the sandbox declares (dir-shaped vars only).
  for (const { name, shape } of ISOLATION_VARS) {
    const value = sandboxEnv[name];
    if (shape !== "file" && typeof value === "string" && value.length > 0) {
      mkdirSync(value, { recursive: true });
    }
  }

  // Fixture inputs override sandbox defaults LAST (they are run INPUTS).
  const env = { ...sandboxEnv };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) env[key] = value;
  }
  const inputKeys = new Set(Object.keys(overrides).filter((k) => overrides[k] !== undefined));
  const assertFinal = (e) => assertFinalEnv(e, root, inputKeys);
  assertFinal(env);
  return { env, root, assertFinal };
}

/**
 * Re-validates the FINAL env after any late mutation (e.g. adopting the
 * generator's fresh config path). Call immediately before spawning.
 */
export function assertFinalEnv(env, root, inputKeys = new Set()) {
  for (const key of SANDBOX_KEYS) {
    const value = env[key];
    if (typeof value !== "string" || value.length === 0) continue;
    if (refusedInsideOwnerState(value)) {
      throw new Error(`isolation: final ${key}=${value} lies inside owner app state; refusing`);
    }
    if (inputKeys.has(key)) continue; // fixture input: owner-state checked, may live outside the root
    if (!pathContains(root, value)) {
      throw new Error(`isolation: final ${key}=${value} escapes the run root ${root}`);
    }
  }
}
