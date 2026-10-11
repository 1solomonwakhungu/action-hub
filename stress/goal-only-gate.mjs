#!/usr/bin/env node
/**
 * stress/goal-only-gate.mjs: the goal-only recall gate (r/mcp follow-up 5).
 *
 * Goal-only queries state an intent without the gold tool's verb ("wipe the
 * expired login tokens" for purge_token) and are the lowest-scoring subtype
 * of the hand-written realistic fixture. This gate tracks them on their own,
 * so a ranking change that trades goal-only recall for a prettier aggregate
 * is visible, and reports them independently of stress/eval-retrieval.mjs
 * (which another owner maintains and which folds goal-only into "hard").
 *
 * Rows: the 30 subtype "goal-only" rows of stress/fixtures/realistic-queries.json
 * (exactly 30, fail closed), scored against the binding generated corpus
 * (44 manifests / 10,000 tools / 5,000 skills; fail closed on any other
 * count) with the repo's real built engine and production wiring.
 *
 * Engines (each reported separately):
 *   keyword     pure BM25 plus query-side synonym expansion (semanticScorer: null)
 *   hashed      dependency-free LocalSemanticIndex blend (the embeddings: null path)
 *   embeddings  vendored MiniLM embeddings fused by RRF (the production default;
 *               opt-in via --engines because embedding 15K records takes minutes)
 *
 * Metrics per engine: recall@1/5/10, MRR@10, per-row rank with its tune/held
 * split membership (stress/fixtures/split-tune.json, split-held.json), and
 * the same metrics on the held-out subset alone, so a synonym-table change
 * tuned on the tune split cannot claim the held-out rows.
 *
 * Gates: committed floors in GOAL_ONLY_FLOORS, one query (3.3 points) below
 * the values measured when the gate landed, per engine that ran. Raise them
 * in the same commit that improves retrieval and record the new numbers.
 *
 * Contract: shared-lib main(): ONE compact JSON last stdout line including
 * `ok`, artifact at stress/.generated/results/goal-only-gate.json, exit code
 * non-zero on ok:false. `--fails` prints the misses (rank > 5) to stderr.
 *
 * Usage:
 *   node stress/goal-only-gate.mjs [--engines keyword,hashed[,embeddings]]
 *        [--corpus DIR] [--fixture PATH] [--fails]
 */
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertIsolated, buildIsolatedEnv, FatalError, makeRunRoot, main } from "./lib/harness.mjs";
import { loadGeneratedCorpus } from "./lib/search-corpus.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** The fixture's goal-only band is exactly this large; anything else is a fixture change. */
export const GOAL_ONLY_ROWS = 30;
export const DEFAULT_ENGINES = ["keyword", "hashed"];
export const ALL_ENGINES = ["keyword", "hashed", "embeddings"];

/**
 * Floors, per engine. Measured 2026-10-11 on the binding corpus (gen-tools v3
 * seed 0x5337c0de, gen-skills v3 seed 1337) at the commit that added the gate:
 *
 *   engine      recall@1  recall@5  recall@10  MRR@10
 *   keyword      0.267     0.433     0.533      0.349
 *   hashed       0.133     0.267     0.333      0.181
 *   embeddings   0.400     0.533     0.567      0.454
 *
 * One query is 1/30 = 0.033 of recall; floors sit one query below the
 * measured recall values and two rank-1 flips below the measured MRR
 * (a rank-1 hit falling to rank 2 costs 0.5/30 = 0.017).
 */
export const GOAL_ONLY_FLOORS = {
  keyword: { recallAt5: 0.4, recallAt10: 0.5, mrrAt10: 0.31 },
  hashed: { recallAt5: 0.23, recallAt10: 0.3, mrrAt10: 0.14 },
  embeddings: { recallAt5: 0.5, recallAt10: 0.53, mrrAt10: 0.42 },
};

