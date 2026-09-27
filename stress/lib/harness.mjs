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
import {
  spawnAnchoredGroup,
  shutdownAnchor,
  anchorLive,
  enumerateGroupPids,
} from "./anchor.mjs";
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

/**
 * win32 group kill via `taskkill /T /F`. Returns a TRUTHFUL verdict —
 * {ok:true} only when taskkill exited 0 (or 128 = already gone); a failed
 * kill must surface, never become a false green (reviewer LIB2-R2.3).
 */
function killTreeWindows(pid) {
  const result = spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)]);
  if (result.error) {
    return { ok: false, status: null, error: String(result.error?.message ?? result.error) };
  }
  if (result.status === 0 || result.status === 128) {
    return { ok: true, status: result.status }; // 128 = process not found (already gone)
  }
  return { ok: false, status: result.status, error: `taskkill exited ${result.status}` };
}

/**
 * TERM -> bounded wait -> KILL -> poll until the group is EMPTY. Runs on
 * every completion path (timeout AND nominal success), so grandchildren that
 * ignore TERM or were spawned+unref'd by a successful launcher cannot outlive
 * the step — and the timeout path drives it INDEPENDENTLY of child exit/close
 * (a group leader that ignores SIGTERM must still be SIGKILLed and the step
 * must still settle). Never throws. Grace deadlines are parameterizable
 * (killGroupAndVerify exposes them to callers); defaults match runStep.
 */

/**
 * Run one step as a detached process group with drained pipes and bounded
 * time. On timeout the group gets TERM -> KILL. On EVERY completion path —
 * timeout, error, or nominal success — the whole recorded group is signalled
 * (TERM -> bounded wait -> KILL) and polled until it is empty before the
 * promise resolves. win32 uses `taskkill /T /F` on the root pid.
 *
 * Resolves { pid, code, signal, timedOut, killed, groupEmpty, stdout, stderr, lastJson, error }.
 */
/**
 * Run one step as an ANCHORED process group (Design C, reviewer ruling
 * LIB2-R3): a dedicated detached anchor is the group leader for the step's
 * whole lifetime; the workload is spawned NON-detached inside the anchor's
 * group and its exit is reported over the control channel. The anchor is the
 * always-live ownership proof — the group can never become leaderless while
 * the step is in flight, so every negative-pgid signal the reaper sends is
 * gated on the exact anchor being provably ours and alive immediately before
 * it fires (TERM, then the FINAL KILL; verify-only after).
 *
 * On EVERY completion path — timeout, error, or nominal success — the whole
 * group is reaped: stragglers (a successful launcher that spawned+unref'd a
 * grandchild) get TERM -> bounded wait -> the FINAL KILL while the anchor is
 * live, then verification. win32 uses `taskkill /T /F` on the ANCHOR pid and
 * its TRUTHFUL verdict is propagated (reviewer LIB2-R2.3: a failed taskkill
 * is never a green).
 *
 * Interrupt discipline: once an interrupt has been received, runStep REFUSES
 * to start new steps (the sweep has snapshotted the registry). The step
 * handle stays registry-visible until the group is VERIFIED empty.
 *
 * Resolves { pid, code, signal, timedOut, killed, groupEmpty, stdout, stderr,
 * lastJson, error }. pid/code/signal describe the WORKLOAD; groupEmpty
 * describes the verified state of the whole anchored group.
 */
