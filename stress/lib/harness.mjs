/**
 * stress/lib/harness.mjs — shared stress harness library (packet LIB1).
 *
 * One tested module for the four bars every stress PR was failing review on:
 *   1. complete process isolation (per /tmp/action-hub-stress/ISOLATION.md)
 *   2. owner-state refusal with separator-safe containment
 *   3. a process-group step runner that cannot hang or leak children
 *   4. a final-summary contract (file + last-stdout-line JSON, exit code)
 *
 * Plain Node ESM (node >= 20), no dependencies. No bare catch anywhere —
 * errors are either surfaced or caught by named errno code only.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";

/** Fatal, expected-refusal errors (distinct from bugs). */
export class FatalError extends Error {}

// ---------------------------------------------------------------------------
// Isolation variable table — SINGLE SOURCE OF TRUTH: the ISOLATION_CHECKLIST
// exported by the repo-root test-isolation.mjs (same module the test preload
// and the smoke test use). This module derives its shaped view from it; drift
// in either direction is caught by harness.check.mjs.
// ---------------------------------------------------------------------------

// Library mode: import the shared module without its preload side effects.
process.env["ACTION_HUB_TEST_ISOLATION_LIBRARY"] = "1";
const { ISOLATION_CHECKLIST } = await import("../../test-isolation.mjs");

/** Vars whose value is a FILE path rather than a directory. */
const FILE_SHAPED_VARS = new Set([
  "ACTION_HUB_CONFIG",
  "ACTION_HUB_CACHE",
  "ACTION_HUB_CREDENTIALS",
  "ACTION_HUB_CONTROL",
]);

export const ISOLATION_VARS = ISOLATION_CHECKLIST.map((name) => ({
  name,
  shape: FILE_SHAPED_VARS.has(name) ? "file" : "dir",
}));

// ---------------------------------------------------------------------------
// Owner home + protected state dirs
// ---------------------------------------------------------------------------

/**
 * The real owner home, read independently of $HOME (os.userInfo() consults
 * the passwd database; homedir() is the fallback).
 */
export function ownerHome() {
  let home;
  try {
    home = userInfo().homedir;
  } catch (err) {
    if (err.code !== "ENOENT") throw err; // surface real errors; ENOENT = no passwd entry
  }
  if (!home) home = homedir();
  return resolve(home);
}

/**
 * The owner's app-state and harness config dirs that a stress run root must
 * never be created inside. Includes the dynamic wildcard entries ~/.claude*
 * and ~/.codex* found on the real filesystem. Real read errors are surfaced,
 * never swallowed.
 */
export function ownerStateDirs(baseEnv = process.env, homeOverride = undefined) {
  const home = homeOverride !== undefined ? resolve(homeOverride) : ownerHome();
  const dirs = [
    join(home, ".cache", "action-hub"),
    join(home, ".config", "action-hub"),
    join(home, ".action-hub"),
    join(home, "Library", "Caches", "action-hub"),
    join(home, "Library", "Application Support", "action-hub"),
    join(home, "AppData", "Roaming", "action-hub"),
    join(home, "AppData", "Local", "action-hub"),
    // Wildcard families: every real ~/.claude* and ~/.codex* entry.
    ...readdirOrEmpty(home).filter((e) => e.startsWith(".claude") || e.startsWith(".codex")).map((e) => join(home, e)),
    // Harness-specific config dirs, honoring explicit overrides.
    baseEnv.CODEX_HOME ?? join(home, ".codex"),
    baseEnv.CLAUDE_CONFIG_DIR ?? join(home, ".claude"),
    join(home, ".cursor"),
    join(home, ".copilot"),
    join(home, ".pi"),
    join(home, ".vscode"),
  ];
  return [...new Set(dirs.map((d) => resolve(d)))];
}