/** Picks the goal-only rows and fails closed on count, shape, and gold presence. */
export function selectGoalOnlyRows(rows, catalogIds) {
  if (!Array.isArray(rows)) throw new FatalError("fixture is not a JSON array");
  const goalOnly = rows.filter((row) => row && row.subtype === "goal-only");
  if (goalOnly.length !== GOAL_ONLY_ROWS) {
    throw new FatalError(`expected exactly ${GOAL_ONLY_ROWS} goal-only rows, got ${goalOnly.length} (fixture changed; update GOAL_ONLY_ROWS and the floors deliberately)`);
  }
  const problems = [];
  const seen = new Set();
  for (const row of goalOnly) {
    if (typeof row.query !== "string" || row.query.trim() === "") problems.push(`empty query: ${JSON.stringify(row)}`);
    if (row.difficulty !== "hard") problems.push(`goal-only row must be difficulty "hard": ${row.query}`);
    if (typeof row.expected !== "string" || row.expected.length === 0 || "expectedAll" in row) {
      problems.push(`goal-only row must carry one non-empty gold and no expectedAll: ${row.query}`);
    } else if (catalogIds && !catalogIds.has(row.expected)) {
      problems.push(`gold id absent from the corpus: ${row.expected} (${row.query})`);
    }
    if (seen.has(row.query)) problems.push(`duplicate goal-only query: ${row.query}`);
    seen.add(row.query);
  }
  if (problems.length > 0) throw new FatalError(`goal-only rows failed validation:\n- ${problems.join("\n- ")}`);
  return goalOnly;
}

/** 1-based rank of the gold in `ids`, or null when not retrieved. */
export function rankOf(ids, gold) {
  const index = ids.indexOf(gold);
  return index === -1 ? null : index + 1;
}

/** recall@1/5/10 and MRR@10 over rows of { rank }. Empty input yields zeros. */
export function scoreRanks(rows) {
  const n = rows.length;
  if (n === 0) return { n: 0, recallAt1: 0, recallAt5: 0, recallAt10: 0, mrrAt10: 0 };
  const within = (k) => rows.filter((row) => row.rank !== null && row.rank <= k).length / n;
  const mrr = rows.reduce((sum, row) => sum + (row.rank !== null && row.rank <= 10 ? 1 / row.rank : 0), 0) / n;
  const round = (value) => Number(value.toFixed(4));
  return { n, recallAt1: round(within(1)), recallAt5: round(within(5)), recallAt10: round(within(10)), mrrAt10: round(mrr) };
}

/** Compares measured metrics with an engine's floors; every floor must hold. */
export function checkFloors(engine, metrics, floors = GOAL_ONLY_FLOORS) {
  const floor = floors[engine];
  if (!floor) throw new FatalError(`no committed floors for engine "${engine}"`);
  const checks = {};
  for (const [metric, target] of Object.entries(floor)) {
    const actual = metrics[metric];
    checks[metric] = { target, actual, pass: typeof actual === "number" && actual >= target };
  }
  return { checks, pass: Object.values(checks).every((check) => check.pass) };
}

export function parseEngines(value) {
  if (value === undefined) return [...DEFAULT_ENGINES];
  const engines = value.split(",").map((name) => name.trim()).filter(Boolean);
  if (engines.length === 0) throw new FatalError("--engines requires at least one engine name");
  const unknown = engines.filter((name) => !ALL_ENGINES.includes(name));
  if (unknown.length > 0) throw new FatalError(`unknown engine(s): ${unknown.join(", ")}; valid: ${ALL_ENGINES.join(", ")}`);
  return [...new Set(engines)];
}

function loadSplitMembership() {
  const read = (name) => {
    const path = join(repoRoot, "stress", "fixtures", name);
    try {
      return new Set(JSON.parse(readFileSync(path, "utf8")).map((row) => row.query));
    } catch {
      return new Set();
    }
  };
  const tune = read("split-tune.json");
  const held = read("split-held.json");
  return (query) => (tune.has(query) ? "tune" : held.has(query) ? "held" : "unsplit");
}

async function buildEngine(name, catalog) {
  const { SearchEngine } = await import(join(repoRoot, "packages", "core", "dist", "search", "search.js"));
  const engine = new SearchEngine(catalog);
  const t0 = performance.now();
  if (name === "hashed") {
    const { LocalSemanticIndex } = await import(join(repoRoot, "packages", "core", "dist", "search", "semantic.js"));
    const index = new LocalSemanticIndex({});
    await index.index(catalog.all());
    engine.setSemanticScorer(index.asScorer());
  } else if (name === "embeddings") {
    const { EmbeddingSemanticIndex } = await import(join(repoRoot, "packages", "core", "dist", "search", "embeddings.js"));
    const embed = new EmbeddingSemanticIndex({});
    if (!(await embed.load())) throw new FatalError("embedding model failed to load");
    await embed.index(catalog.all(), { chunkSize: 256 });
    engine.setFusion("rrf");
    engine.setSemanticScorer(embed.asScorer());
  }
  return { engine, buildMs: Math.round(performance.now() - t0) };
}

