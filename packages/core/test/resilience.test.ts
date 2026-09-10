import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectionManager } from "../dist/servers/connection-manager.js";
import { computeRestartBackoffMs } from "../dist/servers/restart-backoff.js";
import { applyNodeMemoryLimit, isNodeStdioCommand } from "../dist/servers/node-memory.js";
import type { ServerConfig } from "../dist/types.js";
import { FakeClient } from "./fakes.ts";

class FakeClock {
  nowMs = 1_000_000;
  randomValue = 0;
  #timers = new Map<number, { due: number; handler: () => void }>();
  #next = 1;

  now = (): number => this.nowMs;
  random = (): number => this.randomValue;

  setTimeout = (handler: () => void, ms: number): { id: number; unref: () => void } => {
    const id = this.#next++;
    this.#timers.set(id, { due: this.nowMs + Math.max(0, ms), handler });
    return { id, unref() {} };
  };

  clearTimeout = (handle: { id?: number }): void => {
    if (handle?.id !== undefined) this.#timers.delete(handle.id);
  };

  get pending(): number {
    return this.#timers.size;
  }

  async drain(): Promise<void> {
    for (let i = 0; i < 15; i++) {
      await Promise.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    while (true) {
      let next: [number, { due: number; handler: () => void }] | undefined;
      for (const entry of this.#timers) {
        if (entry[1].due > target) continue;
        if (!next || entry[1].due < next[1].due) next = entry;
      }
      if (!next) {
        this.nowMs = target;
        await this.drain();
        return;
      }
      this.#timers.delete(next[0]);
      this.nowMs = next[1].due;
      next[1].handler();
      await this.drain();
    }
  }
}

function server(id: string, extra: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id,
    transport: { type: "stdio", command: id },
    trust: "trusted",
    heartbeat: { enabled: false },
    ...extra,
  };
}

test("backoff stays inside [floor, bound] and never exceeds maxMs", () => {
  assert.equal(
    computeRestartBackoffMs({ attempt: 0, initialMs: 100, maxMs: 800, jitter: 0, random: () => 0 }),
    100,
  );
  assert.equal(
    computeRestartBackoffMs({ attempt: 1, initialMs: 100, maxMs: 800, jitter: 0, random: () => 1 }),
    200,
  );
  assert.equal(
    computeRestartBackoffMs({ attempt: 10, initialMs: 100, maxMs: 800, jitter: 0, random: () => 1 }),
    800,
  );

  const low = computeRestartBackoffMs({ attempt: 2, initialMs: 100, maxMs: 800, jitter: 0.5, random: () => 0 });
  const high = computeRestartBackoffMs({ attempt: 2, initialMs: 100, maxMs: 800, jitter: 0.5, random: () => 1 });
  assert.equal(low, 200);
  assert.equal(high, 400);

  const fullJitterZero = computeRestartBackoffMs({
    attempt: 3,
    initialMs: 100,
    maxMs: 10_000,
    jitter: 1,
    random: () => 0,
  });
  const fullJitterOne = computeRestartBackoffMs({
    attempt: 3,
    initialMs: 100,
    maxMs: 10_000,
    jitter: 1,
    random: () => 1,
  });
  assert.equal(fullJitterZero, 0);
  assert.equal(fullJitterOne, 800);

  assert.equal(computeRestartBackoffMs({ attempt: -2, initialMs: 50, maxMs: 50, jitter: 1, random: () => 1 }), 50);
});

test("ConnectionManager tracks latency, circuit breakers, and health checks", async () => {
  const clock = new FakeClock();
  const configs: ServerConfig[] = [
    server("srv1", {
      circuitBreaker: { failureThreshold: 2, cooldownMs: 50 },
    }),
  ];

  let failConnect = false;
  const client = new FakeClient([{ name: "test_tool", description: "test", inputSchema: {} }]);
  let connects = 0;

  const manager = new ConnectionManager(
    async () => {
      connects += 1;
      if (failConnect) throw new Error("Connection failed");
      return client;
    },
    configs,
    {
      failureThreshold: 2,
      cooldownMs: 50,
      heartbeat: { enabled: false },
      now: clock.now,
      random: clock.random,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    },
  );

  assert.equal(manager.status("srv1"), "inactive");

  const activated = await manager.activate("srv1");
  assert.ok(activated);
  assert.equal(manager.status("srv1"), "ready");
  assert.equal(manager.isCircuitOpen("srv1"), false);
  assert.equal(manager.circuitState("srv1"), "closed");

  const health1 = await manager.checkHealth("srv1");
  assert.equal(health1.status, "ready");
  assert.ok(typeof health1.latencyMs === "number");

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
  assert.equal(manager.circuitState("srv1"), "open");

  await assert.rejects(async () => {
    await manager.activate("srv1");
  }, /Circuit breaker open/);
  const connectsWhileOpen = connects;

  await clock.advance(60);
  assert.equal(manager.isCircuitOpen("srv1"), false);
  assert.equal(manager.circuitState("srv1"), "half-open");
  assert.equal(connects, connectsWhileOpen);

  failConnect = false;
  const recovered = await manager.activate("srv1");
  assert.ok(recovered);
  assert.equal(manager.status("srv1"), "ready");
  assert.equal(manager.circuitState("srv1"), "closed");

  const st = manager.states();
  assert.equal(st[0]?.id, "srv1");
  assert.equal(st[0]?.circuitOpen, false);
  assert.equal(st[0]?.circuitState, "closed");

  await manager.closeAll();
});

