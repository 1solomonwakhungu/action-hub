/**
 * Shared isolation for external stress runners (builder-10).
 * Implements /tmp/action-hub-stress/ISOLATION.md: ONE env object per run with
 * every isolation var REPLACED (never inherited) under a fresh temp root,
 * an owner-home escape check, and a sentinel self-check.
 *
 * Fixture paths passed via `overrides` (e.g. ACTION_HUB_CONFIG pointing at
 * stress/.generated/servers.json) are deliberately exempt from the
 * inside-root check — they are run inputs, not inherited state — but they are
 * still checked against the owner home.
 */
import { userInfo } from "node:os";
import { mkdtempSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

const OWNER_HOME_KEYS = new Set(["HOME", "USERPROFILE"]);

function assertOutsideOwnerHome(key, value, resolvedOwner) {
  if (typeof value !== "string" || !(value.includes("/") || value.includes("\\"))) return;
  if (resolve(value).startsWith(resolvedOwner)) {
    throw new Error(`isolation: ${key}=${value} lies inside the owner home; refusing`);
  }
}

/**
 * Builds the isolated env for a run.
 * @param {Record<string, string|undefined>} overrides extra vars (tokens,
 *        fixture config paths, pools) — never inherited values.
 * @returns {{ env: Record<string,string>, root: string }}
 */
export function buildIsolatedEnv(overrides = {}) {
  // Real owner home, independent of $HOME (ISOLATION.md rule).
  const ownerHome = userInfo().homedir || process.env["HOME"] || "";
  if (!ownerHome) throw new Error("cannot determine owner home; refusing to run");
  const resolvedOwner = resolve(ownerHome) + sep;

  const root = mkdtempSync(join(tmpdir(), "ah-stress-iso-"));
  const resolvedRoot = resolve(root) + sep;

  const sandbox = {
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    APPDATA: join(root, "appdata"),
    LOCALAPPDATA: join(root, "localappdata"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: join(root, "data"),
    ACTION_HUB_CACHE: join(root, "cache", "action-hub"),
    ACTION_HUB_SKILLS_DIR: join(root, "skills"),
    ACTION_HUB_DAEMON_DIR: join(root, "daemon"),
    ACTION_HUB_CREDENTIALS: join(root, "credentials"),
    PI_CODING_AGENT_DIR: join(root, "pi"),
    CODEX_HOME: join(root, "codex"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
  };

  // 1. Owner-home refusal for every sandbox var and override.
  for (const [key, value] of Object.entries(sandbox)) {
    if (OWNER_HOME_KEYS.has(key) && resolve(value) === resolve(ownerHome)) {
      throw new Error(`isolation: ${key} resolves to the owner home; refusing`);
    }
    assertOutsideOwnerHome(key, value, resolvedOwner);
  }
  for (const [key, value] of Object.entries(overrides)) {
    assertOutsideOwnerHome(key, value, resolvedOwner);
  }

  // 2. Sentinel self-check: sandbox vars resolve inside the run root.
  for (const [key, value] of Object.entries(sandbox)) {
    if (!resolve(value).startsWith(resolvedRoot)) {
      throw new Error(`isolation: ${key}=${value} escapes the run root ${root}`);
    }
  }

  // 3. ONE env: inherited base, then ALL sandbox vars REPLACE, then overrides.
  const env = { ...process.env, ...sandbox, ...overrides };
  return { env, root };
}
