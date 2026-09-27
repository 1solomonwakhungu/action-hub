/**
 * SQ4: real local embeddings — offline loading, determinism, persistence,
 * warm-start reuse, and graceful degradation when the model is unavailable.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionHub } from "../dist/action-hub.js";
import { Catalog } from "../dist/catalog/catalog.js";
import { SearchEngine } from "../dist/search/search.js";
import { EmbeddingSemanticIndex } from "../dist/search/embeddings.js";
import { LocalSemanticIndex } from "../dist/search/semantic.js";
import type { ActionRecord } from "../dist/types.js";
import { FakeClient, makeFactory } from "./fakes.ts";

const servers = [
  { id: "acme", transport: { type: "stdio", command: "acme-mcp" }, trust: "trusted" },
] as const;

class EmbeddingFakeClient extends FakeClient {}

function buildClients() {
  return {
    acme: new EmbeddingFakeClient([
      { name: "pause_project", description: "Pauses the project until further notice.", inputSchema: { type: "object" } },
      { name: "enable_project", description: "Enables the project for all users.", inputSchema: { type: "object" } },
      { name: "disable_user", description: "Disables the user account and revokes sessions.", inputSchema: { type: "object" } },
    ]),
  };
}

function record(id: string, description: string): ActionRecord {
  const [serverId, name] = id.split(":");
  return {
    id,
    kind: "tool",
    serverId,
    name,
    summary: description.slice(0, 160),
    description,
    tags: [],
    trust: "trusted",
  };
}

test("embedding index loads offline from the vendored model and is deterministic", async () => {
  const index = new EmbeddingSemanticIndex();
  assert.equal(await index.load(), true);
  const records = [record("acme:pause_project", "Pauses the project until further notice.")];
  const embedded = await index.index(records);
  assert.equal(embedded, 1);
  assert.equal(index.ready, true);

  const a = await index.embedQuery("hold the project");
  const b = await index.embedQuery("hold the project");
  assert.equal(a.length, 384);
  assert.deepEqual([...a], [...b]);

  // normalization + a sanity cosine: identical text vs unrelated text
  const unrelated = await index.embedQuery("kubernetes rollback canary cluster");
  let same = 0;
  let other = 0;
  for (let i = 0; i < a.length; i += 1) {
    same += a[i]! * b[i]!;
    other += a[i]! * unrelated[i]!;
  }
  assert.ok(Math.abs(same - 1) < 0.01, `self-cosine ${same}`);
  assert.ok(other < same, "unrelated text must not out-score identity");
});

test("persisted vectors round-trip and warm-start reuses them (no re-embed)", async () => {
  const index = new EmbeddingSemanticIndex();
  await index.load();
  const records = [
    record("acme:pause_project", "Pauses the project until further notice."),
    record("acme:disable_user", "Disables the user account and revokes sessions."),
  ];
  await index.index(records);
  const persisted = index.toPersisted();
  assert.equal(persisted.modelId, "Xenova/all-MiniLM-L6-v2");
  assert.equal(Object.keys(persisted.vectors).length, 2);

  const warm = new EmbeddingSemanticIndex();
  assert.equal(warm.hydrate(persisted), 2);
  // Nothing to re-embed for unchanged documents.
  const embedded = await warm.index(records);
  assert.equal(embedded, 0);

  // Changed text re-embeds only that document.
  const changed = [...records, record("acme:disable_user", "Completely different text now.")];
  const reembedded = await warm.index(changed);
  assert.equal(reembedded, 1);

  // Mismatched modelId is rejected on hydrate.
  assert.equal(warm.hydrate({ ...persisted, modelId: "other/model" }), 0);
});

test("scorer degrades to zeros for documents without vectors and stays in [0,1]", async () => {
  const index = new EmbeddingSemanticIndex();
  await index.load();
  await index.index([record("acme:pause_project", "Pauses the project.")]);
  const scorer = index.asScorer();
  const scores = await scorer("hold the project", [
    record("acme:pause_project", "Pauses the project."),
    record("acme:enable_project", "Enables the project."),
  ]);
  assert.equal(scores.length, 2);
  assert.ok(scores[0]! > 0);
  assert.equal(scores[1], 0);
});

test("hub with an unloadable model still searches (fallback) and warns", async () => {
  const warnings: string[] = [];
  const clients = buildClients();
  const { factory } = makeFactory(clients);
  const hub = new ActionHub({
    servers: [...servers],
    clientFactory: factory,
    embeddings: {
      modelPath: "/nonexistent/vendor/models",
      onWarning: (message) => warnings.push(message),
    },
  });
  const results = await hub.indexAll();
  await hub.semanticReady();
  assert.equal(results.every((result) => !result.error), true);
  // The fallback scorer path materializes the hashed index; search works.
  const hits = await hub.search("pause project");
  assert.ok(hits.length > 0, "search must still return hits after fallback");
  assert.ok(warnings.some((w) => w.includes("falling back")), `warning emitted: ${JSON.stringify(warnings)}`);
});

test("hub with embeddings finds the paraphrase and never demotes exact names", async () => {
  const clients = buildClients();
  const { factory } = makeFactory(clients);
  const hub = new ActionHub({
    servers: [...servers],
    clientFactory: factory,
    embeddings: {},
  });
  const results = await hub.indexAll();
  await hub.semanticReady();
  assert.equal(results.every((result) => !result.error), true);
  const hits = await hub.search("hold the project until we hear back");
  assert.equal(hits[0].id, "acme:pause_project");

  // Exact-name lookup: the literal name must stay rank 1.
  const exact = await hub.search("disable_user");
  assert.equal(exact[0].id, "acme:disable_user");
});

// --- packaging/review round (R2-1..R6, R1-1..R4) ---

test("chunkSize is normalized: NaN, 0, negative and fractional values all work", async () => {
  const index = new EmbeddingSemanticIndex();
  await index.load();
  const records = [
    record("acme:pause_project", "Pauses the project until further notice."),
    record("acme:disable_user", "Disables the user account and revokes sessions."),
    record("acme:enable_project", "Enables the project for all users."),
  ];
  let variant = 0;
  for (const bad of [NaN, 0, -5, 1.5]) {
    // Fresh text per case: unchanged docs are cached (0 to embed) by design.
    const fresh = records.map((r) => ({ ...r, description: `${r.description} v${variant}`, summary: `${r.summary} v${variant}` }));
    variant += 1;
    const embedded = await index.index(fresh, { chunkSize: bad as number });
    assert.equal(embedded, 3, `chunkSize ${bad} must still embed all docs`);
  }
});

test("RRF with an all-zero semantic scorer returns [] for a zero-overlap query (no fabricated relevance)", async () => {
  const catalog = new Catalog();
  catalog.add(record("acme:alpha", "Alpha bravo charlie delta."));
  catalog.add(record("acme:beta", "Echo foxtrot golf hotel."));
  const engine = new SearchEngine(catalog);
  engine.setFusion("rrf");
  engine.setSemanticScorer(async () => new Array(catalog.all().length).fill(0));
  const hits = await engine.search("quantum teleportation beans");
  assert.deepEqual(hits, []);
});

test("RRF preserves exact-name priority over 100 same-prefix distractors", async () => {
  const catalog = new Catalog();
  catalog.add(record("acme:delete_user", "Deletes the user account permanently."));
  for (let i = 0; i < 100; i += 1) {
    catalog.add(record(`acme:delete_user_${i}`, `Delete user variant ${i} for distractor pressure.`));
  }
  const engine = new SearchEngine(catalog);
  engine.setFusion("rrf");
  // A disagreeing semantic channel: ranks distractors above the exact name.
  engine.setSemanticScorer(async (_query, candidates) =>
    candidates.map((c) => (c.id === "acme:delete_user" ? 0.01 : 0.99)),
  );
  const hits = await engine.search("delete_user");
  assert.equal(hits[0].id, "acme:delete_user", `got ${hits.slice(0, 3).map((h) => h.id)}`);
});

test("cold cache write -> fresh cache load -> unchanged catalog re-embeds 0 documents", async () => {
  const index = new EmbeddingSemanticIndex();
  await index.load();
  const records = [record("acme:pause_project", "Pauses the project until further notice.")];
  await index.index(records);
  const persisted = index.toPersisted();

  // Coercion must carry the embeddings block through a cache round-trip.
  const fresh = new EmbeddingSemanticIndex();
  const loaded = fresh.hydrate(persisted);
  assert.equal(loaded, 1, "persisted vectors must survive coercion");
  assert.equal(await fresh.index(records), 0, "warm start must not re-embed unchanged docs");

  // Backend pinning: a differently-labelled backend rejects the vectors.
  assert.equal(fresh.hydrate({ ...persisted, backend: "native" }), 0);
});

test("rebuild drains catalog mutations: a skill registered mid-rebuild is embedded", async () => {
  const clients = buildClients();
  const { factory } = makeFactory(clients);
  let parked: (() => void) | undefined;
  const parkedPromise = new Promise<void>((resolve) => {
    parked = resolve;
  });
  let gates = 0;
  const release = () => {};
  void release;
  const hub = new ActionHub({
    servers: [...servers],
    clientFactory: factory,
    // Park the FIRST rebuild at its first chunk boundary (2 tools, chunk 1),
    // then behave normally so the drain loop can finish.
    indexing: {
      chunkSize: 1,
      yieldFn: async () => {
        gates += 1;
        if (gates === 1) {
          parked?.();
          await new Promise<void>((done) => setTimeout(done, 5));
        }
      },
    },
  });
  const building = hub.indexAll(); // kicks the rebuild (non-blocking)
  void building;
  await parkedPromise;
  // Catalog is mutated WHILE the first rebuild is parked mid-pass.
  hub.registerSkills([
    {
      id: "local:extra-skill",
      serverId: "local",
      name: "extra-skill",
      summary: "A skill registered during an in-flight rebuild.",
      trust: "trusted",
    },
  ]);
  // Drain: must run through the NEWEST catalog generation.
  await hub.semanticReady();
  const persisted = (
    hub as unknown as {
      toPersisted(h: string): { embeddings?: { vectors: Record<string, unknown> } };
    }
  ).toPersisted("t");
  assert.ok(persisted.embeddings, "persisted catalog carries vectors");
  assert.ok(
    "local:extra-skill" in (persisted.embeddings as { vectors: Record<string, unknown> }).vectors,
    "the mid-rebuild skill must be embedded after the drain",
  );
});

test("WASM pipeline matches the captured reference vectors within backend-numerics tolerance", async () => {
  const { readFileSync } = await import("node:fs");
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/embedding-vectors.json", import.meta.url), "utf8"),
  ) as { texts: string[]; vectors: number[][] };
  const index = new EmbeddingSemanticIndex();
  assert.equal(await index.load(), true);
  const records = fixture.texts.map((text, i) => ({
    id: `t${i}`,
    kind: "tool" as const,
    serverId: "s",
    name: `n${i}`,
    summary: text,
    description: "",
    tags: [] as string[],
    trust: "trusted" as const,
  }));
  await index.index(records, { chunkSize: 64, yieldFn: () => Promise.resolve() });
  const persisted = index.toPersisted();
  // Cosine per text; distribution documented for intake: the int8 GEMM
  // kernels differ between ORT-node (native) and ORT-web (WASM), so exact
  // 0.999 parity is not achievable across backends. Floor = worst-case.
  const cosines: number[] = [];
  for (let i = 0; i < fixture.texts.length; i += 1) {
    const ref = Float32Array.from(fixture.vectors[i]!);
    const entry = persisted.vectors[`t${i}`]!;
    // Signed view: Buffer is unsigned (a negative int8 byte reads as 248).
    // Buffer pooling: a Buffer.from(base64) may have byteOffset != 0, so
    // view it at its own offset (signed — Buffer indexes unsigned).
    const raw = Buffer.from(entry.q, "base64");
    const bytes = new Int8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    const cur = new Float32Array(384);
    for (let f = 0; f < 384; f += 1) cur[f] = bytes[f]! * entry.s;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let f = 0; f < 384; f += 1) {
      dot += ref[f]! * cur[f]!;
      na += ref[f]! * ref[f]!;
      nb += cur[f]! * cur[f]!;
    }
    cosines.push(dot / (Math.sqrt(na) * Math.sqrt(nb)));
  }
  const worst = Math.min(...cosines);
  const sorted = [...cosines].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  assert.ok(
    worst >= 0.98 && median >= 0.99,
    `parity out of tolerance: worst ${worst.toFixed(5)}, median ${median.toFixed(5)}`,
  );
});

test("vectors survive a real disk cache round-trip: cold write -> fresh cache load -> 0 re-embed", async () => {
  // Real CatalogCache disk regression (review-2 round 3 HIGH): the previous
  // proof passed toPersisted() straight into hydrate() and never exercised
  // the write/coerce/load path on disk.
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { CatalogCache, hashServerConfigs } = await import("../dist/catalog/persistence.js");
  const dir = mkdtempSync(join(tmpdir(), "sq4-disk-"));
  try {
    const cachePath = join(dir, "catalog-cache.json");
    const configHash = hashServerConfigs([...servers]);
    const { factory } = makeFactory(buildClients());
    const hub = new ActionHub({ servers: [...servers], clientFactory: factory });
    await hub.indexAll();
    await hub.semanticReady(); // vectors now in memory AND ready to persist
    const cache = new CatalogCache({ path: cachePath });
    await cache.write(hub.toPersisted(configHash));

    // Fresh hub + fresh cache over the SAME file (simulated restart): hub2
    // must actually SERVE search from the restored vectors, not merely
    // hydrate them (review-2 round 4: the previous assertion was
    // tautological and never proved hub2 used restored vectors).
    const cache2 = new CatalogCache({ path: cachePath });
    const entry = await cache2.load(configHash);
    assert.ok(entry?.embeddings, "persisted entry on disk must carry the embeddings block");
    const hub2 = new ActionHub({ servers: [...servers], clientFactory: factory });
    const restored = hub2.restoreCatalog(entry);
    assert.ok(restored >= 3, `expected >=3 restored records, got ${restored}`);
    // REAL search on the restored hub, WITHOUT any indexing: the semantic
    // channel must come from the hydrated vectors (a MiniLM cosine for the
    // exact summary is high; an empty index would score 0).
    await hub2.semanticReady();
    const hits = await hub2.search("pause the project until further notice");
    assert.ok(hits.length > 0, "restored hub must return hits");
    const top = hits.find((h) => h.id === "acme:pause_project");
    assert.ok(top, "expected the pause_project hit");
    assert.ok(
      (top.semantic ?? 0) > 0.5,
      `restored hub must serve hydrated-vector semantics, got ${top.semantic}`,
    );
    // Warm start: unchanged catalog re-embeds nothing (fingerprint match).
    const hub2Index = new EmbeddingSemanticIndex();
    assert.equal(await hub2Index.load(), true);
    hub2Index.hydrate(entry.embeddings);
    assert.equal(await hub2Index.index([...hub2.catalog.all()]), 0, "warm start must not re-embed hydrated docs");
    await hub.close();
    await hub2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("close() cancels the fire-and-forget embedding rebuild: prompt, unref'd, NOT a failure", async () => {
  // 300 tools x chunk 8 => many chunks; close() must land at the first
  // boundary and settle promptly (review-2 round 3 MUST-FIX 3).
  const { factory } = makeFactory({
    acme: new EmbeddingFakeClient(
      Array.from({ length: 300 }, (_, i) => ({
        name: `tool_${i}`,
        description: `Synthetic tool number ${i} for the cancellation regression.`,
        inputSchema: { type: "object" },
      })),
    ),
  });
  const hub = new ActionHub({
    servers: [...servers],
    clientFactory: factory,
    indexing: { chunkSize: 8 },
  });
  void hub.indexAll();
  // Give the rebuild a tick to start, then close and time the settlement.
  await new Promise((r) => setTimeout(r, 50));
  // Capture stderr: a normal close() cancellation must NOT print the
  // "rebuild failed" warning (review-2 round 4: cancellation != failure).
  const warnings: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown) => {
    const text = typeof chunk === "string" ? chunk : String(chunk);
    if (text.includes("rebuild failed")) warnings.push(text);
    return origWrite(chunk);
  };
  const started = Date.now();
  await hub.close();
  const elapsed = Date.now() - started;
  (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = origWrite;
  assert.ok(elapsed < 1500, `close() took ${elapsed}ms; rebuild must settle bounded`);
  assert.equal(warnings.length, 0, `close() must not warn: ${warnings.join("|")}`);
  // The process must not linger: after close() the rebuild is cancelled and
  // hub.embeddedDocs stops growing (hub exposes the count for tests).
  const after = hub.embeddedDocs;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(hub.embeddedDocs, after, "embedding work must stop after close()");
});

test("production rebuild yields real macrotask ticks (no starvation, no custom yieldFn)", async () => {
  // review-2 round 4 MUST-FIX 1: `await undefined` in the default yield
  // wrapper is a microtask — a 300-doc rebuild used to starve the event loop
  // (zero 10ms timer ticks fired). The production path must service timers
  // between chunks so signals/close()/requests stay alive.
  const { factory } = makeFactory({
    acme: new EmbeddingFakeClient(
      Array.from({ length: 300 }, (_, i) => ({
        name: `tool_${i}`,
        description: `Synthetic tool number ${i} for the heartbeat regression.`,
        inputSchema: { type: "object" },
      })),
    ),
  });
  // Small chunks => many chunk boundaries => the macrotask yield between
  // chunks has many chances to service the 10ms heartbeat.
  const hub = new ActionHub({ servers: [...servers], clientFactory: factory, indexing: { chunkSize: 8 } }); // NO indexing.yieldFn
  let ticks = 0;
  const heartbeat = setInterval(() => {
    ticks += 1;
  }, 10);
  try {
    await hub.indexAll();
    await hub.semanticReady();
  } finally {
    clearInterval(heartbeat);
  }
  assert.ok(hub.embeddedDocs >= 300, `expected 300 embedded, got ${hub.embeddedDocs}`);
  assert.ok(ticks >= 10, `expected the event loop serviced during the rebuild (got ${ticks} 10ms ticks)`);
  await hub.close();
});

test("rebuild failure falls back gracefully: warn once, discard partials, hashed scorer, settled semanticReady", async () => {
  // review-2 round 3 MUST-FIX 4: a throwing yieldFn used to reject
  // semanticReady and leave the PARTIAL embedding map serving searches.
  const { factory } = makeFactory(buildClients());
  const hub = new ActionHub({
    servers: [...servers],
    clientFactory: factory,
    indexing: {
      yieldFn: async () => {
        throw new Error("yield sentinel");
      },
    },
  });
  await hub.indexAll();
  await hub.semanticReady(); // must RESOLVE (finished or permanently fallen back)
  const hits = await hub.search("pause the project");
  assert.ok(hits.length > 0, "search must still work after rebuild failure");
  // The served semantic scores must come from the HASHED fallback, not the
  // partial embedding map: build the reference hashed scorer over the same
  // records and compare exactly.
  const reference = new LocalSemanticIndex();
  await reference.indexCooperative([...hub.catalog.all()], { chunkSize: 64, yieldFn: () => Promise.resolve() });
  // The search engine feeds the scorer the literal (stopword-filtered) token
  // string, not the raw query — mirror that exactly.
  const { tokenize, QUERY_STOPWORDS } = await import("../dist/search/search.js");
  const literal = tokenize("pause the project").filter((term: string) => !QUERY_STOPWORDS.has(term)).join(" ");
  const expected = await reference.asScorer()(literal, [...hub.catalog.all()]);
  let matched = 0;
  for (const hit of hits) {
    const idx = [...hub.catalog.all()].findIndex((r) => r.id === hit.id);
    assert.ok(
      hit.semantic !== undefined && Math.abs(hit.semantic - expected[idx]!) < 0.01,
      `fallback search must serve hashed scores, not partial embeddings (hit ${hit.semantic} vs hashed ${expected[idx]})`,
    );
    matched += 1;
  }
  assert.ok(matched > 0);
  await hub.close();
});
