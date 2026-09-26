#!/usr/bin/env node
/**
 * stress/eval-retrieval.mjs — S5 retrieval quality at scale. Owner: builder-6.
 *
 * In-process evaluation (no child processes) of Action Hub retrieval:
 *   engines: keyword (pure BM25, semanticScorer:null) vs built-in local
 *   semantic blend (default hub) vs standalone createLocalSemanticScorer.
 *
 * Metrics (CONTRACT.md query schema v2): recall@1/3/5/10/20, MRR@10, nDCG@10,
 * Completeness@10, Sufficiency@10 (multi-gold), no-match false-positive rate,
 * stage-separated retrieval-vs-rank reporting, warm p50/p95 after an excluded
 * warmup pass, context token cost per response, definition-token savings.
 * Reported by difficulty (exact|paraphrase|hard), subtype, and kind.
 *
 * Gates (reported honestly): recall@5 .90/.80/.65, recall@10 .95/.90/.80,
 * MRR@10 .80/.65/.45 (exact/paraphrase/hard); Sufficiency@10 >= .75;
 * no-match FP <= 5%; warm p95 <= 100 ms at 15K; token savings >= 95%.
 *
 * Data: stress/.generated manifests + query files when the generators have
 * landed; otherwise deterministic self-fixtures in contract format.
 *
 * Output: JSON summary as the LAST stdout line, also written to
 * stress/.generated/results/eval-retrieval.json.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { ActionHub, createLocalSemanticScorer, parseSkillContent } from "../packages/core/dist/index.js";
import { createSandbox, assertIsolated, main as harnessMain } from "./lib/harness.mjs";

// ---- isolation (ISOLATION.md checklist, rev 21:27Z + reviewer-2 rework) ------
// The ENTIRE setup runs inside the failure envelope (see the bottom-of-file
// runner): any throw here produces the final JSON summary on stdout and a
// nonzero exit. All path-bearing env vars are REPLACED under ONE fresh temp
// root; the real owner home is derived independently of $HOME.
const STRESS_DIR = resolve(fileURLToPath(import.meta.url), "..");
const GENERATED = join(STRESS_DIR, ".generated");
const RESULTS_DIR = join(GENERATED, "results");
const ARGV = new Set(process.argv.slice(2));
const QUICK = ARGV.has("--quick");
const SEED = 0x5eed;
const PREFIXES = [100, 1000, 5000, 10000, 15000];
const GATES = {
  recallAt5: { exact: 0.9, paraphrase: 0.8, hard: 0.65 },
  recallAt10: { exact: 0.95, paraphrase: 0.9, hard: 0.8 },
  mrrAt10: { exact: 0.8, paraphrase: 0.65, hard: 0.45 },
  sufficiencyAt10: 0.75,
  noMatchFpRate: 0.05,
  warmP95MsAt15K: 100,
  tokenSavings: 0.95,
};

// ---- seeded RNG (deterministic; no Date/Math.random) ------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
function sampleN(arr, n, r = rand) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.slice(0, n);
}
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const hardIfNot = (difficulty) => (difficulty === "exact" || difficulty === "paraphrase" ? difficulty : "hard");

// ---- fixture catalog (deterministic, contract format) -----------------------
const OBJECTS = [
  "contacts", "invoices", "tickets", "deploys", "secrets", "customers", "orders",
  "shipments", "refunds", "coupons", "reports", "dashboards", "queries", "notes",
  "events", "calendars", "policies", "roles", "tokens", "webhooks", "devices",
  "sim_cards", "fleets", "sensors", "gateways", "products", "vendors", "payrolls",
  "timesheets", "budgets", "leads", "quotes", "contracts", "assets", "licenses",
  "audits", "incidents", "changes", "problems", "branches", "merges", "pipelines",
  "artifacts", "clusters", "namespaces", "certificates", "domains", "tables",
  "indexes", "queues", "alerts", "schedules", "rotations", "playbooks", "skills",
  "agents", "imports", "exports", "snapshots", "backups", "migrations",
];
const VERBS = ["list", "create", "update", "delete", "search", "export", "count", "merge", "archive", "restore", "validate", "assign", "sync", "diff", "approve"];
const DESTRUCTIVE = new Set(["delete", "merge", "archive"]);
const DOMAINS = [
  "crm", "billing", "support", "devops", "knowledge", "scheduling", "warehouse",
  "identity", "inventory", "finance", "network", "observability", "content",
  "sales", "compliance",
];

/** 15 domains x 60 objects x 15 verbs = 13,500 tools on 30 servers. */
function syntheticCatalog(domainCount = DOMAINS.length) {
  const servers = [];
  for (const domain of DOMAINS.slice(0, domainCount)) servers.push(`${domain}-main`, `${domain}-mirror`);
  const tools = [];
  const schemaFor = (verb) => ({
    type: "object",
    properties: {
      filter: { type: "string", description: "Filter text" },
      limit: { type: "integer", description: "Max rows to return" },
      ...(verb === "create" || verb === "update" || verb === "merge"
        ? { payload: { type: "object", description: "Fields to write" } }
        : {}),
    },
  });
  for (const domain of DOMAINS.slice(0, domainCount)) {
    for (const object of OBJECTS) {
      for (const verb of VERBS) {
        const serverId = verb === "list" || verb === "search" ? `${domain}-mirror` : `${domain}-main`;
        tools.push({
          serverId,
          name: `${verb}_${object}`,
          description: `${capitalize(verb)} ${object.replace(/_/g, " ")} in the ${domain} workspace. Supports filters, pagination, and field selection.`,
          inputSchema: schemaFor(verb),
          annotations: DESTRUCTIVE.has(verb) ? { destructiveHint: true } : { readOnlyHint: true },
        });
      }
    }
  }
  return { servers, tools };
}

/**
 * 5,000 synthetic skills: names composed of an adjective, a topic, and a
 * craft word so summaries vary and hard paraphrases stay answerable.
 */
