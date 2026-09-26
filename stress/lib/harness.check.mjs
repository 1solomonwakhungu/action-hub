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
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { dirname } from "node:path";

import {
  ISOLATION_VARS, FatalError, ownerHome, ownerStateDirs, pathContains,
  refusedInsideOwnerState, makeRunRoot, buildIsolatedEnv, assertIsolated,
  createSandbox, runStep, lastJsonLine, main,
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

await main(async () => {
  const checks = [];

  // --- 0. env-table single source of truth (drift check) -------------------
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

  return { checks, suite: "harness.check" };
}, { resultsPath: RESULTS_PATH });


