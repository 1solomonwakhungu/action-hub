import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectionManager } from "../dist/servers/connection-manager.js";
import type { ServerConfig } from "../dist/types.js";
import { FakeClient } from "./fakes.ts";

test("ConnectionManager tracks latency, circuit breakers, and health checks", async () => {
  const configs: ServerConfig[] = [
    {
      id: "srv1",
      transport: { type: "stdio", command: "srv1" },
      trust: "trusted",
      circuitBreaker: {
        failureThreshold: 2,
        cooldownMs: 50,
      },
    },
  ];

  let failConnect = false;
  const client = new FakeClient([{ name: "test_tool", description: "test", inputSchema: {} }]);
  
  const manager = new ConnectionManager(
    async (cfg) => {
      if (failConnect) {
        throw new Error("Connection failed");
      }
      return client;
    },
    configs,
    { failureThreshold: 2, cooldownMs: 50 },
  );

  // Initial status
  assert.equal(manager.status("srv1"), "inactive");

  // Activate successfully
  const activated = await manager.activate("srv1");
  assert.ok(activated);
  assert.equal(manager.status("srv1"), "ready");
  assert.equal(manager.isCircuitOpen("srv1"), false);

  // Health check
  const health1 = await manager.checkHealth("srv1");
  assert.equal(health1.status, "ready");
  assert.ok(typeof health1.latencyMs === "number");

  // Trigger failures to trip circuit breaker
  await manager.deactivate("srv1");
  failConnect = true;

  await assert.rejects(async () => {
    await manager.activate("srv1");
  });
  assert.equal(manager.status("srv1"), "error");

  await assert.rejects(async () => {
    await manager.activate("srv1");
  });
  assert.equal(manager.status("srv1"), "unreachable");
  assert.equal(manager.isCircuitOpen("srv1"), true);

  // Attempting to activate while circuit is open fails fast
  await assert.rejects(
    async () => {
      await manager.activate("srv1");
    },
    /Circuit breaker open/
  );

  // Wait for cooldown
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(manager.isCircuitOpen("srv1"), false);

  // Recover
  failConnect = false;
  const recovered = await manager.activate("srv1");
  assert.ok(recovered);
  assert.equal(manager.status("srv1"), "ready");

  const st = manager.states();
  assert.equal(st[0]?.id, "srv1");
  assert.equal(st[0]?.circuitOpen, false);

  await manager.closeAll();
});