function syntheticSkillPool(count = 5000) {
  const crafts = ["Playbook", "Runbook", "Checklist", "Drill", "Guide", "Sweep", "Digest", "Audit", "Review", "Walkthrough"];
  const moods = ["Weekly", "Rapid", "Deep", "Quiet", "Bulk", "Steady", "First-Pass", "Final", "Nightly", "Full"];
  const skills = [];
  for (let i = 0; i < count; i++) {
    const object = OBJECTS[i % OBJECTS.length];
    const craft = crafts[Math.floor(i / OBJECTS.length) % crafts.length];
    const mood = moods[(i * 7) % moods.length];
    const name = `${mood} ${capitalize(object)} ${craft}`;
    const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") + "-" + i;
    skills.push({
      id: `skill:${slug}`,
      name,
      summary: `${mood} ${object.replace(/_/g, " ")} ${craft.toLowerCase()} for the ${DOMAINS[i % DOMAINS.length]} workspace: verify, clean up, and report on ${object.replace(/_/g, " ")}.`,
      description: `Use this skill when a task involves ${object.replace(/_/g, " ")}. It walks through validation, safe mutation, and reporting. Follow the checklist exactly and record every change.`,
      tags: [object, craft.toLowerCase()],
    });
  }
  return skills;
}


// ---- self-mode query set (contract query schema v2) --------------------------
// Deterministic dev fixtures until the generator query files land. Mix
// approximates the contract: exact / paraphrase / goal-only / near-duplicate
// (distractors: same object rival verbs + mirror-server clones) / noisy
// (typos, fragments) / multi (tool + skill) / no-match. Difficulty mapping
// per contract: goal-only, near-duplicate, noisy, multi, no-match => hard.
let tools = [];

function flipTypo(s) {
  const parts = s.split(" ");
  const w = parts.find((p) => p.length > 3) ?? parts[0];
  const i = parts.indexOf(w);
  parts[i] = w[0] + w[2] + w[1] + w.slice(3);
  return parts.join(" ");
}

const SELF_SKILLS = [
  ["Crm Contact Hygiene", "contacts", "crm"],
  ["Invoice Reconciliation", "invoices", "billing"],
  ["Ticket SLA Triage", "tickets", "support"],
  ["Secret Rotation Drill", "secrets", "identity"],
  ["Shipment Exception Sweep", "shipments", "warehouse"],
  ["Refund Policy Checks", "refunds", "billing"],
  ["Coupon Fraud Watch", "coupons", "billing"],
  ["Slow Query Diagnosis", "queries", "knowledge"],
  ["Meeting Notes Digest", "notes", "knowledge"],
  ["Webhook Replay Drill", "webhooks", "observability"],
  ["Token Expiry Sweep", "tokens", "identity"],
  ["Namespace Quota Review", "namespaces", "devops"],
  ["Domain Renewal Sweep", "domains", "network"],
  ["Vendor Scorecard", "vendors", "finance"],
  ["Backup Restore Drill", "backups", "devops"],
  ["Audit Trail Review", "audits", "compliance"],
].map(([name, object, domain]) => {
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return {
    id: `skill:${slug}`,
    name,
    summary: `${name} keeps the ${domain} workspace tidy: verify, clean up, and report on ${object}.`,
    description: `Use this skill when a task involves ${object}. It walks through validation, safe mutation, and reporting. Follow the checklist exactly and record every change.`,
    tags: [object, domain],
  };
});


function selfQueries() {
  const domains = QUICK ? DOMAINS.slice(0, 2) : DOMAINS;
  const objects = QUICK ? OBJECTS.slice(0, 30) : OBJECTS;
  const queries = [];
  const push = (q) => queries.push(q);
  const findTool = (domain, verb, object) =>
    tools.find((t) => t.serverId === `${domain}-main` && t.name === `${verb}_${object}`) ??
    tools.find((t) => t.serverId === `${domain}-mirror` && t.name === `${verb}_${object}`);
  const pick = (i, arr) => arr[i % arr.length];

  // exact (20%): the tool name itself; a few typos sprinkled in
  const exactCount = Math.max(6, Math.round(objects.length * 0.2));
  for (let i = 0; i < exactCount; i++) {
    const object = pick(i * 7 + 1, objects);
    const domain = pick(i, domains);
    const noisy = i % 6 === 5;
    const tool = findTool(domain, "list", object);
    if (!tool) continue;
    push({
      query: noisy ? flipTypo(`list ${object.replace(/_/g, " ")}`) : `list ${object.replace(/_/g, " ")}`,
      expected: `${tool.serverId}:${tool.name}`,
      difficulty: noisy ? "hard" : "exact", subtype: noisy ? "noisy" : "exact",
    });
  }

  // paraphrase (20%): intent phrased, no command words
  for (let i = 0; i < exactCount; i++) {
    const object = pick(i * 5 + 3, objects);
    const domain = pick(i, domains);
    const tool = findTool(domain, "list", object);
    if (!tool) continue;
    push({
      query: `I need to pull up our ${object.replace(/_/g, " ")} today`,
      expected: `${tool.serverId}:${tool.name}`,
      difficulty: "paraphrase", subtype: "paraphrase",
    });
  }

  // goal-only (20%): intent stated; rival verbs are the near misses
  for (let i = 0; i < exactCount; i++) {
    const object = pick(i * 7 + 9, objects);
    const domain = pick(i, domains);
    const tool = findTool(domain, "merge", object);
    if (!tool) continue;
    push({
      query: `tidy up duplicate and stale ${object.replace(/_/g, " ")} entries in ${domain}`,
      expected: `${tool.serverId}:${tool.name}`,
      difficulty: "hard", subtype: "goal-only",
    });
  }

  // near-duplicate (25%): distractors mined from nearest non-gold neighbours
  // (same object + rival verb, on both the main and the mirror server).
  const ndCount = Math.max(7, Math.round(objects.length * 0.25));
  for (let i = 0; i < ndCount; i++) {
    const object = pick(i * 3 + 2, objects);
    const domain = pick(i, domains);
    if (i % 2 === 0) {
      const toolA = findTool(domain, "archive", object);
    if (!toolA) continue;
    push({ query: `archive old ${object.replace(/_/g, " ")} entries`, expected: `${toolA.serverId}:${toolA.name}`, difficulty: "hard", subtype: "near-duplicate" });
    } else {
      const tool = findTool(domain, "archive", object);
      if (!tool) continue;
      push({ query: `${domain} ${object.replace(/_/g, " ")} cleanup`, expected: `${tool.serverId}:${tool.name}`, difficulty: "hard", subtype: "near-duplicate" });
    }
  }

  // multi (10%): tool + skill pairs sharing a topic
  const multiCount = Math.max(3, Math.round(exactCount * 0.5));
  for (let i = 0; i < multiCount; i++) {
    const skill = pick(i * 3, SELF_SKILLS);
    const object = skill.tags.find((t) => objects.includes(t)) ?? "contacts";
    const domain = skill.tags.find((t) => domains.includes(t)) ?? "crm";
    const tool = findTool(domain, "create", object);
    if (!tool) continue;
    push({
      query: `we need to handle ${object.replace(/_/g, " ")} in ${domain} — do the work and follow the documented procedure`,
      expectedAll: [`${tool.serverId}:${tool.name}`, skill.id],
      difficulty: "hard", subtype: "multi",
    });
  }

  // no-match (5%): nothing in the catalog plausibly matches
  for (const q of [
    "book a flight to Lisbon for two people next month",
    "renew my gym membership and pay the annual fee",
    "translate the onboarding email into Japanese",
    "hire a freelance illustrator for the mascot redesign",
    "plan a wedding seating chart without family drama",
    "find a dentist taking walk-ins this saturday",
  ]) push({ query: q, expected: null, difficulty: "hard", subtype: "no-match" });

  return queries;
}

