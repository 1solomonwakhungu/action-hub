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
    transport: { type: "stdio", command: process.execPath, args: [SERVER_SCRIPT], cwd: CWD },
    trust: "trusted",
  };
  process.env.F16_MODE = mode;
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
  hub.close();
});

test("a dead stdio child trips the breaker via the real adapter without waiting for the heartbeat", async () => {
  const hub = makeHub("ok_then_exit");
  await hub.indexAll();
  const first = await hub.execute("f16:send_message", {});
  assert.equal(first.ok, true);
  // Child exits after its first accepted call: the next executes hit a
  // closed transport (SDK McpError -32000 "Connection closed", then plain
  // "Not connected") — both positively transport-level.
  let opened = false;
  for (let i = 0; i < 6; i++) {
    const r = await hub.execute("f16:send_message", {}).catch(() => ({ ok: false }));
    if (hub.serverStates()[0]!.circuitState === "open") { opened = true; break; }
    assert.equal(r.ok, false);
  }
  assert.equal(opened, true, "a closed transport must open the circuit");
  const [finalState] = hub.serverStates();
  assert.ok(finalState!.nextRestartAt !== undefined, "restart scheduled after the breaker opens");
  hub.close();
});
