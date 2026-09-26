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
  try {
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
      assert.ok(wall >= 2_000 && wall < 15_000, `failed after ${wall}ms; expected ~2s (no-progress window)`);
      assert.match(captured.errors.join("\n"), /did not become ready/);
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
