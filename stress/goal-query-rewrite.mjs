#!/usr/bin/env node
/**
 * stress/goal-query-rewrite.mjs: before/after eval of the opt-in goal-query
 * rewrite (SearchOptions.queryRewrite, packages/core/src/search/query-rewrite.ts).
 *
 * Question (r/mcp thread 1x2u6sb): does rewriting goal-style asks into
 * tool-ish verbs help retrieval? Each engine is built ONCE on the binding
 * corpus and the 30 goal-only rows are scored three ways on the same index:
 *   off     production default (no rewrite)
 *   append  raw query + implied catalog verbs, one pass
 *   fuse    raw pass + tool-ish rewrite pass, rank-fused (raw weighted higher)
 *   append-tuneonly
 *           leakage audit: "append" with the SQ2 tables cut down to entries
 *           whose key occurs in at least one TUNE-split query of the whole
 *           realistic fixture. An entry no tune row exercises cannot have
 *           been validated on tune, so it may encode a held row; this mode's
 *           held block is the number that survives that suspicion.
 *
 * Reported per engine and mode: recall@1/5/10, MRR@10, the tune and held
 * splits separately (the rewriter adds no lexicon, but the held block is the
 * leakage-safe number), per-row ranks, which rows improved / regressed /
 * stayed unchanged against "off", and cost: search passes, added query
 * tokens, and per-query wall time (one untimed warmup pass per engine first).
 *
 * Abstention side effect (rewriting can raise false confidence): the same
 * engine and modes also score the 87 negatives (the 15 realistic no-match
 * rows plus stress/fixtures/no-match-queries.json). Per mode: the gate input
 * the server's abstention rule reads (hits[0].semantic, else hits[0].score),
 * how many negatives abstain at the shipped threshold (0.8) and at the
 * documented embeddings operating point (0.36, docs/harness-guides.md), and
 * how many goal-only correct retrievals (gold in top 10) those thresholds
 * would refuse. Meaningful for the semantic engines; for keyword the input
 * is the unbounded BM25 score and is reported only for completeness.
 *
 * Gate: the "off" metrics must clear the committed goal-only floors
 * (GOAL_ONLY_FLOORS), proving the default path is unchanged. The rewrite
 * modes are reported, not gated.
 *
 * Contract: shared-lib main(): ONE compact JSON last stdout line including
 * `ok`, artifact at stress/.generated/results/goal-query-rewrite.json.
 *
 * Usage:
 *   node stress/goal-query-rewrite.mjs [--engines keyword,hashed[,embeddings]]
 *        [--corpus DIR] [--fixture PATH]
 */
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertIsolated, buildIsolatedEnv, FatalError, makeRunRoot, main } from "./lib/harness.mjs";
import {
  buildCorpusCatalog,
  buildEngine,
  checkFloors,
  loadSplitMembership,
  parseEngines,
  rankOf,
  scoreRanks,
  selectGoalOnlyRows,
} from "./goal-only-gate.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export const MODES = ["off", "append", "fuse", "append-tuneonly"];

/** Thresholds replayed on the abstention gate input (docs/harness-guides.md). */
export const ABSTENTION_THRESHOLDS = { shipped: 0.8, documentedEmbeddings: 0.36 };

/** The value the server's abstention rule compares: raw semantic, else fused score; null when no hits. */
export function gateInput(hits) {
  if (hits.length === 0) return null;
  return typeof hits[0].semantic === "number" ? hits[0].semantic : hits[0].score;
}

/**
 * Abstention outcome counts per threshold: negatives abstained (desired) and
 * positives refused (gold in top 10 but gate input below threshold).
 */
