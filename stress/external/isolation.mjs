/**
 * Shared isolation for external stress runners (builder-10).
 * Implements /tmp/action-hub-stress/ISOLATION.md (rev 21:27Z): ONE env object
 * per run with every isolation var REPLACED (never inherited) under a fresh
 * temp root, owner app-state/harness escape refusal (NOT whole-home), a
 * separator-safe sentinel self-check, and a final-env validator for late
 * mutations (call assertFinalEnv right before spawning).
 *
 * Fixture paths passed via `overrides` (e.g. ACTION_HUB_CONFIG pointing at
 * stress/.generated/servers.json) are run inputs, not inherited state; they
 * are still checked against owner app-state locations.
 */
import { userInfo, tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Owner locations a run must never touch. Separator-safe containment. */
function insideOwnerAppState(candidate) {
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
  // APPDATA/LOCALAPPDATA action-hub dirs (real env values when present).
  for (const key of ["APPDATA", "LOCALAPPDATA"]) {
    const base = process.env[key];
    if (base) guarded.push(join(resolve(base), "action-hub"));
  }
  const abs = resolve(String(candidate));
  for (const guard of guarded) {
    const rel = relative(guard, abs);
    if (rel === "" || (!isAbsolute(rel) && !rel.startsWith("..") && rel !== "" ? true : false) && rel !== ".." && !isAbsolute(rel)) {
      if (rel === "" || (!isAbsolute(rel) && rel.split("..").length === 1)) return guard;
    }
  }
  return null;
}

function containedIn(root, candidate) {
  const rel = relative(resolve(root), resolve(String(candidate)));
  return rel === "" || (!isAbsolute(rel) && !rel.split(/[\\/]/).includes(".."));
}

/**
 * Builds the isolated env for a run.
 * @param {Record<string, string|undefined>} overrides extra vars (tokens,
 *        fixture config paths, pools) — never inherited values.
 * @returns {{ env: Record<string,string>, root: string }}
 */
export function buildIsolatedEnv(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "ah-stress-iso-"));

  const sandbox = {
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    APPDATA: join(root, "appdata"),
    LOCALAPPDATA: join(root, "localappdata"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: join(root, "data"),
    // File-shaped vars get FILE paths, not directories.
    ACTION_HUB_CACHE: join(root, "cache", "action-hub.json"),
    ACTION_HUB_CREDENTIALS: join(root, "credentials.json"),
    ACTION_HUB_CONTROL: join(root, "control.json"),
    ACTION_HUB_SKILLS_DIR: join(root, "skills"),
    ACTION_HUB_DAEMON_DIR: join(root, "daemon"),
    PI_CODING_AGENT_DIR: join(root, "pi"),
    CODEX_HOME: join(root, "codex"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
  };

  // 1. Owner app-state refusal for sandbox vars and overrides.
  for (const value of [...Object.values(sandbox), ...Object.values(overrides)]) {
    if (typeof value !== "string") continue;
    const hit = insideOwnerAppState(value);
    if (hit) throw new Error(`isolation: ${value} lies inside owner app state ${hit}; refusing`);
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
  const sandboxKeys = [
    "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME",
    "ACTION_HUB_CACHE", "ACTION_HUB_SKILLS_DIR", "ACTION_HUB_DAEMON_DIR",
    "ACTION_HUB_CREDENTIALS", "ACTION_HUB_CONTROL", "PI_CODING_AGENT_DIR",
    "CODEX_HOME", "CLAUDE_CONFIG_DIR",
  ];
  for (const key of sandboxKeys) {
    const value = env[key];
    if (typeof value !== "string" || value.length === 0) continue;
    const hit = insideOwnerAppState(value);
    if (hit) throw new Error(`isolation: final ${key}=${value} lies inside owner app state ${hit}`);
    if (inputKeys.has(key)) continue; // fixture input, checked below
    if (!containedIn(root, value)) {
      throw new Error(`isolation: final ${key}=${value} escapes the run root ${root}`);
    }
  }
  // Fixture input vars (config, skills dir, ...) are refused inside owner
  // app state but allowed outside the run root.
  for (const key of inputKeys) {
    const value = env[key];
    if (typeof value !== "string" || value.length === 0) continue;
    const hit = insideOwnerAppState(value);
    if (hit) throw new Error(`isolation: final ${key}=${value} lies inside owner app state ${hit}`);
  }
}