test("half-open probe failure reopens the circuit", async () => {
  const clock = new FakeClock();
  let failConnect = true;
  const manager = new ConnectionManager(
    async () => {
      if (failConnect) throw new Error("down");
      return new FakeClient([]);
    },
    [server("a", { circuitBreaker: { failureThreshold: 2, cooldownMs: 100 } })],
    {
      failureThreshold: 2,
      cooldownMs: 100,
      heartbeat: { enabled: false },
      restartBackoff: { initialMs: 1, maxMs: 1, jitter: 0 },
      now: clock.now,
      random: () => 0,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    },
  );

  await assert.rejects(() => manager.activate("a"));
  await assert.rejects(() => manager.activate("a"));
  assert.equal(manager.circuitState("a"), "open");

  await manager.deactivate("a");
  await clock.advance(100);
  assert.equal(manager.circuitState("a"), "half-open");
  await assert.rejects(() => manager.activate("a"));
  assert.equal(manager.circuitState("a"), "open");
  assert.equal(manager.status("a"), "unreachable");

  await manager.closeAll();
});

test("concurrent activate and half-open recovery share one in-flight connect", async () => {
  const clock = new FakeClock();
  let connects = 0;
  let hang!: (client: FakeClient) => void;
  const manager = new ConnectionManager(
    () => {
      connects += 1;
      return new Promise((resolve) => {
        hang = resolve;
      });
    },
    [server("a")],
    {
      heartbeat: { enabled: false },
      now: clock.now,
      random: clock.random,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    },
  );

  const first = manager.activate("a");
  const second = manager.activate("a");
  const third = manager.activate("a");
  assert.equal(connects, 1);
  hang(new FakeClient([]));
  const clients = await Promise.all([first, second, third]);
  assert.equal(clients[0], clients[1]);
  assert.equal(clients[1], clients[2]);
  assert.equal(connects, 1);

  await manager.closeAll();
});

test("circuit failures stay isolated per server", async () => {
  const clock = new FakeClock();
  const manager = new ConnectionManager(
    async (cfg) => {
      if (cfg.id === "bad") throw new Error("bad");
      return new FakeClient([]);
    },
    [
      server("bad", { circuitBreaker: { failureThreshold: 2, cooldownMs: 1_000 } }),
      server("good"),
    ],
    {
      heartbeat: { enabled: false },
      now: clock.now,
      random: () => 0,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    },
  );

  await assert.rejects(() => manager.activate("bad"));
  await assert.rejects(() => manager.activate("bad"));
  assert.equal(manager.circuitState("bad"), "open");

  await manager.activate("good");
  assert.equal(manager.status("good"), "ready");
  assert.equal(manager.circuitState("good"), "closed");
  assert.equal(manager.isCircuitOpen("good"), false);

  await manager.closeAll();
});

test("heartbeat failures degrade then mark unreachable and restart", async () => {
  const clock = new FakeClock();
  const client = new FakeClient([]);
  const manager = new ConnectionManager(
    async () => client,
    [
      server("hb", {
        heartbeat: { enabled: true, intervalMs: 20, timeoutMs: 10 },
        circuitBreaker: { failureThreshold: 3, cooldownMs: 1_000 },
      }),
    ],
    {
      failureThreshold: 3,
      cooldownMs: 1_000,
      now: clock.now,
      random: () => 0,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    },
  );

  await manager.activate("hb");
  assert.equal(manager.status("hb"), "ready");

  client.listError = new Error("heartbeat failed");
  await clock.advance(20);
  assert.equal(manager.status("hb"), "degraded");
  assert.equal(client.closed, false);

  await clock.advance(20);
  assert.equal(manager.status("hb"), "degraded");

  await clock.advance(20);
  assert.equal(manager.status("hb"), "unreachable");
  assert.equal(manager.circuitState("hb"), "open");
  assert.equal(client.closed, true);

  await manager.closeAll();
});

