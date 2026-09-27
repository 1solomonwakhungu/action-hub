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
 * Usage:
 *   node stress/split-eval.mjs stress/fixtures/split-held.json [--corpus DIR] [--fails]
 * Exits non-zero if the corpus or split cannot be loaded, and prints a single
 * machine-readable JSON line with recall@5 / MRR@10 (and the no-match FP rate
 * for rows with no expected ids).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const splitPath = resolve(flag("--split") ?? join(repoRoot, "stress", "fixtures", "split-held.json"));
const corpusDir = flag("--corpus") ?? join(repoRoot, "stress", ".generated");
const withFails = args.includes("--fails");

const rows = JSON.parse(readFileSync(splitPath, "utf8"));
if (!Array.isArray(rows)) {
  console.error(`split file ${splitPath} is not a JSON array`);
  process.exit(2);
}

const { SearchEngine } = await import(join(repoRoot, "packages", "core", "dist", "search", "search.js"));
const { LocalSemanticIndex } = await import(join(repoRoot, "packages", "core", "dist", "search", "semantic.js"));
const { Catalog } = await import(join(repoRoot, "packages", "core", "dist", "catalog", "catalog.js"));

const catalog = new Catalog();
const toolsDir = join(corpusDir, "tools");
if (!statSync(toolsDir, { throwIfNoEntry: false })) {
  console.error(`corpus not found: ${toolsDir} (run node stress/gen-tools.mjs first)`);
  process.exit(2);
}
for (const f of readdirSync(toolsDir)) {
  if (!f.endsWith(".json")) continue;
  const data = JSON.parse(readFileSync(join(toolsDir, f), "utf8"));
  const serverId = data.serverId ?? basename(f, ".json");
  for (const tool of data.tools ?? []) {
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
}
const skillsDir = join(corpusDir, "skills");
if (statSync(skillsDir, { throwIfNoEntry: false })) {
  for (const entry of readdirSync(skillsDir)) {
    const p = join(skillsDir, entry);
    if (!statSync(p).isDirectory()) continue;
    const md = readFileSync(join(p, "SKILL.md"), "utf8");
    const name = md.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? entry;
    const desc = md.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
    const body = md.split(/^---$/m)[2]?.trim() ?? "";
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
for (const row of noMatch) {
  const hits = await engine.search(row.query, { limit: 10 });
  if (hits.length > 0) fp += 1;
}
const avg = (x) => x.reduce((a, b) => a + b, 0) / x.length;
const summary = {
  corpus: "gen-tools v3 seed 0x5337c0de (10k tools) + gen-skills v3 seed 1337 (5k skills), generated at HEAD",
  split: splitPath.split("/").slice(-2).join("/"),
  n: evaluated.length,
  recall5: +avg(r5).toFixed(3),
  mrr10: +avg(mrr).toFixed(3),
};
if (noMatch.length > 0) summary.noMatchFp = `${fp}/${noMatch.length}`;
console.log(JSON.stringify(summary));
if (withFails) console.log(JSON.stringify(fails, null, 1));