export function runStep(cmd, args, { env, timeoutMs = 300_000, cwd, win32, taskkillRunner, hooks } = {}) {
  if (interruptReceived) {
    return Promise.resolve({
      pid: null, code: null, signal: null, timedOut: false, killed: false,
      groupEmpty: false, error: "interrupt received; refusing to start new step work",
      stdout: "", stderr: "", lastJson: null,
    });
  }
  return new Promise((resolveP) => {
    (async () => {
      const handle = adoptAnchorHandle(
        await spawnAnchoredGroup(cmd, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] }),
      );
      // The step is registry-visible from the earliest moment the anchor
      // exists (INCLUDING failed spawns — the anchor may be live with no
      // workload) so an interrupt arriving during setup sweeps it too.
      registerGroup(handle);
      if (!handle.pid) {
        // Spawn/protocol failure: NEVER terminalize a possibly-live anchor
        // (reviewer LIB2-R3.1) — reap through the normal gated ladder and
        // report its truthful verdict.
        const verdict = await killGroupAndVerify(handle, { win32, taskkillRunner, hooks });
        resolveP({
          pid: null, pgid: handle.pgid, code: null, signal: null, timedOut: false, killed: false,
          groupEmpty: verdict.groupEmpty,
          ...(verdict.error ? { killError: verdict.error } : {}),
          error: handle.error ?? "workload spawn failed",
          stdout: "", stderr: "", lastJson: null,
        });
        return;
      }

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let killed = false;
      let settled = false;
      let timer = null;
      let exitInfo = null;

      handle.stdout?.setEncoding?.("utf8");
      handle.stderr?.setEncoding?.("utf8");
      handle.stdout?.on?.("data", (d) => { stdout += d; });
      handle.stderr?.on?.("data", (d) => { stderr += d; });

      const buildResult = (extraError) => ({
        pid: handle.pid,
        pgid: handle.pgid,
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

      // ONE teardown drive (killGroupAndVerify is single-flight per handle;
      // this gate keeps the timeout path and the natural-exit path from even
      // requesting two verdicts with different error framing).
      const settleAfterTeardown = async (extraError) => {
        const verdict = await killGroupAndVerify(handle, { win32, taskkillRunner, hooks });
        // The relay pipes close when the anchor dies; give data events one
        // bounded window to flush (the verdict, not the drain, is the truth).
        const deadline = Date.now() + 250;
        while (Date.now() < deadline) await sleep(10);
        settle({
          ...buildResult(extraError),
          groupEmpty: verdict.groupEmpty,
          ...(verdict.error ? { killError: verdict.error } : {}),
        });
      };

      timer = setTimeout(() => {
        timedOut = true;
        killed = true;
        // The escalation must NOT depend on workload exit: a workload that
        // ignores SIGTERM never exits, so the timeout path drives the whole
        // anchor-gated ladder itself.
        settleAfterTeardown(`timeout after ${timeoutMs}ms`).catch(() => settle({ ...buildResult(`timeout after ${timeoutMs}ms; escalation error`), groupEmpty: false }));
      }, timeoutMs);

      handle.exited.then(
        (exit) => {
          if (exit?.anchorDied) {
            // The ANCHOR died without reporting a workload exit (crashed or
            // externally killed). Do NOT adopt its death as the workload's
            // signal; the teardown's fail-closed verdict is the honest result.
            if (!settled) {
              settleAfterTeardown("anchor died before reporting workload exit").catch(() => settle({ ...buildResult("anchor died before reporting workload exit"), groupEmpty: false }));
            }
            return;
          }
          exitInfo = { code: exit?.code ?? null, signal: exit?.signal ?? null };
          if (exit?.error && exitInfo.code === null && exitInfo.signal === null) {
            // Workload spawn/exec error reported by the anchor: honest error,
            // still reap the (possibly never-started) group.
            if (!settled) {
              settled = true;
              if (timer) clearTimeout(timer);
              killGroupAndVerify(handle, { win32, taskkillRunner, hooks })
                .then((verdict) => resolveP({
                  ...buildResult(exit.error),
                  groupEmpty: verdict.groupEmpty,
                  ...(verdict.error ? { killError: verdict.error } : {}),
                }))
                .catch(() => resolveP({ ...buildResult(exit.error), groupEmpty: false }));
            }
            return;
          }
          if (!settled) settleAfterTeardown(timedOut ? `timeout after ${timeoutMs}ms` : undefined).catch(() => {});
        },
        (err) => {
          if (!settled) {
            settled = true;
            if (timer) clearTimeout(timer);
            resolveP({ ...buildResult(String((err && err.message) || err)), groupEmpty: false });
          }
        },
      );
    })().catch((err) => resolveP({
      pid: null, code: null, signal: null, timedOut: false, killed: false,
      groupEmpty: false, error: "step setup failed: " + String((err && err.message) || err),
      stdout: "", stderr: "", lastJson: null,
    }));
  });
}

