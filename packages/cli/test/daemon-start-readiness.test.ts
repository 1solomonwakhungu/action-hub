import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";
import { daemonStartCommand } from "../dist/commands/daemon.js";
import { spawnAnchor, startGuardedRetryLoop } from "../dist/commands/process-anchor.js";
import { classifyReadyAnswer } from "../dist/commands/daemon.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const stub = resolve(testDir, "fixtures/stub-daemon.mjs");

function captureConsole(): { logs: string[]; errors: string[]; restore: () => void } {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => void logs.push(args.join(" "));
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
  return {
    logs,
    errors,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

function stubEnv(vars: Record<string, string>): { restore: () => void } {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  return {
    restore: () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

/** Escalates to SIGKILL only after a bounded wait, and re-verifies death. */
async function reapOwnedPids(ownedPids: number[]): Promise<void> {
  for (const pid of ownedPids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  const verify = async (): Promise<number[]> =>
    ownedPids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  const deadline = Date.now() + 5_000;
  let alive = await verify();
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    alive = await verify();
  }
  // Final escalation: SIGKILL stragglers, then RE-VERIFY they died.
  for (const pid of alive) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  if (alive.length > 0) {
    const kDeadline = Date.now() + 5_000;
    do {
      await new Promise((r) => setTimeout(r, 250));
      alive = await verify();
    } while (alive.length > 0 && Date.now() < kDeadline);
  }
  assert.deepEqual(alive, [], `owned processes survived cleanup: ${alive.join(", ")}`);
}

/** Kills only PIDs THIS test spawned, then asserts they are all dead. */
async function cleanupSpawned(daemonDir: string, spawnedPids: number[]): Promise<void> {
  // SIGTERM first: the anchor runs its own gated group cleanup (SIGKILLing
  // the anchor directly would orphan the wrapper and the server).
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  const pollDeadline = Date.now() + 5_000;
  let survivors: number[] = [];
  do {
    await new Promise((r) => setTimeout(r, 250));
    survivors = spawnedPids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  } while (survivors.length > 0 && Date.now() < pollDeadline);
  // Last resort: SIGKILL whatever of OUR spawns is still alive.
  for (const pid of survivors) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  assert.deepEqual(survivors, [], `spawned processes survived: ${survivors.join(", ")}`);
  // The test runner itself must survive every cleanup (F39 regression guard).
  assert.doesNotThrow(() => process.kill(process.pid, 0));
}

// FX10/F25: a daemon that takes longer than the OLD fixed 15s wall but shows
// continuous progress must start successfully under the larger configurable
// cap; the CLI must print progress while waiting.
test("daemon start succeeds for a slow-but-progressing daemon beyond 15s", async () => {
  const root = await mkdtemp(join(tmpdir(), "ah-dstart-slow-"));
  const daemonDir = join(root, "daemon");
  const spawnedPids: number[] = [];
  try {
    const env = stubEnv({ SLOW_MS: "16000" });
    const captured = captureConsole();
    try {
      const startedAt = Date.now();
      const code = await daemonStartCommand({
        daemonDir,
        entryPath: stub,
        startTimeoutMs: 30_000,
        configPath: join(root, "servers.json"),
        onSpawn: (pid) => void spawnedPids.push(pid),
      });
      const wall = Date.now() - startedAt;
      assert.equal(code, 0, `expected start success, got ${code}; stderr=${captured.errors.join("\n")}`);
      assert.ok(wall >= 16_000, `daemon became ready at ${wall}ms; expected > 15s (old fixed wall)`);
      assert.ok(wall < 25_000, `start took ${wall}ms; expected well under the 30s cap`);
      assert.match(captured.logs.join("\n"), /Waiting for Action Hub daemon/);
      // The stub's progress lines go to the daemon log file (stdio is redirected).
      const daemonLog = await readFile(join(daemonDir, "daemon.log"), "utf8");
      assert.match(daemonLog, /still booting/);
    } finally {
      captured.restore();
      env.restore();
    }
  } finally {
    await cleanupSpawned(daemonDir, spawnedPids);
    await rm(root, { recursive: true, force: true });
  }
});

// A daemon that dies during startup must fail fast (no waiting out the cap).
test("daemon start fails fast when the daemon exits during startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "ah-dstart-die-"));
  const daemonDir = join(root, "daemon");
  const spawnedPids: number[] = [];
  try {
    const env = stubEnv({ DIE_MS: "2000" });
    const captured = captureConsole();
    try {
      const startedAt = Date.now();
      const code = await daemonStartCommand({
        daemonDir,
        entryPath: stub,
        startTimeoutMs: 60_000,
        configPath: join(root, "servers.json"),
        onSpawn: (pid) => void spawnedPids.push(pid),
      });
      const wall = Date.now() - startedAt;
      assert.equal(code, 1);
      assert.ok(wall < 10_000, `failed after ${wall}ms; expected fast failure`);
      assert.match(captured.errors.join("\n"), /exited during startup/);
      assert.equal(spawnedPids.length, 1, "start must report the spawned anchor PID");
    } finally {
      captured.restore();
      env.restore();
    }
  } finally {
    await cleanupSpawned(daemonDir, spawnedPids);
    await rm(root, { recursive: true, force: true });
  }
});

// A daemon that stays alive but shows no progress must fail within the
// no-progress window (configured short here), not the full cap.
test("daemon start fails on a silent daemon after the no-progress window", async () => {
  const root = await mkdtemp(join(tmpdir(), "ah-dstart-silent-"));
  const daemonDir = join(root, "daemon");
  const savedNoProgress = process.env["ACTION_HUB_DAEMON_NO_PROGRESS_TIMEOUT_MS"];
  process.env["ACTION_HUB_DAEMON_NO_PROGRESS_TIMEOUT_MS"] = "2000";
  const env = stubEnv({ SILENT: "1" });
  // The silent daemon never writes daemon.json, so the ONLY evidence of the
  // detached child is the PID captured at spawn. The failed start must have
  // terminated and reaped it before returning (no orphans).
  const spawnedPids: number[] = [];
  try {
    const captured = captureConsole();
    try {
      const startedAt = Date.now();
      const code = await daemonStartCommand({
        daemonDir,
        entryPath: stub,
        startTimeoutMs: 60_000,
        configPath: join(root, "servers.json"),
        onSpawn: (pid) => void spawnedPids.push(pid),
      });
      const wall = Date.now() - startedAt;
      assert.equal(code, 1);
      assert.ok(wall >= 2_000 && wall < 15_000, `failed after ${wall}ms; expected ~2s (no-progress window)`);
      assert.match(captured.errors.join("\n"), /did not become ready/);
      assert.equal(spawnedPids.length, 1, "the detached stub must have been spawned exactly once");
      const isAlive = (): boolean => {
        try {
          process.kill(spawnedPids[0]!, 0);
          return true;
        } catch {
          return false;
        }
      };
      assert.equal(isAlive(), false, `spawned silent daemon pid ${spawnedPids[0]} survived the failed start`);
      await assert.rejects(readFile(join(daemonDir, "daemon.json"), "utf8"), { code: "ENOENT" });
    } finally {
      captured.restore();
      env.restore();
    }
  } finally {
    if (savedNoProgress === undefined) delete process.env["ACTION_HUB_DAEMON_NO_PROGRESS_TIMEOUT_MS"];
    else process.env["ACTION_HUB_DAEMON_NO_PROGRESS_TIMEOUT_MS"] = savedNoProgress;
    await cleanupSpawned(daemonDir, spawnedPids);
    await rm(root, { recursive: true, force: true });
  }
});

// Reviewer-1 (PR 70 rework round 2): a daemon entry that spawns a same-group
// TERM-ignoring grandchild and then EXITS on its own must not leak the
// grandchild: killAndReapSpawned must verify whole-GROUP death, not just the
// direct child's exit.
test("failed start reaps the process group even when the daemon exits on its own", async () => {
  const root = await mkdtemp(join(tmpdir(), "ah-dstart-tree-"));
  const daemonDir = join(root, "daemon");
  const pidFile = join(root, "recorded-pids.txt");
  await writeFile(pidFile, "");
  const savedPidFile = process.env["TREE_PIDS_FILE"];
  process.env["TREE_PIDS_FILE"] = pidFile;
  try {
    const captured = captureConsole();
    let spawnedPid: number | undefined;
    try {
      const startedAt = Date.now();
      const code = await daemonStartCommand({
        daemonDir,
        entryPath: resolve(testDir, "fixtures/exiting-daemon-with-grandchild.mjs"),
        startTimeoutMs: 60_000,
        configPath: join(root, "servers.json"),
        onSpawn: (pid) => void (spawnedPid = pid),
      });
      const wall = Date.now() - startedAt;
      assert.equal(code, 1);
      assert.ok(wall < 15_000, `failed after ${wall}ms; expected the child-exit fast path`);
      assert.ok(spawnedPid, "start must report the spawned daemon PID");

      const recordedPids = (await readFile(pidFile, "utf8"))
        .split("\n")
        .map((l) => Number.parseInt(l.trim(), 10))
        .filter((n) => Number.isSafeInteger(n) && n > 0);
      assert.equal(recordedPids.length, 2, `expected daemon + grandchild PIDs, got ${recordedPids.join(", ")}`);

      const isAlive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const pollDeadline = Date.now() + 8_000;
      let survivors = recordedPids.filter(isAlive);
      while (survivors.length > 0 && Date.now() < pollDeadline) {
        await new Promise((r) => setTimeout(r, 250));
        survivors = recordedPids.filter(isAlive);
      }
      assert.deepEqual(survivors, [], `process group survived the failed start: ${survivors.join(", ")}`);
    } finally {
      captured.restore();
    }
  } finally {
    if (savedPidFile === undefined) delete process.env["TREE_PIDS_FILE"];
    else process.env["TREE_PIDS_FILE"] = savedPidFile;
    await rm(root, { recursive: true, force: true });
  }
});

// PR 77 rework round 5: an anchor EXIT_FAILED proof must NEVER take the
// concurrent-winner success path. The orphaned server of THIS failed start
// answers the ready probe; the old code reported "already running" and exit 0.
test("a failed anchor proof never yields the concurrent-winner success path", async () => {
  const root = await mkdtemp(join(tmpdir(), "ah-dstart-victim-"));
  const daemonDir = join(root, "daemon");
  const pidFile = join(root, "recorded-pids.txt");
  await writeFile(pidFile, "");
  const env = stubEnv({ TREE_PIDS_FILE: pidFile });
  const ownedPids: number[] = [];
  const captured = captureConsole();
  try {
    const startPromise = daemonStartCommand({
      daemonDir,
      entryPath: resolve(testDir, "fixtures/wrapper-victim-daemon.mjs"),
      startTimeoutMs: 30_000,
      configPath: join(root, "servers.json"),
      onSpawn: (pid) => void ownedPids.push(pid),
    });
    // Kill ONLY the wrapper as soon as the fixture reports its PPID, exactly
    // like the reviewer's manual repro (kill after daemon start, before the
    // child-exit path is considered).
    // ACK-based wait (never a fixed wall under load): the fixture writes
    // <pidFile>.ack only AFTER its pid record is durably written.
    const ackDeadline = Date.now() + 30_000;
    for (;;) {
      let ackExists = false;
      try {
        await readFile(`${pidFile}.ack`);
        ackExists = true;
      } catch {}
      if (ackExists || Date.now() > ackDeadline) {
        assert.ok(ackExists, "fixture must ack its pid record (30s generous bound)");
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    let wrapperKilled = false;
    {
      const lines = (await readFile(pidFile, "utf8")).split("\n");
      const ppidLine = lines.find((l) => /^PPID:\d+$/.test(l.trim()));
      assert.ok(ppidLine, "fixture must report the wrapper PID");
      const wrapperPid = Number.parseInt(ppidLine!.trim().slice(5), 10);
      process.kill(wrapperPid, "SIGKILL");
      wrapperKilled = true;
    }
    assert.ok(wrapperKilled);
    const code = await startPromise;
    assert.equal(code, 1, `expected fail-closed exit 1, got 0 (false green winner path)`);
  } finally {
    // Cleanup MUST run even when the regression is red: restore env, kill
    // only the exact PIDs this test owns (the orphaned server included).
    // The fixture records SERVER:<pid> and PPID:<wrapper> in pidFile.
    try {
      const recorded = (await readFile(pidFile, "utf8")).split("\n");
      for (const line of recorded) {
        const m = line.match(/^SERVER:(\d+)$/);
        if (m) ownedPids.push(Number.parseInt(m[1]!, 10));
      }
    } catch {}
    await reapOwnedPids(ownedPids);
    env.restore();
    captured.restore();
    await rm(root, { recursive: true, force: true });
  }
});


// PR 77 rework round 6: the timeout/no-progress break must ALSO tear down and
// consult the proof BEFORE the sibling winner probe — otherwise the orphan
// from this failed start satisfies "already running" during the grace window.
test("timeout path tears down before consulting the winner probe", async () => {
  const root = await mkdtemp(join(tmpdir(), "ah-dstart-timeout-"));
  const daemonDir = join(root, "daemon");
  const pidFile = join(root, "recorded-pids.txt");
  await writeFile(pidFile, "");
  // The wrapper must die only AFTER the no-progress break (400ms): the OLD
  // code prints "did not become ready" and then probes the winner for 5s —
  // the kill lands inside that grace, the fixture orphans and becomes ready,
  // and the old code reports "already running" (exit 0). The fixed code tears
  // down at the break BEFORE any probe; the late kill is a no-op there.
  const env = stubEnv({ TREE_PIDS_FILE: pidFile, ACTION_HUB_DAEMON_NO_PROGRESS_TIMEOUT_MS: "400" });
  const ownedPids: number[] = [];
  const captured = captureConsole();
  try {
    const startPromise = daemonStartCommand({
      daemonDir,
      entryPath: resolve(testDir, "fixtures/wrapper-victim-daemon.mjs"),
      startTimeoutMs: 30_000,
      configPath: join(root, "servers.json"),
      onSpawn: (pid) => void ownedPids.push(pid),
    });
    // EVENT-based wait (never a fixed wall under load): the no-progress
    // break is the true gate — under heavy load the teardown can beat the
    // fixture's boot entirely, so a fixture-startup ack is NOT a reliable
    // sync point here. 30s generous bound.
    const breakDeadline2 = Date.now() + 30_000;
    for (;;) {
      if (captured.errors.join("\n").includes("did not become ready")) break;
      if (Date.now() > breakDeadline2) assert.fail("start must hit the no-progress break (30s generous bound)");
      await new Promise((r) => setTimeout(r, 10));
    }
    // Late kill of the wrapper (best-effort no-op): use the fixture's pid
    // record if the fixture got to run at all; under load it may never have
    // started before the teardown — that is fine, the proof-gated winner
    // probe below is exercised either way.
    try {
      const lines = (await readFile(pidFile, "utf8")).split("\n");
      const ppidLine = lines.find((l) => /^PPID:\d+$/.test(l.trim()));
      const wrapperPid = ppidLine ? Number.parseInt(ppidLine.trim().slice(5), 10) : undefined;
      if (wrapperPid) process.kill(wrapperPid, "SIGKILL");
    } catch {
      // fixture never ran / tree already torn down — acceptable
    }
    const code = await startPromise;
    assert.equal(code, 1, `expected fail-closed exit 1, got 0 (orphan satisfied the winner probe)`);
  } finally {
    try {
      const recorded = (await readFile(pidFile, "utf8")).split("\n");
      for (const line of recorded) {
        const m = line.match(/^SERVER:(\d+)$/);
        if (m) ownedPids.push(Number.parseInt(m[1]!, 10));
      }
    } catch {}
    await reapOwnedPids(ownedPids);
    env.restore();
    captured.restore();
    await rm(root, { recursive: true, force: true });
  }
});

// PR 77 rework round 10 (reviewer-1 P1): SIGKILLing ONLY the anchor must not
// orphan the detached wrapper or the server. The wrapper holds a control pipe
// whose write end lives only inside the anchor; on EOF it tears down its own
// group (TERM -> SIGKILL) boundedly. Both deaths are observed by exact PID.
test("SIGKILLing only the anchor leaves no orphaned wrapper or server", async () => {
  const root = await mkdtemp(join(tmpdir(), "ah-anchor-orphan-"));
  const pidFile = join(root, "pids.txt");
  await writeFile(pidFile, "");
  const env = stubEnv({ TREE_PIDS_FILE: pidFile });
  const ownedPids: number[] = [];
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  try {
    const anchor = spawnAnchor("daemon", process.execPath, [
      resolve(testDir, "fixtures/orphan-probe-server.mjs"),
    ], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env },
    });
    assert.ok(anchor.pid);
    ownedPids.push(anchor.pid);
    // Wait for the fixture to report the exact wrapper and server PIDs.
    const reportDeadline = Date.now() + 15_000;
    let serverPid = 0;
    let wrapperPid = 0;
    while (Date.now() < reportDeadline) {
      try {
        const lines = (await readFile(pidFile, "utf8")).split("\n").map((l) => l.trim());
        const s = lines.find((l) => /^SERVER:\d+$/.test(l));
        const w = lines.find((l) => /^PPID:\d+$/.test(l));
        if (s && w) {
          serverPid = Number.parseInt(s.slice(7), 10);
          wrapperPid = Number.parseInt(w.slice(5), 10);
          break;
        }
      } catch {
        // not written yet
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(serverPid && wrapperPid, "fixture must report wrapper+server PIDs in time");
    ownedPids.push(wrapperPid, serverPid);
    assert.ok(alive(wrapperPid) && alive(serverPid), "wrapper and server must be alive before the kill");
    // THE regression: kill ONLY the anchor, exactly like the reviewer's repro.
    process.kill(anchor.pid!, "SIGKILL");
    const deadDeadline = Date.now() + 5_000;
    let bothDead = false;
    while (Date.now() < deadDeadline) {
      if (!alive(wrapperPid) && !alive(serverPid)) { bothDead = true; break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(bothDead, `wrapper ${wrapperPid} and server ${serverPid} must die boundedly after the anchor is SIGKILLed (orphaned)`);
  } finally {
    await reapOwnedPids(ownedPids);
    env.restore();
    await rm(root, { recursive: true, force: true });
  }
});

// The wrapper must be structurally anchor-only: a direct argv invocation has
// no control pipe and no token, and must refuse BEFORE spawning any server.
test("__wrapper-run refuses direct (unauthenticated) invocation", () => {
  const distIndex = resolve(testDir, "../dist/index.js");
  const result = spawnSync(process.execPath, [
    distIndex,
    "__wrapper-run",
    process.execPath,
    "-e",
    "setInterval(() => {}, 1000)",
  ], { timeout: 15_000, encoding: "utf8" });
  assert.equal(result.status, 2, `expected refusal exit 2, got ${result.status}; stderr: ${result.stderr}`);
  assert.match(String(result.stderr), /cannot be invoked directly/);
});

// PR 77 rework round 13 (reviewer-1/intake): the injected regression drives
// the REAL production retry loop — winSelfTeardownLoop, the exact function
// runWrapperProcess's win32 selfTeardown calls — with an always-failing
// kill attempt and a never-dying server. It proves: bounded attempts end in
// ONE guarded retry chain (rate stays single-chain even under repeated
// exhaust() activation), the warning fires exactly once, and the wrapper
// NEVER exits while the server is alive. A second scenario flips the server
// dead and asserts exit(4) fires exactly once.
test("win32 exhausted teardown: single guarded retry chain, warn once, never exits while server alive", async () => {
  const { winSelfTeardownLoop } = await import("../dist/commands/process-anchor.js");
  let attempts = 0;
  let warns = 0;
  let exits: number[] = [];
  const loop = winSelfTeardownLoop({
    serverDead: () => false, // the always-failing / unkillable-server fault
    taskkillExit: () => -1, // taskkill always fails
    attempt: () => { attempts++; },
    exit: (code) => { exits.push(code); },
    writeErr: () => { warns++; },
    verifyDelayMs: 5,
    maxBoundedAttempts: 3,
    retryIntervalMs: 20,
  });
  await new Promise((r) => setTimeout(r, 110));
  const firstWindow = attempts;
  // Repeated activation must be a no-op (the old fanout created a NEW
  // interval on every verifier tick reaching the exhausted branch).
  for (let i = 0; i < 10; i++) loop.exhaust();
  await new Promise((r) => setTimeout(r, 110));
  const secondWindow = attempts - firstWindow;
  loop.stop();
  assert.equal(warns, 1, `warning must fire exactly once, got ${warns}`);
  assert.equal(exits.length, 0, "wrapper must never exit while the server is alive");
  assert.ok(firstWindow >= 4, `bounded chain + retry must run (first window ${firstWindow})`);
  // 110ms at 20ms interval = ~5-6 attempts from ONE chain; the old fanout
  // (new interval per exhausted verifier) would multiply the rate.
  assert.ok(secondWindow <= 8, `single retry chain: ${secondWindow} attempts in the second window (fanout would exceed)`);
});

test("win32 exhausted teardown: exits 4 exactly once once the server is verified dead", async () => {
  const { winSelfTeardownLoop } = await import("../dist/commands/process-anchor.js");
  let attempts = 0;
  let exits: number[] = [];
  const loop = winSelfTeardownLoop({
    serverDead: () => attempts >= 4, // server verified dead after 4 attempts
    taskkillExit: () => 0, // the tree sweep reported success
    attempt: () => { attempts++; },
    exit: (code) => { exits.push(code); },
    writeErr: () => {},
    verifyDelayMs: 5,
    maxBoundedAttempts: 3,
    retryIntervalMs: 20,
  });
  await new Promise((r) => setTimeout(r, 400));
  loop.stop();
  assert.deepEqual(exits, [4], `must exit 4 exactly once, got ${JSON.stringify(exits)}`);
});

// PR 77 rework round 14 (reviewer-1 MUST-FIX): a direct-child PID is NOT
// tree-death proof. Fault: the direct server dies EARLY but a grandchild
// survives (unobservable to the wrapper) and every taskkill fails. The
// wrapper must NOT exit(4) on the direct child's death — the guarded
// taskkill chain must keep running — and may only exit after a SUCCESSFUL
// tree sweep. Scenario A: server dead from attempt 2, taskkill always
// fails -> no exit ever, chain keeps attempting.
test("win32 parent loss: direct server death without a proven tree sweep never exits", async () => {
  const { winSelfTeardownLoop } = await import("../dist/commands/process-anchor.js");
  let attempts = 0;
  let exits: number[] = [];
  const loop = winSelfTeardownLoop({
    serverDead: () => attempts >= 2, // direct server dies early...
    taskkillExit: () => -1,          // ...but every taskkill FAILS (grandchild alive, unobservable)
    attempt: () => { attempts++; },
    exit: (code) => { exits.push(code); },
    writeErr: () => {},
    verifyDelayMs: 5,
    maxBoundedAttempts: 3,
    retryIntervalMs: 20,
  });
  await new Promise((r) => setTimeout(r, 300));
  const before = attempts;
  await new Promise((r) => setTimeout(r, 200));
  loop.stop();
  assert.equal(exits.length, 0, `must NOT exit on direct-child death without tree proof, got exits=${JSON.stringify(exits)}`);
  assert.ok(attempts > before, "guarded chain must keep attempting while the tree is unproven");
});

// Scenario B: same fault shape, but the tree sweep eventually SUCCEEDS
// (taskkill exit 0) -> exit(4) fires exactly once and the chain stops.
test("win32 parent loss: exits 4 only after a successful tree sweep", async () => {
  const { winSelfTeardownLoop } = await import("../dist/commands/process-anchor.js");
  let attempts = 0;
  let exits: number[] = [];
  const loop = winSelfTeardownLoop({
    serverDead: () => attempts >= 2,
    taskkillExit: () => (attempts >= 6 ? 0 : -1), // sweep succeeds only on a later attempt
    attempt: () => { attempts++; },
    exit: (code) => { exits.push(code); },
    writeErr: () => {},
    verifyDelayMs: 5,
    maxBoundedAttempts: 3,
    retryIntervalMs: 20,
  });
  await new Promise((r) => setTimeout(r, 400));
  loop.stop();
  assert.deepEqual(exits, [4], `must exit 4 exactly once after the tree sweep succeeds, got ${JSON.stringify(exits)}`);
});


/** Best-effort probe mirroring the CLI's own readiness probe (state + token
 * files, TCP status request). Used by the F63 ordering-seam regression to
 * prove the fail-closed teardown removed OUR answering tree. */
async function daemonReadyEcho(daemonDir: string): Promise<boolean> {
  try {
    const state = JSON.parse(await readFile(join(daemonDir, "daemon.json"), "utf8")) as {
      endpoint?: { kind?: string; host?: string; port?: number; path?: string };
    };
    const token = (await readFile(join(daemonDir, "auth-token"), "utf8")).trim();
    const endpoint = state.endpoint;
    if (!endpoint || endpoint.kind !== "tcp" || !endpoint.port) return false;
    return await new Promise<boolean>((resolveDone) => {
      const socket = connect(endpoint.port!, "127.0.0.1", () => {
        socket.write(`${JSON.stringify({ token, command: "status" })}\n`);
      });
      const timer = setTimeout(() => { socket.destroy(); resolveDone(false); }, 1000);
      socket.once("data", (chunk) => {
        clearTimeout(timer);
        try {
          resolveDone((JSON.parse(chunk.toString().split("\n")[0]!) as { ok?: boolean }).ok === true);
        } catch {
          resolveDone(false);
        }
        socket.destroy();
      });
      socket.once("error", () => { clearTimeout(timer); resolveDone(false); });
    });
  } catch {
    return false;
  }
}

// F63 deterministic winner check (intake ruling, token-based): the launch
// token is PROBE-CARRIED (our daemon echoes ACTION_HUB_LAUNCH_TOKEN into
// its state at boot and the probe reads it synchronously with the answer),
// so identity has NO dependency on relay/event delivery timing. The only
// remaining liveness input is a synchronous wrapper liveness syscall via
// the anchor's WRAPPER relay — and when that relay has not delivered yet,
// classification is UNDECIDED (never a guessed winner), per the reviewer's
// MUST-FIX: "when readiness arrives before identity, do not decide winner
// until the spawned attempt's identity is resolved or the attempt reaches
// a proof-checked terminal state."
test("F63 identity classification is deterministic under the token probe", async () => {
  const { classifyReadyAnswer } = await import("../dist/commands/daemon.js");
  // Ours + wrapper verifiably dead (synchronous ESRCH) -> unproven orphan
  // -> failure path, regardless of the anchor's exit-event delivery.
  assert.equal(classifyReadyAnswer("tok-ours", "tok-ours", false, false), "ours-unproven");
  assert.equal(classifyReadyAnswer("tok-ours", "tok-ours", false, true), "ours-unproven");
  // Ours + wrapper provably alive + anchor not exited -> the healthy start.
  assert.equal(classifyReadyAnswer("tok-ours", "tok-ours", true, false), "ours-healthy");
  // Ours + anchor definitively exited -> unproven.
  assert.equal(classifyReadyAnswer("tok-ours", "tok-ours", true, true), "ours-unproven");
  // THE REVIEWER'S ORDERING SEAM: readiness arrived while the wrapper relay
  // is still undelivered -> UNDECIDED, never a guessed winner and never an
  // assumed-alive success.
  assert.equal(classifyReadyAnswer("tok-ours", "tok-ours", "unknown", false), "undecided");
  assert.equal(classifyReadyAnswer("tok-ours", "tok-ours", "unknown", true), "ours-unproven");
  // A different or missing token is a foreign winner regardless of our
  // anchor's state (identity rides the probe itself, so a foreign answer
  // needs no relay at all).
  assert.equal(classifyReadyAnswer(undefined, "tok-ours", "unknown", false), "winner");
  assert.equal(classifyReadyAnswer("tok-other", "tok-ours", true, true), "winner");
});

// F63 integrated ordering-seam regression (reviewer MUST-FIX): the anchor's
// WRAPPER relay delivery is HELD past the first ready probe (via the
// ANCHOR_TEST_RELAY_DELAY_MS test-only seam). The ready responder IS our
// tree (it echoes our launch token), and the old code assumed the wrapper
// was alive and took the success path. The fixed code must NOT decide a
// winner on unresolved identity: with the relay held, the start can only
// resolve through identity delivery (healthy) or the fail-closed cap.
test("F63: with the WRAPPER relay held, a ready ours-token answer never takes the winner-success path", async () => {
  const root = await mkdtemp(join(tmpdir(), "ah-dstart-heldrelay-"));
  const daemonDir = join(root, "daemon");
  const ownedPids: number[] = [];
  // The stub becomes ready fast (SLOW_MS=50) while the HOST's relay
  // listener is held for the whole window (reviewer repro shape).
  const env = stubEnv({ SLOW_MS: "50", ACTION_HUB_TEST_RELAY_HOLD_MS: "120000" });
  const captured = captureConsole();
  try {
    const startedAt = Date.now();
    // Short cap: the ready probe answers almost immediately (the stub echoes
    // our token), but identity is UNRESOLVED the whole time. The old code
    // returned 0 within milliseconds (false green); the fixed code must hold
    // the decision and resolve fail-closed at the cap.
    const code = await daemonStartCommand({
      daemonDir,
      entryPath: stub,
      startTimeoutMs: 4_000,
      configPath: join(root, "servers.json"),
      onSpawn: (pid) => void ownedPids.push(pid),
    });
    const wall = Date.now() - startedAt;
    assert.equal(code, 1, `held-relay start must fail closed, got exit ${code} (winner-success false green)`);
    assert.ok(wall >= 3_500, `start returned after ${wall}ms; expected it to wait for identity resolution, not decide early`);
    // The ready responder was OUR tree (the stub echoes our launch token) —
    // prove the fail-closed teardown removed it: after the cap the daemon
    // must no longer answer (the sibling winner probe must NOT be satisfied
    // by our own torn-down tree).
    assert.equal(await daemonReadyEcho(daemonDir), false, "our torn-down tree must not still answer after fail-closed teardown");
    assert.match(captured.errors.join("\n"), /did not become ready|teardown failed closed/);
  } finally {
    await cleanupSpawned(daemonDir, ownedPids);
    env.restore();
    captured.restore();
    await rm(root, { recursive: true, force: true });
  }
});

// F63 ordering-seam control: once the held relay DELIVERS (identity
// resolved), the ours-token answer classifies deterministically and a
// healthy start succeeds — the seam must not turn a healthy start into a
// permanent failure.
test("F63: once the held WRAPPER relay delivers, a healthy ours-token start succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "ah-dstart-relaylate-"));
  const daemonDir = join(root, "daemon");
  const ownedPids: number[] = [];
  const env = stubEnv({ SLOW_MS: "50", ACTION_HUB_TEST_RELAY_HOLD_MS: "1200" });
  const captured = captureConsole();
  try {
    const startedAt = Date.now();
    const code = await daemonStartCommand({
      daemonDir,
      entryPath: stub,
      startTimeoutMs: 30_000,
      configPath: join(root, "servers.json"),
      onSpawn: (pid) => void ownedPids.push(pid),
    });
    const wall = Date.now() - startedAt;
    assert.equal(code, 0, `healthy start with a 1.2s-delayed relay must succeed, got ${code}`);
    assert.ok(wall >= 1_100, `start returned at ${wall}ms; expected it to wait for the delayed relay`);
    assert.match(captured.logs.join("\n"), /Action Hub daemon started/);
  } finally {
    await cleanupSpawned(daemonDir, ownedPids);
    env.restore();
    captured.restore();
    await rm(root, { recursive: true, force: true });
  }
});