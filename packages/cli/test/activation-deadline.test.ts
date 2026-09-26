// F27 end-to-end through the REAL createSdkClientFactory adapter:
// 1) a never-initializing stdio child must not gate indexAll beyond its
//    deadline, and the spawned child must be reaped afterwards;
// 2) hub.close() BEFORE the deadline must abort the in-flight activation
//    and still reap the child.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { ActionHub, type ServerConfig } from "@action-hub/core";
import { createSdkClientFactory } from "../dist/client-factory.js";

const HERE = import.meta.dirname;
const REPO = resolve(HERE, "..", "..", "..");

function deadConfig(env: Record<string, string>): ServerConfig {
  return {
    id: "dead",
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [resolve(HERE, "fixtures", "f16-hang-server.mjs")],
      cwd: REPO,
      env,
    },
    trust: "trusted",
    timeoutMs: 1_000,
  };
}

function liveConfig(): ServerConfig {
  return {
    id: "f16",
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [resolve(HERE, "fixtures", "f16-server.mjs")],
      cwd: REPO,
      env: { F16_MODE: "ok_then_exit" },
    },
    trust: "trusted",
  };
}

function assertChildGone(pidFile: string, waitMs = 8_000): void {
  const deadline = Date.now() + waitMs;
  let pid = NaN;
  while (Date.now() < deadline) {
    if (existsQuiet(pidFile)) {
      pid = Number(readFileSync(pidFile, "utf8"));
      if (!pidAlive(pid)) return; // reaped
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  assert.ok(!pidAlive(pid), `child ${pid} must be reaped`);
}
function existsQuiet(p: string): boolean {
  try { readFileSync(p); return true; } catch { return false; }
}
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("never-initializing stdio child: indexAll completes at the deadline, child reaped", async () => {
  const scratch = mkdtempSync(`${tmpdir()}/f27-`);
  let closed = false;
  const hub = new ActionHub({
    servers: [deadConfig({ F16_PID_FILE: resolve(scratch, "pid") }), liveConfig()],
    clientFactory: createSdkClientFactory(),
    resilience: { failureThreshold: 3, cooldownMs: 3_000, heartbeat: { enabled: false } },
    defaultTimeoutMs: 5_000,
  });
  try {
    const t0 = Date.now();
    const results = await hub.indexAll();
    const elapsed = Date.now() - t0;
    const dead = results.find((r) => r.serverId === "dead")!;
    const live = results.find((r) => r.serverId === "f16")!;
    assert.equal(live.indexed, 1, "healthy server indexed");
    assert.match(dead.error ?? "", /timed out|aborted|closed/i);
    assert.ok(elapsed < 5_000, `indexAll took ${elapsed}ms — must complete near the deadline`);
    const [deadState] = hub.serverStates().filter((s) => s.id === "dead");
    assert.equal(deadState!.status, "unreachable");
    // The manager keeps retrying a dead server on its backoff schedule (by
    // design), so a child may legitimately be mid-flight at any instant.
    // The teardown property is deterministic: after close() no child of
    // THIS server survives.
    await hub.close();
    assertChildGone(resolve(scratch, "pid"));
    closed = true;
  } finally {
    if (!closed) await hub.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("hub.close() before the deadline aborts the in-flight activation and reaps the child", async () => {
  const scratch = mkdtempSync(`${tmpdir()}/f27b-`);
  const hub = new ActionHub({
    servers: [deadConfig({ F16_PID_FILE: resolve(scratch, "pid") })],
    clientFactory: createSdkClientFactory(),
    resilience: { failureThreshold: 3, cooldownMs: 3_000, heartbeat: { enabled: false } },
    defaultTimeoutMs: 5_000,
  });
  try {
    const indexing = hub.indexAll(); // activation in flight (1s deadline)
    await new Promise((r) => setTimeout(r, 200)); // child spawned, initialize pending
    const t0 = Date.now();
    await hub.close(); // must abort the activation, not wait for the deadline
    const closeMs = Date.now() - t0;
    assert.ok(closeMs < 4_000, `close took ${closeMs}ms — must not wait out the deadline`);
    await indexing.catch(() => {});
    assertChildGone(resolve(scratch, "pid"));
  } finally {
    await hub.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
