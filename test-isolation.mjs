// Test-process isolation preload (F20, per /tmp/action-hub-stress/ISOLATION.md).
//
// Wire into every test runner invocation:
//   node --import <repo-root>/test-isolation.mjs --test ...
//
// Before any test module loads, this module points EVERY path-bearing
// environment variable of the isolation checklist at a fresh per-process temp
// root (the "run root"), replacing inherited values — never trusting them —
// so no test or child process can persist state into the real user's
// app-state or harness config locations.
//
// Checklist (ISOLATION.md): HOME, USERPROFILE, APPDATA, LOCALAPPDATA,
// XDG_CACHE_HOME, XDG_CONFIG_HOME, XDG_STATE_HOME, XDG_DATA_HOME,
// ACTION_HUB_CONFIG, ACTION_HUB_CACHE, ACTION_HUB_SKILLS_DIR,
// ACTION_HUB_DAEMON_DIR, ACTION_HUB_CREDENTIALS, ACTION_HUB_CONTROL,
// PI_CODING_AGENT_DIR, CODEX_HOME, CLAUDE_CONFIG_DIR, plus the OS temp
// location (TMPDIR/TMP/TEMP) for descendants.
//
// Order of operations:
//   1. Derive the real owner home independently of $HOME (os.userInfo()).
//   2. Run the incoming-value refusal against owner app-state/harness dirs
//      BEFORE any directory is created — including a hostile TMPDIR/TMP/TEMP,
//      which is itself an owner app-state write target.
//   3. Only then create the run root under the (validated) OS temp location.
//   4. Assign all checklist values into the run root and validate the FINAL
//      values after assignment.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

// --- 1. Real owner home (passwd-derived, independent of $HOME). -------------
function passwdHome() {
  try {
    const dir = userInfo().homedir;
    if (dir && dir.trim().length > 0) return dir;
  } catch {
    // userInfo can throw in exotic environments; fall through.
  }
  return process.env["USERPROFILE"] ?? process.env["HOME"] ?? homedir() ?? "";
}

const realHome = resolve(process.env["ACTION_HUB_TEST_REAL_HOME"] || passwdHome());
const realAppData = resolve(process.env["APPDATA"] ?? join(realHome, "AppData", "Roaming"));
const realLocalAppData = resolve(process.env["LOCALAPPDATA"] ?? join(realHome, "AppData", "Local"));
const realPiDir = process.env["PI_CODING_AGENT_DIR"] ? resolve(process.env["PI_CODING_AGENT_DIR"]) : null;
const realCodexHome = process.env["CODEX_HOME"] ? resolve(process.env["CODEX_HOME"]) : null;
const realClaudeConfig = process.env["CLAUDE_CONFIG_DIR"] ? resolve(process.env["CLAUDE_CONFIG_DIR"]) : null;

