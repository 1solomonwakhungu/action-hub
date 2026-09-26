import assert from "node:assert/strict";
import { test } from "node:test";
import { SearchEngine, tokenize } from "../dist/search/search.js";
import { Catalog } from "../dist/catalog/catalog.js";
import type { ActionRecord } from "../dist/types.js";

/** Deterministic PRNG (mulberry32) so the corpus is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCAB = Array.from({ length: 60 }, (_, i) => `term${i}`);

function makeRecord(i: number, rand: () => number): ActionRecord {
  const words = (n: number) =>
    Array.from({ length: n }, () => VOCAB[Math.floor(rand() * VOCAB.length)]).join(" ");
  return {
    id: `srv${i % 7}:tool-${i}`,
    kind: "tool",
    serverId: `srv${i % 7}`,
    name: `tool-${i}-${VOCAB[Math.floor(rand() * VOCAB.length)]}`,
    summary: words(12),
    description: words(30),
    tags: [VOCAB[Math.floor(rand() * VOCAB.length)]],
    trust: "trusted",
    inputSchema: { type: "object" },
  } as ActionRecord;
}

function makeCatalog(count: number, seed = 42): Catalog {
  const rand = mulberry32(seed);
  const catalog = new Catalog();
  for (let i = 0; i < count; i += 1) catalog.add(makeRecord(i, rand));
  return catalog;
}

/**
 * Reference implementation of the ORIGINAL per-query path (tokenize + build
 * stats from scratch + bm25), used to prove the memoized engine is
 * bit-identical. Deliberately duplicated here so a future change to the
 * engine cannot silently redefine the baseline.
 */
function referenceRank(
  records: readonly ActionRecord[],
  query: string,
  limit: number,
): { id: string; score: number }[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const docFreq = new Map<string, number>();
  const termFreq = new Map<string, Map<string, number>>();
  const lengths = new Map<string, number>();
  let total = 0;
  for (const record of records) {
    const nameTokens = tokenize(record.name);
    const tokens = [
      ...nameTokens,
      ...nameTokens,
      ...nameTokens,
      ...tokenize(record.serverId),
      ...tokenize(record.summary),
      ...tokenize(record.description ?? ""),
      ...(record.tags ?? []).flatMap((tag) => tokenize(tag)),
    ];
    const freq = new Map<string, number>();
    for (const token of tokens) freq.set(token, (freq.get(token) ?? 0) + 1);
    termFreq.set(record.id, freq);
    lengths.set(record.id, tokens.length);
    total += tokens.length;
    for (const token of freq.keys()) docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
  }
  const avg = records.length ? total / records.length : 0;
  const K1 = 1.2;
  const B = 0.75;
  const scored = records.map((record) => {
    const freq = termFreq.get(record.id);
    if (!freq) return { id: record.id, score: 0 };
    const length = lengths.get(record.id) ?? 0;
    let score = 0;
    for (const term of terms) {
      const tf = freq.get(term);
      if (!tf) continue;
      const df = docFreq.get(term) ?? 0;
      const idf = Math.log(1 + (records.length - df + 0.5) / (df + 0.5));
      const denominator = tf + K1 * (1 - B + (B * length) / (avg || 1));
      score += idf * ((tf * (K1 + 1)) / denominator);
    }
    return { id: record.id, score: Number(score.toFixed(6)) };
  });
  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}

const QUERIES = [
  "term3 term17 tool-name",
  "exact term42",
  "term7 term8 term9",
  "tool-100",
  "term55 term2",
];

test("memoized search is bit-identical to the reference per-query path", async () => {
  const catalog = makeCatalog(600);
  const engine = new SearchEngine(catalog);
  for (const query of QUERIES) {
    const expected = referenceRank(catalog.all(), query, 10);
    const actual = (await engine.search(query)).map((hit) => ({ id: hit.id, score: hit.score }));
    assert.deepEqual(actual, expected);
  }
});

