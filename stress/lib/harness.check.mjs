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
  spawnGroup, killGroupAndVerify, registeredGroups,
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

  // --- 8. spawnGroup: long-lived child, killGroupAndVerify ladder -----------
  {
    const { root, env } = createSandbox({ prefix: "harness-check-group-" });
    try {
      assert.deepEqual(registeredGroups(), [], "registry starts empty");
      // Long-lived child that writes its pid, then ignores TERM forever.
      const marker = join(root, "group-child-pid");
      const childCode =
        `require('node:fs').writeFileSync(process.env.MARKER, String(process.pid));` +
        `process.on('SIGTERM', () => {}); setInterval(() => {}, 500);`;
      const handle = spawnGroup(process.execPath, ["-e", childCode], { env: { ...env, MARKER: marker }, cwd: root });
      assert.equal(handle.pgid, handle.pid, "spawnGroup handle must expose the leader pid as pgid (ownership proof)");
      assert.ok(registeredGroups().includes(handle.pgid), "spawnGroup must auto-register");
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

      // F39: killing an ALREADY-EMPTY group must not signal anything.
      const gone = await killGroupAndVerify(handle);
      assert.equal(gone.groupEmpty, true, "an already-empty group verifies empty without signalling");
      assert.deepEqual(gone.survivors, []);
      checks.push({ check: "spawnGroup-killGroupAndVerify-ladder", ok: true, childPid });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // --- 8b. spawnGroup natural exit with an unref'd grandchild ----------------
  {
    const { root, env } = createSandbox({ prefix: "harness-check-group-adopt-" });
    try {
      const marker = join(root, "grandchild-pid");
      const launcherCode =
        `const { spawn } = require("node:child_process");` +
        `const g = spawn(process.execPath, ["-e", "require('node:fs').writeFileSync(process.env.MARKER, String(process.pid)); setInterval(() => {}, 500)"], { env: process.env, stdio: "ignore" });` +
        `g.unref();` +
        `const w = Date.now(); while (!require('node:fs').existsSync(process.env.MARKER) && Date.now() - w < 10000) {}`;
      const handle = spawnGroup(process.execPath, ["-e", launcherCode], { env: { ...env, MARKER: marker }, cwd: root });
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // --- 8c. main() SIGTERM: ONE interrupted JSON, groups dead, exit 143 -------
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
  const handle = spawnGroup(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 500)"], { env: process.env, cwd: process.cwd() });
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
  const handle = spawnGroup(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 500)"], { env: process.env, cwd: process.cwd() });
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  return { checks, suite: "harness.check" };
}, { resultsPath: RESULTS_PATH });


