// F26 end-to-end through the REAL createSdkClientFactory adapter and a real
// stdio MCP child (fixtures/f26-server.mjs): a server that answers
// initialize/tools-list (so it passes heartbeats) while EVERY tools/call
// hangs must be isolated after the execute-timeout threshold, with the
// distinct "repeated execute timeouts" reason, and its child must be reaped.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createSdkClientFactory } from "../dist/client-factory.js";
import type { ServerConfig } from "@action-hub/core";
import { testActionHub } from "./test-hub.ts";

const SERVER_SCRIPT = resolve(import.meta.dirname, "fixtures", "f26-server.mjs");
const CWD = resolve(import.meta.dirname, "..", "..", "..");

async function assertChildGone(pidFile: string, waitMs = 8_000): Promise<void> {
  const deadline = Date.now() + waitMs;
  let pid = NaN;
  while (Date.now() < deadline) {
    try {
      pid = Number(readFileSync(pidFile, "utf8"));
      process.kill(pid, 0);
    } catch {
      return; // reaped (or never started)
    }
    // Non-blocking wait: the close chain (SIGTERM -> child exit) needs event
    // loop turns; a synchronous blocking wait can starve it.
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`child ${pid} must be reaped after hub.close()`);
}

test("a hanging tools/call on a live stdio server opens the circuit after the threshold (real adapter)", async () => {
  const scratch = mkdtempSync(`${tmpdir()}/f26-`);
  const pidFile = resolve(scratch, "pid");
  const config: ServerConfig = {
    id: "f26",
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [SERVER_SCRIPT],
      cwd: CWD,
      env: { F26_PID_FILE: pidFile }, // per-child env: no process-global mutation
    },
    trust: "trusted",
    executeTimeoutThreshold: 2,
    // NOTE: no per-server timeoutMs — that would ALSO set the F27 activation
    // deadline. This scenario is "activates fine, every tools/call hangs",
    // so only the hub-level EXECUTE timeout is short.
  };
  const hub = testActionHub({
    servers: [config],
    clientFactory: createSdkClientFactory(),
    resilience: { cooldownMs: 3_000, heartbeat: { enabled: false } },
    defaultTimeoutMs: 300, // each execute times out after 300ms
  });
  try {
    const results = await hub.indexAll();
    assert.equal(results[0]!.error, undefined, "the server indexes fine (it only hangs tools/call)");
    for (let i = 0; i < 2; i++) {
      const r = await hub.execute("f26:slow_tool", {});
      assert.equal(r.ok, false, `execute ${i + 1} times out`);
    }
    const [state] = hub.serverStates();
    assert.equal(state!.circuitState, "open", "two consecutive execute timeouts isolate the server");
    assert.match(state!.error ?? "", /repeated execute timeouts/, "distinct reason is surfaced");
    assert.equal(state!.executeTimeoutStreak, 2);
    // A third execute is rejected by the OPEN circuit immediately (reason in
    // the message), instead of hanging for another full timeout.
    const t0 = Date.now();
    const third = await hub.execute("f26:slow_tool", {});
    assert.equal(third.ok, false);
    assert.ok(Date.now() - t0 < 300, "open circuit must reject fast, not wait the timeout");
    assert.ok(third.error?.includes("Circuit breaker open"));
  } finally {
    await hub.close();
  }
  await assertChildGone(pidFile);
  rmSync(scratch, { recursive: true, force: true });
});