/** readdir that treats a missing dir as empty and surfaces everything else. */
function readdirOrEmpty(dir) {
  try {
    return readdirSync(dir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Containment + run root
// ---------------------------------------------------------------------------

/** Separator-safe containment via path.relative (never string-prefix + "/"). */
export function pathContains(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Refusal check usable without creating anything (self-testable). */
export function refusedInsideOwnerState(candidate, baseEnv = process.env) {
  for (const dir of ownerStateDirs(baseEnv)) {
    if (pathContains(dir, candidate)) return dir;
  }
  return null;
}

/**
 * Validate the OS temp location FIRST (it must not sit inside an owner state
 * dir), then create the fresh run root inside it.
 */
export function makeRunRoot(prefix = "stress-run-", baseEnv = process.env) {
  const osTmp = resolve(tmpdir());
  const ownerTmpConflict = refusedInsideOwnerState(osTmp, baseEnv);
  if (ownerTmpConflict) {
    throw new FatalError(`os.tmpdir() (${osTmp}) is inside owner state dir ${ownerTmpConflict}; refusing to run`);
  }
  const root = resolve(mkdtempSync(join(osTmp, prefix)));
  const conflict = refusedInsideOwnerState(root, baseEnv);
  if (conflict) {
    // mkdtemp succeeded but the location is owner-protected: remove and refuse.
    rmSync(root, { recursive: true, force: true });
    throw new FatalError(`run root ${root} is inside owner state dir ${conflict}; refusing`);
  }
  return root;
}

// ---------------------------------------------------------------------------
// Isolated environment
// ---------------------------------------------------------------------------

/**
 * ONE complete isolated environment for every child. Every ISOLATION_VARS
 * entry is REPLACED (never forwarded from the caller), for every platform:
 * HOME and the Windows equivalents are all pinned under the run root.
 */
export function buildIsolatedEnv(root, baseEnv = process.env) {
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  const under = (rel) => join(home, rel);
  return {
    ...baseEnv,
    HOME: home,
    USERPROFILE: home,
    APPDATA: under(join("AppData", "Roaming")),
    LOCALAPPDATA: under(join("AppData", "Local")),
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    XDG_CACHE_HOME: under(".cache"),
    XDG_CONFIG_HOME: under(".config"),
    XDG_STATE_HOME: under(join(".local", "state")),
    XDG_DATA_HOME: under(join(".local", "share")),
    ACTION_HUB_CONFIG: under("servers.json"),
    ACTION_HUB_CACHE: under(join(".cache", "action-hub", "catalog.json")),
    ACTION_HUB_SKILLS_DIR: under("skills"),
    ACTION_HUB_DAEMON_DIR: under("daemon"),
    ACTION_HUB_CREDENTIALS: under("credentials.json"),
    ACTION_HUB_CONTROL: under("control.sock"),
    PI_CODING_AGENT_DIR: under("pi-agent"),
    CODEX_HOME: under(".codex"),
    CLAUDE_CONFIG_DIR: under(".claude"),
  };
}

/**
 * Sentinel: validates the FINAL env values (after every assignment — no later
 * re-pointing outside the root), checks file-vs-dir shape, and refuses any
 * overlap with owner state. Throws FatalError on any violation.
 */
export function assertIsolated(env, root, baseEnv = process.env) {
  const rootAbs = resolve(root);
  const violations = [];
  for (const { name, shape } of ISOLATION_VARS) {
    const val = env[name];
    if (val === undefined || val === null || val === "") {
      violations.push(`${name} unset`);
      continue;
    }
    if (!pathContains(rootAbs, val)) {
      violations.push(`${name}=${val} outside run root ${rootAbs}`);
      continue;
    }
    // File-shaped vars must be file paths (not existing directories), and
    // dir-shaped vars must not be existing files.
    if (existsSync(val)) {
      const isDir = statSync(val).isDirectory();
      if (shape === "file" && isDir) violations.push(`${name}=${val} is a directory but must be a file path`);
      if (shape === "dir" && !isDir) violations.push(`${name}=${val} is a file but must be a directory`);
    }
  }
  for (const dir of ownerStateDirs(baseEnv)) {
    if (pathContains(dir, rootAbs)) violations.push(`run root ${rootAbs} is inside owner state ${dir}`);
  }
  if (violations.length > 0) {
    throw new FatalError("isolation violated: " + violations.join("; "));
  }
}

/** Convenience: makeRunRoot + buildIsolatedEnv + assertIsolated + dirs. */
export function createSandbox({ prefix = "stress-run-", baseEnv = process.env, mkdir = [] } = {}) {
  const root = makeRunRoot(prefix, baseEnv);
  const env = buildIsolatedEnv(root, baseEnv);
  assertIsolated(env, root, baseEnv);
  for (const rel of ["home", "tmp", ...mkdir]) mkdirSync(join(root, rel), { recursive: true });
  return { root, env, home: join(root, "home") };
}

// ---------------------------------------------------------------------------
// Process-group step runner
// ---------------------------------------------------------------------------

const TERM_TO_KILL_MS = 5_000;

function killProcessTree(pid) {
  if (process.platform === "win32") {
    // win32 has no process groups; taskkill /T walks the tree.
    spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)]);
    return;
  }
  try {
    process.kill(-pid, "SIGTERM"); // negative pid = the whole group
  } catch (err) {
    if (err.code !== "ESRCH") throw err;
  }
  const killTimer = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (err) {
      if (err.code !== "ESRCH") throw err;
    }
  }, TERM_TO_KILL_MS);
  killTimer.unref();
}