// ---------------------------------------------------------------------------
// Long-lived process groups + interrupt handling (packet LIB2)
// ---------------------------------------------------------------------------

/**
 * Registry of live spawned process groups. spawnGroup registers on spawn;
 * runStep registers while a step is in flight; entries drop when the group
 * is verified empty — but the HANDLE stays authoritative: once verified
 * empty, a handle is marked terminal and can never signal again, even if a
 * later pid reuse makes a probe of its old pgid look non-empty (F39).
 *
 * Ownership is enforced by OBJECT IDENTITY against this registry (plus a
 * module-private WeakSet of every handle this module ever issued): a copied
 * handle shape ({pgid, owned:true}) proves nothing and is refused.
 */
const liveGroups = new Map(); // pgid -> issued handle
const issuedHandles = new WeakSet(); // every handle this module ever issued

/** True once a SIGINT/SIGTERM interrupt has been received in this process. */
let interruptReceived = false;

function issueHandle(shape) {
  const handle = { ...shape, terminal: false };
  issuedHandles.add(handle);
  return handle;
}

/**
 * Adopt a handle produced by the anchor core (spawnAnchoredGroup) into this
 * module's unforgeable identity set. The anchor core issues the object; the
 * harness owns the object-identity contract (killGroupAndVerify refuses any
 * handle outside issuedHandles), so adoption happens exactly once per
 * spawned group, at the harness API boundary.
 */
function adoptAnchorHandle(handle) {
  issuedHandles.add(handle);
  return handle;
}

function registerGroup(handle) {
  if (handle && typeof handle.pgid === "number") liveGroups.set(handle.pgid, handle);
}

function unregisterGroup(handleOrPgid) {
  if (typeof handleOrPgid === "number") liveGroups.delete(handleOrPgid);
  else if (handleOrPgid && typeof handleOrPgid.pgid === "number") {
    // Drop the registry entry only if it still maps to THIS handle (a pgid
    // reuse must not evict a newer handle).
    if (liveGroups.get(handleOrPgid.pgid) === handleOrPgid) liveGroups.delete(handleOrPgid.pgid);
  }
}

/**
 * The authoritative handle currently registered for `pgid` (or null). Returns
 * the module's OWN object — a caller can only ever hold a real issued handle
 * through this, never a fabricated one. Test/cleanup seam: after a
 * non-terminal verdict (e.g. an injected failed taskkill), the registered
 * handle lets the caller drive the real gated ladder.
 */
export function registeredHandleFor(pgid) {
  const handle = liveGroups.get(pgid);
  return handle && !handle.terminal ? handle : null;
}

/** Mark a handle terminal: verified empty (or dead) — it may NEVER signal again. */
function markTerminal(handle) {
  if (handle) handle.terminal = true;
  unregisterGroup(handle);
}

/**
 * Sorted pgids currently registered (test/introspection surface).
 * Terminal handles are never listed: their groups are verified gone.
 */
export function registeredGroups() {
  return [...liveGroups.entries()].filter(([, h]) => !h.terminal).map(([pgid]) => pgid).sort((a, b) => a - b);
}

/**
 * True when `target` may be signalled by this module: it must be a handle
 * OBJECT this module ISSUED (private WeakSet, unforgeable by copying), AND
 * either still authoritative in the registry (liveGroups maps its pgid to
 * this exact handle) or already terminal (verified empty — the safe no-op
 * path). A handle that was unregistered WITHOUT being terminal was replaced
 * by a newer spawn on the same pgid: it must NOT be signalled anymore.
 */
function isAuthoritativeHandle(target) {
  return (
    target &&
    typeof target === "object" &&
    issuedHandles.has(target) &&
    (target.terminal === true || target.pgid == null /* ours, group never existed */ || liveGroups.get(target.pgid) === target)
  );
}


