import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionHub } from "../dist/action-hub.js";
import type { ServerConfig } from "../dist/types.js";
import { FakeClient, makeFactory } from "./fakes.ts";

/**
 * Regression for the D1 stress finding: index-time semantic embedding of a
 * large catalog congests the event loop and can starve already-accepted
 * connections on a shared daemon. indexAll()/indexServer() must embed
 * cooperatively — in chunks, with the event loop served between chunks.
 */

function bigClients(count: number) {
  const words = [
    "deploy", "pipeline", "rollback", "notify", "provision", "database",
    "shard", "backup", "monitor", "cache", "queue", "scheduler", "webhook",
  ];
  const make = (prefix: string) =>
    new FakeClient(
      Array.from({ length: count }, (_, i) => ({
        name: `${prefix}_tool_${i}`,
        description: `${prefix} capability ${i}: ${words[i % words.length]} resource ${i} with ${words[(i + 3) % words.length]} and ${words[(i + 7) % words.length]} schedules for region ${i % 5}.`,
        inputSchema: { type: "object", properties: {} },
      })),
    );
  return { alpha: make("alpha"), beta: make("beta") };
}

function makeServers(): ServerConfig[] {
  return [
    { id: "alpha", transport: { type: "stdio", command: "alpha-mcp" }, trust: "trusted" },
    { id: "beta", transport: { type: "stdio", command: "beta-mcp" }, trust: "trusted" },
  ];
}

test("indexAll embeds cooperatively: yields between chunks and serves the event loop", async () => {
  const PER_SERVER = 4_000;
  const yields: number[] = [];
  const { factory } = makeFactory(bigClients(PER_SERVER));
  const hub = new ActionHub({
    servers: makeServers(),
    clientFactory: factory,
    indexing: {
      chunkSize: 250,
      yieldFn: () => {
        yields.push(performance.now());
        return new Promise<void>((done) => setImmediate(done));
      },
    },
  });

  let ticks = 0;
  const heartbeat = setInterval(() => (ticks += 1), 1);
  try {
    const results = await hub.indexAll();
    assert.equal(results.every((result) => !result.error), true);
  } finally {
    clearInterval(heartbeat);
  }

  assert.equal(hub.catalog.size, 2 * PER_SERVER);
  // 8000 documents at chunk size 250 => at least 31 chunk boundaries.
  assert.ok(yields.length >= 31, `expected >= 31 yields, got ${yields.length}`);
  // The heartbeat must have fired while the embed loop was pending: the event
  // loop was served during the rebuild instead of one blocking sync pass.
  assert.ok(ticks > 0, "event loop heartbeat never fired during indexAll");
});

test("cooperative and synchronous rebuilds produce identical search results", async () => {
  const { factory } = makeFactory(bigClients(40));
  const cooperative = new ActionHub({
    servers: makeServers(),
    clientFactory: factory,
    indexing: { chunkSize: 10, yieldFn: async () => undefined },
  });
  await cooperative.indexAll();

  const { factory: factory2 } = makeFactory(bigClients(40));
  const synchronous = new ActionHub({ servers: makeServers(), clientFactory: factory2 });
  await synchronous.indexAll();

  for (const query of ["deploy pipeline stage 3", "database shard backup", "webhook scheduler"]) {
    const a = await cooperative.search(query, { limit: 5 });
    const b = await synchronous.search(query, { limit: 5 });
    assert.deepEqual(
      a.map((hit) => hit.id),
      b.map((hit) => hit.id),
      `search diverged for "${query}"`,
    );
  }
});
