#!/usr/bin/env node
/**
 * Production-shaped search latency measurement (SQ2 review finding 4).
 *
 * Builds the FULL generated corpus (10k tools + 5k skills), attaches the
 * LocalSemanticIndex exactly like the product default, then measures
 * SearchEngine#search latency over the realistic 121-row set, warm passes.
 *
 * Contract (SQ2-R3): shared-lib main() — ONE compact JSON last stdout line
 * including `ok`, artifact at stress/.generated/results/latency-eval.json,
 * exit code non-zero on ok:false. Actual corpus counts are reported and the
 * run FAILS CLOSED unless exactly the binding corpus is present.
 *
 * Usage: node stress/latency-eval.mjs [--corpus DIR] [--passes 3]
 */
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertIsolated, buildIsolatedEnv, FatalError, makeRunRoot, main } from "./lib/harness.mjs";
import { loadGeneratedCorpus } from "./lib/search-corpus.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
// CLI values are resolved INSIDE main()'s guarded callback (SQ2-R4 review):
// a present-but-valueless --corpus previously threw at module scope, leaving
// zero stdout lines and a stale artifact. Missing values are rejected
// explicitly through the finish path.
const requireFlagValue = (name) => {
  if (!args.includes(name)) return undefined;
  const v = flag(name);
  if (v === undefined) throw new FatalError(`flag ${name} requires a value`);
  return v;
};
const resultsPath = join(repoRoot, "stress", ".generated", "results", "latency-eval.json");

await main(async () => {
  // Self-isolate INSIDE main()'s guarded callback (SQ2-R4 review): preflight
  // failures (e.g. TMPDIR=/dev/null making mkdtemp throw) must flow through
  // the one-JSON/artifact path as ok:false, not bypass it as a raw crash.
  // The run root is removed in finally on every outcome (no tmp debris).
  const root = makeRunRoot("latency-eval-");
  try {
    Object.assign(process.env, buildIsolatedEnv(root));
    assertIsolated(process.env, root);
    const corpusArg = requireFlagValue("--corpus");
    const corpusDir = resolve(corpusArg ?? join(repoRoot, "stress", ".generated"));
    const passesArg = requireFlagValue("--passes");
    const passesRaw = Number(passesArg ?? 3);
    if (!Number.isFinite(passesRaw) || passesRaw < 1) {
      throw new FatalError(`--passes must be a positive number (got "${passesArg ?? "3"}")`);
    }
    const passes = Math.floor(passesRaw);
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

  const queries = JSON.parse(readFileSync(join(repoRoot, "stress", "fixtures", "realistic-queries.json"), "utf8")).map((r) => r.query);
  // warm
  for (const q of queries) await engine.search(q, { limit: 10 });
  const samples = [];
  for (let p = 0; p < passes; p += 1) {
    for (const q of queries) {
      const t0 = process.hrtime.bigint();
      await engine.search(q, { limit: 10 });
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
  }
  samples.sort((a, b) => a - b);
  const q = (x) => {
    const i = Math.min(samples.length - 1, Math.ceil((x / 100) * samples.length) - 1);
    return +samples[i].toFixed(1);
  };
  const summary = { counts, corpusDocs: catalog.all().length, n: queries.length, passes, p50: q(50), p95: q(95), p99: q(99) };
  return summary;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, { resultsPath });