/**
 * Spawn a LONG-LIVED child (hub/daemon under chaos) in an ANCHORED process
 * group (Design C, reviewer ruling LIB2-R3): a dedicated detached ANCHOR is
 * spawned first and is the group leader (pgid) for the handle's entire
 * lifetime; the workload is spawned NON-detached inside the anchor's group
 * and reports its exit over the anchor's control channel. The group can
 * never become leaderless while the handle lives — the anchor stays alive
 * through workload exit (even when the workload spawned+unref'd
 * grandchildren), ignores SIGTERM, and exits only when the parent tells it
 * to AFTER cleanup verification.
 *
 * Returns a PROMISE of a handle (breaking change vs the pre-Design-C sync
 * spawn: the handle exists only once the workload spawn is CONFIRMED over
 * the control channel):
 *   { pid, pgid, anchor, stdin, stdout, stderr, exited, owned, terminal }
 *   - pid: the WORKLOAD pid; pgid: the ANCHOR pid (the group leader). The
 *     anchor ChildProcess object is the ownership proof: killGroupAndVerify
 *     gates every negative-pgid signal on THAT EXACT anchor being provably
 *     ours and alive immediately before it fires (kernel check; no disk
 *     metadata).
 *   - stdin/stdout/stderr: the parent ends of the ANCHOR's relays — "pipe"
 *     entries are transparently relayed to/from the workload (stdio
 *     passthrough, default ["ignore","pipe","pipe"], preserved for the
 *     bench-load stdio MCP hub).
 *   - exited: promise resolving { code, signal } for the WORKLOAD (never
 *     rejects; { error } when the workload failed to exec or the anchor died
 *     before reporting).
 *   - owned: informational marker; ownership is enforced by OBJECT IDENTITY
 *     against this module's registry + the exact anchor ChildProcess.
 *   - terminal: set once the group is VERIFIED empty (or the spawn failed) —
 *     a terminal handle refuses to signal FOREVER (F39).
 *
 * The handle auto-registers in the live-group registry (swept by main()'s
 * interrupt handler); the entry drops when the group is verified empty.
 * After an interrupt has been received, spawnGroup REFUSES (FatalError):
 * main() has promised to stop starting work.
 */
export async function spawnGroup(cmd, args, { env, cwd, stdio = ["ignore", "pipe", "pipe"] } = {}) {
  if (interruptReceived) {
    throw new FatalError("interrupt received; refusing to start new group work");
  }
  const handle = adoptAnchorHandle(await spawnAnchoredGroup(cmd, args, { env, cwd, stdio }));
  // Register whenever a pgid exists — INCLUDING failed spawns: the anchor may
  // still be live with no workload, and the handle must stay sweep-visible
  // until the ladder verifies it empty. A failed spawn is NEVER terminalized
  // here (that would be a false green: reviewer LIB2-R3.1) — the caller's
  // killGroupAndVerify reaps through the normal gated ladder and the verdict
  // reports the truth.
  registerGroup(handle);
  return handle;
}

/**
 * Kill a spawned process group and report a TRUTHFUL verdict:
 *   { groupEmpty, survivors, error? }
 *
 * Design C teardown (reviewer ruling LIB2-R3), shared by runStep, spawnGroup
 * callers, and main()'s interrupt sweep:
 *
 * Ownership (defense in depth, kept from LIB2-R2.2): `target` must be a
 * handle OBJECT this module ISSUED (object identity via the module-private
 * WeakSet) AND still authoritative in the registry (or terminal). Copies,
 * plain {pgid, owned:true} shapes, and bare pgid numbers are all REFUSED
 * without signalling.
 *
 * Live-anchor gate: every negative-pgid signal requires the exact anchor
 * ChildProcess recorded in the handle to be provably ours and alive
 * IMMEDIATELY before the signal (kernel probe). The ladder is TERM -> bounded
 * wait -> FINAL KILL -> verify-only — after the final signal, no further
 * signal ever fires. The anchor ignores TERM, so the group stays owned
 * through the whole ladder.
 *
 * Fail closed: if the anchor is unexpectedly dead (crashed, externally
 * killed, never confirmed), NO group signal is sent — the verdict is
 * groupEmpty:false with a best-effort survivors enumeration. An anchor-less
 * group may be a recycled pgid; no leak prevention justifies killing an
 * unrelated group. If only the anchor remains (workload exited, no
 * stragglers), the group dissolves via the anchor's control channel — the
 * anchor exits 0 after cleanup — so a healthy teardown needs NO signal at
 * all.
 *
 * Terminal: a verified-empty handle refuses forever (F39): never probed,
 * never signalled, even if the old pgid is later reused.
 *
 * win32: `taskkill /T /F` runs against the ANCHOR pid and its TRUTHFUL
 * verdict is propagated (reviewer LIB2-R2.3): a failed taskkill is
 * groupEmpty:false + error and the handle stays non-terminal; the runner is
 * injectable (taskkillRunner) for cross-platform regression coverage.
 */
