/**
 * Shared isolation for external stress runners (builder-10).
 * Implements /tmp/action-hub-stress/ISOLATION.md (rev 21:27Z + R6/R7 bars):
 * ONE env object per run with every isolation var REPLACED (never inherited)
 * under a fresh temp root; owner app-state/harness escape refusal (NOT
 * whole-home) using segment-safe path.relative containment; the temp base is
 * refused BEFORE any filesystem write; a sentinel self-check over the final
 * values; and a final-env validator for late mutations.
 *
 * Fixture paths passed via `overrides` (e.g. ACTION_HUB_CONFIG pointing at
 * stress/.generated/servers.json) are run inputs, not inherited state; they
 * are still checked against owner app-state locations.
 */
import { userInfo, tmpdir } from "node:os";
import { mkdirSync, mkdtempSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Every isolation var the builder replaces. assertFinalEnv checks exactly these. */
export const SANDBOX_KEYS = [
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TMP", "TEMP",
  "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME",
  "ACTION_HUB_CONFIG", "ACTION_HUB_CACHE", "ACTION_HUB_SKILLS_DIR",
  "ACTION_HUB_DAEMON_DIR", "ACTION_HUB_CREDENTIALS", "ACTION_HUB_CONTROL",
  "PI_CODING_AGENT_DIR", "CODEX_HOME", "CLAUDE_CONFIG_DIR",
];

/**
 * Segment-safe containment: `candidate` is inside `dir` only when the
 * relative path is empty or a relative path with no '..' segment. Never a
 * string-prefix comparison.
 */
export function containedIn(dir, candidate) {
  const rel = relative(resolve(dir), resolve(String(candidate)));
  return rel === "" || (!isAbsolute(rel) && !rel.split(/[\\/]/).includes(".."));
}

/** Owner locations a run must never touch (deterministic list + env-derived). */
function ownerAppStateDirs() {
  const ownerHome = userInfo().homedir || process.env["HOME"] || "";
  if (!ownerHome) throw new Error("cannot determine owner home; refusing to run");
  const home = resolve(ownerHome);
  const guarded = [
    join(home, ".cache", "action-hub"),
    join(home, ".config", "action-hub"),
    join(home, ".action-hub"),
    join(home, "Library", "Caches", "action-hub"),
    join(home, "Library", "Application Support", "action-hub"),
    // Harness config dirs (prefix matches: ~/.claude, ~/.claude.json, ...)
    join(home, ".claude"),
    join(home, ".claude.json"),
    join(home, ".codex"),
    join(home, ".cursor"),
    join(home, ".copilot"),
    join(home, ".pi"),
  ];
  // APPDATA/LOCALAPPDATA action-hub dirs (real inherited values when present).
  for (const key of ["APPDATA", "LOCALAPPDATA"]) {
    const base = process.env[key];
    if (base) guarded.push(join(resolve(base), "action-hub"));
  }
  return guarded;
}

/** Returns the owner location containing `candidate`, or null. */
function insideOwnerAppState(candidate) {
  if (typeof candidate !== "string") return null;
  const abs = resolve(candidate);
  for (const guard of ownerAppStateDirs()) {
    if (containedIn(guard, abs)) return guard;
  }
  return null;
}

/** Throws when `candidate` lies inside owner app state. */
function refuseOwnerState(label, candidate) {
  const hit = insideOwnerAppState(candidate);
  if (hit) throw new Error(`isolation: ${label}=${candidate} lies inside owner app state ${hit}; refusing`);
}

/**
 * Builds the isolated env for a run.
 * @param {Record<string, string|undefined>} overrides extra vars (tokens,
 *        fixture config paths, pools) — never inherited values.
 * @returns {{ env: Record<string,string>, root: string }}
 */
export function buildIsolatedEnv(overrides = {}) {
  // Refuse a hostile temp base BEFORE creating anything in it: a hostile
  // inherited TMPDIR must not cause a write inside owner app state.
  const base = tmpdir();
  refuseOwnerState("os.tmpdir()", base);
  const root = mkdtempSync(join(base, "ah-stress-iso-"));
  const tmp = join(root, "tmp");

  const sandboxPaths = {
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    APPDATA: join(root, "appdata"),
    LOCALAPPDATA: join(root, "localappdata"),
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: join(root, "data"),
    // File-shaped vars get FILE paths, not directories.
    ACTION_HUB_CACHE: join(root, "cache", "action-hub.json"),
    ACTION_HUB_CONFIG: join(root, "config", "servers.json"),
    ACTION_HUB_CREDENTIALS: join(root, "credentials.json"),
    ACTION_HUB_CONTROL: join(root, "control.json"),
    ACTION_HUB_SKILLS_DIR: join(root, "skills"),
    ACTION_HUB_DAEMON_DIR: join(root, "daemon"),
    PI_CODING_AGENT_DIR: join(root, "pi"),
    CODEX_HOME: join(root, "codex"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
  };
  const sandbox = Object.fromEntries(SANDBOX_KEYS.map((key) => [key, sandboxPaths[key]]));

  // 1. Owner app-state refusal for sandbox vars and overrides.
  for (const [key, value] of Object.entries(sandbox)) {
    if (key === "HOME" || key === "USERPROFILE") {
      if (resolve(value) === resolve(userInfo().homedir)) {
        throw new Error(`isolation: ${key} resolves to the owner home; refusing`);
      }
    }
    refuseOwnerState(key, value);
  }
  for (const [key, value] of Object.entries(overrides)) {
    refuseOwnerState(key, value);
  }

  // 1b. Create every directory the sandbox declares so children (and their
  // own mkdtemp calls under TMPDIR/TMP/TEMP) never hit ENOENT.
  for (const key of ["HOME", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TMP", "TEMP", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "ACTION_HUB_SKILLS_DIR", "ACTION_HUB_DAEMON_DIR", "PI_CODING_AGENT_DIR", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]) {
    mkdirSync(sandbox[key], { recursive: true });
  }

  // 2. ONE env: inherited base, then ALL sandbox vars REPLACE, then overrides.
  const env = { ...process.env, ...sandbox, ...overrides };
  // Keys provided as overrides are fixture INPUTS (e.g. the generated config
  // or skills dir): they may live outside the fresh root, but never inside
  // owner app state. Everything else must resolve inside the root.
  const inputKeys = new Set(Object.keys(overrides));
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
    refuseOwnerState(`final ${key}`, value);
    if (inputKeys.has(key)) continue; // fixture input, checked below
    if (!containedIn(root, value)) {
      throw new Error(`isolation: final ${key}=${value} escapes the run root ${root}`);
    }
  }
  // Fixture input vars (config, skills dir, ...) are refused inside owner
  // app state but may live outside the run root; sandbox defaults for the
  // same keys have already been checked above.
}
