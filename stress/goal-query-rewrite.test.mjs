// Unit tests for the pure parts of stress/goal-query-rewrite.mjs.
// Run: node --test stress/goal-query-rewrite.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { __test } from "./goal-query-rewrite.mjs";

const { compareRanks, latencySummary, rewriteCost, keyOccursIn, filterTableToQueries, gateInput, abstentionCounts, MODES, ABSTENTION_THRESHOLDS } = __test;

const tokenize = (text) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const stopwords = new Set(["the", "of"]);

test("MODES: off is the baseline and comes first", () => {
  assert.equal(MODES[0], "off");
  assert.ok(MODES.includes("append") && MODES.includes("fuse") && MODES.includes("append-tuneonly"));
});

test("compareRanks: null rank is worse than any rank; buckets by direction", () => {
  const base = [
    { query: "a", split: "tune", rank: 5 },
    { query: "b", split: "held", rank: null },
    { query: "c", split: "tune", rank: 1 },
    { query: "d", split: "held", rank: 3 },
  ];
  const mode = [
    { query: "a", split: "tune", rank: 1 },
    { query: "b", split: "held", rank: 40 },
    { query: "c", split: "tune", rank: 2 },
    { query: "d", split: "held", rank: 3 },
  ];
  const out = compareRanks(base, mode);
  assert.deepEqual(out.improved.map((row) => row.query), ["a", "b"]);
  assert.deepEqual(out.regressed.map((row) => [row.query, row.from, row.to]), [["c", 1, 2]]);
  assert.deepEqual(out.unchanged.map((row) => row.query), ["d"]);
});

test("compareRanks: null to null is unchanged; unknown row fails closed", () => {
  const out = compareRanks([{ query: "a", rank: null }], [{ query: "a", rank: null }]);
  assert.equal(out.unchanged.length, 1);
  assert.throws(() => compareRanks([], [{ query: "zzz", rank: 1 }]), /missing from baseline/);
});

test("latencySummary: median of odd and even lists, empty input", () => {
  assert.deepEqual(latencySummary([3, 1, 2]), { n: 3, medianMs: 2, meanMs: 2, totalMs: 6 });
  assert.equal(latencySummary([1, 2, 3, 10]).medianMs, 2.5);
  assert.deepEqual(latencySummary([]), { n: 0, medianMs: 0, meanMs: 0, totalMs: 0 });
});

test("rewriteCost: passes and added tokens per mode", () => {
  const rewrite = { addedVerbs: ["reject"], toolQuery: "reject onboarding request" };
  assert.deepEqual(rewriteCost("off", rewrite, tokenize), { passes: 1, addedTokens: 0 });
  assert.deepEqual(rewriteCost("append", rewrite, tokenize), { passes: 1, addedTokens: 1 });
  assert.deepEqual(rewriteCost("append-tuneonly", rewrite, tokenize), { passes: 1, addedTokens: 1 });
  assert.deepEqual(rewriteCost("fuse", rewrite, tokenize), { passes: 2, addedTokens: 3 });
  assert.deepEqual(rewriteCost("fuse", null, tokenize), { passes: 1, addedTokens: 0 });
});

test("keyOccursIn: contiguous token runs, stopword-insensitive, no substrings", () => {
  assert.equal(keyOccursIn("turn down", "please turn down the offer", tokenize, stopwords), true);
  assert.equal(keyOccursIn("get rid of", "get rid of the cache", tokenize, stopwords), true);
  assert.equal(keyOccursIn("turn down", "turn it down", tokenize, stopwords), false);
  assert.equal(keyOccursIn("hold", "withhold payment", tokenize, stopwords), false);
  assert.equal(keyOccursIn("the", "the cache", tokenize, stopwords), false);
});

test("filterTableToQueries: keeps only keys some query exercises", () => {
  const table = { hold: ["pause"], "turn down": ["reject"], wipe: ["purge"] };
  const kept = filterTableToQueries(table, ["hold the sku", "turn down the request"], tokenize, stopwords);
  assert.deepEqual(Object.keys(kept).sort(), ["hold", "turn down"]);
});

test("gateInput: raw semantic first, fused score as fallback, null for no hits", () => {
  assert.equal(gateInput([]), null);
  assert.equal(gateInput([{ id: "a", score: 0.02, semantic: 0.41 }]), 0.41);
  assert.equal(gateInput([{ id: "a", score: 3.2 }]), 3.2);
  assert.equal(gateInput([{ id: "a", score: 0.5, semantic: 0 }]), 0);
});

test("abstentionCounts: negatives abstain below threshold or with no hits; refusals need gold in top 10", () => {
  const negatives = [{ gate: null }, { gate: 0.2 }, { gate: 0.5 }, { gate: 0.9 }];
  const positives = [
    { rank: 1, gate: 0.3 },
    { rank: 4, gate: 0.6 },
    { rank: 12, gate: 0.1 },
    { rank: null, gate: null },
  ];
  const out = abstentionCounts(negatives, positives, { low: 0.36, high: 0.8 });
  assert.deepEqual(out.low, { threshold: 0.36, negativesAbstained: 2, negatives: 4, positivesRefusedTop10: 1, positivesInTop10: 2 });
  assert.deepEqual(out.high, { threshold: 0.8, negativesAbstained: 3, negatives: 4, positivesRefusedTop10: 2, positivesInTop10: 2 });
  assert.deepEqual(out.negativeGateInput, { n: 3, mean: 0.5333, max: 0.9 });
  assert.equal(out.negativesWithAnyHit, 3);
  assert.deepEqual(Object.keys(ABSTENTION_THRESHOLDS), ["shipped", "documentedEmbeddings"]);
});