export function abstentionCounts(negatives, positives, thresholds = ABSTENTION_THRESHOLDS) {
  const below = (value, t) => value === null || value < t;
  const out = {};
  for (const [name, t] of Object.entries(thresholds)) {
    out[name] = {
      threshold: t,
      negativesAbstained: negatives.filter((row) => below(row.gate, t)).length,
      negatives: negatives.length,
      positivesRefusedTop10: positives.filter((row) => row.rank !== null && row.rank <= 10 && below(row.gate, t)).length,
      positivesInTop10: positives.filter((row) => row.rank !== null && row.rank <= 10).length,
    };
  }
  const values = negatives.map((row) => row.gate).filter((value) => value !== null);
  out.negativeGateInput = values.length === 0
    ? { n: 0, mean: null, max: null }
    : { n: values.length, mean: Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(4)), max: Number(Math.max(...values).toFixed(4)) };
  out.negativesWithAnyHit = negatives.filter((row) => row.gate !== null).length;
  return out;
}

/** A missing rank sorts below every retrieved rank. */
const rankValue = (rank) => (rank === null ? Number.POSITIVE_INFINITY : rank);

/**
 * Splits rows into improved / regressed / unchanged by rank against the
 * baseline rows (matched by query). Each entry carries both ranks.
 */
export function compareRanks(baselineRows, modeRows) {
  const before = new Map(baselineRows.map((row) => [row.query, row.rank]));
  const out = { improved: [], regressed: [], unchanged: [] };
  for (const row of modeRows) {
    if (!before.has(row.query)) throw new FatalError(`row missing from baseline: ${row.query}`);
    const from = before.get(row.query);
    const entry = { query: row.query, split: row.split, from, to: row.rank };
    const delta = rankValue(row.rank) - rankValue(from);
    if (delta < 0) out.improved.push(entry);
    else if (delta > 0) out.regressed.push(entry);
    else out.unchanged.push(entry);
  }
  return out;
}

