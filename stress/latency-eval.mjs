#!/usr/bin/env node
/**
 * Production-shaped search latency measurement (SQ2 review finding 4).
 *
 * Builds the FULL generated corpus (10k tools + 5k skills), attaches the
 * LocalSemanticIndex exactly like the product default, then measures
 * SearchEngine#search latency over the realistic 121-row set, 3 warm passes.
 *
 * Usage: node stress/latency-eval.mjs [--corpus DIR] [--passes 3]
 * Prints one JSON line: { n, passes, p50, p95, p99 (ms) }.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";


/** Single exit path (CONTRACT hard rule): compact JSON last line + artifact. */
function finish(summary = {}) {
  const payload = { script: "latency-eval.mjs", ok: true, ...summary };
  try {
    const dir = join(repoRoot, "stress", ".generated", "results");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "latency-eval.json"), JSON.stringify(payload, null, 1));
  } catch {
    payload.ok = false;
    payload.artifactError = "failed to write stress/.generated/results/latency-eval.json";
  }
  console.log(JSON.stringify(payload));
  process.exit(payload.ok ? 0 : 1);
}

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const corpusDir = flag("--corpus", join(repoRoot, "stress", ".generated"));
const passes = Number(flag("--passes", 3));

const { SearchEngine } = await import(join(repoRoot, "packages", "core", "dist", "search", "search.js"));
const { LocalSemanticIndex } = await import(join(repoRoot, "packages", "core", "dist", "search", "semantic.js"));
const { Catalog } = await import(join(repoRoot, "packages", "core", "dist", "catalog", "catalog.js"));

const catalog = new Catalog();
const toolsDir = join(corpusDir, "tools");
if (!statSync(toolsDir, { throwIfNoEntry: false })) {
  finish({ ok: false, error: `corpus not found: ${toolsDir} (run node stress/gen-tools.mjs first)` });
}
let toolCount = 0;
let manifestCount = 0;
for (const f of readdirSync(toolsDir)) {
  if (!f.endsWith(".json")) continue;
  manifestCount += 1;
  const data = JSON.parse(readFileSync(join(toolsDir, f), "utf8"));
  const serverId = data.serverId ?? basename(f, ".json");
  for (const tool of data.tools ?? []) {
    toolCount += 1;
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
let skillCount = 0;
for (const entry of readdirSync(skillsDir)) {
  const p = join(skillsDir, entry);
  if (!statSync(p).isDirectory()) continue;
  skillCount += 1;
  const md = readFileSync(join(p, "SKILL.md"), "utf8");
  const name = md.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? entry;
  const desc = md.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const body = md.split(/^---$/m)[2]?.trim() ?? "";
  catalog.add({ id: `skill:${entry}`, kind: "skill", serverId: "skills", name, summary: desc.slice(0, 160), description: body, tags: [], trust: "untrusted" });
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
const summary = {
  corpus: { tools: toolCount, skills: skillCount, docs: toolCount + skillCount, manifests: manifestCount },
  n: queries.length,
  passes,
  p50: q(50),
  p95: q(95),
  p99: q(99),
};
// Fail closed on the binding corpus, same rule as split-eval.
if (!flag("--corpus")) {
  const binding = toolCount === 10_000 && skillCount === 5_000 && manifestCount === 44;
  if (!binding) {
    summary.ok = false;
    summary.error = `binding corpus mismatch: expected 10000 tools / 5000 skills / 44 manifests, got ${toolCount}/${skillCount}/${manifestCount}`;
  }
}
finish(summary);
