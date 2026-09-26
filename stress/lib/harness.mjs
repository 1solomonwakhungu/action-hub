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
const isolationShared = await import("../../test-isolation.mjs");
const { ISOLATION_CHECKLIST } = isolationShared;

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
  // Platform/XDG app-state locations resolved from the INCOMING env first,
  // defaults second — a redirected APPDATA/LOCALAPPDATA/XDG_* that the
  // caller's shell pinned is exactly as owner-owned as the default one.
  const appData = baseEnv.APPDATA ? resolve(baseEnv.APPDATA) : join(home, "AppData", "Roaming");
  const localAppData = baseEnv.LOCALAPPDATA ? resolve(baseEnv.LOCALAPPDATA) : join(home, "AppData", "Local");
  const xdgCache = baseEnv.XDG_CACHE_HOME ? resolve(baseEnv.XDG_CACHE_HOME) : join(home, ".cache");
  const xdgConfig = baseEnv.XDG_CONFIG_HOME ? resolve(baseEnv.XDG_CONFIG_HOME) : join(home, ".config");
  const xdgData = baseEnv.XDG_DATA_HOME ? resolve(baseEnv.XDG_DATA_HOME) : join(home, ".local", "share");
  const dirs = [
    join(home, ".cache", "action-hub"),
    join(home, ".config", "action-hub"),
    join(home, ".action-hub"),
    join(home, "Library", "Caches", "action-hub"),
    join(home, "Library", "Application Support", "action-hub"),
    join(appData, "action-hub"),
    join(localAppData, "action-hub"),
    join(xdgCache, "action-hub"),
    join(xdgConfig, "action-hub"),
    // pi + OpenCode state, honoring the pi override; Codex/Claude keep theirs.
    baseEnv.PI_CODING_AGENT_DIR ? resolve(baseEnv.PI_CODING_AGENT_DIR) : join(home, ".pi"),
    join(home, ".opencode"),
    join(xdgData, "opencode"),
    // Wildcard families: every real ~/.claude* and ~/.codex* entry.
    ...readdirOrEmpty(home).filter((e) => e.startsWith(".claude") || e.startsWith(".codex")).map((e) => join(home, e)),
    // Harness-specific config dirs, honoring explicit overrides.
    baseEnv.CODEX_HOME ?? join(home, ".codex"),
    baseEnv.CLAUDE_CONFIG_DIR ?? join(home, ".claude"),
    join(home, ".cursor"),
    join(home, ".copilot"),
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

/**
 * Separator-safe containment (never string-prefix + "/"). DELEGATED to the
 * shared test-isolation.mjs `containedIn` export — argument order adapted
 * (parent first) to keep this lib's API stable.
 */
export function pathContains(parent, child) {
  return isolationShared.containedIn(child, parent);
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
  // Path-escape check BEFORE creating anything: a prefix like "../x" must be
  // refused, not partially materialized outside the temp root.
  const intended = resolve(join(osTmp, prefix));
  if (!pathContains(osTmp, intended)) {
    throw new FatalError(`run-root prefix ${prefix} escapes the temp root ${osTmp}; refusing`);
  }
  const ownerTmpConflict = refusedInsideOwnerState(osTmp, baseEnv);
  if (ownerTmpConflict) {
    throw new FatalError(`os.tmpdir() (${osTmp}) is inside owner state dir ${ownerTmpConflict}; refusing to run`);
  }
  const root = resolve(mkdtempSync(intended));
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
  // DELEGATED to the shared test-isolation.mjs env builder — the run-root
  // layout (and every checklist path) comes from the single source of truth.
  // This wrapper keeps the lib's (root, baseEnv) signature and the
  // replace-inherited-values contract.
  return { ...baseEnv, ...isolationShared.buildIsolatedEnv(root) };
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
  // Path-escape check BEFORE creating anything: mkdir entries like "../x"
  // must be refused, not materialized outside the run root.
  const toMake = ["tmp", ...mkdir];
  for (const rel of toMake) {
    const target = resolve(join(root, rel));
    if (!pathContains(root, target)) {
      throw new FatalError(`mkdir entry ${rel} escapes the run root ${root}; refusing`);
    }
  }
  for (const rel of toMake) mkdirSync(join(root, rel), { recursive: true });
  return { root, env, home: join(root, "home") };
}

// ---------------------------------------------------------------------------
// Process-group step runner
// ---------------------------------------------------------------------------

const TERM_TO_KILL_MS = 5_000;
const KILL_GRACE_MS = 5_000;
const GROUP_POLL_MS = 50;

function sleep(ms) {
  return new Promise((resolveP) => setTimeout(resolveP, ms));
}

function alive(pid) {
  try {
    process.kill(pid, 0); // signal 0 = existence probe
    return true;
  } catch (err) {
    if (err.code === "ESRCH") return false;
    if (err.code === "EPERM") return true; // exists but not ours
    return true; // any other probe failure: assume alive, never throw
  }
}

/** True when nothing remains in the process group (kill(-pgid, 0) -> ESRCH). */
function groupEmpty(pgid) {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (err) {
    if (err.code === "ESRCH") return true;
    return false; // EPERM or probe failure: assume members remain
  }
}

/** Signal the group; never throws (errors are part of settling, not crashes). */
function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
  } catch {
    // ESRCH = already gone; anything else still must not throw past main.
  }
}