test("stale memo is released after full corpus removal even with early-return searches", async () => {
  const catalog = makeCatalog(500);
  const engine = new SearchEngine(catalog);
  await engine.search(QUERIES[0]); // warm the memo
  assert.ok(engine.memoSizeForTest > 0);

  // Remove every server, then drive BOTH early-return paths.
  for (const serverId of catalog.serverIds()) catalog.removeServer(serverId);
  assert.deepEqual(await engine.search(""), []); // empty-query early return
  assert.deepEqual(await engine.search(QUERIES[0]), []); // empty-candidates early return
  assert.equal(engine.memoSizeForTest, 0, "stale memo must be dropped before the early returns");

  // Re-adding records must rank exactly like a fresh engine.
  const fresh = new SearchEngine(catalog);
  for (let i = 0; i < 40; i += 1) {
    catalog.add(makeRecord(10_000 + i, mulberry32(99)));
  }
  const got = (await engine.search(QUERIES[2])).map((hit) => ({ id: hit.id, score: hit.score }));
  const expected = referenceRank(catalog.all(), QUERIES[2], 10);
  assert.deepEqual(got, expected);
  const freshGot = (await fresh.search(QUERIES[2])).map((hit) => ({ id: hit.id, score: hit.score }));
  assert.deepEqual(got, freshGot);
});

test("warm cache returns identical results and survives catalog mutation", async () => {
  const catalog = makeCatalog(400);
  const engine = new SearchEngine(catalog);

  // Warm: first search populates the memoized stats.
  const first = await engine.search(QUERIES[0]);
  const warm = await engine.search(QUERIES[0]);
  assert.deepEqual(
    warm.map((hit) => ({ id: hit.id, score: hit.score })),
    first.map((hit) => ({ id: hit.id, score: hit.score })),
  );

  // Mutate: add a record that must rank; the cache must invalidate.
  catalog.add({
    id: "srv0:tool-supermatch",
    kind: "tool",
    serverId: "srv0",
    name: "term3 term17 tool-supermatch",
    summary: "term3 term17",
    description: "term3 term17 term17",
    trust: "trusted",
  } as ActionRecord);
  const afterAdd = await engine.search(QUERIES[0]);
  assert.equal(afterAdd[0].id, "srv0:tool-supermatch");
  const expectedAfterAdd = referenceRank(catalog.all(), QUERIES[0], 10);
  assert.deepEqual(
    afterAdd.map((hit) => ({ id: hit.id, score: hit.score })),
    expectedAfterAdd,
  );

  // Mutate again: remove a server; results must match the reference.
  catalog.removeServer("srv1");
  const afterRemove = await engine.search(QUERIES[0]);
  assert.deepEqual(
    afterRemove.map((hit) => ({ id: hit.id, score: hit.score })),
    referenceRank(catalog.all(), QUERIES[0], 10),
  );
});

test("filtered searches stay identical to the reference", async () => {
  const catalog = makeCatalog(300);
  const engine = new SearchEngine(catalog);
  const filtered = catalog.filter({ serverIds: ["srv2"] });
  const expected = referenceRank(filtered, QUERIES[1], 10);
  const hits = await engine.search(QUERIES[1], { serverIds: ["srv2"] } as never);
  assert.deepEqual(
    hits.map((hit) => ({ id: hit.id, score: hit.score })),
    expected,
  );
});

test("microbench: warm per-query cost collapses (no per-query corpus tokenization)", async () => {
  const sizes = [2_000, 10_000];
  const timings: { size: number; coldMs: number; warmMs: number }[] = [];
  for (const size of sizes) {
    const catalog = makeCatalog(size, 7);
    const engine = new SearchEngine(catalog);
    const coldStart = performance.now();
    await engine.search(QUERIES[2]);
    const coldMs = performance.now() - coldStart;
    const iters = 20;
    const warmStart = performance.now();
    for (let i = 0; i < iters; i += 1) await engine.search(QUERIES[i % QUERIES.length]);
    const warmMs = (performance.now() - warmStart) / iters;
    timings.push({ size, coldMs, warmMs });
  }
  // The warm path no longer tokenizes/accumulates the corpus per query, so
  // its per-document cost must be a small fraction of the cold path's. The
  // residual bm25 scan is still O(candidates) by design (it must score every
  // document); what matters is that the constant collapsed.
  for (const t of timings) {
    const coldPerDoc = t.coldMs / t.size;
    const warmPerDoc = t.warmMs / t.size;
    assert.ok(
      coldPerDoc / warmPerDoc > 5,
      `cold/warm per-doc cost ${coldPerDoc.toFixed(4)} vs ${warmPerDoc.toFixed(4)} (${JSON.stringify(timings)})`,
    );
  }
  assert.ok(timings[1].warmMs < 60, `warm 10k-doc query took ${timings[1].warmMs.toFixed(2)}ms`);
});