test("crash loops back off, stay bounded, and do not retry while open", async () => {
  const clock = new FakeClock();
  let connects = 0;
  const manager = new ConnectionManager(
    async () => {
      connects += 1;
      throw new Error("crash");
    },
    [
      server("loop", {
        circuitBreaker: { failureThreshold: 2, cooldownMs: 400 },
        restartBackoff: { initialMs: 50, maxMs: 200, jitter: 0 },
      }),
    ],
    {
      failureThreshold: 2,
      cooldownMs: 400,
      heartbeat: { enabled: false },
      now: clock.now,
      random: () => 0,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    },
  );

  await assert.rejects(() => manager.activate("loop"));
  assert.equal(connects, 1);

  await clock.advance(50);
  assert.equal(connects, 2);
  assert.equal(manager.circuitState("loop"), "open");

  const afterOpen = connects;
  await clock.advance(200);
  assert.equal(connects, afterOpen);

  await assert.rejects(() => manager.activate("loop"), /Circuit breaker open/);
  assert.equal(connects, afterOpen);

  await clock.advance(200);
  assert.equal(connects, afterOpen + 1);
  assert.equal(manager.circuitState("loop"), "open");

  await manager.closeAll();
  const closedAt = connects;
  await clock.advance(10_000);
  assert.equal(connects, closedAt);
});

test("manual shutdown and disabled servers never auto-restart", async () => {
  const clock = new FakeClock();
  let connects = 0;
  const manager = new ConnectionManager(
    async () => {
      connects += 1;
      throw new Error("crash");
    },
    [
      server("manual", {
        circuitBreaker: { failureThreshold: 5, cooldownMs: 10 },
        restartBackoff: { initialMs: 10, maxMs: 10, jitter: 0 },
      }),
      server("off", { enabled: false }),
    ],
    {
      heartbeat: { enabled: false },
      now: clock.now,
      random: () => 0,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    },
  );

  await assert.rejects(() => manager.activate("manual"));
  assert.equal(connects, 1);
  await manager.deactivate("manual");
  await clock.advance(1_000);
  assert.equal(connects, 1);
  assert.equal(clock.pending, 0);

  await assert.rejects(() => manager.activate("off"), /disabled/);
  assert.equal(connects, 1);

  manager.setEnabled("manual", false);
  await clock.advance(1_000);
  assert.equal(connects, 1);

  await manager.closeAll();
});

test("closeAll releases heartbeat and restart timers", async () => {
  const clock = new FakeClock();
  let connects = 0;
  const client = new FakeClient([]);
  const manager = new ConnectionManager(
    async () => {
      connects += 1;
      return client;
    },
    [server("live", { heartbeat: { enabled: true, intervalMs: 15, timeoutMs: 10 } })],
    {
      now: clock.now,
      random: () => 0,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    },
  );

  await manager.activate("live");
  assert.ok(clock.pending > 0);
  await manager.closeAll();
  assert.equal(clock.pending, 0);
  assert.equal(client.closed, true);

  const after = connects;
  await clock.advance(1_000);
  assert.equal(connects, after);
  await assert.rejects(() => manager.activate("live"), /closed/);
});

test("Node memory limit injection skips non-Node commands and existing flags", () => {
  const node = applyNodeMemoryLimit("node", ["server.js"], undefined, 512);
  assert.equal(node.applied, true);
  assert.deepEqual(node.args, ["--max-old-space-size=512", "server.js"]);

  const nested = applyNodeMemoryLimit("/usr/local/bin/node", ["--inspect", "app.js"], {}, 256);
  assert.equal(nested.applied, true);
  assert.equal(nested.args[0], "--max-old-space-size=256");

  const alreadyArg = applyNodeMemoryLimit("node", ["--max-old-space-size=128", "app.js"], undefined, 512);
  assert.equal(alreadyArg.applied, false);
  assert.deepEqual(alreadyArg.args, ["--max-old-space-size=128", "app.js"]);

  const alreadyEnv = applyNodeMemoryLimit("node", ["app.js"], { NODE_OPTIONS: "--max-old-space-size=64" }, 512);
  assert.equal(alreadyEnv.applied, false);

  const npx = applyNodeMemoryLimit("npx", ["-y", "pkg"], { PATH: "/bin" }, 512);
  assert.equal(npx.applied, true);
  assert.deepEqual(npx.args, ["-y", "pkg"]);
  assert.equal(npx.env?.["NODE_OPTIONS"], "--max-old-space-size=512");

  const npxMerge = applyNodeMemoryLimit("npx", ["-y", "pkg"], { NODE_OPTIONS: "--enable-source-maps" }, 256);
  assert.equal(npxMerge.env?.["NODE_OPTIONS"], "--enable-source-maps --max-old-space-size=256");

  const python = applyNodeMemoryLimit("python", ["-m", "server"], undefined, 512);
  assert.equal(python.applied, false);
  assert.deepEqual(python.args, ["-m", "server"]);

  const none = applyNodeMemoryLimit("node", ["app.js"], undefined, undefined);
  assert.equal(none.applied, false);

  assert.equal(isNodeStdioCommand("node.exe"), true);
  assert.equal(isNodeStdioCommand("C:\\\\Program Files\\\\nodejs\\\\node.exe"), true);
  assert.equal(isNodeStdioCommand("python"), false);
});