export async function killGroupAndVerify(target, { termGraceMs = TERM_TO_KILL_MS, killDeadlineMs = KILL_GRACE_MS, taskkillRunner, win32, hooks } = {}) {
  if (!isAuthoritativeHandle(target)) {
    return {
      groupEmpty: false,
      survivors: [],
      error: "refused: target is not an authoritative spawnGroup handle (object identity required; bare pgids and copied handles can name a recycled group this process never created)",
    };
  }
  if (target.terminal) {
    return { groupEmpty: true, survivors: [] }; // verified gone before; never probe, never signal (F39)
  }
  if (target.pgid == null) {
    // Our OWN handle that never got a group (anchor never spawned): nothing
    // provable, nothing signallable — fail closed with a precise reason
    // (not the forgery refusal; the identity is fine, the group is absent).
    return { groupEmpty: false, survivors: [], error: "fail closed: no group was ever created for this handle (anchor never spawned)" };
  }
  // Single-flight: a handle must never have TWO teardown ladders running —
  // concurrent TERM/KILL sequences from racing callers (timeout path vs
  // natural-exit path) are themselves the unsynchronized-signal hazard this
  // design exists to kill. Concurrent callers share the in-flight verdict.
  if (target.teardownPromise) return target.teardownPromise;
  target.teardownPromise = teardownAnchoredGroup(target, { termGraceMs, killDeadlineMs, taskkillRunner, win32, hooks }).then((verdict) => {
    // A verified-empty verdict terminalizes (later calls are safe no-ops).
    // A NOT-empty verdict clears the flight lock so a later, changed state
    // (e.g. the workload exited since) can be re-attempted honestly.
    if (!verdict.groupEmpty) target.teardownPromise = null;
    return verdict;
  });
  return target.teardownPromise;
}