function alive(pid) {
  try {
    process.kill(pid, 0); // signal 0 = existence probe
    return true;
  } catch (err) {
    if (err.code === "ESRCH") return false;
    if (err.code === "EPERM") return true; // exists but not ours
    throw err;
  }
}

/**
 * Run one step as a detached process group with drained pipes and bounded
 * time. On timeout the group gets SIGTERM, a bounded wait, then SIGKILL; the
 * promise resolves only after the group is reaped (stdio closed AND exit
 * observed). win32 uses `taskkill /T /F`.
 *
 * Resolves { code, signal, timedOut, killed, stdout, stderr, lastJson, error }.
 */
export function runStep(cmd, args, { env, timeoutMs = 300_000, cwd } = {}) {
  return new Promise((resolveP) => {
    let child;
    try {
      child = spawn(cmd, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (err) {
      resolveP({ pid: null, code: null, signal: null, timedOut: false, killed: false, error: "spawn failed: " + err.message, stdout: "", stderr: "", lastJson: null });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killed = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    const timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      killProcessTree(child.pid);
    }, timeoutMs);

    let exitInfo = null;
    let closed = false;
    let settled = false;
    const finish = () => {
      if (settled || exitInfo === null || !closed) return;
      settled = true;
      clearTimeout(timer);
      resolveP({
        pid: child.pid,
        code: exitInfo.code,
        signal: exitInfo.signal,
        timedOut,
        killed,
        stdout,
        stderr,
        lastJson: lastJsonLine(stdout),
        error: timedOut ? `timeout after ${timeoutMs}ms` : killed ? "terminated by runner" : undefined,
      });
    };
    child.on("exit", (code, signal) => { exitInfo = { code, signal }; finish(); });
    child.on("close", () => { closed = true; finish(); });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP({ pid: child.pid, code: null, signal: null, timedOut, killed, error: "spawn error: " + err.message, stdout, stderr, lastJson: null });
    });
  });
}

// ---------------------------------------------------------------------------
// Final summary contract
// ---------------------------------------------------------------------------

/** Parse ONLY the exact last non-empty line of stdout as JSON (else null). */
export function lastJsonLine(stdout) {
  const lines = String(stdout ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === "") continue;
    try {
      return JSON.parse(lines[i]);
    } catch {
      return null; // the exact last non-empty line is not JSON
    }
  }
  return null;
}

/**
 * Script wrapper implementing the final-summary contract:
 *   - removes the stale results file at start
 *   - catches FatalError / any error ONCE
 *   - writes the same final object (with ok) to the results file AND prints
 *     it as ONE compact JSON last stdout line
 *   - sets process.exitCode (never calls process.exit)
 */
export async function main(fn, { resultsPath } = {}) {
  if (!resultsPath) {
    throw new TypeError("main() requires { resultsPath } — the final summary must have a durable home");
  }
  // Stale results from previous runs must not survive into this run.
  rmSync(resultsPath, { force: true });
  const started = performance.now();
  let ok = true;
  let error = null;
  let result = null;
  try {
    result = (await fn()) ?? {};
  } catch (err) {
    ok = false;
    error = err instanceof FatalError ? err.message : String((err && err.stack) || err);
    console.error("run failed: " + error);
  }
  const final = {
    ok,
    ...(error ? { error } : {}),
    ...result,
    totalMs: Math.round(performance.now() - started),
  };
  // Exactly one file write and exactly one last-line JSON print.
  mkdirSync(dirname(resultsPath), { recursive: true });
  writeFileSync(resultsPath, JSON.stringify(final, null, 2) + "\n");
  console.log(JSON.stringify(final));
  if (!ok) process.exitCode = 1;
  return final;
}
