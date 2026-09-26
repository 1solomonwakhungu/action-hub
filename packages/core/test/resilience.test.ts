import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectionManager } from "../dist/servers/connection-manager.js";
import { computeRestartBackoffMs } from "../dist/servers/restart-backoff.js";
import { applyNodeMemoryLimit, isNodeStdioCommand } from "../dist/servers/node-memory.js";
import type { ServerConfig } from "../dist/types.js";
import { FakeClient, makeFactory } from "./fakes.ts";
import { ActionHub } from "../dist/action-hub.js";
import type { McpClient } from "../dist/types.js";

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

// ---------------------------------------------------------------------------
// F16: execute-time connection errors trip the circuit breaker
// ---------------------------------------------------------------------------

// Helper: calls through the manager's wrapped client and returns the thrown cause.
async function clientWrapperCall(manager: ConnectionManager, id: string, tool: string): Promise<unknown> {
  const client = await manager.activate(id);
  try {
    await client.callTool(tool, {});
    throw new Error("expected callTool to reject");
  } catch (cause) {
    if (cause instanceof Error && cause.message === "expected callTool to reject") throw cause;
    return cause;
  }
}

test("transport failures are positively marked; uncoded/unknown errors are never tagged", async () => {
  const { isTransportFailure, markTransportFailure, ToolError } = await import("../dist/servers/connection-manager.js");
  assert.equal(isTransportFailure(new Error("Not connected to Slack workspace. Authenticate this integration first.")), false, "uncoded plain error text is never transport");
  assert.equal(isTransportFailure(markTransportFailure(new Error("Not connected"))), true, "positively marked error is transport");
  assert.equal(isTransportFailure(new ToolError("tool failed")), false, "ToolError is never transport");
  const clock = new FakeClock();
  const client = new FakeClient([
    { name: "t1", description: "dies at transport layer", inputSchema: { type: "object" } },
    { name: "t2", description: "returns a JSON-RPC error", inputSchema: { type: "object" } },
  ]);
  let mode: "transport" | "epipe" | "jsonrpc" = "transport";
  (client as unknown as { callTool: (...a: unknown[]) => Promise<unknown> }).callTool = async (...args: unknown[]) => {
    if (mode === "epipe") {
      const e: Error & { errno?: string } = new Error("write EPIPE");
      e.errno = "EPIPE";
      throw e;
    }
    if (mode === "transport") throw new Error("Stdio transport closed unexpectedly");
    const e: Error & { code?: number } = new Error("Not connected to Slack workspace. Authenticate this integration first.");
    e.code = -32000;
    throw e;
  };
  const manager = new ConnectionManager((async () => client) as unknown as Parameters<typeof ConnectionManager["prototype"]["activate"]> extends never ? never : never, [server("t")], {
    failureThreshold: 3, cooldownMs: 3_000, heartbeat: { enabled: false },
    now: clock.now, random: clock.random, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  await manager.activate("t");
  mode = "transport";
  const transportCause = await clientWrapperCall(manager, "t", "t1").catch((c) => c);
  assert.equal(transportCause instanceof Error, true);
  assert.equal(isTransportFailure(transportCause), false, "uncoded plain error must NOT be tagged (positive rule only)");
  mode = "epipe";
  const epipeCause = await clientWrapperCall(manager, "t", "t1").catch((c) => c);
  assert.equal(isTransportFailure(epipeCause), true, "transport errno is positively tagged by the wrapper backstop");
  mode = "jsonrpc";
  const jsonrCause = await clientWrapperCall(manager, "t", "t2").catch((c) => c);
  assert.equal(isTransportFailure(jsonrCause), false, "coded JSON-RPC error must NOT be tagged");
});

test("reportExecuteFailure: consecutive marked transport failures open the circuit, release the client, and restart after cooldown", async () => {
  const clock = new FakeClock();
  let alive = true; // the child dies mid-flight after a healthy start
  const underlying = new FakeClient([{ name: "ping", description: "pings", inputSchema: { type: "object" } }], () => {
    if (!alive) {
      // Simulates the adapter's positive marking of a dead transport.
      const e = new Error("Not connected");
      (e as Error & { errno?: string }).errno = "EPIPE";
      throw e;
    }
    return "ok:ping";
  });
  const factory = async (): Promise<McpClient> => {
    if (!alive) throw new Error("spawn failed: child process exited with code 1");
    return underlying;
  };
  const manager = new ConnectionManager(factory, [server("dead")], {
    failureThreshold: 3, cooldownMs: 3_000, heartbeat: { enabled: false },
    restartBackoff: { initialMs: 1_000, maxMs: 60_000, jitter: 0 },
    now: clock.now, random: clock.random, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  await manager.activate("dead");
  assert.equal(manager.states()[0]!.circuitState, "closed");
  alive = false;
  let lastCause: unknown;
  for (let i = 0; i < 3; i++) {
    lastCause = await clientWrapperCall(manager, "dead", "ping");
    await manager.reportExecuteFailure("dead", lastCause, (lastCause as Error).message);
  }
  const open = manager.states()[0]!;
  assert.equal(open.circuitState, "open");
  assert.equal(open.consecutiveFailures, 3);
  assert.equal(underlying.closed, true, "stale client must be released once the breaker opens");
  assert.ok(open.nextRestartAt !== undefined, "a restart must be scheduled");
  await clock.advance(3_000); // restart fires while the server is still dead
  assert.equal(manager.states()[0]!.circuitState, "open");
  alive = true;
  await clock.advance(4_000); // failed attempt re-armed the cooldown; clear it fully
  await clock.drain();
  const recovered = manager.states()[0]!;
  assert.equal(recovered.circuitState, "closed");
  assert.equal(recovered.consecutiveFailures, 0);
});

test("a successful execute resets the failure streak (alternating failures must not open the circuit)", async () => {
  const clock = new FakeClock();
  let fail = true;
  const client = new FakeClient([{ name: "flaky_pipe", description: "alternates", inputSchema: { type: "object" } }]);
  const rawCall = client.callTool.bind(client);
  (client as unknown as { callTool: (...a: unknown[]) => Promise<unknown> }).callTool = async (...args: unknown[]) => {
    if (fail) {
      fail = false;
      const e: Error & { errno?: string } = new Error("write EPIPE");
      e.errno = "EPIPE";
      throw e;
    }
    fail = true;
    return rawCall(args[0] as string, args[1] as Record<string, unknown>, args[2]);
  };
  const manager = new ConnectionManager(async () => client, [server("alt")], {
    failureThreshold: 3, cooldownMs: 3_000, heartbeat: { enabled: false },
    now: clock.now, random: clock.random, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  await manager.activate("alt");
  for (let i = 0; i < 3; i++) {
    const cause = await clientWrapperCall(manager, "alt", "flaky_pipe");
    await manager.reportExecuteFailure("alt", cause, (cause as Error).message);
    // successful call in between resets the streak
    const wrapped = await manager.activate("alt");
    await wrapped.callTool("flaky_pipe", {});
    manager.recordSuccess("alt", 1);
  }
  const st = manager.states()[0]!;
  assert.equal(st.circuitState, "closed", "alternating failures are not consecutive");
  assert.equal(st.consecutiveFailures, 0);
  assert.equal(client.closed, false);
});

test("free-form tool error text can never open the circuit (JSON-RPC coded errors are tool-level)", async () => {
  const clock = new FakeClock();
  const client = new FakeClient([{ name: "send_message", description: "slack-like", inputSchema: { type: "object" } }]);
  (client as unknown as { callTool: (...a: unknown[]) => Promise<unknown> }).callTool = async () => {
    const e: Error & { code?: number } = new Error("Not connected to Slack workspace. Authenticate this integration first.");
    e.code = -32000; // live server JSON-RPC error response
    throw e;
  };
  const manager = new ConnectionManager(async () => client, [server("live")], {
    failureThreshold: 3, cooldownMs: 3_000, heartbeat: { enabled: false },
    now: clock.now, random: clock.random, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  await manager.activate("live");
  for (let i = 0; i < 5; i++) {
    const cause = await clientWrapperCall(manager, "live", "send_message");
    await manager.reportExecuteFailure("live", cause, (cause as Error).message);
  }
  const st = manager.states()[0]!;
  assert.equal(st.circuitState, "closed", "tool-level error text must not trip the breaker");
  assert.equal(st.consecutiveFailures, 0);
  assert.equal(client.closed, false, "a live server's client must be retained");
});

test("a threshold execute failure returns promptly even when close() never settles", async () => {
  const clock = new FakeClock();
  const client = new FakeClient([{ name: "t", description: "d", inputSchema: { type: "object" } }]);
  (client as unknown as { callTool: (...a: unknown[]) => Promise<unknown> }).callTool = async () => {
    const e: Error & { errno?: string } = new Error("Stdio transport closed unexpectedly");
    e.errno = "ERR_STREAM_DESTROYED"; // positive transport signal
    throw e;
  };
  (client as unknown as { close: () => Promise<void> }).close = () => new Promise<void>(() => {}); // never settles
  // Real timers: the bounded background close must not need a clock advance.
  const manager = new ConnectionManager(async () => client, [server("stuck")], {
    failureThreshold: 3, cooldownMs: 3_000, heartbeat: { enabled: false },
    restartBackoff: { initialMs: 1_000, maxMs: 60_000, jitter: 0 },
    now: clock.now, random: clock.random,
  });
  await manager.activate("stuck");
  const cause = await clientWrapperCall(manager, "stuck", "t");
  const t0 = Date.now();
  await manager.reportExecuteFailure("stuck", cause, "Stdio transport closed unexpectedly");
  await manager.reportExecuteFailure("stuck", cause, "Stdio transport closed unexpectedly");
  // Third failure opens the circuit and must not hang on the never-settling close.
  await manager.reportExecuteFailure("stuck", cause, "Stdio transport closed unexpectedly");
  assert.ok(Date.now() - t0 < 250, "threshold failure must return without awaiting close");
  const st = manager.states()[0]!;
  assert.equal(st.circuitState, "open");
  assert.ok(st.nextRestartAt !== undefined, "restart scheduled despite unbounded close");
  assert.equal(client.closed, false, "close is left to the bounded background task");
});

test("execute-time connection errors trip the breaker without waiting for the heartbeat", async () => {
  const clock = new FakeClock();
  let calls = 0;
  const factory = async (): Promise<McpClient> => {
    calls += 1;
    return new FakeClient([
      { name: "do_thing", description: "does a thing", inputSchema: { type: "object" } },
    ], (name) => {
      calls += 1;
      if (calls <= 2) return `ok:${name}`;
      // Simulates the adapter positively marking a dead transport.
      const e = new Error("Not connected");
      (e as Error & { errno?: string }).errno = "EPIPE";
      throw e;
    });
  };
  const hub = new ActionHub({
    servers: [server("dead")],
    clientFactory: factory,
    resilience: {
      failureThreshold: 3,
      cooldownMs: 3_000,
      heartbeat: { enabled: false },
      restartBackoff: { initialMs: 1_000, maxMs: 60_000, jitter: 0 },
      now: clock.now,
      random: clock.random,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    },
    defaultTimeoutMs: 5_000,
  });
  await hub.indexAll();

  // Calls 1-2 succeed, then the child dies: every later call fails instantly.
  const good = await hub.execute("dead:do_thing", {});
  assert.equal(good.ok, true);
  for (let i = 0; i < 3; i++) {
    const result = await hub.execute("dead:do_thing", {});
    assert.equal(result.ok, false);
  }
  const [broken] = hub.serverStates();
  assert.equal(broken!.circuitState, "open");
  assert.ok(broken!.nextRestartAt !== undefined, "restart scheduled from execute failures");

  // Free-form uncoded error text from a live server must NOT trip the breaker:
  // 3 plain "Not connected" tool errors leave the circuit closed.
  const textyClient = new FakeClient([
    { name: "chatty", description: "fails with text", inputSchema: { type: "object" } },
  ], () => { throw new Error("Not connected to Slack workspace. Authenticate this integration first."); });
  const texty = new ActionHub({
    servers: [server("chatty")],
    clientFactory: makeFactory({ chatty: textyClient }).factory,
    resilience: {
      failureThreshold: 3,
      cooldownMs: 3_000,
      heartbeat: { enabled: false },
      now: clock.now,
      random: clock.random,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    },
    defaultTimeoutMs: 5_000,
  });
  await texty.indexAll();
  for (let i = 0; i < 5; i++) {
    const r = await texty.execute("chatty:chatty", {});
    assert.equal(r.ok, false);
  }
  const [textyState] = texty.serverStates();
  assert.equal(textyState!.circuitState, "closed", "uncoded tool error text must not trip the breaker");
  assert.equal(textyClient.closed, false);
  texty.close();

  // A tool-level isError result from a live server must NOT trip the breaker.
  const erroringClient = new FakeClient([
    { name: "flaky", description: "returns isError", inputSchema: { type: "object" } },
  ], () => ({ isError: true, content: [{ type: "text", text: "nope" }] }));
  const live = new ActionHub({
    servers: [server("live")],
    clientFactory: makeFactory({ live: erroringClient }).factory,
    resilience: {
      failureThreshold: 3,
      cooldownMs: 3_000,
      heartbeat: { enabled: false },
      now: clock.now,
      random: clock.random,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    },
    defaultTimeoutMs: 5_000,
  });
  await live.indexAll();
  for (let i = 0; i < 5; i++) {
    await live.execute("live:flaky", {});
  }
  const [liveState] = live.serverStates();
  assert.equal(liveState!.circuitState, "closed", "tool isError must not trip the breaker");
  assert.equal(erroringClient.closed, false);
  hub.close();
  live.close();
});

// ---------------------------------------------------------------------------
// F27: activation deadline (FX11)
// ---------------------------------------------------------------------------

test("activation deadline: a never-initializing server cannot gate startup", async () => {
  const clock = new FakeClock();
  const neverFactory = (config: ServerConfig): Promise<McpClient> =>
    new Promise(() => {
      void config; // spawn "succeeds", initialize never answers, signal ignored
    });
  const healthy = (): McpClient =>
    new FakeClient([{ name: "do_thing", description: "d", inputSchema: { type: "object" } }]);
  const hub = new ActionHub({
    servers: [
      { id: "dead", transport: { type: "stdio", command: "x" }, trust: "trusted", timeoutMs: 500 },
      { id: "ok1", transport: { type: "stdio", command: "x" }, trust: "trusted" },
      { id: "ok2", transport: { type: "stdio", command: "x" }, trust: "trusted" },
    ],
    clientFactory: (config, options) => {
      void options;
      return config.id === "dead" ? neverFactory(config) : Promise.resolve(healthy());
    },
    resilience: { now: clock.now, random: clock.random, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    defaultTimeoutMs: 30_000,
  });
  const indexing = hub.indexAll();
  await clock.advance(600); // past the dead server's deadline
  const results = await indexing;
  const dead = results.find((r) => r.serverId === "dead")!;
  assert.match(dead.error ?? "", /timed out/);
  assert.equal(results.find((r) => r.serverId === "ok1")!.indexed, 1);
  assert.equal(results.find((r) => r.serverId === "ok2")!.indexed, 1);
  const [deadState] = hub.serverStates().filter((s) => s.id === "dead");
  assert.equal(deadState!.status, "unreachable", "deadline miss marks the server unreachable");
  hub.close();
});

test("a slow-but-within-deadline server still activates", async () => {
  const clock = new FakeClock();
  const hub = new ActionHub({
    servers: [{ id: "slow", transport: { type: "stdio", command: "x" }, trust: "trusted", timeoutMs: 1_000 }],
    clientFactory: async () => {
      await new Promise((r) => setTimeout(r, 50)); // real 50ms, well within deadline
      return new FakeClient([{ name: "ping", description: "d", inputSchema: { type: "object" } }]);
    },
    resilience: { now: clock.now, random: clock.random, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    defaultTimeoutMs: 5_000,
  });
  const results = await hub.indexAll();
  assert.equal(results[0]!.indexed, 1);
  assert.equal(results[0]!.error, undefined);
  hub.close();
});

test("repeated activation timeouts flow through the failure/restart state machine", async () => {
  const clock = new FakeClock();
  let alive = false; // server never initializes until it "comes back"
  let activations = 0;
  const factory = (config: ServerConfig, options?: { signal?: AbortSignal }): Promise<McpClient> => {
    activations += 1;
    void options;
    if (!alive) return new Promise(() => void config); // never settles (ignores signal)
    return Promise.resolve(new FakeClient([{ name: "ping", description: "d", inputSchema: { type: "object" } }]));
  };
  const manager = new ConnectionManager(factory, [{ ...server("dead"), timeoutMs: 100 }], {
    failureThreshold: 3,
    cooldownMs: 3_000,
    heartbeat: { enabled: false },
    restartBackoff: { initialMs: 1_000, maxMs: 60_000, jitter: 0 },
    now: clock.now,
    random: clock.random,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  const deadlineMs = 100;
  for (let i = 0; i < 3; i++) {
    const attempt = manager.activate("dead").catch((e: Error) => e.message);
    await clock.advance(deadlineMs + 10);
    const message = await attempt;
    assert.match(message, /timed out/);
    const st = manager.states()[0]!;
    assert.equal(st.status, "unreachable");
    assert.equal(st.consecutiveFailures, i + 1, `timeout ${i + 1} must be recorded`);
    if (i < 2) assert.equal(st.circuitState, "closed");
  }
  const open = manager.states()[0]!;
  assert.equal(open.circuitState, "open", "3 consecutive activation timeouts open the circuit");
  assert.ok(open.nextRestartAt !== undefined, "restart scheduled from the state machine");
  // Server comes back: the scheduled restart recovers through the normal path.
  alive = true;
  await clock.advance(5_000);
  await clock.drain();
  const recovered = manager.states()[0]!;
  assert.equal(recovered.circuitState, "closed");
  assert.equal(recovered.consecutiveFailures, 0);
});

test("deactivate aborts an in-flight activation and settles bounded", async () => {
  const clock = new FakeClock();
  // Cooperative factory like the real adapters: rejects when aborted.
  const factory = (_config: ServerConfig, options?: { signal?: AbortSignal }): Promise<McpClient> =>
    new Promise((_, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("activation aborted")), { once: true });
    });
  const manager = new ConnectionManager(factory, [{ ...server("stuck"), timeoutMs: 60_000 }], {
    failureThreshold: 3, cooldownMs: 3_000, heartbeat: { enabled: false },
    now: clock.now, random: clock.random, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  const t0 = Date.now();
  // The fake factory never settles and ignores the signal; activate() can
  // only reject at its (60s fake) deadline. Race it against the real clock.
  const activating = manager.activate("stuck").catch(() => "rejected");
  await Promise.race([activating, new Promise((r) => setTimeout(r, 100))]);
  await manager.deactivate("stuck"); // must not wait for the 60s deadline
  assert.ok(Date.now() - t0 < 4_000, "deactivate settles bounded, not on the activation deadline");
  // Swallow the still-hanging activation so the test process can exit.
  activating.catch(() => {});
  assert.equal(manager.states()[0]!.status, "inactive");
});

test("reconnect aborts and settles an in-flight activation before replacing it", async () => {
  const clock = new FakeClock();
  const abortsSeen: AbortSignal[] = [];
  const factory = (_config: ServerConfig, options?: { signal?: AbortSignal }): Promise<McpClient> => {
    const signal = options?.signal;
    if (signal) {
      abortsSeen.push(signal);
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("activation aborted")), { once: true });
      });
    }
    return Promise.resolve(new FakeClient([{ name: "ping", description: "d", inputSchema: { type: "object" } }]));
  };
  const manager = new ConnectionManager(factory, [{ ...server("flappy"), timeoutMs: 60_000 }], {
    failureThreshold: 3, cooldownMs: 3_000, heartbeat: { enabled: false },
    now: clock.now, random: clock.random, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  // First activation in flight (never initializes, cooperative abort).
  void manager.activate("flappy").catch(() => {});
  await clock.drain();
  assert.equal(abortsSeen.length, 1);
  // Reconnect must abort the old activation, not leave it initializing.
  // Its replacement activation never initializes (fake factory), so race
  // the call instead of awaiting the 60s fake deadline.
  const reconnecting = manager.reconnect("flappy").catch(() => "rejected");
  await Promise.race([reconnecting, new Promise((r) => setTimeout(r, 200))]);
  assert.equal(abortsSeen[0]!.aborted, true, "reconnect aborts the in-flight activation");
  assert.equal(abortsSeen.length, 2, "replacement activation started");
  reconnecting.catch(() => {});
  await manager.closeAll();
});

test("setEnabled(false) during an in-flight activation leaves status disabled with no failure recorded", async () => {
  const clock = new FakeClock();
  const factory = (_config: ServerConfig, options?: { signal?: AbortSignal }): Promise<McpClient> =>
    new Promise((_, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("activation aborted")), { once: true });
    });
  const manager = new ConnectionManager(factory, [{ ...server("gated"), timeoutMs: 60_000 }], {
    failureThreshold: 3, cooldownMs: 3_000, heartbeat: { enabled: false },
    now: clock.now, random: clock.random, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  void manager.activate("gated").catch(() => {});
  await clock.drain();
  manager.setEnabled("gated", false);
  await manager.deactivate("gated"); // completes the shutdown path
  const st = manager.states()[0]!;
  assert.equal(st.status, "disabled", "manual shutdown must not be overwritten with unreachable");
  assert.equal(st.consecutiveFailures, 0, "manual shutdown records no failure");
  assert.equal(st.circuitState, "closed");
});

test("a cooperative factory's abort rejection is bookkept exactly once (1,2,3)", async () => {
  const clock = new FakeClock();
  const factory = (_config: ServerConfig, options?: { signal?: AbortSignal }): Promise<McpClient> =>
    new Promise((_, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("activation aborted")), { once: true });
    });
  const manager = new ConnectionManager(factory, [{ ...server("coop"), timeoutMs: 100 }], {
    failureThreshold: 3, cooldownMs: 3_000, heartbeat: { enabled: false },
    restartBackoff: { initialMs: 1_000, maxMs: 60_000, jitter: 0 },
    now: clock.now, random: clock.random, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  for (let i = 0; i < 3; i++) {
    const attempt = manager.activate("coop").catch((e: Error) => e.message);
    await clock.advance(200);
    await attempt;
    const st = manager.states()[0]!;
    assert.equal(st.consecutiveFailures, i + 1, `timeout ${i + 1} must count exactly once`);
  }
  assert.equal(manager.states()[0]!.circuitState, "open", "opens on exactly the 3rd timeout");
});

test("connectWithDeadline: never-settling client.close still closes the transport and returns promptly", async () => {
  const keepAlive = setTimeout(() => {}, 10_000); // bounded-close timers are unref'd by design
  const { connectWithDeadline } = await import("../dist/servers/activation-deadline.js");
  let transportClosed = false;
  const controller = new AbortController();
  const client = {
    connect: () =>
      new Promise<void>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("activation timed out")), { once: true });
      }),
    close: () => new Promise<void>(() => undefined), // never settles
  };
  const transport = { close: async () => { transportClosed = true; } };
  const t0 = Date.now();
  const attempt = connectWithDeadline(client, transport, controller.signal).catch((e: Error) => e.message);
  setTimeout(() => controller.abort(new Error("activation timed out")), 50);
  const message = await attempt;
  assert.match(message, /timed out/);
  assert.equal(transportClosed, true, "transport.close must run even when client.close never settles");
  assert.ok(Date.now() - t0 < 3_500, "bounded close must not wait on the never-settling close");
  clearTimeout(keepAlive);
});