// ---- data loading -------------------------------------------------------------
/** Loads the generated corpus when builder-1/4 artifacts exist; verifies the
 *  contract's skill:<slug> id rule against parseSkillContent output. */
function loadGenerated() {
  const toolsDir = join(GENERATED, "tools");
  const skillsDir = join(GENERATED, "skills");
  const tq = join(GENERATED, "tools-queries.json");
  const sqp = join(GENERATED, "skills-queries.json");
  if (!existsSync(toolsDir) || !existsSync(tq) || !existsSync(sqp)) return null;

  const manifests = [];
  for (const e of readdirSync(toolsDir, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith(".json")) continue;
    const m = JSON.parse(readFileSync(join(toolsDir, e.name), "utf8"));
    if (Array.isArray(m?.tools) && m.tools.length > 0) manifests.push(m);
  }
  const skills = [];
  let idMismatches = 0;
  if (existsSync(join(GENERATED, "skills"))) {
    for (const e of readdirSync(join(GENERATED, "skills"), { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const md = join(GENERATED, "skills", e.name, "SKILL.md");
      if (!existsSync(md)) continue;
      const parsed = parseSkillContent(readFileSync(md, "utf8"), md, "custom");
      // CONTRACT: action id = skill:<slug> as produced by parseSkillContent.
      if (parsed.id !== `skill:${e.name}`) {
        idMismatches += 1;
        console.error(`[eval-retrieval] id mismatch for ${e.name}: parser said "${parsed.id}", expected "skill:${e.name}" (forcing)`);
      }
      skills.push({ id: `skill:${e.name}`, name: parsed.name, serverId: "skills", summary: parsed.summary, description: parsed.description, tags: parsed.tags });
    }
  }
  const loadJson = (p) => {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    const arr = Array.isArray(parsed) ? parsed : parsed.queries;
    return arr.filter((q) => q && typeof q.query === "string");
  };
  return {
    manifests,
    skills,
    queries: [...loadJson(tq), ...loadJson(sqp)],
    idMismatches,
  };
}

function groupTools(tools) {
  const byServer = new Map();
  for (const t of tools) {
    if (!byServer.has(t.serverId)) byServer.set(t.serverId, []);
    byServer.get(t.serverId).push(t);
  }
  return [...byServer.entries()].map(([serverId, list]) => ({ serverId, tools: list }));
}

// ---- evaluation -----------------------------------------------------------------
async function buildEngine(name, manifests, skills) {
  const t0 = performance.now();
  const hub = new ActionHub({
    clientFactory: async (config) => {
      const m = manifests.find((x) => x.serverId === config.id);
      const list = m ? m.tools : [];
      return {
        async listTools() { return list; },
        async callTool(n) { throw new Error(`fake client does not execute "${n}"`); },
        async close() {},
      };
    },
    servers: manifests.map((m) => ({ id: m.serverId, transport: { type: "stdio", command: "fake" }, trust: "trusted" })),
    semanticScorer: name === "keyword"
      ? null
      : name === "scorer"
        ? createLocalSemanticScorer([
            ...manifests.flatMap((m) => m.tools.map((t) => ({
              id: `${m.serverId}:${t.name}`, kind: "tool", serverId: m.serverId, name: t.name,
              summary: t.description, description: t.description, inputSchema: t.inputSchema ?? {}, trust: "trusted",
            }))),
            ...skills.map((s) => ({ ...s, kind: "skill", trust: "trusted" })),
          ])
        : undefined,
  });
  await hub.indexAll();
  if (skills.length > 0) hub.replaceSkills(skills);
  return { hub, buildMs: performance.now() - t0 };
}

const ENGINE_NAMES = ["keyword", "blend", "scorer"];
const SWEEP_ENGINES = ["keyword", "blend"];
const ENGINE_DESC = {
  keyword: "pure BM25 (semanticScorer: null)",
  blend: "built-in local semantic blend (default ActionHub)",
  scorer: "createLocalSemanticScorer injected as the scorer",
};

async function warmAndTime(hub, queries) {
  const withTimeout = (promise, ms, label) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout: ${label} exceeded ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  };
  for (const q of queries) await withTimeout(hub.search(q.query, { limit: 20 }), 30_000, `warmup "${q.query.slice(0, 40)}"`);
  const rows = [];
  const latencies = [];
  for (const q of queries) {
    const t0 = performance.now();
    const hits = await withTimeout(hub.search(q.query, { limit: 20 }), 30_000, `search "${q.query.slice(0, 40)}"`);
    latencies.push(performance.now() - t0);
    const golds = goldsOf(q);
    const ids = hits.map((h) => h.id);
    const goldRanks = golds.map((g) => (ids.includes(g) ? ids.indexOf(g) + 1 : null));
    rows.push({
      query: q.query,
      expected: q.expected ?? null,
      expectedAll: golds.length > 1 ? golds : undefined,
      difficulty: q.difficulty,
      subtype: q.subtype,
      kind: golds.length > 1 ? "multi" : golds[0] && golds[0].startsWith("skill:") ? "skill" : "tool",
      goldRanks,
      firstGoldRank: golds.length ? Math.min(...golds.map((g, i) => (goldRanks[i] ?? Infinity))) : null,
      top1: ids[0] ?? null,
      top1Score: hits[0]?.score ?? 0,
      top3: hits.slice(0, 3).map((h) => ({ id: h.id, name: h.name, score: Number((h.score ?? 0).toFixed(4)) })),
      responseTokens: tokens(JSON.stringify(hits)),
    });
  }
  return { rows, latencies };
}

const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const safeDiv = (a, b) => (b === 0 ? 0 : a / b);
const tokens = (s) => Math.ceil(String(s ?? "").length / 4);
function percentileOf(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function scoreEngine(rows, latencies, fpThreshold) {
  const matched = rows.filter((r) => r.expected !== null || (r.expectedAll?.length ?? 0) > 0);
  const noMatch = rows.filter((r) => r.expected === null && !r.expectedAll);
  const multi = matched.filter((r) => (r.expectedAll?.length ?? 0) > 1);
  const byDifficulty = {};
  for (const d of ["exact", "paraphrase", "hard"]) {
    const subset = matched.filter((r) => r.difficulty === d);
    byDifficulty[d] = subset.length ? coreMetrics(subset) : null;
  }
  const bySubtype = {};
  for (const r of rows) {
    bySubtype[r.subtype] ??= [];
    bySubtype[r.subtype].push(r);
  }
  const byKind = {};
  for (const k of ["tool", "skill", "multi"]) {
    const subset = matched.filter((r) => r.kind === k);
    byKind[k] = subset.length ? coreMetrics(subset) : null;
  }

  let fpRate = null, fpDefinition = null, noMatchTop1Mean = null;
  if (noMatch.length > 0) {
    const threshold = percentileOf(matched.map((r) => r.top1Score), 25);
    fpRate = noMatch.filter((r) => r.top1Score >= threshold).length / noMatch.length;
    fpDefinition = "top-1 score >= P25 of matched-query top-1 scores";
    noMatchTop1Mean = mean(noMatch.map((r) => r.top1Score));
  }

  const recalls = {};
  for (const k of [1, 3, 5, 10, 20]) {
    let found = 0, total = 0;
    for (const r of matched) {
      const golds = r.expectedAll?.length > 1 ? r.expectedAll : [r.expected];
      for (const g of golds) {
        const idx = golds.indexOf(g);
        const pos = r.goldRanks[idx];
        total += 1;
        if (pos !== null && pos <= k) found += 1;
      }
    }
    recalls[`recallAt${k}`] = safeDiv(found, total);
  }

  const lat = [...latencies].sort((a, b) => a - b);
  return {
    queryCount: rows.length,
    matchedCount: matched.length,
    ...recalls,
    mrrAt10: mean(matched.map((r) => (r.firstGoldRank !== Infinity && r.firstGoldRank <= 10 ? 1 / r.firstGoldRank : 0))),
    ndcgAt10: mean(matched.map((r) => {
      const golds = r.expectedAll?.length > 1 ? r.expectedAll : [r.expected];
      const dcg = golds
        .map((g, i) => r.goldRanks[i])
        .filter((p) => p !== null && p <= 10)
        .reduce((s, p) => s + 1 / Math.log2(p + 1), 0);
      const ideal = Math.min(golds.length, 10);
      const idcg = Array.from({ length: ideal }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
      return idcg > 0 ? dcg / idcg : 1;
    })),
    completenessAt10: multi.length
      ? mean(multi.map((r) => safeDiv(r.expectedAll.filter((g, i) => r.goldRanks[i] !== null && r.goldRanks[i] <= 10).length, r.expectedAll.length)))
      : null,
    sufficiencyAt10: multi.length
      ? mean(multi.map((r) => (r.expectedAll.every((g, i) => r.goldRanks[i] !== null && r.goldRanks[i] <= 10) ? 1 : 0)))
      : null,
    noMatch: {
      count: noMatch.length,
      fpRate,
      fpDefinition,
      meanTop1Score: noMatchTop1Mean,
      matchedMeanTop1Score: matched.length ? mean(matched.map((r) => r.top1Score)) : null,
    },
    latency: {
      warmP50Ms: Number(percentileOf(lat, 50).toFixed(2)),
      warmP95Ms: Number(percentileOf(lat, 95).toFixed(2)),
      meanMs: Number(mean(lat).toFixed(2)),
      maxMs: Number(Math.max(...lat, 0).toFixed(2)),
    },
    responseTokensMean: Math.round(mean(rows.map((r) => r.responseTokens))),
    byDifficulty,
    bySubtype: mapValues(bySubtype, (rs) => coreMetrics(rs)),
    byKind,
  };
}

function coreMetrics(rows) {
  const matched = rows.filter((r) => r.expected !== null || (r.expectedAll?.length ?? 0) > 0);
  const multi = matched.filter((r) => (r.expectedAll?.length ?? 0) > 1);
  const out = { queryCount: rows.length };
  for (const k of [1, 3, 5, 10, 20]) {
    let found = 0, total = 0;
    for (const r of matched) {
      const golds = r.expectedAll?.length > 1 ? r.expectedAll : [r.expected];
      for (let i = 0; i < golds.length; i++) {
        total += 1;
        const p = r.goldRanks[i];
        if (p !== null && p <= k) found += 1;
      }
    }
    out[`recallAt${k}`] = safeDiv(found, total);
  }
  out.mrrAt10 = mean(matched.map((r) => (r.firstGoldRank !== Infinity && r.firstGoldRank <= 10 ? 1 / r.firstGoldRank : 0)));
  out.ndcgAt10 = mean(matched.map((r) => {
    const golds = r.expectedAll?.length > 1 ? r.expectedAll : [r.expected];
    const dcg = golds
      .map((_, i) => r.goldRanks[i])
      .filter((p) => p !== null && p <= 10)
      .reduce((s, p) => s + 1 / Math.log2(p + 1), 0);
    const ideal = Math.min(golds.length, 10);
    const idcg = Array.from({ length: ideal }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
    return idcg > 0 ? dcg / idcg : 1;
  }));
  if (multi.length > 0) {
    out.completenessAt10 = mean(multi.map((r) =>
      safeDiv(r.expectedAll.filter((g, i) => r.goldRanks[i] !== null && r.goldRanks[i] <= 10).length, r.expectedAll.length)));
    out.sufficiencyAt10 = mean(multi.map((r) => (r.expectedAll.every((g, i) => r.goldRanks[i] !== null && r.goldRanks[i] <= 10) ? 1 : 0)));
  }
  return out;
}

function mapValues(obj, fn) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v)]));
}
function groupBy(rows, keyFn) {
  const groups = {};
  for (const row of rows) {
    const k = keyFn(row);
    (groups[k] ??= []).push(row);
  }
  return groups;
}

