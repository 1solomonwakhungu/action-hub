/**
 * stress/abstention-threshold.test.mjs : unit tests for the pure parts of
 * stress/abstention-threshold.mjs and for the no-match fixture it consumes.
 * Run: node --test stress/abstention-threshold.test.mjs
 * (Imports the ESM source directly; no dist build and no generated corpus.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BANDS,
  ENABLE_CRITERIA,
  MIN_NEGATIVES,
  SHIPPED_THRESHOLD,
  assertOffDomainDisjoint,
  corpusVocabulary,
  enableDecision,
  gateInputOf,
  pickThresholds,
  scoreAt,
  splitRows,
  thresholdGrid,
  validateNoMatchRows,
} from "./abstention-threshold.mjs";

const FIXTURES = resolve(fileURLToPath(new URL("./fixtures", import.meta.url)));
const fixture = JSON.parse(readFileSync(join(FIXTURES, "no-match-queries.json"), "utf8"));
const realistic = JSON.parse(readFileSync(join(FIXTURES, "realistic-queries.json"), "utf8"));
const realisticNoMatch = new Set(realistic.filter((r) => r.subtype === "no-match").map((r) => r.query));

test("fixture: every row is a banded no-match row, unique, disjoint from the realistic no-match rows", () => {
  const perBand = validateNoMatchRows(fixture, { reserved: realisticNoMatch });
  for (const band of BANDS) assert.ok((perBand[band] ?? 0) >= 30, `band ${band} needs at least 30 rows, got ${perBand[band] ?? 0}`);
  assert.ok(fixture.length + realisticNoMatch.size >= MIN_NEGATIVES, "enough negatives for a held split");
});

test("fixture: the config default the script calibrates against is the one config.ts ships", () => {
  const config = readFileSync(resolve(fileURLToPath(new URL("../packages/plugin/server/src/config.ts", import.meta.url))), "utf8");
  const match = config.match(/DEFAULT_ABSTENTION_THRESHOLD\s*=\s*([0-9.]+)/);
  assert.ok(match, "config.ts declares DEFAULT_ABSTENTION_THRESHOLD");
  assert.equal(Number(match[1]), SHIPPED_THRESHOLD);
});

test("validateNoMatchRows fails closed on malformed rows", () => {
  const good = { query: "teach my puppy to sit", expected: null, subtype: "no-match", difficulty: "hard", band: "off-domain" };
  validateNoMatchRows([good]);
  for (const bad of [
    { ...good, expected: "acme-corp-crm:get_contact" },
    { ...good, expectedAll: ["a", "b"] },
    { ...good, subtype: "paraphrase" },
    { ...good, difficulty: "exact" },
    { ...good, band: "mystery" },
    { ...good, query: "tiny" },
  ]) {
    assert.throws(() => validateNoMatchRows([bad]), /failed validation/, JSON.stringify(bad));
  }
  assert.throws(() => validateNoMatchRows([good, { ...good }]), /duplicate query/);
  assert.throws(() => validateNoMatchRows([good], { reserved: new Set([good.query]) }), /duplicates a realistic/);
  assert.throws(() => validateNoMatchRows({ not: "an array" }), /not a JSON array/);
});

test("off-domain rows may not share content tokens with the corpus vocabulary; adjacent rows may", () => {
  const manifests = [{ serverId: "acme-corp-crm", serverDescription: "Customer relationship management.", tools: [{ name: "list_contacts", description: "List contacts in the workspace." }] }];
  const vocab = corpusVocabulary(manifests);
  assert.ok(vocab.has("contacts") && vocab.has("crm") && vocab.has("workspace"));
  assert.ok(!vocab.has("the"), "stopwords are not vocabulary");
  assertOffDomainDisjoint([{ query: "bake sourdough bread", band: "off-domain" }], vocab);
  assertOffDomainDisjoint([{ query: "export my contacts to a spreadsheet", band: "adjacent" }], vocab);
  assert.throws(() => assertOffDomainDisjoint([{ query: "clean up the crm contacts", band: "off-domain" }], vocab), /overlap the corpus vocabulary/);
});

test("splitRows is deterministic, disjoint, and sized floor(60%)", () => {
  const rows = fixture.map((r) => ({ query: r.query }));
  const a = splitRows(rows);
  const b = splitRows([...rows].reverse());
  assert.equal(a.tune.length, Math.floor(0.6 * rows.length));
  assert.equal(a.tune.length + a.held.length, rows.length);
  assert.deepEqual(a.tune.map((r) => r.query), b.tune.map((r) => r.query), "input order does not change the split");
  const tune = new Set(a.tune.map((r) => r.query));
  assert.ok(a.held.every((r) => !tune.has(r.query)), "tune and held are disjoint");
});

test("gateInputOf mirrors the server gate: raw semantic first, fused score as fallback, 0 when empty", () => {
  assert.equal(gateInputOf([]), 0);
  assert.equal(gateInputOf([{ score: 0.016, semantic: 0.42 }]), 0.42);
  assert.equal(gateInputOf([{ score: 0.55 }]), 0.55);
  assert.equal(gateInputOf([{ score: 0.55, semantic: 0 }]), 0, "a present zero semantic is the signal, not a miss");
});

const synthetic = [
  { kind: "positive", gateInput: 0.9, goldRank: 1 },
  { kind: "positive", gateInput: 0.7, goldRank: 1 },
  { kind: "positive", gateInput: 0.5, goldRank: 3 },
  { kind: "positive", gateInput: 0.4, goldRank: null },
  { kind: "negative", gateInput: 0.65, band: "adjacent" },
  { kind: "negative", gateInput: 0.3, band: "off-domain" },
  { kind: "negative", gateInput: 0.2, band: "off-domain" },
];

test("scoreAt counts refusals, helpful abstentions and abstained negatives per band", () => {
  const s = scoreAt(synthetic, 0.6);
  assert.equal(s.positives, 4);
  assert.equal(s.positivesTop10, 3);
  assert.equal(s.refusedTop10, 1, "the rank-3 row at 0.5 is a hidden correct retrieval");
  assert.equal(s.refusedRank1, 0);
  assert.equal(s.helpfulAbstain, 1, "the missed row at 0.4 is a prevented wrong pick");
  assert.equal(s.abstained, 2);
  assert.equal(s.abstainedRate, 0.6667);
  assert.equal(s.byBand["off-domain"].abstained, 2);
  assert.equal(s.byBand.adjacent.abstained, 0);
  const strict = scoreAt(synthetic, 0.95);
  assert.equal(strict.refusedTop10, 3);
  assert.equal(strict.abstained, 3);
  assert.equal(scoreAt([], 0.5).refusedTop10Rate, null, "no rows means no rate, not a fake zero");
});

test("pickThresholds chooses on the given rows only and prefers the largest zero-refusal threshold", () => {
  const grid = thresholdGrid(0.05);
  assert.ok(grid.includes(SHIPPED_THRESHOLD) && grid[0] === 0 && grid[grid.length - 1] === 1);
  const picks = pickThresholds(synthetic, grid);
  // Correct top-10 retrievals sit at 0.9, 0.7, 0.5: the largest grid value
  // that refuses none of them is 0.5 (strictly-below semantics).
  assert.equal(picks.zeroRefusal, 0.5);
  // Youden on this toy set: from 0.35 up to 0.5 two of three negatives
  // abstain with no refusal (J = 0.667); at 0.7 all three abstain but one of
  // three correct retrievals is refused (J = 0.667 again). Ties resolve to
  // the lowest threshold, the one that refuses the fewest real matches.
  assert.equal(picks.balanced, 0.35);
});

test("enableDecision applies the criteria on every channel's held rows at the shipped threshold", () => {
  const good = [
    { kind: "positive", gateInput: 0.95, goldRank: 1 },
    { kind: "positive", gateInput: 0.9, goldRank: 2 },
    { kind: "negative", gateInput: 0.1, band: "off-domain" },
    { kind: "negative", gateInput: 0.2, band: "adjacent" },
    { kind: "negative", gateInput: 0.3, band: "adjacent" },
    { kind: "negative", gateInput: 0.4, band: "adjacent" },
    { kind: "negative", gateInput: 0.85, band: "adjacent" },
  ];
  assert.equal(enableDecision({ embeddings: good }).enableByDefault, true);
  const refusing = [{ kind: "positive", gateInput: 0.5, goldRank: 1 }, ...good];
  const verdict = enableDecision({ embeddings: good, hashed: refusing });
  assert.equal(verdict.enableByDefault, false);
  assert.match(verdict.reason, /hashed: refuses 1\/3/);
  assert.equal(verdict.threshold, SHIPPED_THRESHOLD);
  assert.deepEqual(verdict.criteria, ENABLE_CRITERIA);
});
