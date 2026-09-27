#!/usr/bin/env node
/**
 * Deterministic search-quality eval over a fixed query split, using the repo's
 * real built engine (packages/core/dist) with production wiring:
 * BM25 + query-side stopwords + LocalSemanticIndex blend (default weight).
 *
 * Splits: stress/fixtures/split-tune.json / split-held.json — a deterministic
 * SHA-256 (of query, sorted) 60/40 split of stress/fixtures/realistic-queries.json.
 * The tune split was used to build the verb-synonym table; the held-out split
 * was never used for table construction. Any other split file with rows of the
 * shape { query, expected?, expectedAll? } works (e.g. the generated
 * regression sets under stress/.generated/*-queries.json).
 *
 * Contract (SQ2-R3): shared-lib main() — ONE compact JSON last stdout line
 * including `ok`, artifact at stress/.generated/results/split-eval.json,
 * exit code non-zero on ok:false. Actual corpus counts are reported and the
 * run FAILS CLOSED unless exactly the binding corpus is present.
 * --fails pretty output goes to STDERR, before the summary.
 *
 * Usage:
 *   node stress/split-eval.mjs [--split stress/fixtures/split-held.json] [--corpus DIR] [--fails]
 */
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertIsolated, buildIsolatedEnv, FatalError, makeRunRoot, main } from "./lib/harness.mjs";
import { loadGeneratedCorpus } from "./lib/search-corpus.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const splitPath = resolve(flag("--split") ?? join(repoRoot, "stress", "fixtures", "split-held.json"));
const corpusDir = resolve(flag("--corpus") ?? join(repoRoot, "stress", ".generated"));
const withFails = args.includes("--fails");
const resultsPath = join(repoRoot, "stress", ".generated", "results", "split-eval.json");

await main(async () => {
  // Self-isolate INSIDE main()'s guarded callback (SQ2-R4 review): preflight
  // failures (e.g. TMPDIR=/dev/null making mkdtemp throw) must flow through
  // the one-JSON/artifact path as ok:false, not bypass it as a raw crash.
  // The run root is removed in finally on every outcome (no tmp debris).
  const root = makeRunRoot("split-eval-");
  try {
    Object.assign(process.env, buildIsolatedEnv(root));
    assertIsolated(process.env, root);
  const rows = JSON.parse(readFileSync(splitPath, "utf8"));
  if (!Array.isArray(rows)) throw new FatalError(`split file ${splitPath} is not a JSON array`);

  const { SearchEngine } = await import(join(repoRoot, "packages", "core", "dist", "search", "search.js"));
  const { LocalSemanticIndex } = await import(join(repoRoot, "packages", "core", "dist", "search", "semantic.js"));
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
    catalog.add({
      id: `skill:${entry}`,
      kind: "skill",
      serverId: "skills",
      name,
      summary: desc.slice(0, 160),
      description: body,
      tags: [],
      trust: "untrusted",
    });
  }

  const engine = new SearchEngine(catalog);
  const index = new LocalSemanticIndex({});
  await index.index(catalog.all());
  engine.setSemanticScorer(index.asScorer());

  const gold = (r) => (r.expected ? [r.expected] : r.expectedAll ?? []);
  const evaluated = rows.filter((r) => gold(r).length > 0);
  const noMatch = rows.filter((r) => gold(r).length === 0);
  const r5 = [];
  const mrr = [];
  const fails = [];
  let fp = 0;
  for (const row of evaluated) {
    const hits = await engine.search(row.query, { limit: 50 });
    const ids = hits.map((h) => h.id);
    const golds = gold(row);
    let rank = Infinity;
    for (const g of golds) {
      const i = ids.indexOf(g);
      if (i !== -1) {
        rank = i + 1;
        break;
      }
    }
    r5.push(rank <= 5 ? 1 : 0);
    mrr.push(rank <= 10 ? 1 / rank : 0);
    if (rank > 5) {
      fails.push({ query: row.query, difficulty: row.difficulty, gold: golds, rank: Number.isFinite(rank) ? rank : null, top5: ids.slice(0, 5) });
    }
  }
  // OBSERVABLE no-match FP (contract): a nonempty result for a no-match query.
  for (const row of noMatch) {
    const hits = await engine.search(row.query, { limit: 10 });
    if (hits.length > 0) fp += 1;
  }
  const avg = (x) => x.reduce((a, b) => a + b, 0) / x.length;
  if (withFails) console.error(JSON.stringify(fails, null, 1));
  return {
    corpus: "gen-tools v3 seed 0x5337c0de + gen-skills v3 seed 1337, generated at HEAD",
    counts,
    split: splitPath.split("/").slice(-2).join("/"),
    n: evaluated.length,
    recall5: +avg(r5).toFixed(3),
    mrr10: +avg(mrr).toFixed(3),
    ...(noMatch.length > 0 ? { noMatchFp: `${fp}/${noMatch.length}` } : {}),
  };
  return summary;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, { resultsPath });