async function teardownAnchoredGroup(target, { termGraceMs = TERM_TO_KILL_MS, killDeadlineMs = KILL_GRACE_MS, taskkillRunner, win32: win32Override, hooks } = {}) {
  // Platform + verdict-mapping seam (reviewer LIB2-R3.3): the win32 branch
  // (taskkill /T /F against the anchor pid, truthful verdict mapping) is
  // EXERCISABLE on any host by passing win32:true with an injectable
  // taskkillRunner; real win32 hosts take the same branch with the real
  // runner. POSIX default is unchanged.
  const win32 = win32Override ?? process.platform === "win32";
  // Before every negative-pgid signal: run the caller's test hook (if any),
  // then require the exact anchor to be provably ours and alive RIGHT HERE —
  // the gate is the last thing before the signal fires (reviewer LIB2-R3.2).
  const signalGate = async (which) => {
    try { await hooks?.beforeSignal?.(which, target); } catch { /* the gate below decides, not the hook */ }
    return anchorLive(target.anchor);
  };
  const failClosed = () => ({
    groupEmpty: false,
    survivors: enumerateGroupPids(target.pgid),
    error: "fail closed: the group's anchor is not provably alive; no negative-pgid signal permitted (the pgid may be recycled)",
  });

  if (win32) {
    // Gate: taskkill walks the tree from the anchor pid; that is only safe
    // while the anchor is still the process we spawned.
    if (!(await signalGate("taskkill"))) return failClosed();
    const taskkill = taskkillRunner ?? killTreeWindows;
    const verdict = taskkill(target.anchor.pid);
    if (!verdict.ok) {
      // A failed taskkill is NOT a green: report it truthfully so callers
      // (and the interrupt summary) surface the possible orphan tree.
      return { groupEmpty: false, survivors: [], error: `taskkill failed (status ${verdict.status ?? "?"}): ${verdict.error ?? "unknown"}` };
    }
    markTerminal(target);
    return { groupEmpty: true, survivors: [] }; // the tree was killed by pid, no probeable group
  }

  // POSIX. The anchor must be provably ours and alive before ANY signal.
  if (!anchorLive(target.anchor)) return failClosed();

  // Fast path: the workload already exited and no non-anchor member remains
  // — dissolve the group through the anchor's control channel. A healthy
  // teardown needs no negative-pgid signal at all.
  const members = enumerateGroupPids(target.pgid);
  const nonAnchor = members.filter((p) => p !== target.anchor.pid);
  if (groupEmpty(target.pgid)) {
    // Verified empty (the anchor is the group leader — if the probe is ESRCH
    // the anchor itself is gone; nothing left to signal).
    markTerminal(target);
    return { groupEmpty: true, survivors: [] };
  }
  if (nonAnchor.length === 0) {
    await shutdownAnchor(target);
    const deadline = Date.now() + killDeadlineMs;
    while (Date.now() < deadline && !groupEmpty(target.pgid)) await sleep(GROUP_POLL_MS);
    if (!groupEmpty(target.pgid)) {
      // Members remain after the anchor exited: leaderless state — fail
      // closed rather than signal an unprovably-owned group.
      return {
        groupEmpty: false,
        survivors: enumerateGroupPids(target.pgid),
        error: "group still non-empty after anchor shutdown (leaderless; no signal permitted)",
      };
    }
    markTerminal(target);
    return { groupEmpty: true, survivors: [] };
  }

  // Ladder: TERM (the workload/stragglers die; the anchor ignores TERM),
  // bounded wait, then — gated on the anchor being STILL provably live —
  // the FINAL KILL, then verify-only. The TERM gate is checked IMMEDIATELY
  // before the signal (enumeration/probes happen in between; reviewer
  // LIB2-R3.2).
  if (!(await signalGate("TERM"))) return failClosed();
  signalGroup(target.pgid, "SIGTERM");
  const termDeadline = Date.now() + termGraceMs;
  while (Date.now() < termDeadline && !groupEmpty(target.pgid)) await sleep(GROUP_POLL_MS);
  if (!groupEmpty(target.pgid)) {
    const nowMembers = enumerateGroupPids(target.pgid);
    if (nowMembers.length > 0 && nowMembers.every((p) => p === target.anchor.pid)) {
      // Only the ownership proof remains (the workload died of TERM): skip
      // the KILL, dissolve via the control channel.
      await shutdownAnchor(target);
      const d2 = Date.now() + killDeadlineMs;
      while (Date.now() < d2 && !groupEmpty(target.pgid)) await sleep(GROUP_POLL_MS);
      if (!groupEmpty(target.pgid)) {
        return {
          groupEmpty: false,
          survivors: enumerateGroupPids(target.pgid),
          error: "group still non-empty after anchor shutdown (leaderless; no signal permitted)",
        };
      }
      markTerminal(target);
      return { groupEmpty: true, survivors: [] };
    }
    if (!(await signalGate("KILL"))) return failClosed();
    signalGroup(target.pgid, "SIGKILL"); // FINAL signal — verify-only after
    const killDeadline = Date.now() + killDeadlineMs;
    while (Date.now() < killDeadline && !groupEmpty(target.pgid)) await sleep(GROUP_POLL_MS);
  }
  if (!groupEmpty(target.pgid)) {
    return { groupEmpty: false, survivors: enumerateGroupPids(target.pgid), error: "group still non-empty after final KILL" };
  }
  // Verified empty. The anchor died with the final KILL (it is a group
  // member) — nothing left to shut down.
  markTerminal(target);
  return { groupEmpty: true, survivors: [] };
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
 *   - installs SIGINT/SIGTERM interrupt handling (LIB2): the FIRST signal
 *     stops work (spawnGroup refuses new groups), kills and verifies every
 *     registered group with the shared ladder, then serializes ONE summary
 *     shaped like an ordinary failure: {ok:false, interrupted:<signal>,
 *     survivors, ...result-so-far} to the results file AND as the last
 *     stdout line, with exitCode 130 (SIGINT) / 143 (SIGTERM). No
 *     process.exit before stdout flush; a SECOND signal after cleanup is
 *     honored with process.exit(code) — it means "die now".
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

  // --- interrupt path (LIB2, reworked per reviewer LIB2-R2.1) --------------
  // Installed BEFORE the guarded region so a signal can never arrive between
  // work starting and the handler existing.
  //
  // ONE coordinated finish: `interruptBegun` suppresses the normal summary —
  // once the sweep starts, the interrupt summary is the ONLY final object
  // this run may serialize. The sweep iterates the REAL registry handles (no
  // fabricated {pgid, owned:true} shapes), and because runStep/spawnGroup
  // refuse to start after interruptReceived, nothing can join the registry
  // after the snapshot below. A second signal after cleanup exits immediately.
  let interruptBegun = false;
  let interruptDone = false;
  let interruptCode = null;
  const onInterrupt = async (signal) => {
    const code = signal === "SIGINT" ? 130 : 143;
    if (interruptDone) {
      // Second signal: the operator means "die now". Stdio has already been
      // flushed by the first pass; exit immediately.
      process.exit(code);
    }
    if (interruptBegun) return; // a sweep is already in flight for this signal
    interruptBegun = true;
    interruptReceived = true; // spawnGroup/runStep now refuse new work
    const handles = [...liveGroups.values()]; // the REAL issued handles
    let survivors = [];
    for (const handle of handles) {
      const verdict = await killGroupAndVerify(handle, { termGraceMs: 2_000, killDeadlineMs: 2_000 });
      if (!verdict.groupEmpty) {
        survivors.push(...(verdict.survivors.length ? verdict.survivors : [handle.pgid]));
      }
    }
    const final = {
      ok: false,
      interrupted: signal,
      groupsKilled: handles.length,
      ...(survivors.length ? { survivors } : {}),
      totalMs: Math.round(performance.now() - started),
    };
    try {
      mkdirSync(dirname(resultsPath), { recursive: true });
      writeFileSync(resultsPath, JSON.stringify(final, null, 2) + "\n");
    } catch {
      // The interrupt summary must still reach stdout even if the disk refuses.
    }
    interruptDone = true;
    interruptCode = code;
    process.stdout.write(JSON.stringify(final) + "\n", () => process.exit(code));
    // Hard fallback if the write callback never fires (pipe edge cases).
    setTimeout(() => process.exit(code), 1_000).unref();
  };
  const wasRawSigint = process.listenerCount("SIGINT");
  const wasRawSigterm = process.listenerCount("SIGTERM");
  if (wasRawSigint === 0) process.on("SIGINT", onInterrupt);
  if (wasRawSigterm === 0) process.on("SIGTERM", onInterrupt);

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
  } finally {
    // Normal completion: the interrupt handler must not fire after the
    // summary contract has taken over (and must not keep the loop alive).
    if (wasRawSigint === 0) process.off("SIGINT", onInterrupt);
    if (wasRawSigterm === 0) process.off("SIGTERM", onInterrupt);
  }
  // Reviewer LIB2-R2.1: once an interrupt settlement has begun, the normal
  // completion path is SUPPRESSED — the interrupt summary is the only final
  // object. fn() returning (or throwing) while the sweep is in flight must
  // not emit a second (possibly ok:true) summary; wait for the interrupt
  // serializer to exit this process instead.
  if (interruptBegun) {
    const idle = () => new Promise(() => {}); // never resolves; exit comes from onInterrupt
    return idle();
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
