import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionHub } from "../dist/action-hub.js";
import { LocalSemanticIndex } from "../dist/index.js";
import type { ActionRecord, ServerConfig } from "../dist/types.js";
import { FakeClient, makeFactory } from "./fakes.ts";

/**
 * Regression tests for the D1 stress finding and the D1-R2 rework:
 * index-time semantic embedding of a large catalog congests the event loop
 * and can starve already-accepted connections on a shared daemon.
 *
 * Three invariants:
 * 1. indexAll()/indexServer() embed cooperatively — chunked, event loop served.
 * 2. Searches running DURING a cooperative rebuild stay bounded (no lazy
 *    full-corpus embedding; the previous generation keeps serving) and the
 *    event loop stays serviceable.
 * 3. Overlapping cooperative rebuilds do not corrupt shared state — the
 *    latest-started generation wins and the published index is always one
 *    complete rebuild's input.
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

/** Yields whose settlements the test controls explicitly. */
function gatedYield() {
  const pending: Array<() => void> = [];
  let automatic = false;
  return {
    fn: (): Promise<void> =>
      automatic ? Promise.resolve() : new Promise<void>((done) => pending.push(done)),
    paused: () => pending.length,
    releaseOne: () => pending.shift()?.(),
    releaseAll: () => {
      const waiting = [...pending];
      pending.length = 0;
      for (const done of waiting) done();
    },
    auto: () => {
      automatic = true;
    },
  };
}

test("indexAll embeds cooperatively: yields between chunks and serves the event loop", async () => {
  // F68 suite-cost: 4000/server (8000 real WASM embeds) made this file the
  // suite tail (~6.7 min). 1000/server keeps >8 chunk boundaries and a live
  // heartbeat — the structural evidence this test pins — at ~1/8 the cost.
  const PER_SERVER = 1_000;
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

  const t0 = performance.now();
  let ticks = 0;
  let lastTick = t0;
  let maxStallMs = 0;
  const heartbeat = setInterval(() => {
    ticks += 1;
    const now = performance.now();
    maxStallMs = Math.max(maxStallMs, now - lastTick);
    lastTick = now;
  }, 1);
  try {
    // SQ4: the embedding rebuild is the semantic index now; it runs
    // cooperatively and is awaited via semanticReady (indexAll itself stays
    // lexical-fast so per-server restart backoff timers cannot fire
    // mid-index — see the failing-server test).
    const results = await hub.indexAll();
    await hub.semanticReady();
    assert.equal(results.every((result) => !result.error), true);
  } finally {
    clearInterval(heartbeat);
  }

  assert.equal(hub.catalog.size, 2 * PER_SERVER);
  // 2000 documents at chunk size 250 => at least 7 chunk boundaries.
  assert.ok(yields.length >= 7, `expected >= 7 yields, got ${yields.length}`);
  assert.ok(ticks > 0, "event loop heartbeat never fired during indexAll");
  // Wall-clock stall bounds live in stress/index-stall-bench.mjs (generous,
  // contention-tolerant thresholds in a dedicated perf script) after the
  // in-suite absolute bound went red under root-suite CPU contention
  // (D1-R4). Here we keep the structural evidence: many yields + a live
  // heartbeat prove the rebuild did not run as one blocking pass.
  assert.ok(ticks > 5, `heartbeat fired only ${ticks} times during indexAll`);
});

test("a search during a paused rebuild stays bounded and the event loop stays live", async () => {
  const PER_SERVER = 1_000;
  const gate = gatedYield();
  const { factory } = makeFactory(bigClients(PER_SERVER));
  const hub = new ActionHub({
    servers: makeServers(),
    clientFactory: factory,
    indexing: { chunkSize: 250, yieldFn: gate.fn },
  });

  const building = hub.indexAll();
  // Wait until the rebuild is parked at its first chunk boundary.
  while (gate.paused() === 0) await new Promise((done) => setImmediate(done));
  assert.equal(hub.catalog.size, 2 * PER_SERVER, "catalog is populated while the semantic rebuild is still parked");

  // Deterministic boundedness evidence (D1-R4): with the fix, the scorer
  // refuses to embed while a rebuild is in flight, so the semantic channel
  // contributes EXACTLY zero — the paused search's ids AND scores must be
  // identical to a pure-BM25 (semanticScorer: null) reference over the same
  // catalog. The pre-rework build lazily embedded the whole corpus here,
  // producing nonzero semantic scores and a different ranking. No wall-clock
  // thresholds: those went red under root-suite CPU contention with no
  // correctness regression (measured separately in stress/index-stall-bench.mjs).
  let served = false;
  setImmediate(() => (served = true));
  const paused = await hub.search("deploy pipeline stage 3", { limit: 5 });
  assert.ok(Array.isArray(paused), "search must complete during the rebuild");
  await new Promise((done) => setImmediate(done));
  assert.ok(served, "setImmediate never fired — event loop starved during search");

  const { factory: referenceFactory } = makeFactory(bigClients(PER_SERVER));
  const reference = new ActionHub({
    servers: makeServers(),
    clientFactory: referenceFactory,
    semanticScorer: null,
  });
  await reference.indexAll();
  const lexical = await reference.search("deploy pipeline stage 3", { limit: 5 });
  assert.deepEqual(
    paused.map((hit) => hit.id),
    lexical.map((hit) => hit.id),
    "paused-rebuild search ranking diverged from pure BM25 — lazy embedding ran during the rebuild",
  );
  // Score-level proof (per-hit, exact): the engine emits
  // (1-w)*(lex/(1+lex)) + w*sem with w=0.2 (lex is the raw BM25 score the
  // reference emits; lex/(1+lex) is the engine's lexical normalization).
  // With the semantic channel contributing exactly zero, each paused score
  // must equal 0.8*(lex/(1+lex)) for THAT hit's raw BM25 score. Any lazy
  // embedding gives w*sem > 0 and moves the hit off its expected value.
  // (The earlier constant-ratio version was accidental: paused/raw varies
  // with s, and only passed because the top five lexical scores happened to
  // be equal.)
  const weight = 0.2;
  paused.forEach((hit, i) => {
    const lex = lexical[i].score;
    const expected = (1 - weight) * (lex / (1 + lex));
    assert.ok(
      Math.abs(hit.score - expected) < 1e-6,
      `paused score ${hit.score} != zero-semantic blend ${expected.toFixed(9)} of raw ${lex} at rank ${i} — lazy embedding ran during the rebuild`,
    );
  });

  gate.releaseAll();
  gate.auto();
  await building;
  assert.equal(hub.catalog.size, 2 * PER_SERVER);
});

