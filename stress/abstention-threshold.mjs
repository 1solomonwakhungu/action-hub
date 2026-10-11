#!/usr/bin/env node
/**
 * stress/abstention-threshold.mjs : held-out calibration of the search
 * abstention gate (docs/harness-guides.md, "No-confident-match abstention").
 *
 * The gate in packages/plugin/server/src/index.ts abstains when the top hit's
 * RAW semantic score (`hits[0].semantic`, falling back to the fused `score`
 * when no semantic channel is active) is below `search.abstention.threshold`.
 * This script measures that exact observable on the binding generated corpus
 * (44 manifests / 10,000 tools / 5,000 skills) with production wiring:
 *
 *   embeddings  vendored MiniLM EmbeddingSemanticIndex + RRF fusion (the
 *               hub's default channel since SQ4)
 *   hashed      LocalSemanticIndex + blend (the automatic fallback when the
 *               model cannot load; the same threshold applies to it)
 *
 * Rows:
 *   positives   stress/fixtures/realistic-queries.json rows with a gold
 *               (paraphrase / goal-only / near-duplicate / multi)
 *   negatives   the 15 realistic no-match rows plus
 *               stress/fixtures/no-match-queries.json (bands: off-domain,
 *               adjacent)
 *   synthetic   stress/.generated/tools-queries.json when present; reported
 *               by subtype, never used for calibration
 *
 * Calibration and evaluation are disjoint: realistic rows keep their
 * split-tune.json / split-held.json assignment; the new negative fixture is
 * split by the same rule (sort by SHA-256 of the query text, first 60% tune).
 * Thresholds are chosen on the tune split only and reported on the held split.
 *
 * Definitions (per threshold t, per split):
 *   refusedTop10   positive rows whose gold is in the top 10 AND the gate
 *                  input is < t (a correct retrieval the gate would hide)
 *   refusedRank1   same, restricted to rows whose gold is ranked first
 *   helpfulAbstain positive rows whose gold is NOT in the top 10 and the
 *                  gate input is < t (the gate prevented a wrong pick)
 *   abstained      negative rows with gate input < t (the desired outcome)
 *
 * The run is honest by construction: `ok` reflects fixture validity and
 * measurement validity (disjoint splits, enough negatives), never whether
 * the shipped gate looks good. The enable-by-default verdict is a reported
 * field with its criteria spelled out, so a reader can disagree with the
 * criteria and still use the numbers.
 *
 * Output contract: ONE compact JSON summary as the last stdout line (shared
 * harness main()), artifact at stress/.generated/results/abstention-threshold.json
 * with per-row detail for audit, nonzero exit iff ok:false.
 *
 * Usage:
 *   node stress/abstention-threshold.mjs [--semantic embeddings|hashed|both]
 *        [--corpus stress/.generated] [--fixture stress/fixtures/no-match-queries.json]
 *        [--vectors-cache stress/.generated/abstention-vectors.json]
 *
 * The first embeddings run embeds the 15K-document corpus in WASM (minutes);
 * the vectors are persisted to --vectors-cache so reruns only embed queries.
 *
 * Unit tests for the pure parts: node --test stress/abstention-threshold.test.mjs
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertIsolated, buildIsolatedEnv, FatalError, makeRunRoot, main } from "./lib/harness.mjs";
import { loadGeneratedCorpus } from "./lib/search-corpus.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURES = join(repoRoot, "stress", "fixtures");
const resultsPath = join(repoRoot, "stress", ".generated", "results", "abstention-threshold.json");
const detailPath = join(repoRoot, "stress", ".generated", "results", "abstention-threshold.detail.json");

/** The threshold the plugin ships in its config default (config.ts). */
export const SHIPPED_THRESHOLD = 0.8;
export const BANDS = ["off-domain", "adjacent"];
/** Fewer negatives than this and the held split is too thin to report on. */
export const MIN_NEGATIVES = 60;
export const TUNE_FRACTION = 0.6;
/**
 * Enable-by-default criteria, evaluated on the HELD split of EVERY channel
 * at the shipped threshold: a gate that hides more than 2% of correct
 * retrievals is a recall regression, and one that lets more than 20% of
 * no-match queries through is not doing its job.
 */
