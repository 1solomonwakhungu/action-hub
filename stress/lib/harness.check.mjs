#!/usr/bin/env node
/**
 * stress/lib/harness.check.mjs — self-test for stress/lib/harness.mjs (LIB1).
 * Prints progress lines, then the contract-required compact JSON summary as
 * the LAST stdout line; writes the same object to
 * stress/.generated/results/harness-check.json; exits nonzero on failure.
 * Run: node stress/lib/harness.check.mjs
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { dirname } from "node:path";

import {
  ISOLATION_VARS, FatalError, ownerHome, ownerStateDirs, pathContains,
  refusedInsideOwnerState, makeRunRoot, buildIsolatedEnv, assertIsolated,
  createSandbox, runStep, lastJsonLine, main,
  spawnGroup, killGroupAndVerify, registeredGroups, registeredHandleFor,
} from "./harness.mjs";

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const RESULTS_PATH = join(LIB_DIR, "..", ".generated", "results", "harness-check.json");

const TERM_LADDER_GRACE_MS = 1_000;

function aliveByProbe(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === "ESRCH") return false;
    if (err.code === "EPERM") return true; // exists but not ours
    throw err;
  }
}

function strayCount() {
  try {
    const out = spawnSync("ps", ["-eo", "pid,ppid,command"], { encoding: "utf8", timeout: 3_000 });
    if (out.status !== 0) return -1;
    let n = 0;
    for (const line of String(out.stdout).split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 3 && Number(parts[1]) === 1 && line.includes('setInterval(()=>{},500)')) n++;
    }
    return n;
  } catch { return -1; }
}
let __lastStrays = null;
function strayDelta(label) {
  const n = strayCount();
  if (__lastStrays !== null && n > __lastStrays) console.error("[stray-delta]", label, __lastStrays, "->", n);
  if (n >= 0) __lastStrays = n;
}

const __final = await main(async () => {
  const checks = [];

  // --- 0. env-table single source of truth (drift check) -------------------
  console.error("[progress]", "\"0. env-table single source of truth (drift check)\"".replace(/---/g, "").trim());

  {
    // harness.mjs already put test-isolation.mjs in library mode.
    const { ISOLATION_CHECKLIST } = await import("../../test-isolation.mjs");
    const names = ISOLATION_VARS.map((v) => v.name).sort();
    const shared = [...ISOLATION_CHECKLIST].sort();
    assert.deepEqual(names, shared, "ISOLATION_VARS must derive exactly from test-isolation.mjs ISOLATION_CHECKLIST");
    const { root, env } = createSandbox({ prefix: "harness-check-drift-" });
    rmSync(root, { recursive: true, force: true });
    for (const name of ISOLATION_CHECKLIST) {
      assert.ok(env[name], `buildIsolatedEnv must set ${name} from the shared checklist`);
    }
    checks.push({ check: "isolation-table-single-source-of-truth", ok: true, shared: shared.length });
  }

  // --- 1. hostile run-root location is refused with nothing created ---------
  console.error("[progress]", "\"1. hostile run-root location is refused with nothing created\"".replace(/---/g, "").trim());

  {
    const hostile = join(ownerHome(), ".cache", "action-hub", "harness-check-hostile");
    const conflict = refusedInsideOwnerState(hostile);
    assert.ok(conflict, "owner .cache/action-hub path must be refused");
    assert.ok(!existsSync(hostile), "nothing may be created for a refused location");
    let threw = null;
    // Drive makeRunRoot with a HOSTILE temp location: it must refuse BEFORE
    // creating anything, then a clean temp must succeed.
    const previousTmp = process.env["TMPDIR"];
    process.env["TMPDIR"] = hostile;
    try {
      makeRunRoot("harness-check-hostile-");
    } catch (err) {
      threw = err;
    } finally {
      if (previousTmp === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = previousTmp;
    }
    assert.ok(threw instanceof FatalError, `hostile TMPDIR must be refused, threw: ${threw}`);
    assert.ok(!existsSync(hostile), "nothing may be created under the hostile temp");
    const root = makeRunRoot("harness-check-");
    assert.ok(!pathContains(conflict, root), "real run root must not be inside owner state");
    rmSync(root, { recursive: true, force: true });
    checks.push({ check: "hostile-location-refused-without-creation", ok: true });
  }

  // --- 2. isolated env: complete, sandboxed, hostile base replaced ----------
  console.error("[progress]", "\"2. isolated env: complete, sandboxed, hostile base replaced\"".replace(/---/g, "").trim());

  {
    const { root, env } = createSandbox({ prefix: "harness-check-env-" });
    try {
      assertIsolated(env, root);
      for (const { name } of ISOLATION_VARS) {
        assert.ok(env[name], `${name} must be set`);
        assert.ok(pathContains(root, env[name]), `${name} must live inside the run root`);
      }
      assert.equal(env.USERPROFILE, root, "USERPROFILE pinned to the shared run-root layout");
      assert.equal(env.HOME, root);
      // File-shaped vars are file paths, dir-shaped vars are directories.
      for (const { name, shape } of ISOLATION_VARS) {
        const stats = statSync(env[name], { throwIfNoEntry: false });
        if (shape === "file") assert.ok(!stats?.isDirectory?.(), `${name} must be a file path`);
        if (shape === "dir") assert.ok(!stats || stats.isDirectory(), `${name} must be a directory path`);
      }
      checks.push({ check: "isolated-env-complete-and-sandboxed", ok: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // --- 3. assertIsolated refuses leaks (FatalError) --------------------------
  console.error("[progress]", "\"3. assertIsolated refuses leaks (FatalError)\"".replace(/---/g, "").trim());

  {
    const { root, env } = createSandbox({ prefix: "harness-check-leak-" });
    try {
      const leaky = { ...env, XDG_CACHE_HOME: join(ownerHome(), ".cache") };
      assert.throws(() => assertIsolated(leaky, root), FatalError);
      checks.push({ check: "leaked-var-refused", ok: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // --- 4. timed-out step: group killed, ZERO survivors -----------------------
  console.error("[progress]", "\"4. timed-out step: group killed, ZERO survivors\"".replace(/---/g, "").trim());

  {
    const { root, env } = createSandbox({ prefix: "harness-check-timeout-" });
    try {
      const marker = join(root, "grandchild-pid");
      const childCode =
        `const { spawn } = require("node:child_process");` +
        `const g = spawn(process.execPath, ["-e", "require('node:fs').writeFileSync(process.env.MARKER, String(process.pid)); setInterval(() => {}, 500)"], { env: process.env });` +
        `setInterval(() => {}, 500);`;
      const childEnv = { ...env, MARKER: marker };
      const res = await runStep(process.execPath, ["-e", childCode], { env: childEnv, cwd: root, timeoutMs: 1_500 });
      assert.equal(res.timedOut, true, "step must report timedOut");
      // Wait for the grandchild marker, then verify BOTH pids are dead.
      const deadline = performance.now() + 5_000;
      while (!existsSync(marker) && performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(existsSync(marker), "grandchild must have started (marker written)");
      const grandchildPid = Number(readFileSync(marker, "utf8").trim());
      // Give the TERM->KILL ladder a moment to finish reaping the group.
      await new Promise((r) => setTimeout(r, TERM_LADDER_GRACE_MS));
      assert.ok(!aliveByProbe(res.pid ?? 0), "direct child must be reaped");
      assert.ok(!aliveByProbe(grandchildPid), "grandchild must be reaped (group kill)");
      checks.push({ check: "timeout-leaves-zero-survivors", ok: true, grandchildPid });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // --- 5. runStep success path: exit code + lastJson from the exact last line
  {
    const { root, env } = createSandbox({ prefix: "harness-check-ok-" });
    try {
      const res = await runStep(process.execPath, ["-e", "console.log('noise'); console.log(JSON.stringify({answer: 42}))"], { env, cwd: root, timeoutMs: 10_000 });
      assert.equal(res.code, 0);
      assert.deepEqual(res.lastJson, { answer: 42 });
      assert.equal(lastJsonLine("not json\n"), null);
      assert.equal(lastJsonLine(""), null);
      checks.push({ check: "runStep-success-and-lastJson", ok: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // --- 5b. adversarial: grandchild that IGNORES TERM survives a timeout -----
  console.error("[progress]", "\"5b. adversarial: grandchild that IGNORES TERM survives a timeout\"".replace(/---/g, "").trim());

  {
    const { root, env } = createSandbox({ prefix: "harness-check-term-ignorer-" });
    try {
      const marker = join(root, "grandchild-pid");
      const childCode =
        `const { spawn } = require("node:child_process");` +
        `const g = spawn(process.execPath, ["-e", "require('node:fs').writeFileSync(process.env.MARKER, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 500)"], { env: process.env, stdio: "ignore" });` +
        `g.unref(); setInterval(() => {}, 500);`;
      const res = await runStep(process.execPath, ["-e", childCode], { env: { ...env, MARKER: marker }, cwd: root, timeoutMs: 1_500 });
      assert.equal(res.timedOut, true, "the step must time out");
      const deadline = Date.now() + 15_000;
      while (!existsSync(marker) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(existsSync(marker), "grandchild must have started (marker written)");
      const grandchildPid = Number(readFileSync(marker, "utf8").trim());
      assert.equal(res.groupEmpty, true, "runStep must not resolve until the group is empty");
      assert.ok(!aliveByProbe(grandchildPid), "TERM-ignoring grandchild must be SIGKILLed (0 survivors)");
      checks.push({ check: "term-ignoring-grandchild-zero-survivors", ok: true, grandchildPid });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // --- 5b2. adversarial: the GROUP LEADER itself ignores SIGTERM ------------
  {
    const { root, env } = createSandbox({ prefix: "harness-check-leader-" });
    try {
      const marker = join(root, "leader-pid");
      const leaderCode =
        `require('node:fs').writeFileSync(process.env.MARKER, String(process.pid));` +
        `process.on('SIGTERM', () => {}); setInterval(() => {}, 500);`;
      const started = Date.now();
      const res = await runStep(process.execPath, ["-e", leaderCode], { env: { ...env, MARKER: marker }, cwd: root, timeoutMs: 1_000 });
      const elapsed = Date.now() - started;
      assert.equal(res.timedOut, true, "the step must time out");
      assert.equal(res.groupEmpty, true, "the runner must settle with an empty group");
      assert.ok(!aliveByProbe(res.pid ?? 0), "the TERM-ignoring group leader must be SIGKILLed");
      assert.ok(elapsed < 15_000, `the timeout path must escalate independently of exit/close (took ${elapsed}ms)`);
      checks.push({ check: "term-ignoring-group-leader-escalates-and-settles", ok: true, leaderPid: res.pid, elapsedMs: elapsed });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // --- 5c. adversarial: successful launcher leaves an unref'd grandchild ----
  console.error("[progress]", "\"5c. adversarial: successful launcher leaves an unref\"d grandchild\"".replace(/---/g, "").trim());

  {
    const { root, env } = createSandbox({ prefix: "harness-check-unref-" });
    try {
      const marker = join(root, "grandchild-pid");
      const childCode =
        `const { spawn } = require("node:child_process");` +
        `const fs = require("node:fs");` +
        `const g = spawn(process.execPath, ["-e", "require('node:fs').writeFileSync(process.env.MARKER, String(process.pid)); setInterval(() => {}, 500)"], { env: process.env, stdio: "ignore" });` +
        `g.unref();` +
        // The launcher waits for the grandchild marker, then exits 0 — so the
        // grandchild is definitively alive when the step completes.
        `const w = Date.now(); while (!fs.existsSync(process.env.MARKER) && Date.now() - w < 10000) {}` +
        `console.log(JSON.stringify({ok: true}));`;
      const res = await runStep(process.execPath, ["-e", childCode], { env: { ...env, MARKER: marker }, cwd: root, timeoutMs: 20_000 });
      assert.equal(res.code, 0, "the launcher must succeed");
      assert.deepEqual(res.lastJson, { ok: true });
      const deadline = Date.now() + 15_000;
      while (!existsSync(marker) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(existsSync(marker), "grandchild must have started (marker written)");
      const grandchildPid = Number(readFileSync(marker, "utf8").trim());
      assert.equal(res.groupEmpty, true, "runStep must reap the group even after success");
      assert.ok(!aliveByProbe(grandchildPid), "unref'd grandchild must not outlive a successful step (0 survivors)");
      checks.push({ check: "unref-grandchild-after-success-zero-survivors", ok: true, grandchildPid });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // --- 6. ownerStateDirs includes dynamic wildcard entries -------------------
  console.error("[progress]", "\"6. ownerStateDirs includes dynamic wildcard entries\"".replace(/---/g, "").trim());

  {
    const ownerRoot = makeRunRoot("harness-check-owner-");
    const fakeHome = join(ownerRoot, "fake-owner-home");
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(fakeHome, ".codex-90210"), "{}");
    mkdirSync(join(fakeHome, ".claude-foobar"), { recursive: true });
    const dirs = ownerStateDirs({ CODEX_HOME: join(fakeHome, "custom-codex") }, fakeHome);
    assert.ok(dirs.some((d) => d.endsWith(".codex-90210")), "dynamic ~/.codex* entries must be enumerated");
    assert.ok(dirs.some((d) => d.endsWith(".claude-foobar")), "dynamic ~/.claude* entries must be enumerated");
    assert.ok(dirs.some((d) => d.endsWith("custom-codex")), "explicit CODEX_HOME override must be honored");
    // Redirected incoming app-state envs must be honored too.
    const redirected = ownerStateDirs(
      { APPDATA: join(fakeHome, "AppData", "Roaming"), XDG_CACHE_HOME: join(fakeHome, "xdg-cache"), PI_CODING_AGENT_DIR: join(fakeHome, "pi-state") },
      fakeHome,
    );
    assert.ok(redirected.some((d) => d.includes(join("AppData", "Roaming", "action-hub"))), "redirected APPDATA must produce its action-hub dir");
    assert.ok(redirected.some((d) => d === join(fakeHome, "xdg-cache", "action-hub")), "redirected XDG_CACHE_HOME must be honored");
    assert.ok(redirected.some((d) => d === join(fakeHome, "pi-state")), "redirected PI_CODING_AGENT_DIR must be honored");
    assert.ok(redirected.some((d) => d.endsWith(join(".local", "share", "opencode"))), "opencode state must be enumerated");
    rmSync(ownerRoot, { recursive: true, force: true });
    checks.push({ check: "ownerStateDirs-dynamic-entries", ok: true, enumerated: dirs.length });
  }

  // --- 7. main(): stale results removed, failure contract exactly-once ------
  console.error("[progress]", "\"7. main(): stale results removed, failure contract exactly-once\"".replace(/---/g, "").trim());

  {
    const mainRoot = makeRunRoot("harness-check-main-");
    const nestedResults = join(mainRoot, "results.json");
    // Stale artifact must not survive into the run.
    mkdirSync(dirname(nestedResults), { recursive: true });
    writeFileSync(nestedResults, '{"ok":true,"stale":true}');
    const okFinal = await main(async () => ({ suite: "nested-ok" }), { resultsPath: nestedResults });
    assert.equal(okFinal.ok, true);
    const onDisk = JSON.parse(readFileSync(nestedResults, "utf8"));
    assert.equal(onDisk.ok, true, "stale results must be replaced");
    assert.equal("stale" in onDisk, false, "stale content must be gone");
    assert.deepEqual(onDisk, okFinal, "file must carry the SAME final object");

    // Failure: ok:false written to the file exactly once and returned.
    const failResults = join(dirname(nestedResults), "fail.json");
    const failFinal = await main(async () => {
      throw new Error("boom for the exactly-once check");
    }, { resultsPath: failResults });
    assert.equal(failFinal.ok, false);
    assert.ok(/boom for the exactly-once check/.test(failFinal.error));
    const failDisk = JSON.parse(readFileSync(failResults, "utf8"));
    assert.equal(failDisk.ok, false);
    assert.deepEqual(failDisk, failFinal, "failure file must carry the SAME final object");
    const raw = readFileSync(failResults, "utf8");
    assert.equal(raw.split('"ok"').length - 1, 1, "exactly one ok field in the artifact");
    checks.push({ check: "main-stale-removal-and-exactly-once-failure", ok: true });

    // Exit code derives from the FINAL object: a task that returns
    // {ok:false} must leave process.exitCode nonzero.
    const exitBefore = process.exitCode;
    const taskFailFinal = await main(async () => ({ ok: false, reason: "task-decided" }), { resultsPath: join(mainRoot, "task-fail.json") });
    assert.equal(taskFailFinal.ok, false, "the task's ok:false must become the final ok");
    assert.equal(taskFailFinal.reason, "task-decided");
    assert.equal(process.exitCode, 1, "main(() => ({ok:false})) must exit nonzero");
    assert.equal(readFileSync(join(mainRoot, "task-fail.json"), "utf8").split('"ok"').length - 1, 1);
    checks.push({ check: "main-exit-code-from-final-object", ok: true });

    // resultsPath pointing at an EXISTING DIRECTORY: stale-removal and the
    // write both fail, yet exactly ONE failure JSON is still printed.
    const dirResults = join(mainRoot, "results-dir");
    mkdirSync(dirResults, { recursive: true });
    const logged = [];
    const realLog = console.log;
    console.log = (...args) => logged.push(args.join(" "));
    let dirFinal = null;
    try {
      dirFinal = await main(async () => ({ suite: "dir-path" }), { resultsPath: dirResults });
    } finally {
      console.log = realLog;
    }
    assert.equal(dirFinal.ok, false);
    assert.match(dirFinal.error, /results write failed/);
    const jsonLines = logged.filter((line) => {
      try { return JSON.parse(line).suite !== undefined || JSON.parse(line).ok !== undefined; } catch { return false; }
    });
    assert.equal(jsonLines.length, 1, "exactly ONE failure JSON line on stdout");
    assert.equal(JSON.parse(jsonLines[0]).ok, false);
    checks.push({ check: "main-results-path-dir-still-emits-one-failure-json", ok: true });

    process.exitCode = exitBefore === undefined ? null : exitBefore;
    rmSync(mainRoot, { recursive: true, force: true });
  }

  // --- 8. spawnGroup: long-lived child, killGroupAndVerify ladder -----------
  console.error("[progress]", "\"8. spawnGroup: long-lived child, killGroupAndVerify ladder\"".replace(/---/g, "").trim());

  {
    const { root, env } = createSandbox({ prefix: "harness-check-group-" });
    try {
      assert.deepEqual(registeredGroups(), [], "registry starts empty");
      // Long-lived child that writes its pid, then ignores TERM forever.
      const marker = join(root, "group-child-pid");
      const childCode =
        `require('node:fs').writeFileSync(process.env.MARKER, String(process.pid));` +
        `process.on('SIGTERM', () => {}); setInterval(() => {}, 500);`;
      const handle = await spawnGroup(process.execPath, ["-e", childCode], { env: { ...env, MARKER: marker }, cwd: root });
      // Design C: pgid is the ANCHOR pid (the dedicated detached group leader
      // and the always-live ownership proof); pid is the WORKLOAD pid.
      assert.equal(handle.pgid, handle.anchor.pid, "pgid must be the anchor pid (the group leader / ownership proof)");
      assert.notEqual(handle.pgid, handle.pid, "workload pid and anchor pgid must be distinct processes");
      assert.ok(registeredGroups().includes(handle.pgid), "spawnGroup must auto-register (keyed by the anchor's pgid)");
      const deadline = performance.now() + 10_000;
      while (!existsSync(marker) && performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(existsSync(marker), "long-lived child must have started (marker written)");
      const childPid = Number(readFileSync(marker, "utf8").trim());
      assert.equal(childPid, handle.pid, "the leader pid must be the spawned child");

      // Ownership refusal: a BARE pgid (no owned handle) must NEVER be signalled.
      const refused = await killGroupAndVerify(handle.pgid);
      assert.equal(refused.groupEmpty, false);
      assert.match(refused.error, /refused/);
      assert.ok(aliveByProbe(childPid), "refused kill must not signal the group");

      // The real ladder: owned handle, TERM-ignoring child -> SIGKILL -> empty.
      const killed = await killGroupAndVerify(handle, { termGraceMs: 1_000, killDeadlineMs: 3_000 });
      assert.equal(killed.groupEmpty, true, "TERM-ignoring long-lived child must be reaped to an EMPTY group");
      assert.deepEqual(killed.survivors, []);
      assert.ok(!aliveByProbe(childPid), "the child must be dead after killGroupAndVerify");
      assert.ok(!registeredGroups().includes(handle.pgid), "verified-empty groups must unregister");
      assert.equal(handle.terminal, true, "verified-empty handles must be marked terminal");

      // F39 + reviewer LIB2-R2.2: a TERMINAL handle refuses forever — even if
      // its old pgid were reused, no probe/signal may fire from the stale handle.
      const gone = await killGroupAndVerify(handle);
      assert.equal(gone.groupEmpty, true, "a terminal handle reports verified-empty WITHOUT probing or signalling");
      assert.deepEqual(gone.survivors, []);
      assert.equal(gone.error, undefined, "terminal refusal is a clean verdict, not an error");
      checks.push({ check: "spawnGroup-killGroupAndVerify-ladder", ok: true, childPid });
      strayDelta("spawnGroup-killGroupAndVerify-ladder");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // --- 8b. spawnGroup natural exit with an unref'd grandchild ----------------
  console.error("[progress]", "\"8b. spawnGroup natural exit with an unref\"d grandchild\"".replace(/---/g, "").trim());

  {
    const { root, env } = createSandbox({ prefix: "harness-check-group-adopt-" });
    try {
      const marker = join(root, "grandchild-pid");
      const launcherCode =
        `const { spawn } = require("node:child_process");` +
        `const g = spawn(process.execPath, ["-e", "require('node:fs').writeFileSync(process.env.MARKER, String(process.pid)); setInterval(() => {}, 500)"], { env: process.env, stdio: "ignore" });` +
        `g.unref();` +
        `const w = Date.now(); while (!require('node:fs').existsSync(process.env.MARKER) && Date.now() - w < 10000) {}`;
      const handle = await spawnGroup(process.execPath, ["-e", launcherCode], { env: { ...env, MARKER: marker }, cwd: root });
      await handle.exited; // leader exits naturally after the grandchild starts
      const deadline = performance.now() + 10_000;
      while (!existsSync(marker) && performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(existsSync(marker), "grandchild must have started");
      const grandchildPid = Number(readFileSync(marker, "utf8").trim());
      // The leader is gone but the group is NOT empty: the handle must STAY
      // registered so the interrupt sweep can reap the survivor.
      assert.ok(registeredGroups().includes(handle.pgid), "leader's natural exit must NOT unregister while the group still has members");
      const killed = await killGroupAndVerify(handle, { termGraceMs: 1_000, killDeadlineMs: 3_000 });
      assert.equal(killed.groupEmpty, true, "the surviving grandchild must be reaped by the owned kill");
      assert.ok(!aliveByProbe(grandchildPid), "the orphaned grandchild must be dead");
      checks.push({ check: "spawnGroup-leader-exit-keeps-registry-until-group-empty", ok: true, grandchildPid });
      strayDelta("spawnGroup-leader-exit-keeps-registry-until-group-empty");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // --- 8c. main() SIGTERM: ONE interrupted JSON, groups dead, exit 143 -------
  console.error("[progress]", "\"8c. main() SIGTERM: ONE interrupted JSON, groups dead, exit 143\"".replace(/---/g, "").trim());

  {
    const { root, env } = createSandbox({ prefix: "harness-check-sigterm-" });
    const resultsPath = join(root, "interrupted.json");
    try {
      // The script under test: registers a TERM-ignoring long-lived group via
      // spawnGroup, then idles until signalled. It must serialize exactly one
      // interrupted summary and die with exit code 143.
      const scriptPath = join(root, "sigterm-target.mjs");
      const targetResults = join(root, "target-results.json");
      writeFileSync(scriptPath, `
import { spawnGroup, main } from ${JSON.stringify(resolve(LIB_DIR, "harness.mjs"))};
await main(async () => {
  const handle = await spawnGroup(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 500)"], { env: process.env, cwd: process.cwd() });
  require('node:fs').writeFileSync(process.env.TARGET_PID_FILE, String(handle.pid));
  await new Promise(() => {}); // idle forever; SIGTERM is the only way out
}, { resultsPath: ${JSON.stringify(targetResults)} });
`);
      // NOTE: writeFileSync of an ESM script using require() would fail at
      // runtime; use an fs import instead.
      writeFileSync(scriptPath, `
import { spawnGroup, main } from ${JSON.stringify(resolve(LIB_DIR, "harness.mjs"))};
import { writeFileSync } from "node:fs";
await main(async () => {
  const handle = await spawnGroup(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 500)"], { env: process.env, cwd: process.cwd() });
  writeFileSync(process.env.TARGET_PID_FILE, String(handle.pid));
  await new Promise(() => {}); // idle forever; SIGTERM is the only way out
}, { resultsPath: ${JSON.stringify(targetResults)} });
`);
      const targetEnv = { ...env, TARGET_PID_FILE: join(root, "target-pid") };
      const proc = spawn(process.execPath, [scriptPath], { env: targetEnv, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
      let procStdout = "";
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (d) => { procStdout += d; });
      const pidDeadline = performance.now() + 10_000;
      while (!existsSync(targetEnv.TARGET_PID_FILE) && performance.now() < pidDeadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(existsSync(targetEnv.TARGET_PID_FILE), "target must have registered its group");
      const groupLeaderPid = Number(readFileSync(targetEnv.TARGET_PID_FILE, "utf8").trim());
      assert.ok(aliveByProbe(groupLeaderPid), "the long-lived group must be alive before the signal");

      proc.kill("SIGTERM");
      const exitCode = await new Promise((resolveP) => {
        const t0 = performance.now();
        proc.on("exit", (code2, signal2) => resolveP({ code: code2, signal: signal2, waited: performance.now() - t0 }));
      });
      assert.equal(exitCode.code, 143, `SIGTERM must produce exit 143, got ${JSON.stringify(exitCode)}`);
      assert.ok(exitCode.waited < 15_000, `interrupt cleanup must be bounded (took ${exitCode.waited}ms)`);
      const lines = procStdout.split("\n").filter((l) => l.trim() !== "");
      assert.equal(lines.length, 1, `exactly ONE stdout JSON line, got: ${JSON.stringify(lines)}`);
      const summary = JSON.parse(lines[0]);
      assert.equal(summary.ok, false);
      assert.equal(summary.interrupted, "SIGTERM");
      assert.ok(summary.groupsKilled >= 1, "the registered group must have been swept");
      assert.equal("survivors" in summary, false, "no survivors may remain");
      const disk = JSON.parse(readFileSync(targetResults, "utf8"));
      assert.deepEqual(disk, summary, "interrupt summary: file must carry the SAME final object");
      // The registered group leader must be DEAD.
      await new Promise((r) => setTimeout(r, TERM_LADDER_GRACE_MS));
      assert.ok(!aliveByProbe(groupLeaderPid), "the registered long-lived group must be dead after the interrupt");
      checks.push({ check: "main-sigterm-one-json-groups-dead-exit-143", ok: true, groupLeaderPid, groupsKilled: summary.groupsKilled });
      strayDelta("main-sigterm-one-json-groups-dead-exit-143");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // --- 8d. reviewer LIB2-R2.1: SIGTERM during an IN-FLIGHT runStep ----------
  console.error("[progress]", "\"8d. reviewer LIB2-R2.1: SIGTERM during an IN-FLIGHT runStep\"".replace(/---/g, "").trim());

  // The exact repro: a main() script whose fn() is awaiting a long runStep
  // when SIGTERM lands. The interrupt sweep must be the ONLY final summary:
  // exactly ONE ok:false JSON line (never a preceding ok:true from the
  // step settling), exit 143, step group dead.
  {
    const { root, env } = createSandbox({ prefix: "harness-check-sigterm-step-" });
    try {
      const scriptPath = join(root, "sigterm-step-target.mjs");
      const targetResults = join(root, "target-results.json");
      writeFileSync(scriptPath, `
import { runStep, main } from ${JSON.stringify(resolve(LIB_DIR, "harness.mjs"))};
import { writeFileSync } from "node:fs";
await main(async () => {
  // Long child that ignores TERM and writes its pid, so the sweep has a
  // registered group to kill while fn() is still awaiting the step.
  const step = runStep(process.execPath, ["-e",
    "const fs = require('node:fs'); if (process.env.STEP_PID_FILE) fs.writeFileSync(process.env.STEP_PID_FILE, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 500)"],
    { env: process.env, cwd: process.cwd(), timeoutMs: 120_000 });
  writeFileSync(process.env.STEP_STARTED, "1");
  const res = await step;
  return { step: { code: res.code, signal: res.signal } }; // would emit ok:true pre-fix
}, { resultsPath: ${JSON.stringify(targetResults)} });
`);
      const targetEnv = { ...env, STEP_PID_FILE: join(root, "step-pid"), STEP_STARTED: join(root, "step-started") };
      const proc = spawn(process.execPath, [scriptPath], { env: targetEnv, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
      let procStdout = "";
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (d) => { procStdout += d; });
      const startedDeadline = performance.now() + 10_000;
      while (!existsSync(targetEnv.STEP_STARTED) && performance.now() < startedDeadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const pidDeadline = performance.now() + 10_000;
      while (!existsSync(targetEnv.STEP_PID_FILE) && performance.now() < pidDeadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(existsSync(targetEnv.STEP_PID_FILE), "the in-flight step must have started (pid written)");
      const stepPid = Number(readFileSync(targetEnv.STEP_PID_FILE, "utf8").trim());
      assert.ok(aliveByProbe(stepPid), "the step child must be alive before the signal");

      proc.kill("SIGTERM"); // land while runStep is in flight
      const exit = await new Promise((resolveP) => proc.on("exit", (code2, signal2) => resolveP({ code: code2, signal: signal2 })));
      assert.equal(exit.code, 143, `interrupted in-flight runStep must exit 143, got ${JSON.stringify(exit)}`);
      const lines = procStdout.split("\n").filter((l) => l.trim() !== "");
      assert.equal(lines.length, 1, `exactly ONE stdout JSON line (no ok:true from the settled step), got: ${JSON.stringify(lines)}`);
      const summary = JSON.parse(lines[0]);
      assert.equal(summary.ok, false, "the only summary must be the interrupt summary");
      assert.equal(summary.interrupted, "SIGTERM");
      assert.equal("step" in summary, false, "the fn() result must NOT leak into the final summary");
      await new Promise((r) => setTimeout(r, TERM_LADDER_GRACE_MS));
      assert.ok(!aliveByProbe(stepPid), "the in-flight step's group must be dead");
      checks.push({ check: "main-sigterm-inflight-runstep-one-json-exit-143", ok: true, stepPid });
      strayDelta("main-sigterm-inflight-runstep-one-json-exit-143");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // --- 8e. reviewer LIB2-R2.2: forged / stale / terminal handles -------------
  console.error("[progress]", "\"8e. reviewer LIB2-R2.2: forged / stale / terminal handles\"".replace(/---/g, "").trim());

  {
    const { root, env } = createSandbox({ prefix: "harness-check-forge-" });
    try {
      // (a) A copied handle shape ({pgid, owned:true}) must be REFUSED.
      const { execPath } = process;
      const child = spawn(execPath, ["-e", "setInterval(()=>{},500)"], { env, cwd: root, detached: true, stdio: "ignore" });
      const realPgid = child.pid; // live group that is NOT ours by handle
      await new Promise((r) => setTimeout(r, 200));
      const forged = await killGroupAndVerify({ pgid: realPgid, owned: true });
      assert.equal(forged.groupEmpty, false, "forged handle must be refused");
      assert.match(forged.error, /refused/);
      assert.ok(aliveByProbe(realPgid), "forged handle must not have signalled the live group");
      // (b) A bare pgid number must still be refused.
      const bare = await killGroupAndVerify(realPgid);
      assert.equal(bare.groupEmpty, false);
      assert.match(bare.error, /refused/);
      assert.ok(aliveByProbe(realPgid), "bare pgid must not have signalled the live group");
      // (c) Terminal handles: verify-empty, then re-issue the SAME pgid via a
      // second spawn, and prove the STALE terminal handle cannot signal the
      // new group (the reviewer's pgid-reuse F39 case).
      const marker = join(root, "reuse-pid");
      const h1 = await spawnGroup(execPath, ["-e", "setInterval(()=>{},500)"], { env: { ...env, MARKER: marker }, cwd: root });
      await new Promise((r) => setTimeout(r, 300));
      const k1 = await killGroupAndVerify(h1, { termGraceMs: 1_000, killDeadlineMs: 2_000 });
      assert.equal(k1.groupEmpty, true);
      assert.equal(h1.terminal, true, "handle must be terminal after verified-empty");
      // Spin until the OS reuses h1.pgid for a NEW live child (bounded;
      // usually immediate on macOS/Linux with the old group freshly dead).
      let reused = null;
      const reuseDeadline = performance.now() + 5_000;
      while (reused === null && performance.now() < reuseDeadline) {
        const probe = spawn(execPath, ["-e", "setInterval(()=>{},500)"], { env, cwd: root, detached: true, stdio: "ignore" });
        await new Promise((r) => setTimeout(r, 150));
        if (probe.pid === h1.pgid && aliveByProbe(probe.pid)) reused = probe;
        else probe.kill("SIGKILL");
      }
      if (reused) {
        try {
          const stale = await killGroupAndVerify(h1); // terminal: must refuse
          assert.equal(stale.groupEmpty, true, "stale terminal handle must be a clean no-op");
          assert.equal(stale.error, undefined);
          assert.ok(aliveByProbe(reused.pid), "the REUSED pgid's live group must be UNTOUCHED by the stale handle");
        } finally {
          try { process.kill(-reused.pid, "SIGKILL"); } catch { /* reaping our own probe */ }
        }
        checks.push({ check: "terminal-handle-cannot-signal-reused-pgid", ok: true, reusedPgid: reused.pid });
        strayDelta("terminal-handle-cannot-signal-reused-pgid");
      } else {
        // pgid reuse not observed within the window (OS-dependent); the
        // terminal no-op path is still proven above (b/c).
        checks.push({ check: "terminal-handle-cannot-signal-reused-pgid", ok: true, reusedPgid: null, note: "pgid reuse not observed in window; terminal no-op verified" });
        strayDelta("terminal-handle-cannot-signal-reused-pgid");
      }
      // Cleanup of the (a)/(b) probe group.
      try { process.kill(-realPgid, "SIGKILL"); } catch { /* already gone */ }
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // --- 8f. reviewer LIB2-R3.3: win32 verdict mapping, EXERCISABLE anywhere --
  // The win32 branch (taskkill /T /F against the anchor pid, truthful verdict
  // mapping) is now behind an injectable seam: win32:true + taskkillRunner
  // run the EXACT branch code on any host. These checks drive FAILED and
  // successful verdicts through killGroupAndVerify AND BOTH runStep cleanup
  // paths (timeout + nominal) on THIS host. On a real win32 host the same
  // branch runs with the real taskkill (the platform default), so the
  // win32-host assertion is retained.
  {
    const { root, env } = createSandbox({ prefix: "harness-check-taskkill-" });
    try {
      const failStub = () => ({ ok: false, status: 1, error: "stubbed taskkill failure" });

      // (a) killGroupAndVerify seam: failed taskkill is NOT a green.
      const h = await spawnGroup(process.execPath, ["-e", "setInterval(()=>{},500)"], { env, cwd: root });
      const failedKill = await killGroupAndVerify(h, { win32: true, taskkillRunner: failStub });
      assert.equal(failedKill.groupEmpty, false, "a failed taskkill must NOT report groupEmpty:true");
      assert.match(failedKill.error, /taskkill failed/);
      assert.equal(h.terminal, false, "a failed taskkill must NOT mark the handle terminal");
      // Real cleanup through the normal (POSIX) ladder — the handle is still
      // authoritative and registered.
      const realDown = await killGroupAndVerify(h, { termGraceMs: 1_000, killDeadlineMs: 2_000 });
      assert.equal(realDown.groupEmpty, true);
      assert.equal(h.terminal, true);

      // (b) runStep TIMEOUT path propagates the failure verdict.
      const resTimeout = await runStep(process.execPath, ["-e", 'process.on("SIGTERM",()=>{});setInterval(()=>{},500)'], {
        env, cwd: root, timeoutMs: 800, win32: true, taskkillRunner: failStub,
      });
      assert.equal(resTimeout.timedOut, true);
      assert.equal(resTimeout.groupEmpty, false, "runStep timeout: a failed taskkill must surface as groupEmpty:false");
      assert.match(resTimeout.killError ?? "", /taskkill failed/);
      assert.ok(resTimeout.pgid, "the result must expose the anchored pgid for cleanup");
      // Real cleanup via the authoritative handle.
      const handleT = registeredHandleFor(resTimeout.pgid);
      assert.ok(handleT, "the failed-verdict handle must still be registered (non-terminal)");
      assert.equal((await killGroupAndVerify(handleT, { termGraceMs: 1_000, killDeadlineMs: 2_000 })).groupEmpty, true);

      // (c) runStep NOMINAL path propagates the failure verdict.
      const resNominal = await runStep(process.execPath, ["-e", "process.exit(0)"], {
        env, cwd: root, win32: true, taskkillRunner: failStub,
      });
      assert.equal(resNominal.code, 0);
      assert.equal(resNominal.groupEmpty, false, "runStep nominal: a failed taskkill must surface as groupEmpty:false");
      assert.match(resNominal.killError ?? "", /taskkill failed/);
      const handleN = registeredHandleFor(resNominal.pgid);
      assert.ok(handleN);
      assert.equal((await killGroupAndVerify(handleN, { termGraceMs: 1_000, killDeadlineMs: 2_000 })).groupEmpty, true);

      // (d) A SUCCESSFUL stubbed verdict maps to groupEmpty:true + terminal
      // (the mapping's green side; on POSIX the real group is then cleaned
      // through the normal ladder because the stub did not actually kill it).
      const h2 = await spawnGroup(process.execPath, ["-e", "setInterval(()=>{},500)"], { env, cwd: root });
      const okStubKill = await killGroupAndVerify(h2, { win32: true, taskkillRunner: () => ({ ok: true, status: 0 }) });
      assert.equal(okStubKill.groupEmpty, true);
      assert.equal(h2.terminal, true);
      const realDown2 = await killGroupAndVerify(h2, { termGraceMs: 1_000, killDeadlineMs: 2_000 });
      assert.equal(realDown2.groupEmpty, true, "stubbed-win32 green must still be followed by real cleanup on a POSIX host");

      if (process.platform === "win32") {
        // Real win32 host: the default (non-seam) path with the REAL taskkill.
        const h3 = await spawnGroup(process.execPath, ["-e", "setInterval(()=>{},500)"], { env, cwd: root });
        const realWin = await killGroupAndVerify(h3);
        assert.equal(realWin.groupEmpty, true, "real win32 taskkill must verify empty");
        assert.equal(h3.terminal, true);
        checks.push({ check: "win32-taskkill-real-host", ok: true });
        strayDelta("win32-taskkill-real-host");
      }
      checks.push({ check: "win32-taskkill-failure-not-a-green", ok: true, note: "verdict mapping exercised on this host via the win32 seam (failed + successful stubs, runStep timeout + nominal paths); real win32 branch retained for win32 hosts" });
      strayDelta("win32-taskkill-failure-not-a-green");
      checks.push({ check: "win32-taskkill-failure-not-a-green-contract", ok: true });
      strayDelta("win32-taskkill-failure-not-a-green-contract");
      assert.deepEqual(registeredGroups(), [], "all seam-driven handles must be reaped");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // --- 8i. Design C: anchor survives workload exit; dies only via cleanup ---
  console.error("[progress]", "\"8i. Design C: anchor survives workload exit; dies only via cleanup\"".replace(/---/g, "").trim());

  {
    const { root, env } = createSandbox({ prefix: "harness-check-anchor-life-" });
    try {
      const h = await spawnGroup(process.execPath, ["-e", "console.log('bye')"], { env, cwd: root });
      const exit = await h.exited; // the WORKLOAD exits naturally
      assert.equal(exit.code, 0);
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(aliveByProbe(h.anchor.pid), "the anchor must STILL be alive after the workload exits (the group is never leaderless while the handle lives)");
      assert.ok(registeredGroups().includes(h.pgid), "the handle must stay registered through workload exit");
      const killed = await killGroupAndVerify(h, { termGraceMs: 1_000, killDeadlineMs: 2_000 });
      assert.equal(killed.groupEmpty, true, "post-exit teardown must dissolve the group via the anchor's control channel");
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(!aliveByProbe(h.anchor.pid), "the anchor must die only via the cleanup path");
      assert.equal(h.terminal, true);
      assert.deepEqual(registeredGroups(), []);
      checks.push({ check: "anchor-survives-workload-exit-dies-via-cleanup", ok: true });
      strayDelta("anchor-survives-workload-exit-dies-via-cleanup");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // --- 8j. reviewer LIB2-R3.1: spawn failures are reaped, never blessed ----
  {
    const { root, env } = createSandbox({ prefix: "harness-check-spawn-fail-" });
    try {
      // (a) Invalid COMMAND (ENOENT): the anchor program must NOT confirm a
      // phantom pid; the handle stays non-terminal; the ladder reaps the live
      // anchor and reports the truth. No orphan, no false green.
      const hBad = await spawnGroup("/definitely/missing/binary-xyz", ["--flag"], { env, cwd: root });
      assert.equal(hBad.pid, null, "an ENOENT workload must not produce a pid");
      assert.equal(hBad.terminal, false, "a failed spawn must NOT be terminalized while its anchor may be live");
      assert.ok(hBad.pgid, "the anchor pgid exists");
      const downBad = await killGroupAndVerify(hBad, { termGraceMs: 1_000, killDeadlineMs: 2_000 });
      assert.equal(downBad.groupEmpty, true, "the failed spawn's group must be reaped through the normal ladder");
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(!aliveByProbe(hBad.pgid), "no anchor may survive a failed-spawn cleanup");
      assert.ok(!registeredGroups().includes(hBad.pgid));

      // (b) Invalid CWD: the ANCHOR fails to spawn — the caller's process
      // must NOT crash on an unhandled ChildProcess 'error' event, and the
      // verdict must be fail-closed truth (nothing provable, nothing signalled).
      const resBadCwd = await runStep(process.execPath, ["-e", "console.log(1)"], { env, cwd: "/definitely/missing/dir-xyz", timeoutMs: 10_000 });
      assert.equal(resBadCwd.code, null);
      assert.ok(resBadCwd.error, "an invalid-cwd step must surface an error, not crash");
      assert.equal(resBadCwd.groupEmpty, false, "an unprovable group must never be reported empty");
      assert.match(String(resBadCwd.killError ?? resBadCwd.error ?? ""), /fail closed|anchor/i);
      assert.deepEqual(registeredGroups(), [], "no spawn-failure handle may leak in the registry");
      checks.push({ check: "spawn-failure-reaped-never-blessed", ok: true });
      strayDelta("spawn-failure-reaped-never-blessed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // --- 8k. reviewer LIB2-R3.2: TERM is gated immediately before the signal --
  {
    const { root, env } = createSandbox({ prefix: "harness-check-term-gate-" });
    try {
      const h = await spawnGroup(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},500)"], { env, cwd: root });
      // Spy: every negative-pgid SIGNAL (TERM/KILL) this process attempts.
      const realKill = process.kill.bind(process);
      const groupSignals = [];
      process.kill = (pid, sig) => {
        if (typeof pid === "number" && pid < 0 && (sig === "SIGTERM" || sig === "SIGKILL")) {
          groupSignals.push({ pgid: -pid, sig });
        }
        return realKill(pid, sig);
      };
      try {
        // The seam: between enumeration/probes and the TERM, kill the anchor.
        const verdict = await killGroupAndVerify(h, {
          termGraceMs: 1_000, killDeadlineMs: 1_000,
          hooks: { beforeSignal: async () => { h.anchor.kill("SIGKILL"); await new Promise((r2) => setTimeout(r2, 150)); } },
        });
        assert.equal(verdict.groupEmpty, false, "an anchor that died before the TERM must yield a fail-closed verdict");
        assert.match(verdict.error, /fail closed/);
        assert.equal(groupSignals.length, 0, `ZERO negative-pgid signals may fire once the anchor is dead (got ${JSON.stringify(groupSignals)})`);
      } finally {
        process.kill = realKill;
      }
      // Check hygiene: the workload is our own descendant via the handle pid.
      try { realKill(h.pid, "SIGKILL"); } catch { /* gone */ }
      checks.push({ check: "term-gated-on-live-anchor-zero-signals", ok: true });
      strayDelta("term-gated-on-live-anchor-zero-signals");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // --- 8h. Design C: unexpected anchor death -> fail closed, zero signals --
  console.error("[progress]", "\"8h. Design C: unexpected anchor death -> fail closed, zero signals\"".replace(/---/g, "").trim());

  {
    const { root, env } = createSandbox({ prefix: "harness-check-anchor-death-" });
    try {
      const h = await spawnGroup(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},500)"], { env, cwd: root });
      // Spy: count every negative-pgid SIGNAL (TERM/KILL; sig-0 probes are
      // probes, not signals, and are permitted).
      const realKill = process.kill.bind(process);
      const groupSignals = [];
      process.kill = (pid, sig) => {
        if (typeof pid === "number" && pid < 0 && (sig === "SIGTERM" || sig === "SIGKILL")) {
          groupSignals.push({ pgid: -pid, sig });
        }
        return realKill(pid, sig);
      };
      try {
        // Kill the anchor directly (single pid — provably ours via the exact
        // ChildProcess on the handle; never a negative-pgid signal).
        h.anchor.kill("SIGKILL");
        await new Promise((r) => setTimeout(r, 400));
        assert.ok(aliveByProbe(h.pid), "the workload must still be alive after its anchor died (it is not the anchor's business to kill it)");
        const verdict = await killGroupAndVerify(h, { termGraceMs: 500, killDeadlineMs: 1_000 });
        assert.equal(verdict.groupEmpty, false, "an unexpected anchor death must NOT be reported as a green");
        assert.match(verdict.error, /fail closed/, "the verdict must name the fail-closed refusal");
        assert.equal(h.terminal, false, "a fail-closed handle stays non-terminal (the state is unresolved)");
      } finally {
        process.kill = realKill;
      }
      assert.equal(groupSignals.length, 0, `no negative-pgid signal may fire once the anchor is dead (got ${JSON.stringify(groupSignals)})`);
      // Check hygiene: the workload is our own descendant (handle.pid — a
      // single pid we spawned); clean it up with a direct pid kill.
      try { realKill(h.pid, "SIGKILL"); } catch { /* already gone */ }
      checks.push({ check: "anchor-death-fail-closed-zero-signals", ok: true });
      strayDelta("anchor-death-fail-closed-zero-signals");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  return { checks, suite: "harness.check" };
}, { resultsPath: RESULTS_PATH });
// The final object is on disk and stdout; any lingering loop holder (a dying
// anchor's pipe racing its own close) must not wedge the harness after the
// evidence is durable.
process.exit(__final && __final.ok === false ? 1 : 0);