function killTreeWindows(pid) {
  const result = spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)]);
  if (result.error || (result.status !== 0 && result.status !== 128)) {
    // 128 = process not found; anything else is logged, never thrown.
  }
}

/**
 * TERM -> bounded wait -> KILL -> poll until the group is EMPTY. Runs on
 * every completion path (timeout AND nominal success), so grandchildren that
 * ignore TERM or were spawned+unref'd by a successful launcher cannot outlive
 * the step — and the timeout path drives it INDEPENDENTLY of child exit/close
 * (a group leader that ignores SIGTERM must still be SIGKILLed and the step
 * must still settle). Never throws.
 */
async function reapGroup(pgid, { alreadyTermed = false } = {}) {
  if (process.platform === "win32") {
    // win32 has no process groups; taskkill /T walks the tree by pid.
    return true; // caller already ran taskkill against the root pid
  }
  if (!alreadyTermed) signalGroup(pgid, "SIGTERM");
  const termDeadline = Date.now() + TERM_TO_KILL_MS;
  while (Date.now() < termDeadline && !groupEmpty(pgid)) {
    await sleep(GROUP_POLL_MS);
  }
  if (!groupEmpty(pgid)) {
    signalGroup(pgid, "SIGKILL");
    const killDeadline = Date.now() + KILL_GRACE_MS;
    while (Date.now() < killDeadline && !groupEmpty(pgid)) {
      await sleep(GROUP_POLL_MS);
    }
  }
  return groupEmpty(pgid);
}

/** Bounded wait for in-flight 'exit'/'close' events to flush stdio. */
async function drainPipes(child, ms = 250) {
  const deadline = Date.now() + ms;
  while ((child.exitCode === null && child.signalCode === null) && Date.now() < deadline) {
    await sleep(10);
  }
  await new Promise((r) => setTimeout(r, 25)); // one macrotask for data events
}

/**
 * Run one step as a detached process group with drained pipes and bounded
 * time. On timeout the group gets TERM -> KILL. On EVERY completion path —
 * timeout, error, or nominal success — the whole recorded group is signalled
 * (TERM -> bounded wait -> KILL) and polled until it is empty before the
 * promise resolves. win32 uses `taskkill /T /F` on the root pid.
 *
 * Resolves { pid, code, signal, timedOut, killed, groupEmpty, stdout, stderr, lastJson, error }.
 */