export const ENABLE_CRITERIA = { maxRefusedTop10Rate: 0.02, minAbstainedRate: 0.8 };

// Same stopword list and tokenizer as stress/validate-realistic-queries.mjs
// (rule 6: an off-domain no-match query shares no content token with the
// corpus vocabulary).
const STOPWORDS = new Set(
  `a about access across after again against all also am an and any are as at back be because been before
   being best between bit but by call came can cannot come could did do does doing done down due during each
   either else even every few for from further get gets getting give given go goes going got had has have
   having he her here hers him his how i if in into is it its itself just keep kind last let like long look
   looking make makes making may me mine more most much must my myself need needs neither never new no nor
   not now of off on once one only onto or other others our ours out over own per please put puts ran rather
   really right run running same see sees seem seems set several she should show side since so some someone
   something still such take taken than that the their theirs them then there these they thing things this
   those though through to too took two under until up upon us use used using very was way we well went were
   what when where which while who whom whose why will with within without would yet you your yours`
    .split(/\s+/)
    .filter(Boolean),
);
export function wordTokens(text) {
  return String(text).toLowerCase().match(/[a-z]+/g) ?? [];
}
export function contentTokens(text) {
  return wordTokens(text).filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/** Mirrors the gate input in packages/plugin/server/src/index.ts exactly. */
export function gateInputOf(hits) {
  return hits[0]?.semantic ?? hits[0]?.score ?? 0;
}

/**
 * Validates the negative fixture (fail closed). Every row is a no-match row
 * with a band; queries are unique and disjoint from `reserved` (the realistic
 * no-match queries, which already carry their own split assignment).
 */
export function validateNoMatchRows(rows, { reserved = new Set() } = {}) {
  if (!Array.isArray(rows)) throw new FatalError("no-match fixture is not a JSON array");
  const problems = [];
  const seen = new Set();
  const perBand = {};
  for (const row of rows) {
    const label = JSON.stringify(row?.query ?? row).slice(0, 80);
    if (typeof row?.query !== "string" || row.query.trim().length < 5) problems.push(`bad query: ${label}`);
    if (row.expected !== null) problems.push(`no-match row must have expected null: ${label}`);
    if ("expectedAll" in row) problems.push(`no-match row must not carry expectedAll: ${label}`);
    if (row.subtype !== "no-match") problems.push(`subtype must be no-match: ${label}`);
    if (row.difficulty !== "hard") problems.push(`difficulty must be hard: ${label}`);
    if (!BANDS.includes(row.band)) problems.push(`unknown band ${JSON.stringify(row.band)}: ${label}`);
    if (seen.has(row.query)) problems.push(`duplicate query: ${label}`);
    if (reserved.has(row.query)) problems.push(`query duplicates a realistic no-match row: ${label}`);
    seen.add(row.query);
    perBand[row.band] = (perBand[row.band] ?? 0) + 1;
  }
  if (problems.length > 0) throw new FatalError(`no-match fixture failed validation:\n- ${problems.join("\n- ")}`);
  return perBand;
}

/** Corpus vocabulary as validate-realistic-queries.mjs defines it. */
export function corpusVocabulary(manifests) {
  const vocab = new Set();
  for (const m of manifests) {
    for (const tool of m.tools ?? []) {
      for (const tok of wordTokens(tool.name)) vocab.add(tok);
      for (const tok of contentTokens(`${tool.summary ?? ""} ${tool.description ?? ""}`)) vocab.add(tok);
    }
    for (const tok of wordTokens(m.serverId ?? "")) vocab.add(tok);
    for (const tok of contentTokens(m.serverDescription ?? "")) vocab.add(tok);
  }
  return vocab;
}

/** Off-domain rows must share no content token with the corpus (rule 6). */
export function assertOffDomainDisjoint(rows, vocab) {
  const violations = [];
  for (const row of rows) {
    if (row.band !== "off-domain") continue;
    const overlap = contentTokens(row.query).filter((t) => vocab.has(t));
    if (overlap.length > 0) violations.push(`${row.query} [${overlap.join(", ")}]`);
  }
  if (violations.length > 0) {
    throw new FatalError(`off-domain no-match rows overlap the corpus vocabulary:\n- ${violations.join("\n- ")}`);
  }
}

/**
 * Deterministic split: sort by SHA-256 of the query text, first
 * floor(fraction * n) rows are tune, the rest held. Same rule that produced
 * split-tune.json / split-held.json from the realistic fixture.
 */
export function splitRows(rows, fraction = TUNE_FRACTION) {
  const hashed = rows.map((row) => ({ row, h: createHash("sha256").update(row.query).digest("hex") }));
  hashed.sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
  const n = Math.floor(fraction * rows.length);
  return {
    tune: hashed.slice(0, n).map((x) => x.row),
    held: hashed.slice(n).map((x) => x.row),
  };
}

export function thresholdGrid(step = 0.02) {
  const grid = [];
  for (let i = 0; i <= Math.round(1 / step); i += 1) grid.push(Number((i * step).toFixed(4)));
  if (!grid.includes(SHIPPED_THRESHOLD)) grid.push(SHIPPED_THRESHOLD);
  return grid.sort((a, b) => a - b);
}

const rate = (num, den) => (den === 0 ? null : Number((num / den).toFixed(4)));

/**
 * Counts the gate's outcomes at threshold t over scored rows
 * ({ kind: "positive"|"negative", gateInput, goldRank, band }).
 */
export function scoreAt(rows, t) {
  const pos = rows.filter((r) => r.kind === "positive");
  const neg = rows.filter((r) => r.kind === "negative");
  const abstains = (r) => r.gateInput < t;
  const top10 = pos.filter((r) => r.goldRank !== null && r.goldRank <= 10);
  const rank1 = pos.filter((r) => r.goldRank === 1);
  const missed = pos.filter((r) => r.goldRank === null || r.goldRank > 10);
  const byBand = {};
  // Every band present in the rows (the fixture bands plus "realistic" for
  // the original 15 no-match rows), so no negative is left out of the table.
  const bands = [...new Set([...BANDS, ...neg.map((r) => r.band).filter(Boolean)])];
  for (const band of bands) {
    const rowsInBand = neg.filter((r) => r.band === band);
    byBand[band] = { n: rowsInBand.length, abstained: rowsInBand.filter(abstains).length, abstainedRate: rate(rowsInBand.filter(abstains).length, rowsInBand.length) };
  }
  return {
    threshold: t,
    positives: pos.length,
    positivesTop10: top10.length,
    positivesRank1: rank1.length,
    positivesMissed: missed.length,
    refusedAll: pos.filter(abstains).length,
    refusedAllRate: rate(pos.filter(abstains).length, pos.length),
    refusedTop10: top10.filter(abstains).length,
    refusedTop10Rate: rate(top10.filter(abstains).length, top10.length),
    refusedRank1: rank1.filter(abstains).length,
    refusedRank1Rate: rate(rank1.filter(abstains).length, rank1.length),
    helpfulAbstain: missed.filter(abstains).length,
    helpfulAbstainRate: rate(missed.filter(abstains).length, missed.length),
    negatives: neg.length,
    abstained: neg.filter(abstains).length,
    abstainedRate: rate(neg.filter(abstains).length, neg.length),
    byBand,
  };
}

/**
 * Chooses operating points on the TUNE rows only:
 *   zeroRefusal  the largest t that hides no correct top-10 retrieval
 *   balanced     the t maximizing abstainedRate - refusedTop10Rate (Youden);
 *                ties resolve to the lowest t (fewest refusals)
 */
export function pickThresholds(tuneRows, grid = thresholdGrid()) {
  let zeroRefusal = null;
  let balanced = null;
  let bestJ = -Infinity;
  for (const t of grid) {
    const s = scoreAt(tuneRows, t);
    if (s.refusedTop10 === 0 && (zeroRefusal === null || t > zeroRefusal)) zeroRefusal = t;
    // Rounded so a floating-point tie cannot promote the stricter threshold.
    const j = Number(((s.abstainedRate ?? 0) - (s.refusedTop10Rate ?? 0)).toFixed(4));
    if (j > bestJ) {
      bestJ = j;
      balanced = t;
    }
  }
  return { zeroRefusal, balanced };
}

export function enableDecision(heldByChannel, threshold = SHIPPED_THRESHOLD, criteria = ENABLE_CRITERIA) {
  const failures = [];
  for (const [channel, held] of Object.entries(heldByChannel)) {
    const s = scoreAt(held, threshold);
    if ((s.refusedTop10Rate ?? 1) > criteria.maxRefusedTop10Rate) {
      failures.push(`${channel}: refuses ${s.refusedTop10}/${s.positivesTop10} correct top-10 retrievals at ${threshold} (rate ${s.refusedTop10Rate}, limit ${criteria.maxRefusedTop10Rate})`);
    }
    if ((s.abstainedRate ?? 0) < criteria.minAbstainedRate) {
      failures.push(`${channel}: abstains on only ${s.abstained}/${s.negatives} held-out no-match queries at ${threshold} (rate ${s.abstainedRate}, floor ${criteria.minAbstainedRate})`);
    }
  }
  return {
    threshold,
    criteria,
    enableByDefault: failures.length === 0,
    reason: failures.length === 0
      ? `the shipped gate (${threshold}) meets the criteria on the held split of every channel`
      : failures.join("; "),
  };
}

const goldsOf = (row) => (row.expected ? [row.expected] : row.expectedAll ?? []);

async function buildEngine(channel, catalog, { vectorsCache } = {}) {
  const { SearchEngine } = await import(join(repoRoot, "packages", "core", "dist", "search", "search.js"));
  const engine = new SearchEngine(catalog);
  const t0 = performance.now();
  if (channel === "embeddings") {
    const { EmbeddingSemanticIndex } = await import(join(repoRoot, "packages", "core", "dist", "search", "embeddings.js"));
    const embed = new EmbeddingSemanticIndex({});
    if (!(await embed.load())) throw new FatalError("embedding model failed to load (vendored MiniLM missing?)");
    // Embedding 15K documents in WASM takes minutes; the hub persists its
    // vectors in the catalog cache for the same reason. Reruns hydrate the
    // previous run's vectors (fingerprint-checked per document, so a changed
    // corpus re-embeds exactly what changed) and persist them afterwards.
    let hydrated = 0;
    if (vectorsCache && existsSync(vectorsCache)) {
      try {
        hydrated = embed.hydrate(JSON.parse(readFileSync(vectorsCache, "utf8")));
      } catch (cause) {
        console.error(`[abstention-threshold] ignoring unreadable vectors cache ${vectorsCache}: ${String(cause).slice(0, 120)}`);
      }
    }
    const embedded = await embed.index(catalog.all(), { chunkSize: 256 });
    console.error(`[abstention-threshold] embeddings: hydrated ${hydrated}, embedded ${embedded} documents`);
    if (vectorsCache && embedded > 0) {
      mkdirSync(dirname(vectorsCache), { recursive: true });
      writeFileSync(vectorsCache, JSON.stringify(embed.toPersisted()));
    }
    engine.setFusion("rrf");
    engine.setSemanticScorer(embed.asScorer());
  } else if (channel === "hashed") {
    const { LocalSemanticIndex } = await import(join(repoRoot, "packages", "core", "dist", "search", "semantic.js"));
    const index = new LocalSemanticIndex({});
    await index.index(catalog.all());
    engine.setSemanticScorer(index.asScorer());
  } else {
    throw new FatalError(`unknown semantic channel ${channel}`);
  }
  return { engine, buildMs: Math.round(performance.now() - t0) };
}

async function scoreRows(engine, rows) {
  const out = [];
  for (const row of rows) {
    // limit 10 is the server's default search page: the gate reads hits[0].
    const hits = await engine.search(row.query, { limit: 10 });
    const ids = hits.map((h) => h.id);
    const golds = goldsOf(row);
    let goldRank = null;
    for (const g of golds) {
      const i = ids.indexOf(g);
      if (i !== -1 && (goldRank === null || i + 1 < goldRank)) goldRank = i + 1;
    }
    out.push({
      kind: golds.length > 0 ? "positive" : "negative",
      split: row.split,
      subtype: row.subtype,
      band: row.band ?? null,
      query: row.query,
      gateInput: Number(gateInputOf(hits).toFixed(4)),
      fusedTop: hits[0] ? Number(hits[0].score.toFixed(6)) : null,
      top1: hits[0]?.id ?? null,
      hitCount: hits.length,
      goldRank,
    });
  }
  return out;
}

const pct = (values, p) => {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
};
function distribution(values) {
  return { n: values.length, min: pct(values, 0), p10: pct(values, 10), p25: pct(values, 25), p50: pct(values, 50), p75: pct(values, 75), p90: pct(values, 90), max: pct(values, 100) };
}

async function run(args) {
  const flag = (name, dflt) => {
    const i = args.indexOf(name);
    if (i === -1) return dflt;
    const v = args[i + 1];
    if (v === undefined) throw new FatalError(`flag ${name} requires a value`);
    return v;
  };
  const semantic = flag("--semantic", "both");
  const channels = semantic === "both" ? ["embeddings", "hashed"] : [semantic];
  const corpusDir = resolve(flag("--corpus", join(repoRoot, "stress", ".generated")));
  const fixturePath = resolve(flag("--fixture", join(FIXTURES, "no-match-queries.json")));
  const vectorsCache = resolve(flag("--vectors-cache", join(corpusDir, "abstention-vectors.json")));

  // --- fixtures ---------------------------------------------------------------
  const realistic = JSON.parse(readFileSync(join(FIXTURES, "realistic-queries.json"), "utf8"));
  const tuneQueries = new Set(JSON.parse(readFileSync(join(FIXTURES, "split-tune.json"), "utf8")).map((r) => r.query));
  const heldQueries = new Set(JSON.parse(readFileSync(join(FIXTURES, "split-held.json"), "utf8")).map((r) => r.query));
  const realisticRows = [];
  for (const row of realistic) {
    const split = tuneQueries.has(row.query) ? "tune" : heldQueries.has(row.query) ? "held" : null;
    if (!split) throw new FatalError(`realistic row is in neither split file: ${row.query}`);
    realisticRows.push({ ...row, split, band: row.subtype === "no-match" ? "realistic" : null });
  }
  const realisticNoMatch = new Set(realisticRows.filter((r) => r.subtype === "no-match").map((r) => r.query));
  const extraNegatives = JSON.parse(readFileSync(fixturePath, "utf8"));
  const perBand = validateNoMatchRows(extraNegatives, { reserved: realisticNoMatch });
  const extraSplit = splitRows(extraNegatives);
  const negativeRows = [
    ...extraSplit.tune.map((r) => ({ ...r, split: "tune" })),
    ...extraSplit.held.map((r) => ({ ...r, split: "held" })),
  ];
  const totalNegatives = negativeRows.length + realisticNoMatch.size;
  if (totalNegatives < MIN_NEGATIVES) throw new FatalError(`only ${totalNegatives} negative rows; need at least ${MIN_NEGATIVES}`);

  // --- corpus (fail closed on anything but the binding counts) ------------------
  const { tools, skills, counts } = loadGeneratedCorpus(corpusDir);
  const manifests = new Map();
  for (const { serverId, tool } of tools) {
    if (!manifests.has(serverId)) manifests.set(serverId, { serverId, tools: [] });
    manifests.get(serverId).tools.push(tool);
  }
  // Server descriptions live in the manifest files, not the loader output.
  for (const m of manifests.values()) {
    const p = join(corpusDir, "tools", `${m.serverId}.json`);
    if (existsSync(p)) m.serverDescription = JSON.parse(readFileSync(p, "utf8")).serverDescription ?? "";
  }
  assertOffDomainDisjoint(extraNegatives, corpusVocabulary([...manifests.values()]));

  const catalogIds = new Set([...tools.map(({ serverId, tool }) => `${serverId}:${tool.name}`), ...skills.map((s) => `skill:${s.entry}`)]);
  const missingGold = realisticRows.filter((r) => goldsOf(r).some((g) => !catalogIds.has(g)));
  if (missingGold.length > 0) throw new FatalError(`fail-closed: ${missingGold.length} realistic rows reference gold ids absent from the corpus`);

  const { Catalog } = await import(join(repoRoot, "packages", "core", "dist", "catalog", "catalog.js"));
  const catalog = new Catalog();
  for (const { serverId, tool } of tools) {
    const description = tool.description ?? "";
    const firstPara = description.split(/\n\n|\r\n\r\n/)[0] ?? "";
    catalog.add({ id: `${serverId}:${tool.name}`, kind: "tool", serverId, name: tool.name, summary: firstPara.slice(0, 160).replace(/\n/g, " "), description, tags: tool.tags ?? [], trust: "trusted" });
  }
  for (const { entry, name, desc, body } of skills) {
    catalog.add({ id: `skill:${entry}`, kind: "skill", serverId: "skills", name, summary: desc.slice(0, 160), description: body, tags: [], trust: "untrusted" });
  }

  // Synthetic generated queries: reported by subtype, never calibrated on.
  const syntheticPath = join(corpusDir, "tools-queries.json");
  let synthetic = [];
  if (existsSync(syntheticPath)) {
    const raw = JSON.parse(readFileSync(syntheticPath, "utf8"));
    synthetic = (Array.isArray(raw) ? raw : raw.queries ?? [])
      .filter((q) => typeof q?.query === "string" && goldsOf(q).every((g) => catalogIds.has(g)))
      .map((q) => ({ ...q, split: "synthetic", band: q.subtype === "no-match" ? "synthetic" : null }));
  }

  // --- measure ------------------------------------------------------------------
  const grid = thresholdGrid();
  const calibrationRows = [...realisticRows, ...negativeRows];
  const channelsOut = {};
  const heldByChannel = {};
  const detail = {};
  for (const channel of channels) {
    const { engine, buildMs } = await buildEngine(channel, catalog, { vectorsCache });
    const t0 = performance.now();
    const scored = await scoreRows(engine, calibrationRows);
    const syntheticScored = synthetic.length > 0 ? await scoreRows(engine, synthetic) : [];
    const searchMs = Math.round(performance.now() - t0);
    const tune = scored.filter((r) => r.split === "tune");
    const held = scored.filter((r) => r.split === "held");
    heldByChannel[channel] = held;
    const picks = pickThresholds(tune, grid);
    const operatingPoints = {};
    for (const [name, t] of Object.entries({ shipped: SHIPPED_THRESHOLD, zeroRefusal: picks.zeroRefusal, balanced: picks.balanced })) {
      if (t === null) { operatingPoints[name] = null; continue; }
      operatingPoints[name] = { tune: scoreAt(tune, t), held: scoreAt(held, t) };
    }
    const bySubtype = {};
    for (const subtype of ["paraphrase", "goal-only", "near-duplicate", "multi"]) {
      const rows = held.filter((r) => r.subtype === subtype);
      if (rows.length === 0) continue;
      bySubtype[subtype] = { n: rows.length, refusedAtShipped: rows.filter((r) => r.gateInput < SHIPPED_THRESHOLD).length, gateInput: distribution(rows.map((r) => r.gateInput)) };
    }
    const syntheticBySubtype = {};
    for (const r of syntheticScored) {
      const key = r.subtype ?? "unknown";
      syntheticBySubtype[key] ??= { n: 0, refusedAtShipped: 0, abstainedAtShipped: 0, goldTop10: 0, values: [] };
      const s = syntheticBySubtype[key];
      s.n += 1;
      s.values.push(r.gateInput);
      if (r.kind === "positive") {
        if (r.goldRank !== null && r.goldRank <= 10) s.goldTop10 += 1;
        if (r.gateInput < SHIPPED_THRESHOLD && r.goldRank !== null && r.goldRank <= 10) s.refusedAtShipped += 1;
      } else if (r.gateInput < SHIPPED_THRESHOLD) s.abstainedAtShipped += 1;
    }
    for (const s of Object.values(syntheticBySubtype)) { s.gateInput = distribution(s.values); delete s.values; }
    channelsOut[channel] = {
      buildMs,
      searchMs,
      rows: { tune: tune.length, held: held.length, positivesHeld: held.filter((r) => r.kind === "positive").length, negativesHeld: held.filter((r) => r.kind === "negative").length },
      gateInput: {
        positivesHeld: distribution(held.filter((r) => r.kind === "positive").map((r) => r.gateInput)),
        positivesHeldRank1: distribution(held.filter((r) => r.kind === "positive" && r.goldRank === 1).map((r) => r.gateInput)),
        negativesHeld: distribution(held.filter((r) => r.kind === "negative").map((r) => r.gateInput)),
      },
      picks,
      operatingPoints,
      heldSweep: grid.map((t) => { const s = scoreAt(held, t); return { t, refusedTop10Rate: s.refusedTop10Rate, abstainedRate: s.abstainedRate }; }),
      heldBySubtype: bySubtype,
      synthetic: syntheticScored.length > 0 ? { n: syntheticScored.length, bySubtype: syntheticBySubtype } : null,
    };
    detail[channel] = { calibration: scored, synthetic: syntheticScored };
    const sh = operatingPoints.shipped.held;
    console.error(`[abstention-threshold] ${channel}: build ${buildMs}ms, search ${searchMs}ms, held @${SHIPPED_THRESHOLD}: refusedTop10 ${sh.refusedTop10}/${sh.positivesTop10}, abstained ${sh.abstained}/${sh.negatives}; tune picks ${JSON.stringify(picks)}`);
  }

  const decision = enableDecision(heldByChannel);
  // Per-row detail (every query, its gate input, rank and top hit) goes to a
  // sibling artifact so the stdout summary stays compact but the audit trail
  // is complete.
  mkdirSync(dirname(resultsPath), { recursive: true });
  writeFileSync(detailPath, JSON.stringify(detail, null, 1) + "\n");
  return {
    corpus: counts,
    fixtures: {
      realistic: { rows: realisticRows.length, positives: realisticRows.filter((r) => r.subtype !== "no-match").length, noMatch: realisticNoMatch.size },
      noMatchFixture: { path: "stress/fixtures/no-match-queries.json", rows: extraNegatives.length, perBand, tune: extraSplit.tune.length, held: extraSplit.held.length },
      negativesTotal: totalNegatives,
      splitRule: "realistic rows keep split-tune/split-held; new negatives sorted by sha256(query), first 60% tune",
    },
    gateInputDefinition: "hits[0].semantic ?? hits[0].score ?? 0 at limit 10 (packages/plugin/server/src/index.ts)",
    shippedThreshold: SHIPPED_THRESHOLD,
    channels: channelsOut,
    decision,
    detailArtifact: relative(repoRoot, detailPath),
  };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  await main(async () => {
    const root = makeRunRoot("abstention-threshold-");
    try {
      Object.assign(process.env, buildIsolatedEnv(root));
      assertIsolated(process.env, root);
      return await run(process.argv.slice(2));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, { resultsPath });
}

export const __test = { run };
