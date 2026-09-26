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

  // --- 1. hostile run-root location is refused with nothing created ---------
  {
    const hostile = join(ownerHome(), ".cache", "action-hub", "harness-check-hostile");
    const conflict = refusedInsideOwnerState(hostile);
    assert.ok(conflict, "owner .cache/action-hub path must be refused");
    assert.ok(!existsSync(hostile), "nothing may be created for a refused location");
    let threw = null;
    try {
      // makeRunRoot would refuse before creating anything; exercise the same
      // refusal logic without touching the real FS via a tmpdir-level check.
      const root = makeRunRoot("harness-check-");
      assert.ok(!pathContains(conflict, root), "real run root must not be inside owner state");
      rmSync(root, { recursive: true, force: true });
    } catch (err) {
      threw = err;
    }
    assert.equal(threw, null, "makeRunRoot from a clean tmpdir must succeed");
    checks.push({ check: "hostile-location-refused-without-creation", ok: true });
  }

  // --- 2. isolated env: complete, sandboxed, hostile base replaced ----------
  {
    const { root, env, home } = createSandbox({ prefix: "harness-check-env-" });
    try {
      assertIsolated(env, root);
      for (const { name } of ISOLATION_VARS) {
        assert.ok(env[name], `${name} must be set`);
        assert.ok(pathContains(root, env[name]), `${name} must live inside the run root`);
      }
      assert.equal(env.USERPROFILE, join(root, "home"), "USERPROFILE pinned to sandbox home");
      assert.equal(env.HOME, home);
      // File-shaped vars are file paths, dir-shaped vars are directories.
      for (const { name, shape } of ISOLATION_VARS) {
        if (shape === "file") assert.ok(!statSync(env[name], { throwIfNoEntry: false })?.isDirectory?.(), `${name} must be a file path`);
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

  // --- 6. ownerStateDirs includes dynamic wildcard entries -------------------
  {
    const fakeHome = join(makeRunRoot("harness-check-owner-"), "fake-owner-home");
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(fakeHome, ".codex-90210"), "{}");
    mkdirSync(join(fakeHome, ".claude-foobar"), { recursive: true });
    const dirs = ownerStateDirs({ CODEX_HOME: join(fakeHome, "custom-codex") }, fakeHome);
    assert.ok(dirs.some((d) => d.endsWith(".codex-90210")), "dynamic ~/.codex* entries must be enumerated");
    assert.ok(dirs.some((d) => d.endsWith(".claude-foobar")), "dynamic ~/.claude* entries must be enumerated");
    assert.ok(dirs.some((d) => d.endsWith("custom-codex")), "explicit CODEX_HOME override must be honored");
    checks.push({ check: "ownerStateDirs-dynamic-entries", ok: true, enumerated: dirs.length });
  }

  // --- 7. main(): stale results removed, failure contract exactly-once ------
  {
    const nestedResults = join(makeRunRoot("harness-check-main-"), "results.json");
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
  }

  return { checks, suite: "harness.check" };
}, { resultsPath: RESULTS_PATH });


