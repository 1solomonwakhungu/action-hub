// SQ4 offline tuner: embed the corpus ONCE, then evaluate weight/query-mode
// variants on ONE split in-process. Never touches the held split during search.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const splitPath = resolve(arg("--split", join(repoRoot, "stress", "fixtures", "split-tune.json")));
const corpusDir = arg("--corpus", join(repoRoot, "stress", ".generated"));

const { SearchEngine, tokenize, QUERY_STOPWORDS } = await import(join(repoRoot, "packages", "core", "dist", "search", "search.js"));
const { EmbeddingSemanticIndex } = await import(join(repoRoot, "packages", "core", "dist", "search", "embeddings.js"));
const { expandQuery } = await import(join(repoRoot, "packages", "core", "dist", "search", "synonyms.js"));
const { Catalog } = await import(join(repoRoot, "packages", "core", "dist", "catalog", "catalog.js"));

const catalog = new Catalog();
for (const f of readdirSync(join(corpusDir, "tools"))) {
  if (!f.endsWith(".json")) continue;
  const data = JSON.parse(readFileSync(join(corpusDir, "tools", f), "utf8"));
  const serverId = data.serverId ?? basename(f, ".json");
  for (const tool of data.tools ?? []) {
    const description = tool.description ?? "";
    catalog.add({ id: `${serverId}:${tool.name}`, kind: "tool", serverId, name: tool.name, summary: (description.split(/\n\n|\r\n\r\n/)[0] ?? "").slice(0, 160).replace(/\n/g, " "), description, tags: tool.tags ?? [], trust: "trusted" });
  }
}
const skillsDir = join(corpusDir, "skills");
for (const entry of readdirSync(skillsDir)) {
  const p = join(skillsDir, entry);
  if (!statSync(p).isDirectory()) continue;
  const md = readFileSync(join(p, "SKILL.md"), "utf8");
  catalog.add({ id: `skill:${entry}`, kind: "skill", serverId: "skills", name: md.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? entry, summary: (md.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "").slice(0, 160), description: md.split(/^---$/m)[2]?.trim() ?? "", tags: [], trust: "untrusted" });
}
console.error(`corpus: ${catalog.all().length} docs`);

const embed = new EmbeddingSemanticIndex({});
const t0 = performance.now();
await embed.load();
const loadMs = performance.now() - t0;
let embedded = 0;
let embedMs = 0;
for (let i = 0; i < catalog.all().length; i += 512) {
  const chunk = catalog.all().slice(i, i + 512);
  const c0 = performance.now();
  embedded += await embed.index(chunk, { chunkSize: 512, yieldFn: () => Promise.resolve() });
  embedMs += performance.now() - c0;
}
console.error(`load ${loadMs | 0}ms, embedded ${embedded} docs in ${(embedMs / 1000).toFixed(1)}s (${(embedded / (embedMs / 1000)).toFixed(0)} docs/s)`);

const rows = JSON.parse(readFileSync(splitPath, "utf8"));
const gold = (r) => (r.expected ? [r.expected] : r.expectedAll ?? []);

// query-mode: raw | expanded (synonym-expanded token text, down-weighted ignored)
function queryText(row, mode) {
  if (mode === "raw") return row.query;
  const { terms } = expandQuery(row.query, tokenize, 0.5, QUERY_STOPWORDS);
  return terms.map((t) => t.term).join(" ");
}

for (const mode of ["raw", "expanded"]) {
  for (const weight of [0.2, 0.5, 1.0]) {
    const engine = new SearchEngine(catalog);
    const scorer = embed.asScorer();
    engine.setFusion("rrf");
    // monkey-set weight via public setter
    engine.setSemanticWeight(weight);
    engine.setSemanticScorer(async (query, candidates) => scorer(query, candidates));
    let r5 = 0, mrr = 0, n = 0;
    for (const row of rows) {
      if (gold(row).length === 0) continue;
      n += 1;
      const hits = await engine.search(queryText(row, mode), { limit: 50 });
      const ids = hits.map((h) => h.id);
      let rank = Infinity;
      for (const g of gold(row)) { const i = ids.indexOf(g); if (i !== -1) { rank = i + 1; break; } }
      r5 += rank <= 5 ? 1 : 0;
      mrr += rank <= 10 ? 1 / rank : 0;
    }
    console.log(JSON.stringify({ mode, weight, n, recall5: +(r5 / n).toFixed(3), mrr10: +(mrr / n).toFixed(3) }));
  }
}