// ---- main ----------------------------------------------------------------------
const SEARCH_TOOL_DEF = "search(query, limit, serverId): Search the indexed catalog of tools and skills. Returns the top matches with id, name, and summary. Load an action by id to get its full input schema.";

function goldsOf(q) {
  if (Array.isArray(q.expectedAll) && q.expectedAll.length > 0) return q.expectedAll;
  return q.expected == null ? [] : [q.expected];
}

/**
 * Fail-closed corpus validation (reviewer-2 blocker 5): a partial or
 * malformed fixture set must never silently pass as "full-generated".
 */
function validateGeneratedCorpus({ manifests, skills, queries, idMismatches }) {
  const errors = [];
  const toolCount = manifests.reduce((s, m) => s + m.tools.length, 0);
  if (manifests.length !== 44) errors.push(`expected 44 server manifests, got ${manifests.length}`);
  if (toolCount !== 10000) errors.push(`expected 10,000 tools, got ${toolCount}`);
  if (skills.length !== 5000) errors.push(`expected 5,000 skills, got ${skills.length}`);
  if (queries.length !== 1500) errors.push(`expected 1,500 queries, got ${queries.length}`);
  if ((idMismatches ?? 0) !== 0) errors.push(`${idMismatches} skill id mismatches vs parseSkillContent`);
  for (const q of queries) {
    if (typeof q.query !== "string" || q.query.trim() === "") { errors.push(`invalid query text: ${JSON.stringify(q).slice(0, 80)}`); break; }
    const hasExpected = typeof q.expected === "string" || q.expected === null;
    const hasExpectedAll = Array.isArray(q.expectedAll);
    if (!hasExpected && !hasExpectedAll) { errors.push(`query without expected/expectedAll: ${String(q.query).slice(0, 60)}`); break; }
    if (hasExpectedAll && (q.expectedAll.length < 2 || q.expectedAll.length > 4 || q.expectedAll.some((g) => typeof g !== "string"))) {
      errors.push(`invalid expectedAll on: ${String(q.query).slice(0, 60)}`); break;
    }
  }
  const uniqueQueries = new Set(queries.map((q) => q.query));
  if (uniqueQueries.size !== queries.length) errors.push(`duplicate query strings: ${queries.length - uniqueQueries.size}`);
  if (errors.length > 0) throw new Error(`generated corpus failed fail-closed validation:\n- ${errors.join("\n- ")}`);
}