/** Median and mean of a list of millisecond timings, rounded to 0.01 ms. */
export function latencySummary(values) {
  if (values.length === 0) return { n: 0, medianMs: 0, meanMs: 0, totalMs: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const total = values.reduce((sum, value) => sum + value, 0);
  const round = (value) => Number(value.toFixed(2));
  return { n: values.length, medianMs: round(median), meanMs: round(total / values.length), totalMs: round(total) };
}

/** True when `key` occurs as a contiguous token run in the tokenized query. */
export function keyOccursIn(key, query, tokenize, stopwords) {
  const keyTokens = tokenize(key).filter((term) => !stopwords.has(term));
  const tokens = tokenize(query).filter((term) => !stopwords.has(term));
  if (keyTokens.length === 0) return false;
  outer: for (let i = 0; i + keyTokens.length <= tokens.length; i += 1) {
    for (let j = 0; j < keyTokens.length; j += 1) if (tokens[i + j] !== keyTokens[j]) continue outer;
    return true;
  }
  return false;
}

/** Keeps only table entries whose key occurs in at least one of `queries`. */
export function filterTableToQueries(table, queries, tokenize, stopwords) {
  return Object.fromEntries(
    Object.entries(table).filter(([key]) => queries.some((query) => keyOccursIn(key, query, tokenize, stopwords))),
  );
}

/**
 * Cost of one mode for one row: search passes and query tokens beyond the
 * raw query's. A null rewrite costs nothing extra in any mode.
 */
export function rewriteCost(mode, rewrite, tokenize) {
  if (mode === "off" || rewrite === null) return { passes: 1, addedTokens: 0 };
  if (mode === "append" || mode === "append-tuneonly") return { passes: 1, addedTokens: rewrite.addedVerbs.length };
  return { passes: 2, addedTokens: tokenize(rewrite.toolQuery).length };
}

export async function runRewriteEval({ corpusDir, fixturePath, engines }) {
  const core = await import(join(repoRoot, "packages", "core", "dist", "index.js"));
  const synonyms = await import(join(repoRoot, "packages", "core", "dist", "search", "synonyms.js"));
  const { QUERY_STOPWORDS } = await import(join(repoRoot, "packages", "core", "dist", "search", "search.js"));
  const { catalog, counts } = await buildCorpusCatalog(corpusDir);
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const rows = selectGoalOnlyRows(fixture, new Set(catalog.all().map((record) => record.id)));
  const negatives = [
    ...fixture.filter((row) => row?.subtype === "no-match"),
    ...JSON.parse(readFileSync(join(repoRoot, "stress", "fixtures", "no-match-queries.json"), "utf8")),
  ].map((row) => row.query);
  if (negatives.length === 0 || negatives.some((query) => typeof query !== "string" || query.trim() === "")) {
    throw new FatalError("negative fixture rows must be non-empty strings");
  }
  const splitOf = loadSplitMembership(rows);

  // The same rewrite the engine computes internally, for the report.
  const verbs = core.catalogVerbs(catalog.all(), core.tokenize);
  const rewriteWith = (phrases, synonymTable) => new Map(rows.map((row) => [row.query, core.rewriteGoalQuery(row.query, verbs, {
    tokenize: core.tokenize,
    stopwords: QUERY_STOPWORDS,
    phrases,
    synonyms: synonymTable,
  })]));
  const rewrites = rewriteWith(synonyms.VERB_PHRASES, synonyms.VERB_SYNONYMS);

  // Leakage audit tables: entries exercised by at least one tune-split query
  // (all subtypes, not only goal-only). Held rows are never consulted.
  const tuneQueries = JSON.parse(readFileSync(join(repoRoot, "stress", "fixtures", "split-tune.json"), "utf8")).map((row) => row.query);
  const tunePhrases = filterTableToQueries(synonyms.VERB_PHRASES, tuneQueries, core.tokenize, QUERY_STOPWORDS);
  const tuneSynonyms = filterTableToQueries(synonyms.VERB_SYNONYMS, tuneQueries, core.tokenize, QUERY_STOPWORDS);
  const tuneOnlyRewrites = rewriteWith(tunePhrases, tuneSynonyms);
  const tuneOnlyRewriteOf = (query) => (tuneOnlyRewrites.has(query)
    ? tuneOnlyRewrites.get(query)
    : core.rewriteGoalQuery(query, verbs, { tokenize: core.tokenize, stopwords: QUERY_STOPWORDS, phrases: tunePhrases, synonyms: tuneSynonyms }));
  const tuneSupported = (source) => {
    const [kind, key] = [source.slice(0, source.indexOf(":")), source.slice(source.indexOf(":") + 1)];
    if (kind === "phrase") return key in tunePhrases;
    if (kind === "synonym") return key in tuneSynonyms;
    return true;
  };

  const results = {};
  for (const name of engines) {
    const { engine, buildMs } = await buildEngine(name, catalog);
    for (const row of rows) await engine.search(row.query, { limit: 50 });
    const byMode = {};
    for (const mode of MODES) {
      const options = mode === "off" ? { limit: 50 } : { limit: 50, queryRewrite: mode };
      const perRow = [];
      const timings = [];
      let passes = 0;
      let addedTokens = 0;
      const searchOne = async (query) => {
        if (mode !== "append-tuneonly") return engine.search(query, options);
        const tuneOnly = tuneOnlyRewriteOf(query);
        return engine.search(tuneOnly ? tuneOnly.appendedQuery : query, { limit: 50 });
      };
      for (const row of rows) {
        // append-tuneonly reproduces "append" outside the engine (which always
        // uses the full tables): one pass over the appended query, or the raw
        // query when the cut-down tables imply no new verb. Methodology
        // difference: this path skips #searchRewritten's exact-name
        // short-circuit on the raw query. No goal-only row spells an exact
        // action name, so the goal-only numbers are unaffected.
        const tuneOnly = tuneOnlyRewrites.get(row.query);
        const t0 = performance.now();
        const hits = mode === "append-tuneonly"
          ? await engine.search(tuneOnly ? tuneOnly.appendedQuery : row.query, { limit: 50 })
          : await engine.search(row.query, options);
        timings.push(performance.now() - t0);
        const ids = hits.map((hit) => hit.id);
        const cost = rewriteCost(mode, mode === "append-tuneonly" ? tuneOnly : rewrites.get(row.query), core.tokenize);
        passes += cost.passes;
        addedTokens += cost.addedTokens;
        perRow.push({ query: row.query, expected: row.expected, split: splitOf(row.query), rank: rankOf(ids, row.expected), gate: gateInput(hits), top3: ids.slice(0, 3) });
      }
      const negativeRows = [];
      for (const query of negatives) {
        const hits = await searchOne(query);
        negativeRows.push({ query, gate: gateInput(hits), top1: hits[0]?.id ?? null });
      }
      const bySplit = {};
      for (const split of ["tune", "held"]) bySplit[split] = scoreRanks(perRow.filter((row) => row.split === split));
      byMode[mode] = {
        ...scoreRanks(perRow),
        bySplit,
        cost: { searchPasses: passes, addedQueryTokens: addedTokens, latency: latencySummary(timings) },
        abstention: abstentionCounts(negativeRows, perRow),
        rows: perRow,
        negativeRows,
      };
    }
    const comparisons = Object.fromEntries(
      MODES.filter((mode) => mode !== "off").map((mode) => {
        const cmp = compareRanks(byMode.off.rows, byMode[mode].rows);
        return [mode, { counts: { improved: cmp.improved.length, regressed: cmp.regressed.length, unchanged: cmp.unchanged.length }, ...cmp }];
      }),
    );
    const offGate = checkFloors(name, byMode.off);
    results[name] = { buildMs, offGate, modes: byMode, comparisons };
    for (const mode of MODES) {
      const m = byMode[mode];
      const a = m.abstention;
      console.error(`[goal-query-rewrite] ${name} ${mode}: r@1=${m.recallAt1} r@5=${m.recallAt5} r@10=${m.recallAt10} mrr@10=${m.mrrAt10} held r@5=${m.bySplit.held.recallAt5} median=${m.cost.latency.medianMs}ms neg-abstain@0.36=${a.documentedEmbeddings.negativesAbstained}/${a.documentedEmbeddings.negatives} refused@0.36=${a.documentedEmbeddings.positivesRefusedTop10}/${a.documentedEmbeddings.positivesInTop10}`);
    }
  }

  return {
    ok: Object.values(results).every((result) => result.offGate.pass),
    script: "goal-query-rewrite",
    corpus: "gen-tools v3 seed 0x5337c0de + gen-skills v3 seed 1337, generated at HEAD",
    counts,
    rows: rows.length,
    engines,
    catalogVerbCount: verbs.size,
    negatives: negatives.length,
    tableEntries: {
      phrases: Object.keys(synonyms.VERB_PHRASES).length,
      synonyms: Object.keys(synonyms.VERB_SYNONYMS).length,
      tuneSupportedPhrases: Object.keys(tunePhrases).length,
      tuneSupportedSynonyms: Object.keys(tuneSynonyms).length,
    },
    rewrites: rows.map((row) => {
      const rewrite = rewrites.get(row.query);
      const tuneOnly = tuneOnlyRewrites.get(row.query);
      return {
        query: row.query,
        split: splitOf(row.query),
        addedVerbs: rewrite?.addedVerbs ?? [],
        toolQuery: rewrite?.toolQuery ?? null,
        sources: rewrite?.sources ?? [],
        sourcesWithoutTuneSupport: (rewrite?.sources ?? []).filter((source) => !tuneSupported(source)),
        tuneOnlyAddedVerbs: tuneOnly?.addedVerbs ?? [],
      };
    }),
    results,
  };
}

export const __test = { compareRanks, latencySummary, rewriteCost, keyOccursIn, filterTableToQueries, gateInput, abstentionCounts, MODES, ABSTENTION_THRESHOLDS };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    if (i === -1) return undefined;
    const value = args[i + 1];
    if (value === undefined) throw new FatalError(`flag ${name} requires a value`);
    return value;
  };
  const resultsPath = join(repoRoot, "stress", ".generated", "results", "goal-query-rewrite.json");
  await main(async () => {
    const root = makeRunRoot("goal-query-rewrite-");
    try {
      Object.assign(process.env, buildIsolatedEnv(root));
      assertIsolated(process.env, root);
      return await runRewriteEval({
        corpusDir: resolve(flag("--corpus") ?? join(repoRoot, "stress", ".generated")),
        fixturePath: resolve(flag("--fixture") ?? join(repoRoot, "stress", "fixtures", "realistic-queries.json")),
        engines: parseEngines(flag("--engines")),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, { resultsPath });
}
