#!/usr/bin/env node
/**
 * stress/validate-realistic-queries.mjs — FX13-R2 gate for the hand-written
 * realistic query fixture (stress/fixtures/realistic-queries.json).
 *
 * Validates every row against the seeded generated corpus
 * (stress/.generated/tools/*.json; regenerates it via gen-tools.mjs if
 * missing) so gold labels can never reference a tool that does not exist.
 *
 * Checks:
 *  (1) mix: 40 paraphrase, 30 goal-only, 20 near-duplicate, 15 multi,
 *      15 no-match; every query string unique; 120 rows total.
 *  (2) existence: every expected / expectedAll id "<serverId>:<name>"
 *      exists in the corpus.
 *  (3) multi rows: expected null, expectedAll non-empty.
 *  (4) goal-only: the query shares NO token with the gold tool's name
 *      (intent must be expressed without the tool's own vocabulary).
 *  (5) near-duplicate: the gold name is a clone (>= 2 servers in the
 *      corpus) and the query carries a domain clue (a token of the gold
 *      serverId, e.g. "crm", "billing", "initech").
 *  (6) no-match: after stopword removal the query shares ZERO tokens with
 *      the full corpus vocabulary (tool names, summaries, descriptions,
 *      serverIds).
 *
 * Output contract: one compact JSON summary as the last stdout line with
 * ok:true/false; writes stress/.generated/results/validate-realistic-queries.json;
 * exits nonzero iff ok is false. `--samples N` prints N random queries.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "realistic-queries.json");
const TOOLS_DIR = path.join(HERE, ".generated", "tools");
const RESULTS_PATH = path.join(HERE, ".generated", "results", "validate-realistic-queries.json");

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

function tokens(text) {
  return String(text).toLowerCase().match(/[a-z]+/g) ?? [];
}
function contentTokens(text) {
  return tokens(text).filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function finish(summary) {
  try {
    fs.mkdirSync(path.dirname(RESULTS_PATH), { recursive: true });
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(summary) + "\n");
  } catch (err) {
    summary.ok = false;
    summary.artifactError = String(err?.message ?? err);
  }
  console.log(JSON.stringify(summary));
  process.exitCode = summary.ok ? 0 : 1;
}

try {
  const rows = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  if (!fs.existsSync(TOOLS_DIR) || fs.readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".json")).length === 0) {
    const r = spawnSync("node", [path.join(HERE, "gen-tools.mjs")], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("corpus manifests missing and gen-tools.mjs failed to regenerate them");
  }

  const corpus = new Map(); // id -> { name, serverId }
  const vocab = new Set();
  const byName = new Map();
  for (const f of fs.readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".json"))) {
    const m = JSON.parse(fs.readFileSync(path.join(TOOLS_DIR, f), "utf8"));
    for (const t of m.tools) {
      const id = `${m.serverId}:${t.name}`;
      corpus.set(id, t);
      if (!byName.has(t.name)) byName.set(t.name, new Set());
      byName.get(t.name).add(m.serverId);
      for (const tok of tokens(t.name)) vocab.add(tok);
      for (const tok of contentTokens(`${t.summary ?? ""} ${t.description ?? ""}`)) vocab.add(tok);
    }
    for (const tok of tokens(m.serverId)) vocab.add(tok);
    for (const tok of contentTokens(m.serverDescription ?? "")) vocab.add(tok);
  }

  const problems = [];
  const MIX = { paraphrase: 40, "goal-only": 30, "near-duplicate": 20, multi: 15, "no-match": 15 };
  const counts = {};
  const seen = new Set();
  for (const row of rows) {
    counts[row.subtype] = (counts[row.subtype] ?? 0) + 1;
    if (seen.has(row.query)) problems.push(`duplicate query: ${row.query}`);
    seen.add(row.query);
    const check = (id) => {
      if (!corpus.has(id)) problems.push(`unknown gold id: ${id} (query: ${row.query})`);
    };
    if (row.expected != null) check(row.expected);
    for (const id of row.expectedAll ?? []) check(id);

    if (row.subtype === "no-match") {
      const hits = contentTokens(row.query).filter((t) => vocab.has(t));
      if (hits.length > 0) problems.push(`no-match overlaps corpus vocabulary [${hits}]: ${row.query}`);
      continue;
    }
    if (row.subtype === "multi") {
      if (row.expected != null) problems.push(`multi row must have expected null: ${row.query}`);
      if (!Array.isArray(row.expectedAll) || row.expectedAll.length < 2) {
        problems.push(`multi row needs expectedAll >= 2: ${row.query}`);
      }
      continue;
    }
    if (row.expectedAll) problems.push(`non-multi row has expectedAll: ${row.query}`);
    if (!row.expected) { problems.push(`row without expected: ${row.query}`); continue; }
    const tool = corpus.get(row.expected);
    if (!tool) continue;

    if (row.subtype === "goal-only") {
      // Intent without the gold tool's VERB; entity wording is allowed to
      // appear (that is what makes it goal-only rather than a paraphrase).
      const verb = tokens(tool.name)[0];
      if (contentTokens(row.query).includes(verb)) {
        problems.push(`goal-only shares the gold VERB token "${verb}" with gold name: ${row.query}`);
      }
    }
    if (row.subtype === "near-duplicate") {
      const servers = byName.get(tool.name) ?? new Set();
      if (servers.size < 2) problems.push(`near-dup gold is not cloned (${servers.size} servers): ${row.query}`);
      const clue = tokens(row.expected.split(":")[0]).filter((t) => contentTokens(row.query).includes(t));
      if (clue.length === 0) {
        problems.push(`near-dup query missing domain clue (gold serverId token): ${row.query}`);
      }
    }
    if (row.subtype === "no-match") {
      const hits = contentTokens(row.query).filter((t) => vocab.has(t));
      if (hits.length > 0) problems.push(`no-match overlaps corpus vocabulary [${hits}]: ${row.query}`);
    }
  }
  for (const [sub, want] of Object.entries(MIX)) {
    if ((counts[sub] ?? 0) !== want) problems.push(`mix ${sub}: got ${counts[sub] ?? 0}, want ${want}`);
  }
  if (rows.length !== 120) problems.push(`row count: got ${rows.length}, want 120`);

  const summary = {
    ok: problems.length === 0,
    rows: rows.length,
    counts,
    corpusTools: corpus.size,
    problems: problems.slice(0, 40),
    problemCount: problems.length,
  };

  const sampleArg = process.argv.indexOf("--samples");
  if (sampleArg > 0) {
    const n = Number(process.argv[sampleArg + 1] ?? 20);
    for (let i = rows.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [rows[i], rows[j]] = [rows[j], rows[i]];
    }
    summary.samples = rows.slice(0, n).map((r) => ({
      query: r.query,
      expected: r.expected ?? null,
      expectedAll: r.expectedAll ? r.expectedAll.length : undefined,
      subtype: r.subtype,
    }));
  }
  finish(summary);
} catch (err) {
  finish({ ok: false, error: String(err?.message ?? err) });
}