export async function runGate({ corpusDir, fixturePath, engines, withFails }) {
  const { Catalog } = await import(join(repoRoot, "packages", "core", "dist", "catalog", "catalog.js"));
  const { tools, skills, counts } = loadGeneratedCorpus(corpusDir);
  const catalog = new Catalog();
  for (const { serverId, tool } of tools) {
    const description = tool.description ?? "";
    const firstPara = description.split(/\n\n|\r\n\r\n/)[0] ?? "";
    catalog.add({
      id: `${serverId}:${tool.name}`,
      kind: "tool",
      serverId,
      name: tool.name,
      summary: firstPara.slice(0, 160).replace(/\n/g, " "),
      description,
      tags: tool.tags ?? [],
      trust: "trusted",
    });
  }
  for (const { entry, name, desc, body } of skills) {
    catalog.add({ id: `skill:${entry}`, kind: "skill", serverId: "skills", name, summary: desc.slice(0, 160), description: body, tags: [], trust: "untrusted" });
  }

  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const catalogIds = new Set(catalog.all().map((record) => record.id));
  const rows = selectGoalOnlyRows(fixture, catalogIds);
  const splitOf = loadSplitMembership();

  const results = {};
  const gates = {};
  const fails = [];
  for (const name of engines) {
    const { engine, buildMs } = await buildEngine(name, catalog);
    const perRow = [];
    for (const row of rows) {
      const hits = await engine.search(row.query, { limit: 50 });
      const ids = hits.map((hit) => hit.id);
      const rank = rankOf(ids, row.expected);
      perRow.push({ query: row.query, expected: row.expected, split: splitOf(row.query), rank, top3: ids.slice(0, 3) });
      if (rank === null || rank > 5) fails.push({ engine: name, query: row.query, expected: row.expected, rank, top5: ids.slice(0, 5) });
    }
    const metrics = scoreRanks(perRow);
    const bySplit = {};
    for (const split of ["tune", "held"]) {
      const subset = perRow.filter((row) => row.split === split);
      if (subset.length > 0) bySplit[split] = scoreRanks(subset);
    }
    const gate = checkFloors(name, metrics);
    results[name] = { buildMs, ...metrics, bySplit, rows: perRow };
    gates[name] = gate;
    console.error(`[goal-only-gate] ${name}: r@1=${metrics.recallAt1} r@5=${metrics.recallAt5} r@10=${metrics.recallAt10} mrr@10=${metrics.mrrAt10} ${gate.pass ? "PASS" : "FAIL"}`);
  }
  if (withFails) console.error(JSON.stringify(fails, null, 1));

  return {
    ok: Object.values(gates).every((gate) => gate.pass),
    script: "goal-only-gate",
    corpus: "gen-tools v3 seed 0x5337c0de + gen-skills v3 seed 1337, generated at HEAD",
    counts,
    rows: rows.length,
    engines,
    floors: Object.fromEntries(engines.map((name) => [name, GOAL_ONLY_FLOORS[name]])),
    gates,
    results,
  };
}

export const __test = { selectGoalOnlyRows, rankOf, scoreRanks, checkFloors, parseEngines, GOAL_ONLY_FLOORS, GOAL_ONLY_ROWS };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    if (i === -1) return undefined;
    const value = args[i + 1];
    if (value === undefined) throw new FatalError(`flag ${name} requires a value`);
    return value;
  };
  const resultsPath = join(repoRoot, "stress", ".generated", "results", "goal-only-gate.json");
  await main(async () => {
    // Self-isolate inside main()'s guarded callback so preflight failures
    // flow through the one-JSON/artifact path; the run root is removed in
    // finally on every outcome.
    const root = makeRunRoot("goal-only-gate-");
    try {
      Object.assign(process.env, buildIsolatedEnv(root));
      assertIsolated(process.env, root);
      return await runGate({
        corpusDir: resolve(flag("--corpus") ?? join(repoRoot, "stress", ".generated")),
        fixturePath: resolve(flag("--fixture") ?? join(repoRoot, "stress", "fixtures", "realistic-queries.json")),
        engines: parseEngines(flag("--engines")),
        withFails: args.includes("--fails"),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, { resultsPath });
}