test("overlapping cooperative rebuilds publish atomically: latest generation wins", async () => {
  const record = (id: string, text: string): ActionRecord => ({
    id,
    kind: "tool",
    name: text,
    serverId: "test",
    summary: text,
    description: text,
    tags: [],
    trust: "trusted",
  });

  const index = new LocalSemanticIndex();

  // Rebuild A parks after embedding 2 of 3 records; rebuild B parks after 1
  // of 2. With both parked the shared state must show NOTHING published (the
  // pre-rework build emptied the live map at start). Completing A then B must
  // leave exactly B's authoritative input live — never an interleave, and a
  // stale generation must not regress a newer published one.
  const gateA = gatedYield();
  const gateB = gatedYield();
  const buildA = index.indexCooperative(
    [
      record("a:one", "alpha one deploy"),
      record("a:two", "alpha two rollback"),
      record("a:three", "alpha three notify"),
    ],
    { chunkSize: 2, yieldFn: gateA.fn },
  );
  while (gateA.paused() === 0) await new Promise((done) => setImmediate(done));
  const buildB = index.indexCooperative(
    [record("b:one", "beta one backup"), record("b:two", "beta two monitor")],
    { chunkSize: 1, yieldFn: gateB.fn },
  );
  while (gateB.paused() === 0) await new Promise((done) => setImmediate(done));

  assert.equal(index.stats().documents, 0, "nothing may be published while rebuilds are parked");

  gateA.releaseAll();
  gateA.auto();
  await buildA;
  assert.equal(index.stats().documents, 3, "A's complete generation must publish on completion");

  gateB.releaseAll();
  gateB.auto();
  await buildB;
  assert.equal(index.stats().documents, 2, "latest-started generation (B) must win, no interleave");
});

test("a synchronous rebuild wins over an older parked cooperative rebuild", async () => {
  const record = (id: string, text: string): ActionRecord => ({
    id,
    kind: "tool",
    name: text,
    serverId: "test",
    summary: text,
    description: text,
    tags: [],
    trust: "trusted",
  });

  const index = new LocalSemanticIndex();
  const gate = gatedYield();
  // Cooperative build (3 records) parks at its chunk boundary...
  const building = index.indexCooperative(
    [
      record("a:one", "alpha one deploy"),
      record("a:two", "alpha two rollback"),
      record("a:three", "alpha three notify"),
    ],
    { chunkSize: 2, yieldFn: gate.fn },
  );
  while (gate.paused() === 0) await new Promise((done) => setImmediate(done));

  // ...then a synchronous rebuild runs (registerSkills/replaceSkills path).
  // It must take the newest generation and publish immediately.
  index.index([record("b:one", "beta one backup")]);
  assert.equal(index.stats().documents, 1, "sync rebuild must publish immediately");

  // The older cooperative build resumes: its stale generation is discarded.
  gate.releaseAll();
  gate.auto();
  await building;
  assert.equal(index.stats().documents, 1, "older cooperative build must not regress the newer sync generation");
});

test("non-integer and NaN chunk sizes fall back to the default instead of indexing nothing", async () => {
  for (const chunkSize of [Number.NaN, 2.9]) {
    const index = new LocalSemanticIndex();
    await index.indexCooperative(
      [
        { id: "a", name: "one", serverId: "t", summary: "one", description: "one", tags: [], trust: "trusted" },
        { id: "b", name: "two", serverId: "t", summary: "two", description: "two", tags: [], trust: "trusted" },
        { id: "c", name: "three", serverId: "t", summary: "three", description: "three", tags: [], trust: "trusted" },
        { id: "d", name: "four", serverId: "t", summary: "four", description: "four", tags: [], trust: "trusted" },
      ],
      { chunkSize: chunkSize as number },
    );
    assert.equal(index.stats().documents, 4, `chunkSize ${chunkSize} dropped documents`);
  }
});

test("cooperative indexAll matches the true synchronous rebuild path", async () => {
  const { factory } = makeFactory(bigClients(40));
  const hub = new ActionHub({
    servers: makeServers(),
    clientFactory: factory,
    indexing: { chunkSize: 10 },
  });
  await hub.indexAll();

  for (const query of ["deploy pipeline stage 3", "database shard backup", "webhook scheduler"]) {
    const cooperative = await hub.search(query, { limit: 5 });
    // Force the genuinely synchronous path (LocalSemanticIndex.index via
    // rebuildSemanticIndex) and compare rankings on the same catalog.
    hub.rebuildSemanticIndex();
    const synchronous = await hub.search(query, { limit: 5 });
    assert.deepEqual(
      cooperative.map((hit) => hit.id),
      synchronous.map((hit) => hit.id),
      `cooperative and synchronous paths diverged for "${query}"`,
    );
  }
});
