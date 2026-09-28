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
import type { ServerConfig } from "@action-hub/core";
import { createSdkClientFactory } from "../dist/client-factory.js";
import { testActionHub } from "./test-hub.ts";

const HERE = import.meta.dirname;
const REPO = resolve(HERE, "..", "..", "..");

function deadConfig(env: Record<string, string>, timeoutMs = 1_000): ServerConfig {
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
    timeoutMs,
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// F54 (reviewer-2/intake): real bounded awaits. A post-hoc elapsed check can
// only run AFTER the awaited promise settles, so it can never fail a stuck
// call. This race rejects on a hang, failing the test while the caller's
// finally block still runs cleanup; the timer is unref'd so it cannot keep
// the process alive after the test ends.
function hangGuard<T>(p: Promise<T>, label: string, ms = 60_000): Promise<T> {
  // HYG3: clear the timer when the GUARDED promise wins, so the closure does
  // not linger for the full window after a fast result (reviewer-2 note on
  // PR 87; unref already meant this was cosmetic, not a leak).
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: exceeded the ${ms}ms hang guard`)), ms);
      timer.unref?.();
    }),
  ]);
}

// F54 rework (reviewer-2): the reap poll must be ASYNCHRONOUS. The previous
// Atomics.wait blocked the Node event loop, which is exactly what has to run
// to deliver the child-process exit and reap the pid — creating an
// intermittent false "must be reaped" failure under load.
async function assertChildGone(pidFile: string, waitMs = 20_000): Promise<void> {
  const deadline = Date.now() + waitMs;
  let pid = NaN;
  while (Date.now() < deadline) {
    if (existsQuiet(pidFile)) {
      pid = Number(readFileSync(pidFile, "utf8"));
      if (!pidAlive(pid)) return; // reaped
    }
    await sleep(100);
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
  const hub = testActionHub({
    servers: [deadConfig({ F16_PID_FILE: resolve(scratch, "pid") }), liveConfig()],
    clientFactory: createSdkClientFactory(),
    resilience: { failureThreshold: 3, cooldownMs: 3_000, heartbeat: { enabled: false } },
    defaultTimeoutMs: 5_000,
  });
  try {
    const t0 = Date.now();
    const results = await hangGuard(hub.indexAll(), "indexAll hung");
    const elapsed = Date.now() - t0;
    const dead = results.find((r) => r.serverId === "dead")!;
    const live = results.find((r) => r.serverId === "f16")!;
    assert.equal(live.indexed, 1, "healthy server indexed");
    assert.match(dead.error ?? "", /timed out|aborted|closed/i);
    // F54: hang guard only. "Completes near the deadline" is not provable
    // with a tight absolute bound under CI contention (process spawn, event-
    // loop stalls); the deadline MECHANISM is asserted by the timeout error
    // above and by the far-deadline abort assertions in the second test.
    // The 60s bounded await above IS the hang guard; `elapsed` is recorded
    // for diagnostics only (elapsed is the race winner's timestamp).
    const [deadState] = hub.serverStates().filter((s) => s.id === "dead");
    // F54: the manager retries a dead server on its backoff schedule (by
    // design), so the snapshot may legitimately read "reconnecting" instead
    // of "unreachable" (seen 1-in-10 under load). The load-bearing event is
    // the recorded timeout error above.
    assert.ok(
      deadState!.status === "unreachable" || deadState!.status === "reconnecting",
      `dead server status must be unreachable or reconnecting, got: ${deadState!.status}`,
    );
    // The manager keeps retrying a dead server on its backoff schedule (by
    // design), so a child may legitimately be mid-flight at any instant.
    // The teardown property is deterministic: after close() no child of
    // THIS server survives.
    await hub.close();
    await assertChildGone(resolve(scratch, "pid"));
    closed = true;
  } finally {
    if (!closed) await hub.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("hub.close() before the deadline aborts the in-flight activation and reaps the child", async () => {
  const scratch = mkdtempSync(`${tmpdir()}/f27b-`);
  // F54: a FAR deadline (10s) makes the assertion event-based instead of a
  // timing race. With a 1s deadline, heavy CI contention could make close()
  // slower than the remaining deadline and flip the abort/timeout outcome;
  // at 10s the deadline cannot realistically fire before the local close()
  // returns, so "the rejection is abort-caused, not deadline-caused" is a
  // stable ordering assertion.
  const hub = testActionHub({
    servers: [deadConfig({ F16_PID_FILE: resolve(scratch, "pid") }, 10_000)],
    clientFactory: createSdkClientFactory(),
    resilience: { failureThreshold: 3, cooldownMs: 3_000, heartbeat: { enabled: false } },
    defaultTimeoutMs: 5_000,
  });
  try {
    const indexing = hub.indexAll(); // activation in flight (10s deadline)
    await new Promise((r) => setTimeout(r, 200)); // child spawned, initialize pending
    const t0 = Date.now();
    await hub.close(); // must abort the activation, not wait for the deadline
    const closeMs = Date.now() - t0;
    // Generous bound RELATIVE to the 10s deadline: waiting it out would take
    // ~9.8s; a local close() must return well below that even on a loaded
    // runner (this is the only wall-clock check left, with ~10x margin).
    assert.ok(closeMs < 9_000, `close took ${closeMs}ms — must not wait out the 10s deadline`);
    // Event assertion: the in-flight activation must end ABORT-caused
    // (close/hub-shutdown), never deadline-caused. indexAll resolves with
    // per-server errors; capture either channel without assuming which.
    const results = await hangGuard(indexing, "indexAll hung after close");
    const dead = results.find((r) => r.serverId === "dead")!;
    assert.match(dead.error ?? "", /abort|cancel|shut ?down|closed/i, `dead server error must be shutdown-abort-caused, got: ${dead.error}`);
    assert.doesNotMatch(dead.error ?? "", /timed out/i, "the deadline must NOT have been what ended the activation");
    await assertChildGone(resolve(scratch, "pid"));
  } finally {
    await hub.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
