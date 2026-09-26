import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonStartCommand } from "../dist/commands/daemon.js";

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

async function killStub(daemonDir: string): Promise<void> {
  try {
    const state = JSON.parse(await readFile(join(daemonDir, "daemon.json"), "utf8")) as {
      pid: number;
    };
    try {
      process.kill(state.pid, "SIGKILL");
    } catch {
      // already gone
    }
  } catch {
    // state file never written
  }
}

// FX10/F25: a daemon that takes longer than the OLD fixed 15s wall but shows
// continuous progress must start successfully under the larger configurable
// cap; the CLI must print progress while waiting.
test("daemon start succeeds for a slow-but-progressing daemon beyond 15s", async () => {
  const root = await mkdtemp(join(tmpdir(), "ah-dstart-slow-"));
  const daemonDir = join(root, "daemon");
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
    await killStub(daemonDir);
    await rm(root, { recursive: true, force: true });
  }
});

// A daemon that dies during startup must fail fast (no waiting out the cap).
test("daemon start fails fast when the daemon exits during startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "ah-dstart-die-"));
  const daemonDir = join(root, "daemon");
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
      });
      const wall = Date.now() - startedAt;
      assert.equal(code, 1);
      assert.ok(wall < 10_000, `failed after ${wall}ms; expected fast failure`);
      assert.match(captured.errors.join("\n"), /exited during startup/);
    } finally {
      captured.restore();
      env.restore();
    }
  } finally {
    await killStub(daemonDir);
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
    await killStub(daemonDir);
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