// --- 2. Containment + refusal (pure path math, no filesystem writes). -------
// Separator-safe containment: `contained` must lie inside `root`.
function containedIn(contained, root) {
  if (!contained || !root || !isAbsolute(resolve(contained))) return false;
  const rel = relative(resolve(root), resolve(contained));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// Refuse only paths inside the OWNER's app-state/harness locations — never
// merely "under the home" (os.tmpdir() is under USERPROFILE on Windows).
function insideOwnerState(value) {
  if (!value) return false;
  const abs = resolve(value.startsWith("~") ? join(realHome, value.slice(1)) : value);
  const ownerDirs = [
    join(realHome, ".cache/action-hub"),
    join(realHome, ".config/action-hub"),
    join(realHome, ".action-hub"),
    join(realHome, "Library/Caches/action-hub"),
    join(realHome, "Library/Application Support/action-hub"),
    join(realAppData, "action-hub"),
    join(realLocalAppData, "action-hub"),
    join(realHome, ".claude"),
    join(realHome, ".claude.json"),
    join(realHome, ".codex"),
    join(realHome, ".cursor"),
    join(realHome, ".copilot"),
    join(realHome, ".pi"),
  ];
  return ownerDirs.some((owner) => containedIn(abs, owner));
}

// Fail fast on hostile INCOMING values BEFORE creating anything. Applied to
// every path-bearing checklist input — including the harness dirs and the OS
// temp location (TMPDIR/TMP/TEMP): a hostile temp location is itself an owner
// app-state write target, so it must be refused before mkdir/mkdtemp runs.
const incomingGuardVars = [
  ...Object.keys(process.env).filter(
    (name) =>
      (name.startsWith("ACTION_HUB_") || name.startsWith("XDG_")) &&
      name !== "ACTION_HUB_TEST_REAL_HOME" &&
      name !== "ACTION_HUB_TEST_REAL_CACHE",
  ),
  "PI_CODING_AGENT_DIR",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "TMPDIR",
  "TMP",
  "TEMP",
];
for (const name of incomingGuardVars) {
  if (insideOwnerState(process.env[name])) {
    throw new Error(
      `test-isolation: incoming ${name}=${process.env[name]} resolves inside the owner's app-state or harness config; refusing to run. ` +
        "Set it to a temp path.",
    );
  }
}

// --- 3. Create the run root under the (validated) OS temp location. ---------
mkdirSync(tmpdir(), { recursive: true }); // tmpdir may not exist in shaped/sandboxed envs
const runRoot = mkdtempSync(join(tmpdir(), "action-hub-test-home-"));
for (const dir of [
  ".cache/action-hub",
  ".config/action-hub",
  ".local/state/action-hub",
  "config",
  "skills",
  "daemon",
  "pi",
  ".codex",
  ".claude",
  ".cursor",
  ".copilot",
  "tmp",
]) {
  mkdirSync(join(runRoot, dir), { recursive: true, mode: 0o700 });
}

// Record the pre-isolation reality for regression guards.
process.env["ACTION_HUB_TEST_REAL_HOME"] = realHome;
process.env["ACTION_HUB_TEST_REAL_CACHE"] = process.env["ACTION_HUB_CACHE"] ?? "";
process.env["ACTION_HUB_TEST_INCOMING_HOME_UNSET"] = "HOME" in process.env ? "" : "1";

// --- 4. Assign + validate final values. ------------------------------------
const assignment = {
  HOME: runRoot,
  USERPROFILE: runRoot,
  APPDATA: join(runRoot, "AppData/Roaming"),
  LOCALAPPDATA: join(runRoot, "AppData/Local"),
  XDG_CACHE_HOME: join(runRoot, ".cache"),
  XDG_CONFIG_HOME: join(runRoot, ".config"),
  XDG_STATE_HOME: join(runRoot, ".local/state"),
  XDG_DATA_HOME: join(runRoot, ".local/share"),
  // File-shaped vars get file paths, not directories.
  ACTION_HUB_CACHE: join(runRoot, ".cache/action-hub/catalog.json"),
  ACTION_HUB_CREDENTIALS: join(runRoot, ".local/state/action-hub/credentials.json"),
  ACTION_HUB_CONTROL: join(runRoot, ".cache/action-hub/control.json"),
  ACTION_HUB_CONFIG: join(runRoot, "config/servers.json"),
  // Directory vars.
  ACTION_HUB_SKILLS_DIR: join(runRoot, "skills"),
  ACTION_HUB_DAEMON_DIR: join(runRoot, "daemon"),
  PI_CODING_AGENT_DIR: join(runRoot, "pi"),
  CODEX_HOME: join(runRoot, ".codex"),
  CLAUDE_CONFIG_DIR: join(runRoot, ".claude"),
  // The OS temp location is repointed into the run root so later children
  // (spawned servers, daemons, downstream stdio MCP processes) cannot reuse
  // the inherited temp location.
  TMPDIR: join(runRoot, "tmp"),
  TMP: join(runRoot, "tmp"),
  TEMP: join(runRoot, "tmp"),
};

for (const [name, value] of Object.entries(assignment)) {
  process.env[name] = value;
}

// Sentinel self-check: EVERY checklist value must resolve inside the run
// root, after all assignments.
for (const [name, value] of Object.entries(assignment)) {
  if (!containedIn(value, runRoot)) {
    throw new Error(`test-isolation: post-assignment ${name}=${value} is not inside the run root ${runRoot}`);
  }
}

// Best-effort cleanup so test runs do not leak temp trees.
process.on("exit", () => {
  try {
    rmSync(runRoot, { recursive: true, force: true, maxRetries: 2 });
  } catch {
    // Never fail the test run over cleanup.
  }
});