async function runEval() {

  // --- corpus ------------------------------------------------------------------
  let manifests, skills, queries, mode = "self-fixtures";
  const generated = loadGenerated();
  const idMismatches = generated?.idMismatches ?? 0;
  if (generated) {
    manifests = generated.manifests;
    skills = generated.skills;
    queries = generated.queries;
    mode = "full-generated";
    // Fail closed on malformed/partial full fixtures (reviewer-2 blocker 5).
    validateGeneratedCorpus({ manifests, skills, queries, idMismatches: generated.idMismatches ?? 0 });
    console.error(`[eval-retrieval] using generated corpus: ${manifests.length} servers, ${skills.length} skills, ${queries.length} queries`);
  } else {
    ({ tools } = syntheticCatalog(QUICK ? 2 : DOMAINS.length));
    manifests = groupTools(tools);
    skills = QUICK ? syntheticSkillPool(30) : syntheticSkillPool(1500);
    queries = selfQueries();
    console.error(`[eval-retrieval] no generated corpus found; using self-fixtures (${tools.length} tools, ${skills.length} skills, ${queries.length} queries)`);
  }
  // --quick: smoke run, subsample queries deterministically (noted in output)
  if (QUICK && queries.length > 150) {
    const r = mulberry32(SEED ^ 0x4b1d);
    queries = sampleN(queries, 150, r);
  }

  const catalogIds = new Set([
    ...manifests.flatMap((m) => m.tools.map((t) => `${m.serverId}:${t.name}`)),
    ...skills.map((s) => s.id),
  ]);
  const totalQueries = queries.length;
  queries = queries.filter((q) => goldsOf(q).every((g) => catalogIds.has(g)));
  const excluded = totalQueries - queries.length;
  if (excluded > 0) {
    // Fail closed: a full corpus with missing gold ids is malformed, not
    // merely smaller (reviewer-2 blocker 5).
    if (mode === "full-generated") {
      throw new Error(`fail-closed: ${excluded}/${totalQueries} queries reference gold ids absent from the corpus`);
    }
    console.error(`[eval-retrieval] excluded ${excluded} queries whose gold ids are not in the catalog`);
  }

  // Realistic headline set (intake FX13-R2, builder-1 PR 72): 120
  // hand-written v2 rows. When present it is reported as the HEADLINE product
  // numbers; the generated corpus becomes the regression table. Contract
  // gates stay on the generated corpus (binding until the contract changes).
  const REALISTIC_PATH = join(STRESS_DIR, "fixtures", "realistic-queries.json");
  let realistic = null;
  if (existsSync(REALISTIC_PATH)) {
    const raw = JSON.parse(readFileSync(REALISTIC_PATH, "utf8"));
    const list = Array.isArray(raw) ? raw : raw.queries;
    // Fail closed on a malformed realistic fixture as well.
    const rErrors = [];
    if (list.length !== 120) rErrors.push(`expected 120 realistic rows, got ${list.length}`);
    for (const q of list) {
      if (typeof q.query !== "string" || q.query.trim() === "" || !("expected" in q)) { rErrors.push(`invalid realistic row: ${JSON.stringify(q).slice(0, 80)}`); break; }
    }
    if (rErrors.length > 0) throw new Error(`realistic fixture failed validation:\n- ${rErrors.join("\n- ")}`);
    realistic = list;
    console.error(`[eval-retrieval] realistic fixture loaded: ${list.length} rows`);
  } else {
    console.error(`[eval-retrieval] realistic fixture not present (${REALISTIC_PATH}); realistic headline section omitted`);
  }

  // Engine comparison runs ALL THREE engines on ONE fixed, identical query
  // sample (reviewer-2 blocker: no side-by-side recall on different samples).
  // Gates are then computed from keyword+blend on the FULL query set.
  const fixedEvalSample = (() => { const r = mulberry32(SEED ^ 0xe11a); return sampleN(queries, Math.min(300, queries.length), r); })();
  const results = {};
  for (const name of ENGINE_NAMES) {
    const t0 = performance.now();
    const { hub, buildMs } = await buildEngine(name, manifests, skills);
    const engineBuildMs = Number((performance.now() - t0).toFixed(0));
    const { rows, latencies } = await warmAndTime(hub, fixedEvalSample);
    const scored = scoreEngine(rows, latencies);
    results[name] = {
      description: ENGINE_DESC[name], buildMs, engineBuildMs, ...scored,
      querySample: { size: fixedEvalSample.length, note: "identical fixed sample for all engines" },
    };
    console.error(`[eval-retrieval] ${name} (n=${fixedEvalSample.length}): recall@5=${scored.recallAt5?.toFixed?.(3)} mrr@10=${scored.mrrAt10?.toFixed?.(3)} p95=${scored.latency.warmP95Ms}ms`);
    await hub.close?.();
  }

  // Full-query-set runs for the GATE numbers (keyword + blend only; the
  // scorer engine is not needed at full scale and is excluded from gates).
  const gateRows = {};
  for (const name of SWEEP_ENGINES) {
    const { hub, buildMs } = await buildEngine(name, manifests, skills);
    const { rows, latencies } = await warmAndTime(hub, queries);
    gateRows[name] = { scored: scoreEngine(rows, latencies), rows, buildMs };
    console.error(`[eval-retrieval] gates ${name} (n=${queries.length}): recall@5=${gateRows[name].scored.recallAt5?.toFixed?.(3)} p95=${gateRows[name].scored.latency.warmP95Ms}ms`);
    await hub.close?.();
  }

  // --- realistic headline runs (keyword + blend) -----------------------------------
  let realisticReport = null;
  if (realistic) {
    const realisticIds = new Set([
      ...manifests.flatMap((m) => m.tools.map((t) => `${m.serverId}:${t.name}`)),
      ...skills.map((s) => s.id),
    ]);
    const rMissing = realistic.filter((q) => goldsOf(q).some((g) => !realisticIds.has(g))).length;
    if (rMissing > 0) throw new Error(`fail-closed: ${rMissing} realistic rows reference gold ids absent from the corpus`);
    realisticReport = { count: realistic.length, mix: countBy(realistic, (q) => q.subtype), engines: {}, gates: {} };
    for (const name of SWEEP_ENGINES) {
      const { hub } = await buildEngine(name, manifests, skills);
      const { rows, latencies } = await warmAndTime(hub, realistic);
      const all = scoreEngine(rows, latencies);
      const bySubtype = {};
      for (const st of Object.keys(realisticReport.mix)) {
        const sub = rows.filter((r) => r.subtype === st);
        if (sub.length > 0) {
          const scored = scoreEngine(sub, latencies.filter((_, i) => rows[i].subtype === st));
          bySubtype[st] = { n: sub.length, recallAt5: scored.recallAt5, recallAt10: scored.recallAt10, mrrAt10: scored.mrrAt10 };
        }
      }
      realisticReport.engines[name] = { recallAt5: all.recallAt5, recallAt10: all.recallAt10, mrrAt10: all.mrrAt10, noMatch: all.noMatch, latency: all.latency, bySubtype };
      await hub.close?.();
    }
    console.error(`[eval-retrieval] realistic: blend r@5=${realisticReport.engines.blend.recallAt5?.toFixed(3)} mrr@10=${realisticReport.engines.blend.mrrAt10?.toFixed(3)}`);
  }

  // --- prefix sweep ---------------------------------------------------------------
  const sweep = [];
  // ONE fixed latency sample for every prefix (reviewer-2 blocker 3). Recall
  // uses only the golds-present subset of this same fixed sample; both counts
  // are reported per row.
  const fixedLatencySample = (() => { const r = mulberry32(SEED ^ 0x7a7); return sampleN(queries, Math.min(100, queries.length), r); })();
  for (const size of PREFIXES) {
    const totalTools = manifests.reduce((s, m) => s + m.tools.length, 0);
    const toolTake = Math.min(totalTools, size);
    const skillTake = Math.max(0, Math.min(skills.length, size - toolTake));
    // Preserve serverId when flattening (blocker 3): bare manifest tools do
    // not carry it, which previously collapsed every prefix under "undefined".
    const prefixTools = manifests
      .flatMap((m) => m.tools.map((t) => ({ ...t, serverId: m.serverId })))
      .slice(0, toolTake);
    const prefixManifests = groupTools(prefixTools);
    const prefixSkills = skills.slice(0, skillTake);
    const ids = new Set([
      ...prefixManifests.flatMap((m) => m.tools.map((t) => `${m.serverId}:${t.name}`)),
      ...prefixSkills.map((s) => s.id),
    ]);
    const usable = fixedLatencySample.filter((q) => goldsOf(q).every((g) => ids.has(g)));
    const actualSize = toolTake + skillTake;
    const row = { requestedSize: size, prefixSize: actualSize, toolCount: prefixManifests.reduce((s, m) => s + m.tools.length, 0), skillCount: prefixSkills.length, queriesUsed: usable.length, queriesExcluded: fixedLatencySample.length - usable.length, engines: {} };
    for (const name of SWEEP_ENGINES) {
      const { hub, buildMs } = await buildEngine(name, prefixManifests, prefixSkills);
      const { rows, latencies } = await warmAndTime(hub, usable);
      const scored = scoreEngine(rows, latencies);
      row.engines[name] = {
        indexBuildMs: Number(buildMs.toFixed(0)),
        matchedCount: scored.matchedCount,
        warmP50Ms: scored.latency.warmP50Ms,
        warmP95Ms: scored.latency.warmP95Ms,
        recallAt1: scored.recallAt1, recallAt3: scored.recallAt3, recallAt5: scored.recallAt5,
        recallAt10: scored.recallAt10, recallAt20: scored.recallAt20,
        mrrAt10: scored.mrrAt10, ndcgAt10: scored.ndcgAt10,
      };
      await hub.close?.();
    }
    sweep.push(row);
    console.error(`[eval-retrieval] sweep ${row.prefixSize}: ` + SWEEP_ENGINES.map((n) => `${n} r@5=${row.engines[n].recallAt5.toFixed(3)} p95=${row.engines[n].warmP95Ms.toFixed(0)}ms build=${row.engines[n].indexBuildMs}ms`).join(" | "));
  }

  // --- gates (evaluated on the full-corpus blend + keyword engines) ---------------
  const gateChecks = {};
  for (const difficulty of ["exact", "paraphrase", "hard"]) {
    const d = gateRows.blend?.scored.byDifficulty[difficulty];
    gateChecks[`recallAt5_${difficulty}`] = { target: GATES.recallAt5[difficulty], actual: d?.recallAt5 ?? null, pass: (d?.recallAt5 ?? 0) >= GATES.recallAt5[difficulty] };
    gateChecks[`recallAt10_${difficulty}`] = { target: GATES.recallAt10[difficulty], actual: d?.recallAt10 ?? null, pass: (d?.recallAt10 ?? 0) >= GATES.recallAt10[difficulty] };
    gateChecks[`mrrAt10_${difficulty}`] = { target: GATES.mrrAt10[difficulty], actual: d?.mrrAt10 ?? null, pass: (d?.mrrAt10 ?? 0) >= GATES.mrrAt10[difficulty] };
  }
  // Gate numbers come from the full-query-set gate runs, not the engine
  // comparison sample (reviewer-2 blockers 3+5): warmP95 uses the TRUE
  // full-corpus blend run on all 1,500 queries at the full 15K corpus.
  const blend = gateRows.blend?.scored ?? results.blend;
  gateChecks.sufficiencyAt10 = { target: GATES.sufficiencyAt10, actual: blend.sufficiencyAt10, pass: (blend.sufficiencyAt10 ?? 0) >= GATES.sufficiencyAt10 };
  gateChecks.noMatchFpRate = { target: GATES.noMatchFpRate, actual: blend.noMatch.fpRate, pass: blend.noMatch.fpRate !== null && blend.noMatch.fpRate <= GATES.noMatchFpRate };
  const fullBlendP95 = gateRows.blend?.scored.latency.warmP95Ms ?? null;
  gateChecks.warmP95MsAt15K = { target: GATES.warmP95MsAt15K, actual: fullBlendP95, pass: (fullBlendP95 ?? Infinity) <= GATES.warmP95MsAt15K };

  // --- definition-token savings -----------------------------------------------------
  const allDefTokens =
    manifests.reduce((s, m) => s + m.tools.reduce((acc, t) => acc + tokens(`${t.name} ${t.description} ${JSON.stringify(t.inputSchema ?? {})}`), 0), 0) +
    skills.reduce((acc, s) => acc + tokens(`${s.name} ${s.summary ?? s.description ?? ""}`), 0);
  // Per-response context cost (reviewer-2 blocker 4): one search response
  // (search-tool definition + mean returned definitions) against ONE eager
  // definition payload of the whole catalog. Load cost (the follow-up
  // load() call that returns a full input schema) is NOT included in the
  // numerator; responseTokens cover name/id/summary/score per hit only.
  const meanResponseTokens = gateRows.blend?.rows.length
    ? mean(gateRows.blend.rows.map((r) => r.responseTokens))
    : (results.blend?.responseTokensMean ?? 0);
  const hubPerResponseTokens = tokens(SEARCH_TOOL_DEF) + meanResponseTokens;
  const savings = safeDiv(allDefTokens - hubPerResponseTokens, allDefTokens);
  gateChecks.tokenSavings = { target: GATES.tokenSavings, actual: Number(savings.toFixed(4)), pass: savings >= GATES.tokenSavings };

  // worst 20 failures from the full-set blend engine rows
  const blendRows = gateRows.blend?.rows ?? [];
  const worst = blendRows
    .filter((r) => r.expected !== null || (r.expectedAll?.length ?? 0) > 0)
    .sort((a, b) => (b.firstGoldRank === Infinity ? 1 : 0) - (a.firstGoldRank === Infinity ? 1 : 0) || (b.firstGoldRank === a.firstGoldRank ? 0 : (a.firstGoldRank === Infinity ? -1 : b.firstGoldRank - a.firstGoldRank)))
    .slice(0, 20)
    .map((r) => ({ query: r.query, expected: r.expectedAll ?? r.expected, difficulty: r.difficulty, subtype: r.subtype, kind: r.kind, top3: r.top3 }));

  const summary = {
    script: "eval-retrieval",
    mode,
    corpus: {
      servers: manifests.length,
      tools: manifests.reduce((s, m) => s + m.tools.length, 0),
      skills: skills.length,
      totalEntries: manifests.reduce((s, m) => s + m.tools.length, 0) + skills.length,
      queries: queries.length,
      queriesExcludedForMissingGolds: excluded,
      queryMix: countBy(queries, (q) => q.subtype),
      skillIdMismatches: idMismatches,
    },
    engines: results,
    sweep,
    gates: { definitions: GATES, checks: gateChecks, tokenSavings: { allDefinitionTokens: allDefTokens, meanReturnedDefinitionsTokens: Math.round(meanResponseTokens), searchToolDefTokens: tokens(SEARCH_TOOL_DEF), savings: Number(savings.toFixed(4)), formula: "1 - (search tool def + mean returned definitions per response) / (one eager definition payload of the full catalog); load() schema cost excluded" } },
    worstFailures: { engine: "blend", querySet: "full", items: worst },
    realistic: realisticReport
      ? {
          note: "HEADLINE product numbers (hand-written realistic fixture, intake FX13-R2); contract gates below remain on the generated corpus",
          count: realisticReport.count, mix: realisticReport.mix, engines: realisticReport.engines,
          gates: {
            recallAt5: { target: GATES.recallAt5.paraphrase, actual: realisticReport.engines.blend.recallAt5, pass: realisticReport.engines.blend.recallAt5 >= GATES.recallAt5.paraphrase },
            recallAt10: { target: GATES.recallAt10.paraphrase, actual: realisticReport.engines.blend.recallAt10, pass: realisticReport.engines.blend.recallAt10 >= GATES.recallAt10.paraphrase },
            mrrAt10: { target: GATES.mrrAt10.paraphrase, actual: realisticReport.engines.blend.mrrAt10, pass: realisticReport.engines.blend.mrrAt10 >= GATES.mrrAt10.paraphrase },
            noMatchFpRate: { target: GATES.noMatchFpRate, actual: realisticReport.engines.blend.noMatch.fpRate, pass: realisticReport.engines.blend.noMatch.fpRate !== null && realisticReport.engines.blend.noMatch.fpRate <= GATES.noMatchFpRate },
            informational: true,
          },
        }
      : null,
  };

  // summary.ok reflects EVERY required gate (reviewer-2 blocker 2); the
  // harness contract turns it into the exit code and the last stdout line.
  summary.ok = Object.values(gateChecks).every((c) => c.pass);
  return summary;
  // Human-readable tail (stdout), then the machine-readable JSON as the LAST line.
  console.log(`# mode=${mode} tools=${summary.corpus.tools} skills=${summary.corpus.skills} queries=${queries.length} (${excluded} excluded)`);
  for (const [name, r] of Object.entries(results)) {
    console.log(`# ${name}: r@1=${fmt(r.recallAt1)} r@5=${fmt(r.recallAt5)} r@10=${fmt(r.recallAt10)} r@20=${fmt(r.recallAt20)} mrr@10=${fmt(r.mrrAt10)} ndcg@10=${fmt(r.ndcgAt10)} p95=${r.latency.warmP95Ms}ms`);
  }
  for (const row of sweep) {
    console.log(`# prefix ${row.prefixSize}: ` + SWEEP_ENGINES.map((n) => `${n} r@5=${fmt(row.engines[n].recallAt5)} p95=${row.engines[n].warmP95Ms.toFixed(0)}ms build=${row.engines[n].indexBuildMs}ms`).join(" | "));
  }
  for (const [check, res] of Object.entries(gateChecks)) {
    console.log(`# gate ${check}: ${res.pass ? "PASS" : "FAIL"} (actual=${fmt(res.actual)} target=${res.target})`);
  }
  console.log(`# token savings: ${(savings * 100).toFixed(1)}% (all-def=${allDefTokens} per-response=${hubPerResponseTokens})`);
  console.log(JSON.stringify(summary));
}

function fmt(v) {
  return typeof v === "number" ? v.toFixed(3) : String(v);
}
function countBy(arr, keyFn) {
  const counts = {};
  for (const item of arr) {
    const k = keyFn(item);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

// Shared-harness failure envelope (PR 64): isolation, summary contract and
// exit code all come from stress/lib/harness.mjs. setupIsolation, the local
// withTimeout-guarded runner and the local write/exit logic are gone.
harnessMain(async () => {
  // Isolate THIS process first: every checklist env var is replaced under one
  // fresh run root before any hub construction.
  const sandbox = createSandbox({ prefix: "action-hub-eval-" });
  Object.assign(process.env, sandbox.env);
  assertIsolated(process.env, sandbox.root);
  return runEval();
}, { resultsPath: join(RESULTS_DIR, "eval-retrieval.json") });
