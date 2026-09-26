// F16 end-to-end regressions through the REAL createSdkClientFactory adapter
// and a real stdio MCP child (fixtures/f16-server.mjs). Companion to the
// core-level tests in packages/core/test/resilience.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { ActionHub } from "@action-hub/core";
import { createSdkClientFactory } from "../dist/client-factory.js";
import type { ServerConfig } from "@action-hub/core";

const SERVER_SCRIPT = resolve(import.meta.dirname, "fixtures", "f16-server.mjs");
const CWD = resolve(import.meta.dirname, "..", "..", "..");

function makeHub(mode: string, threshold = 3) {
  const config: ServerConfig = {
    id: "f16",
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [SERVER_SCRIPT],
      cwd: CWD,
      env: { F16_MODE: mode }, // per-child env: no process-global mutation
    },
    trust: "trusted",
  };
  const hub = new ActionHub({
    servers: [config],
    clientFactory: createSdkClientFactory(),
    resilience: { failureThreshold: threshold, cooldownMs: 3_000, heartbeat: { enabled: false } },
    defaultTimeoutMs: 5_000,
  });
  return hub;
}

test("isError tool text that looks like a connection error never trips the breaker (real adapter, real child)", async () => {
  const hub = makeHub("isError");
  try {
    const results = await hub.indexAll();
    assert.equal(results[0]!.error, undefined);
    for (let i = 0; i < 5; i++) {
      const r = await hub.execute("f16:send_message", {});
      assert.equal(r.ok, false, "isError tool call must surface as a failed execute");
    }
    const [state] = hub.serverStates();
    assert.equal(state!.circuitState, "closed", "tool-level isError text must never open the circuit");
    assert.equal(state!.consecutiveFailures, 0);
    assert.equal(state!.status !== "unreachable", true);
  } finally {
    await hub.close();
  }
});

test("a dead stdio child trips the breaker via the real adapter without waiting for the heartbeat", async () => {
  const hub = makeHub("ok_then_exit");
  try {
  await hub.indexAll();
  const first = await hub.execute("f16:send_message", {});
  assert.equal(first.ok, true);
  // Child exits after its first accepted call: the next executes hit a
  // closed transport. The first failed call surfaces as SDK McpError -32000
  // "Connection closed" WITH transportClosed=true (counted), then plain
  // "Not connected" — the breaker must open on EXACTLY the 3rd consecutive
  // failed call (threshold 3, no earlier, no loop-until-open).
  const second = await hub.execute("f16:send_message", {});
  assert.equal(second.ok, false, "first call after child death must fail");
  let s1 = hub.serverStates()[0]!;
  assert.equal(s1.circuitState, "closed");
  assert.equal(s1.consecutiveFailures, 1, "SDK -32000 with transportClosed counts as failure 1");
  await hub.execute("f16:send_message", {});
  let s2 = hub.serverStates()[0]!;
  assert.equal(s2.circuitState, "closed");
  assert.equal(s2.consecutiveFailures, 2);
  await hub.execute("f16:send_message", {});
  const s3 = hub.serverStates()[0]!;
  assert.equal(s3.circuitState, "open", "breaker opens on exactly the 3rd consecutive failed call");
  assert.equal(s3.consecutiveFailures, 3);
  assert.ok(s3.nextRestartAt !== undefined, "restart scheduled after the breaker opens");
  } finally {
    await hub.close();
  }
});