export function runStep(cmd, args, { env, timeoutMs = 300_000, cwd } = {}) {
  return new Promise((resolveP) => {
    let child;
    try {
      child = spawn(cmd, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (err) {
      resolveP({ pid: null, code: null, signal: null, timedOut: false, killed: false, groupEmpty: true, error: "spawn failed: " + err.message, stdout: "", stderr: "", lastJson: null });
      return;
    }
    const pgid = child.pid; // detached + first member => the group leader
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killed = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    let timer = null;
    let settled = false;
    let exitInfo = null;
    let closed = false;

    const buildResult = (extraError) => ({
      pid: pgid,
      code: exitInfo ? exitInfo.code : null,
      signal: exitInfo ? exitInfo.signal : null,
      timedOut,
      killed,
      stdout,
      stderr,
      lastJson: lastJsonLine(stdout),
      ...(extraError ? { error: extraError } : {}),
    });

    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveP(result);
    };

    timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      // The escalation must NOT depend on child exit/close: a group leader
      // that ignores SIGTERM never exits, so 'finish' would never run and
      // nothing would ever escalate to SIGKILL. Drive the ladder here.
      (async () => {
        if (process.platform === "win32") {
          killTreeWindows(pgid);
          await drainPipes(child);
          settle({ ...buildResult(), groupEmpty: true, error: `timeout after ${timeoutMs}ms` });
          return;
        }
        signalGroup(pgid, "SIGTERM");
        const empty = await reapGroup(pgid, { alreadyTermed: true });
        await drainPipes(child);
        settle({
          ...buildResult(),
          groupEmpty: empty === true,
          error: `timeout after ${timeoutMs}ms`,
        });
      })().catch(() => settle({ ...buildResult(), groupEmpty: false, error: `timeout after ${timeoutMs}ms; escalation error` }));
    }, timeoutMs);

    const finish = async () => {
      if (settled || exitInfo === null || !closed) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Reap the WHOLE group on every path: TERM -> bounded wait -> KILL ->
      // poll until empty. A successful launcher that spawned+unref'd a
      // grandchild leaves it in this group; it must not survive the step.
      if (pgid) {
        if (process.platform === "win32" && !timedOut) {
          killTreeWindows(pgid);
        }
        const empty = await reapGroup(pgid, { alreadyTermed: timedOut });
        resolveP({
          ...buildResult(timedOut ? `timeout after ${timeoutMs}ms` : killed ? "terminated by runner" : undefined),
          groupEmpty: empty === true,
        });
        return;
      }
      resolveP({
        ...buildResult(timedOut ? `timeout after ${timeoutMs}ms` : undefined),
        groupEmpty: true,
      });
    };
    child.on("exit", (code, signal) => { exitInfo = { code, signal }; finish(); });
    child.on("close", () => { closed = true; finish(); });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveP({ pid: pgid, code: null, signal: null, timedOut, killed, groupEmpty: false, error: "spawn error: " + err.message, stdout, stderr, lastJson: null });
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
  const started = performance.now();
  let ok = true;
  let error = null;
  let result = null;
  try {
    // Stale results from previous runs must not survive into this run.
    // Inside the guarded region: a hostile resultsPath must produce a final
    // ok:false summary, not a raw crash.
    rmSync(resultsPath, { force: true });
    result = (await fn()) ?? {};
  } catch (err) {
    ok = false;
    error = err instanceof FatalError ? err.message : String((err && err.stack) || err);
    console.error("run failed: " + error);
  }
  // `ok` and `error` are RESERVED: the task may override ok (that is the
  // point of the contract), so the FINAL object decides the exit code.
  const final = {
    ok,
    ...(error ? { error } : {}),
    ...result,
    totalMs: Math.round(performance.now() - started),
  };
  // Durable write is also guarded: results-dir creation or file-write
  // failures must still yield ONE final JSON line on stdout.
  try {
    mkdirSync(dirname(resultsPath), { recursive: true });
    writeFileSync(resultsPath, JSON.stringify(final, null, 2) + "\n");
  } catch (err) {
    final.ok = false;
    final.error = (final.error ? final.error + "; " : "") + `results write failed: ${String(err && err.message)}`;
    console.error("results write failed: " + (err && err.message));
  }
  console.log(JSON.stringify(final));
  // exitCode derives from the FINAL object (never a private ok from main's
  // own bookkeeping, and never leaked from a nested failure).
  process.exitCode = final.ok === false ? 1 : 0;
  return final;
}
