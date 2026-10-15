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
 * warm p50/p95 after an excluded
 * warmup pass, context token cost per response, definition-token savings.
 * Reported by difficulty (exact|paraphrase|hard), subtype, and kind.
 *
 * Three distinct outcome metrics (r/mcp follow-up, item 1): every engine run
 * reports RETRIEVAL RANK (the recall/MRR family above), ABSTENTION (the
 * server's documented no-confident-match rule, docs/harness-guides.md,
 * replayed on the raw per-query confidence at the documented default
 * threshold 0.8, overridable with --abstention-threshold=<0..1>) and
 * SUCCESSFUL EXECUTION (the top-1 pick is executed through the REAL
 * ActionHub.execute path, policy + argument validation + dispatch, with the
 * arguments the gold tool's schema calls for; success means the GOLD ran and
 * returned ok). They are scored independently and never folded into one
 * number: the execution probe runs unconditionally (it does not consult the
 * abstention rule), so a query can rank its gold first and still fail
 * execution, or abstain correctly without ranking anything. The derived
 * `gatedByAbstention` view shows what an agent honoring the rule would get.
 * Headline block: `threeMetrics`.
 *
 * Execution is side-effect free by construction: every server in the eval is
 * an in-process fake whose callTool returns a canned acknowledgement. No
 * external MCP server, process, or destructive tool is ever invoked.
 *
 * Incompatible-argument near-duplicates (r/mcp follow-up, item 3): the
 * synthetic catalog carries, next to each archive_X / delete_X / export_X,
 * a same-server twin (archive_X_by_id, delete_X_by_id, export_X_report)
 * whose name and description are confusable but whose argument shape is
 * incompatible both ways (required keys the other lacks, and
 * additionalProperties:false on every schema). A wrong pick between twins
 * therefore surfaces as a LOUD execution failure (hub-side
 * validation_failed), while a wrong pick between same-shape rivals
 * (archive_X vs delete_X) surfaces as a SILENT wrong-tool execution. The
 * execution block reports the two classes separately.
 *
 * Self-fixture population note: the twins add twin-gold near-duplicate rows
 * next to the pre-existing base-gold rows (same contract subtype, same
 * "hard" difficulty), so self-fixtures-mode hard-difficulty gate numbers are
 * NOT comparable with runs from before the twins landed. The headline
 * nearDuplicate block reports the two gold directions separately. The
 * generated corpus (full-generated mode) is unaffected.
 *
 * Gates (reported honestly): recall@5 .90/.80/.65, recall@10 .95/.90/.80,
 * MRR@10 .80/.65/.45 (exact/paraphrase/hard); Sufficiency@10 >= .75;
 * no-match FP <= 5%; warm p95 <= 100 ms at 15K; token savings >= 95%.
 * Abstention and execution are reported, not gated (no contract target yet).
 *
 * Data: stress/.generated manifests + query files when the generators have
 * landed; otherwise deterministic self-fixtures in contract format.
 *
 * Output: JSON summary as the LAST stdout line, also written to
 * stress/.generated/results/eval-retrieval.json.
 *
 * Unit tests: stress/eval-retrieval.test.mjs imports this module (nothing
 * runs at import time; the harness runner is guarded by the argv[1] check).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ActionHub, createLocalSemanticScorer, parseSkillContent, validateArguments } from "../packages/core/dist/index.js";
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
// Await the embedding rebuild before scoring the engine-comparison and gate
// runs (the runs that carry abstention + execution). Off by default: warming
// costs roughly 35 ms per catalog entry on a CPU host. The sweep, skills
// and realistic sections keep the historical cold-build behaviour either way.
const WARM = ARGV.has("--warm-embeddings");
const SEED = 0x5eed;
// Abstention replay threshold: mirrors DEFAULT_ABSTENTION_THRESHOLD in
// packages/plugin/server/src/config.ts (the shipped code default; the docs
// discuss its calibration separately and may recommend a different value for
// the embedding channel). At 0.8 the warm blend engine abstains on most
// matched rows (top-1 cosines mostly sit well below 0.8), so the
// gatedByAbstention view reports near-total abstention unless the flag is
// lowered. Parsed inside runEval so a malformed flag fails closed through
// the harness.
const ABSTENTION_THRESHOLD_DEFAULT = 0.8;
const ABSTENTION_FLAG = "--abstention-threshold";
function parseAbstentionThreshold(argv) {
  const raw = [...argv].find((a) => a === ABSTENTION_FLAG || a.startsWith(`${ABSTENTION_FLAG}=`));
  if (raw === undefined) return ABSTENTION_THRESHOLD_DEFAULT;
  const value = raw.includes("=") ? raw.slice(raw.indexOf("=") + 1) : "";
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`${ABSTENTION_FLAG} requires a number in [0, 1] (got ${JSON.stringify(value)})`);
  }
  return n;
}
// Opt-in goal-query rewrite (SearchOptions.queryRewrite, experimental): every
// hub.search in the eval carries the mode, so the gates and the abstention
// replay are measured with the rewrite on. Absent means production default.
const QUERY_REWRITE_FLAG = "--query-rewrite";
const QUERY_REWRITE_MODES = ["append", "fuse"];
function parseQueryRewrite(argv) {
  const raw = [...argv].find((a) => a === QUERY_REWRITE_FLAG || a.startsWith(`${QUERY_REWRITE_FLAG}=`));
  if (raw === undefined) return undefined;
  const value = raw.includes("=") ? raw.slice(raw.indexOf("=") + 1) : "";
  if (!QUERY_REWRITE_MODES.includes(value)) {
    throw new Error(`${QUERY_REWRITE_FLAG} requires one of ${QUERY_REWRITE_MODES.join(", ")} (got ${JSON.stringify(value)})`);
  }
  return value;
}
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

/**
 * Incompatible-argument twin families (r/mcp follow-up, item 3). Each base
 * verb gets a same-server twin whose name and description are confusable
 * with the base tool but whose argument shape is incompatible BOTH ways:
 * the twin requires keys the base schema rejects (additionalProperties is
 * false everywhere) and rejects the base's filter/limit keys. A wrong pick
 * inside a twin pair cannot execute silently; it fails hub-side validation.
 */
const TWIN_FAMILIES = [
  {
    baseVerb: "archive",
    suffix: "_by_id",
    describe: (object, domain) => `Archive specific ${object} by id in the ${domain} workspace. Takes an explicit id list and an optional reason; no filters or pagination.`,
    schema: () => ({
      type: "object",
      required: ["ids"],
      properties: {
        ids: { type: "array", description: "Ids of the records to archive", items: { type: "string" }, minItems: 1 },
        reason: { type: "string", description: "Why these records are archived" },
      },
      additionalProperties: false,
    }),
  },
  {
    baseVerb: "delete",
    suffix: "_by_id",
    describe: (object, domain) => `Delete specific ${object} by id in the ${domain} workspace. Takes an explicit id list and an optional reason; no filters or pagination.`,
    schema: () => ({
      type: "object",
      required: ["ids"],
      properties: {
        ids: { type: "array", description: "Ids of the records to delete", items: { type: "string" }, minItems: 1 },
        reason: { type: "string", description: "Why these records are deleted" },
      },
      additionalProperties: false,
    }),
  },
  {
    baseVerb: "export",
    suffix: "_report",
    describe: (object, domain) => `Export a formatted ${object} report in the ${domain} workspace. Requires an output format and a date range; no filters or pagination.`,
    schema: () => ({
      type: "object",
      required: ["format", "range"],
      properties: {
        format: { type: "string", description: "Output format", enum: ["csv", "pdf"] },
        range: {
          type: "object",
          description: "Reporting period",
          required: ["from", "to"],
          properties: {
            from: { type: "string", description: "Start date (YYYY-MM-DD)" },
            to: { type: "string", description: "End date (YYYY-MM-DD)" },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    }),
  },
];
const twinNameFor = (family, object) => `${family.baseVerb}_${object}${family.suffix}`;
const isTwinName = (name) => TWIN_FAMILIES.some((f) => name.startsWith(`${f.baseVerb}_`) && name.endsWith(f.suffix));

/**
 * 15 domains x 61 objects x (15 verbs + 3 twins) = 16,470 tools on 30
 * servers. Every schema pins additionalProperties:false, matching the
 * generated corpus, so a wrong pick is only silent when the shapes agree.
 */
function syntheticCatalog(domainCount = DOMAINS.length) {
  const servers = [];
  for (const domain of DOMAINS.slice(0, domainCount)) servers.push(`${domain}-main`, `${domain}-mirror`);
  const tools = [];
  const schemaFor = (verb) => ({
    type: "object",
    properties: {
      filter: { type: "string", description: "Filter text" },
      limit: { type: "integer", description: "Max rows to return", minimum: 1, maximum: 500 },
      ...(verb === "create" || verb === "update" || verb === "merge"
        ? { payload: { type: "object", description: "Fields to write" } }
        : {}),
    },
    additionalProperties: false,
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
        const family = TWIN_FAMILIES.find((f) => f.baseVerb === verb);
        if (family) {
          tools.push({
            serverId,
            name: twinNameFor(family, object),
            description: family.describe(object.replace(/_/g, " "), domain),
            inputSchema: family.schema(),
            annotations: DESTRUCTIVE.has(verb) ? { destructiveHint: true } : { readOnlyHint: true },
          });
        }
      }
    }
  }
  return { servers, tools };
}

/**
 * Fail-closed fixture check: for every twin pair, the gold-shaped arguments
 * of one side must be REJECTED by the other side's schema. Run on the
 * synthetic catalog before any engine is built; a twin that accepts its
 * base's arguments would turn a loud failure back into a silent one.
 */
function assertTwinsIncompatible(catalogTools) {
  const byKey = new Map(catalogTools.map((t) => [`${t.serverId}:${t.name}`, t]));
  let pairs = 0;
  const problems = [];
  for (const t of catalogTools) {
    const family = TWIN_FAMILIES.find((f) => t.name.startsWith(`${f.baseVerb}_`) && t.name.endsWith(f.suffix));
    if (!family) continue;
    const baseName = t.name.slice(0, -family.suffix.length);
    const base = byKey.get(`${t.serverId}:${baseName}`);
    if (!base) { problems.push(`twin ${t.serverId}:${t.name} has no base tool`); continue; }
    pairs += 1;
    const baseArgs = intendedArgs(base.inputSchema);
    const twinArgs = intendedArgs(t.inputSchema);
    if (!validateArguments(base.inputSchema, baseArgs).valid) problems.push(`base ${base.name} rejects its own intended args`);
    if (!validateArguments(t.inputSchema, twinArgs).valid) problems.push(`twin ${t.name} rejects its own intended args`);
    if (validateArguments(t.inputSchema, baseArgs).valid) problems.push(`twin ${t.name} ACCEPTS base-shaped args (not incompatible)`);
    if (validateArguments(base.inputSchema, twinArgs).valid) problems.push(`base ${base.name} ACCEPTS twin-shaped args (not incompatible)`);
    if (problems.length > 20) break;
  }
  if (problems.length > 0) throw new Error(`twin fixture check failed:\n- ${problems.join("\n- ")}`);
  return pairs;
}

// ---- intended arguments (deterministic, schema-faithful) ----------------------
/**
 * The arguments an agent acting on the GOLD tool would send: every declared
 * property filled with a schema-valid value (enum member, bounded number,
 * non-empty array, nested object with its required keys). Deterministic by
 * construction (no RNG); the same schema always yields the same arguments.
 * A property whose constraints cannot be satisfied is omitted unless it is
 * required, in which case the control execution reports it (controlFailed).
 */
const PROBE_MAX_PROPERTIES = 8;
function intendedArgs(schema, depth = 0) {
  const out = {};
  if (!schema || typeof schema !== "object") return out;
  const props = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const keys = [...new Set([...required, ...Object.keys(props)])].slice(0, Math.max(PROBE_MAX_PROPERTIES, required.length));
  for (const key of keys) {
    const value = probeValue(props[key], key, depth);
    if (value !== undefined) out[key] = value;
  }
  return out;
}
function probeValue(prop, key, depth) {
  if (!prop || typeof prop !== "object") return `probe-${key}`;
  if (Array.isArray(prop.enum) && prop.enum.length > 0) return prop.enum[0];
  if (prop.const !== undefined) return prop.const;
  const type = Array.isArray(prop.type) ? prop.type[0] : prop.type;
  switch (type) {
    case "string": {
      if (typeof prop.pattern === "string") {
        // A handful of canned candidates; the first that matches wins.
        let re = null;
        try { re = new RegExp(prop.pattern); } catch { re = null; }
        if (re) {
          for (const c of ["2026-01-01", "probe", "probe-1", "a", "1", "probe@example.com", "https://example.com"]) {
            if (re.test(c)) return c;
          }
          return undefined;
        }
      }
      const min = typeof prop.minLength === "number" ? prop.minLength : 0;
      const max = typeof prop.maxLength === "number" ? prop.maxLength : Infinity;
      let s = `probe-${key}`;
      if (s.length < min) s = s.padEnd(min, "x");
      if (s.length > max) s = s.slice(0, max);
      return s.length >= min ? s : undefined;
    }
    case "integer":
    case "number": {
      const min = typeof prop.minimum === "number" ? prop.minimum : null;
      const max = typeof prop.maximum === "number" ? prop.maximum : null;
      let n = 1;
      if (min !== null && n < min) n = min;
      if (max !== null && n > max) n = max;
      if (type === "integer") n = Math.ceil(n);
      if ((min !== null && n < min) || (max !== null && n > max)) return undefined;
      return n;
    }
    case "boolean": return true;
    case "array": {
      const minItems = typeof prop.minItems === "number" ? prop.minItems : 0;
      const count = Math.max(1, minItems);
      const item = probeValue(prop.items, key, depth + 1);
      return Array.from({ length: count }, (_, i) => (typeof item === "string" ? `${item}-${i + 1}` : item));
    }
    case "object": return depth < 4 ? intendedArgs(prop, depth + 1) : {};
    case "null": return null;
    default:
      return prop.properties ? (depth < 4 ? intendedArgs(prop, depth + 1) : {}) : `probe-${key}`;
  }
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


function selfQueries(catalogTools = tools, quick = QUICK) {
  const domains = quick ? DOMAINS.slice(0, 2) : DOMAINS;
  const objects = quick ? OBJECTS.slice(0, 30) : OBJECTS;
  const queries = [];
  const push = (q) => queries.push(q);
  const findTool = (domain, verb, object) =>
    catalogTools.find((t) => t.serverId === `${domain}-main` && t.name === `${verb}_${object}`) ??
    catalogTools.find((t) => t.serverId === `${domain}-mirror` && t.name === `${verb}_${object}`);
  const findTwin = (domain, family, object) =>
    catalogTools.find((t) => t.serverId === `${domain}-main` && t.name === twinNameFor(family, object));
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

  // near-duplicate, incompatible-argument twins (item 3): the gold is the
  // TWIN (archive_X_by_id / delete_X_by_id / export_X_report) and the row
  // carries the intended arguments explicitly, in the twin's shape. If the
  // engine picks the same-shape base tool instead, hub-side validation
  // rejects those arguments: the wrong pick is a loud execution failure, not
  // only a rank loss. The base-gold rows above exercise the mirror case (a
  // twin pick with base-shaped filter/limit arguments).
  for (let i = 0; i < ndCount; i++) {
    // Stride 7 keeps the (object, family) pairs distinct for both the quick
    // (30 objects, 8 rows) and the full (61 objects, 15 rows) object sets.
    const object = pick(i * 7 + 4, objects);
    const domain = pick(i + 1, domains);
    const obj = object.replace(/_/g, " ");
    const family = TWIN_FAMILIES[i % TWIN_FAMILIES.length];
    const twin = findTwin(domain, family, object);
    if (!twin) continue;
    const row = { expected: `${twin.serverId}:${twin.name}`, difficulty: "hard", subtype: "near-duplicate" };
    if (family.baseVerb === "archive") {
      push({ ...row, query: `archive these specific ${obj} by id in ${domain}`, args: { ids: [`${object}-1041`, `${object}-1042`], reason: "stale" } });
    } else if (family.baseVerb === "delete") {
      push({ ...row, query: `delete the ${domain} ${obj} with these ids`, args: { ids: [`${object}-2201`], reason: "duplicate" } });
    } else {
      push({ ...row, query: `export a csv report of ${obj} for ${domain} last quarter`, args: { format: "csv", range: { from: "2026-07-01", to: "2026-09-30" } } });
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
  // Tool queries and skill queries are SEPARATE universes: tools are
  // retrieved against the tool catalog (contract mix + gates), skills against
  // the skill catalog (regression section). Merging them mislabels both.
  return {
    manifests,
    skills,
    toolQueries: loadJson(tq),
    skillQueries: loadJson(sqp),
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
/**
 * Builds one engine. `warm: true` awaits ActionHub.semanticReady() so the
 * blend engine is scored on a WARM embedding index. Default off: the eval
 * historically searched the blend engine while its embedding rebuild was
 * still in flight (embeddedDocs 0, every hit's raw semantic score 0, blend
 * ranking identical to keyword). The returned `embedding` block records
 * which state was measured so no number is reported without its state.
 */
async function buildEngine(name, manifests, skills, { warm = false } = {}) {
  const t0 = performance.now();
  const hub = new ActionHub({
    clientFactory: async (config) => {
      const m = manifests.find((x) => x.serverId === config.id);
      const list = m ? m.tools : [];
      return {
        async listTools() { return list; },
        // Side-effect free in-process fake (execution probe): acknowledges a
        // call to a tool it advertises and refuses anything else. Nothing is
        // read, written, spawned, or sent; destructive annotations are
        // irrelevant here because no real tool is ever reached.
        async callTool(name, args) {
          if (!list.some((t) => t.name === name)) throw new Error(`fake server "${config.id}" has no tool "${name}"`);
          return { content: [{ type: "text", text: `${config.id}:${name} acknowledged ${Object.keys(args ?? {}).length} argument(s)` }] };
        },
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
  const indexMs = performance.now() - t0;
  let warmMs = null;
  if (warm) {
    const w0 = performance.now();
    await hub.semanticReady();
    warmMs = Number((performance.now() - w0).toFixed(0));
  }
  const embeddedDocs = hub.embeddedDocs ?? 0;
  const embedding = {
    // "n/a": the engine has no embedding index (keyword, injected scorer);
    // "warm": vectors present for the catalog; "cold": rebuild still in flight.
    state: name === "blend" ? (embeddedDocs > 0 ? "warm" : "cold") : "n/a",
    embeddedDocs,
    awaited: warm,
    warmMs,
  };
  return { hub, buildMs: indexMs, embedding };
}

const ENGINE_NAMES = ["keyword", "blend", "scorer"];
const SWEEP_ENGINES = ["keyword", "blend"];
const ENGINE_DESC = {
  keyword: "pure BM25 (semanticScorer: null)",
  blend: "built-in local semantic blend (default ActionHub)",
  scorer: "createLocalSemanticScorer injected as the scorer",
};

// ---- abstention replay (server rule, docs/harness-guides.md) ------------------
/**
 * Mirrors the plugin server's no-confident-match gate on the raw hub hits:
 * confidence is the top hit's raw semantic score when the channel is active,
 * else its fused score; abstain when there are no hits or the confidence is
 * below the threshold. The eval has no bundles, so the server's bundle veto
 * never fires here (noted in the report). This is a REPLAY on the core
 * search result, scored whether or not a deployment enables the flag.
 */
function abstentionDecision(hits, threshold) {
  const top = hits[0];
  const basis = top === undefined ? "none" : typeof top.semantic === "number" ? "semantic" : "score";
  const confidence = top === undefined ? 0 : (typeof top.semantic === "number" ? top.semantic : (top.score ?? 0));
  return { abstained: hits.length === 0 || confidence < threshold, confidence, basis };
}
const ABSTENTION_RULE = "abstain when no hits or top-1 confidence (raw semantic score when present, else fused score) < threshold; bundle veto not applicable (eval has no bundles)";

// ---- execution probe -----------------------------------------------------------
// Unconditional outcomes (the probe always executes the top-1 pick, so this
// metric is independent of the abstention rule); the gated view adds
// "abstained" for rows the abstention rule would have stopped.
const EXECUTION_OUTCOMES = ["success", "wrongToolExecuted", "wrongToolRejected", "goldFailed", "noResult", "controlFailed"];
const GATED_EXECUTION_OUTCOMES = [...EXECUTION_OUTCOMES, "abstained"];

function classifyFailure(error) {
  const msg = String(error ?? "");
  if (msg.startsWith("Invalid arguments")) return "validation";
  if (msg.includes("is a skill and must be loaded")) return "skill";
  if (msg.startsWith("Unknown action")) return "unknownAction";
  if (/denied|blocked|disabled/i.test(msg)) return "policy";
  return "downstream";
}

/**
 * Pure classification of one probe (unit-tested): what happened when the
 * top-1 pick was executed with the gold's intended arguments.
 *   success            gold was picked and ran ok (the ONLY success)
 *   wrongToolExecuted  a non-gold pick ran ok: silent misfire (worst case)
 *   wrongToolRejected  a non-gold pick failed loudly (validation, skill,
 *                      policy, or server rejection)
 *   goldFailed         gold picked but execution failed (fixture or hub bug)
 *   noResult           search returned nothing; nothing executed
 *   controlFailed      the gold itself refused its intended args (not scored)
 * The gated view (gateOutcome) adds:
 *   abstained          the abstention rule would have stopped the agent
 *                      before executing; the unconditional outcome is kept
 */
function classifyExecution({ gold, pick, result, control }) {
  if (control && control.ok !== true) {
    return { outcome: "controlFailed", pick: pick ?? null, failureClass: classifyFailure(control.error), error: control.error ?? null };
  }
  if (!pick) return { outcome: "noResult", pick: null };
  if (pick === gold) {
    return result?.ok === true
      ? { outcome: "success", pick }
      : { outcome: "goldFailed", pick, failureClass: classifyFailure(result?.error), error: result?.error ?? null };
  }
  if (result?.approval) return { outcome: "wrongToolRejected", pick, failureClass: "approval", error: result.error ?? "approval required" };
  return result?.ok === true
    ? { outcome: "wrongToolExecuted", pick }
    : { outcome: "wrongToolRejected", pick, failureClass: classifyFailure(result?.error), error: result?.error ?? null };
}

/** Gated view of one probe: what an agent honoring the abstention rule would have seen. */
function gateOutcome(outcome, abstained) {
  return abstained && outcome !== "controlFailed" ? "abstained" : outcome;
}

/**
 * Runs the probe for one row through the REAL hub API: load the gold's
 * schema, derive (or take) the intended arguments, run a control execution
 * of the gold, then execute the top-1 pick with those same arguments. The
 * probe is UNCONDITIONAL (it does not consult the abstention rule) so the
 * execution metric stays independent of the abstention metric; the gated
 * view is derived afterwards from the same row. The result cache is bypassed
 * so the control call can never answer the probe.
 */
async function executeProbe(hub, { gold, pick, args }) {
  const schema = hub.load(gold).inputSchema ?? {};
  const intended = args && typeof args === "object" ? args : intendedArgs(schema);
  const control = await hub.execute(gold, intended, { noCache: true });
  const result = control.ok === true && pick ? await hub.execute(pick, intended, { noCache: true }) : null;
  return { ...classifyExecution({ gold, pick, result, control }), args: intended };
}

async function warmAndTime(hub, queries, { abstentionThreshold = ABSTENTION_THRESHOLD_DEFAULT, execute = true, queryRewrite } = {}) {
  const searchOptions = queryRewrite ? { limit: 20, queryRewrite } : { limit: 20 };
  const withTimeout = (promise, ms, label) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout: ${label} exceeded ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  };
  for (const q of queries) await withTimeout(hub.search(q.query, searchOptions), 30_000, `warmup "${q.query.slice(0, 40)}"`);
  const rows = [];
  const latencies = [];
  for (const q of queries) {
    const t0 = performance.now();
    const hits = await withTimeout(hub.search(q.query, searchOptions), 30_000, `search "${q.query.slice(0, 40)}"`);
    latencies.push(performance.now() - t0);
    const golds = goldsOf(q);
    const ids = hits.map((h) => h.id);
    const goldRanks = golds.map((g) => (ids.includes(g) ? ids.indexOf(g) + 1 : null));
    const kind = golds.length > 1 ? "multi" : golds[0] && golds[0].startsWith("skill:") ? "skill" : "tool";
    const abstention = abstentionDecision(hits, abstentionThreshold);
    // Execution is scored on single-gold TOOL rows only: a skill cannot be
    // executed, and a multi row has no single intended call.
    const eligible = execute && kind === "tool" && golds.length === 1;
    const probe = eligible
      ? await withTimeout(executeProbe(hub, { gold: golds[0], pick: ids[0] ?? null, args: q.args }), 30_000, `execute "${q.query.slice(0, 40)}"`)
      : null;
    const execution = probe ? { ...probe, gatedOutcome: gateOutcome(probe.outcome, abstention.abstained) } : null;
    rows.push({
      query: q.query,
      expected: q.expected ?? null,
      expectedAll: golds.length > 1 ? golds : undefined,
      difficulty: q.difficulty,
      subtype: q.subtype,
      kind,
      goldRanks,
      firstGoldRank: golds.length ? Math.min(...golds.map((g, i) => (goldRanks[i] ?? Infinity))) : null,
      top1: ids[0] ?? null,
      resultCount: hits.length,
      top1Score: hits[0]?.score ?? 0,
      top3: hits.slice(0, 3).map((h) => ({ id: h.id, name: h.name, score: Number((h.score ?? 0).toFixed(4)) })),
      responseTokens: tokens(JSON.stringify(hits)),
      abstained: abstention.abstained,
      confidence: Number(abstention.confidence.toFixed(4)),
      confidenceBasis: abstention.basis,
      execution,
    });
  }
  return { rows, latencies };
}

/** Abstention block: true abstentions on no-match rows vs false abstentions on matched rows. */
function abstentionMetrics(rows, threshold) {
  const noMatch = rows.filter((r) => r.expected === null && !r.expectedAll);
  const matched = rows.filter((r) => r.expected !== null || (r.expectedAll?.length ?? 0) > 0);
  const abstainedNoMatch = noMatch.filter((r) => r.abstained === true).length;
  const abstainedMatched = matched.filter((r) => r.abstained === true).length;
  const withHits = rows.filter((r) => r.confidenceBasis && r.confidenceBasis !== "none");
  const confidences = withHits.map((r) => r.confidence);
  return {
    threshold,
    rule: ABSTENTION_RULE,
    // The scale the threshold was compared against. Raw semantic scores are
    // cosines in [0,1]; the fused-score fallback is on whatever scale the
    // engine emits (the keyword engine's lexical-only hub reports
    // unnormalized BM25, so at a [0,1] threshold it abstains only on empty
    // results). Reported so no rate is read without its scale.
    top1ConfidenceRange: confidences.length
      ? { min: Number(Math.min(...confidences).toFixed(4)), max: Number(Math.max(...confidences).toFixed(4)), median: Number(percentileOf(confidences, 50).toFixed(4)) }
      : null,
    noMatchCount: noMatch.length,
    noMatchAbstained: abstainedNoMatch,
    noMatchAbstainRate: noMatch.length ? abstainedNoMatch / noMatch.length : null,
    matchedCount: matched.length,
    matchedAbstained: abstainedMatched,
    falseAbstainRate: matched.length ? abstainedMatched / matched.length : null,
    overallAbstainRate: rows.length ? rows.filter((r) => r.abstained === true).length / rows.length : null,
    confidenceBasis: countBy(rows, (r) => r.confidenceBasis ?? "n/a"),
  };
}

/**
 * Execution block: successful execution of the GOLD, with the failure
 * classes kept apart. The headline rates are UNCONDITIONAL (every eligible
 * row's top-1 pick was executed, whatever the abstention rule said), so this
 * metric is independent of the abstention metric. `gatedByAbstention` is the
 * derived view an agent honoring the rule would have seen.
 */
function executionMetrics(rows) {
  const probed = rows.filter((r) => r.execution);
  const outcomes = Object.fromEntries(EXECUTION_OUTCOMES.map((o) => [o, 0]));
  const gated = Object.fromEntries(GATED_EXECUTION_OUTCOMES.map((o) => [o, 0]));
  const failureClasses = {};
  for (const r of probed) {
    outcomes[r.execution.outcome] = (outcomes[r.execution.outcome] ?? 0) + 1;
    const g = r.execution.gatedOutcome ?? r.execution.outcome;
    gated[g] = (gated[g] ?? 0) + 1;
    if (r.execution.failureClass) failureClasses[r.execution.failureClass] = (failureClasses[r.execution.failureClass] ?? 0) + 1;
  }
  const scored = probed.length - outcomes.controlFailed;
  const attempted = outcomes.success + outcomes.wrongToolExecuted + outcomes.wrongToolRejected + outcomes.goldFailed;
  return {
    definition: "success = the top-1 pick IS the gold and ActionHub.execute returned ok with the gold's intended arguments; rates are over scored rows (single-gold tool rows whose control execution of the gold succeeded); unconditional of the abstention rule",
    probedCount: probed.length,
    scoredCount: scored,
    attemptedCount: attempted,
    successCount: outcomes.success,
    successRate: scored ? outcomes.success / scored : null,
    wrongToolExecutedRate: scored ? outcomes.wrongToolExecuted / scored : null,
    wrongToolRejectedRate: scored ? outcomes.wrongToolRejected / scored : null,
    outcomes,
    failureClasses,
    gatedByAbstention: {
      definition: "same rows, but a row the abstention rule stops counts as abstained (no execution); what an agent honoring the rule would get",
      successRate: scored ? gated.success / scored : null,
      abstainedCount: gated.abstained,
      wrongToolExecutedRate: scored ? gated.wrongToolExecuted / scored : null,
      wrongToolRejectedRate: scored ? gated.wrongToolRejected / scored : null,
      outcomes: gated,
    },
  };
}

const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const safeDiv = (a, b) => (b === 0 ? 0 : a / b);
const tokens = (s) => Math.ceil(String(s ?? "").length / 4);
function percentileOf(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank definition: the smallest value covering >= p% of the sample,
  // i.e. sorted[ceil(p/100 * N) - 1] (reviewer-1 must-fix #2). Documented and
  // pinned by percentileSelfTest().
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * Macro per-query recall@k (reviewer-1 must-fix #1): for each matched query,
 * |retrieved@k ∩ golds| / |golds|, then mean across queries. This is the
 * BINDING gate metric; micro recall (gold-id-weighted) is reported separately.
 */
function macroRecallAt(matchedRows, k) {
  return mean(matchedRows.map((r) => {
    const golds = r.expectedAll?.length > 1 ? r.expectedAll : [r.expected];
    const hit = golds.filter((_, i) => r.goldRanks[i] !== null && r.goldRanks[i] <= k).length;
    return safeDiv(hit, golds.length);
  }));
}

function microRecallAt(matchedRows, k) {
  let found = 0, total = 0;
  for (const r of matchedRows) {
    const golds = r.expectedAll?.length > 1 ? r.expectedAll : [r.expected];
    for (let i = 0; i < golds.length; i++) {
      total += 1;
      const p = r.goldRanks[i];
      if (p !== null && p <= k) found += 1;
    }
  }
  return safeDiv(found, total);
}

function percentileSelfTest() {
  const eq = (a, b, m) => { if (a !== b) throw new Error(`self-test failed: ${m} (${a} !== ${b})`); };
  const base = Array.from({ length: 100 }, (_, i) => i + 1);
  eq(percentileOf(base, 50), 50, "p50 nearest-rank of 1..100");
  eq(percentileOf(base, 95), 95, "p95 nearest-rank of 1..100");
  eq(percentileOf([1, 2, 3, 4], 95), 4, "p95 of 4 items");
  eq(percentileOf([5], 50), 5, "p50 of single value");
  eq(percentileOf([], 95), 0, "empty");
  const fakeRows = [
    { expected: "a", expectedAll: null, goldRanks: [1] },
    { expected: null, expectedAll: ["b", "c", "d", "e"], goldRanks: [1, null, null, null] },
  ];
  eq(Number(macroRecallAt(fakeRows, 5).toFixed(4)), 0.625, "macro recall@5 per-query mean");
  eq(Number(microRecallAt(fakeRows, 5).toFixed(4)), 0.4, "micro recall@5 gold-weighted");
  // F52: the validators must reject malformed rows (fail closed), including
  // the previously-passing expected=null single-gold hole.
  const good = [{ query: "q1", expected: "a:tool", subtype: "exact", difficulty: "exact" }];
  const goodSkill = [{ query: "s1", expected: "skill:x", subtype: "noisy", difficulty: "hard" }];
  const vbase = { manifests: [], skills: [], idMismatches: 0 };
  validateGeneratedCorpus({ ...vbase, queries: good, skillQueries: [], expectCounts: false });
  validateGeneratedCorpus({ ...vbase, queries: [], skillQueries: goodSkill, expectCounts: false });
  // Negative tests through the skillQueries path as well (reviewer-2).
  const badSkillPairs = [
    [{ query: "s", expected: "skill:x", subtype: "exact", difficulty: "hard" }],
    [{ query: "s", expected: null, expectedAll: ["skill:a", "skill:b"], subtype: "multi", difficulty: "paraphrase" }],
  ];
  for (const bad of badSkillPairs) {
    let threw = false;
    try { validateGeneratedCorpus({ ...vbase, queries: [], skillQueries: bad, expectCounts: false }); } catch { threw = true; }
    eq(threw, true, `validator must reject malformed skill row: ${JSON.stringify(bad)}`);
  }
  for (const bad of [
    [{ query: "q", expected: null, subtype: "exact", difficulty: "exact" }],
    [{ query: "q", expected: null, expectedAll: ["a", "b"], subtype: "exact", difficulty: "exact" }],
    [{ query: "q", expected: "g", subtype: "bogus", difficulty: "exact" }],
    [{ query: "q", expected: "g", subtype: "exact", difficulty: "weird" }],
    [{ query: "q", expected: null, expectedAll: ["only1"], subtype: "multi", difficulty: "hard" }],
    [{ query: "q", expected: null, expectedAll: ["a", "b"], subtype: "no-match", difficulty: "hard" }],
  ]) {
    let threw = false;
    try { validateGeneratedCorpus({ ...vbase, queries: bad, skillQueries: [], expectCounts: false }); } catch { threw = true; }
    eq(threw, true, `validator must reject malformed row: ${JSON.stringify(bad)}`);
  }
  // Intended arguments (item 1): accepted on a single-gold tool row, rejected
  // when malformed or on a row that has nothing to execute.
  validateGeneratedCorpus({ ...vbase, queries: [{ query: "q", expected: "a:tool", subtype: "exact", difficulty: "exact", args: { ids: ["x"] } }], skillQueries: [], expectCounts: false });
  for (const bad of [
    [{ query: "q", expected: "a:tool", subtype: "exact", difficulty: "exact", args: ["not", "an", "object"] }],
    [{ query: "q", expected: "a:tool", subtype: "exact", difficulty: "exact", args: null }],
    [{ query: "q", expected: null, subtype: "no-match", difficulty: "hard", args: {} }],
    [{ query: "q", expected: null, expectedAll: ["a", "b"], subtype: "multi", difficulty: "hard", args: {} }],
  ]) {
    let threw = false;
    try { validateGeneratedCorpus({ ...vbase, queries: bad, skillQueries: [], expectCounts: false }); } catch { threw = true; }
    eq(threw, true, `validator must reject malformed args row: ${JSON.stringify(bad)}`);
  }
  // Abstention replay rule (item 1): raw semantic first, fused score fallback.
  eq(abstentionDecision([], 0.8).abstained, true, "no hits abstains");
  eq(abstentionDecision([{ id: "a", score: 0.95, semantic: 0.3 }], 0.8).abstained, true, "semantic below threshold abstains even with a high fused score");
  eq(abstentionDecision([{ id: "a", score: 0.2, semantic: 0.9 }], 0.8).abstained, false, "semantic above threshold answers");
  eq(abstentionDecision([{ id: "a", score: 0.85 }], 0.8).basis, "score", "fused score is the fallback basis");
  eq(abstentionDecision([{ id: "a", score: 0.85 }], 0.8).abstained, false, "fused score above threshold answers");
  eq(abstentionDecision([{ id: "a", score: 0.8 }], 0.8).abstained, false, "threshold is inclusive (score >= threshold answers)");
  // Execution classification (item 1 + 3): the outcomes are disjoint and the
  // gated view only ever adds "abstained" on top of the unconditional one.
  const ok = { ok: true }, bad = { ok: false, error: "Invalid arguments: arguments.ids: required property is missing" };
  eq(classifyExecution({ gold: "g", pick: "g", result: ok, control: ok }).outcome, "success", "gold picked and ran");
  eq(classifyExecution({ gold: "g", pick: "w", result: ok, control: ok }).outcome, "wrongToolExecuted", "wrong pick ran silently");
  const loud = classifyExecution({ gold: "g", pick: "w", result: bad, control: ok });
  eq(loud.outcome, "wrongToolRejected", "wrong pick rejected loudly");
  eq(loud.failureClass, "validation", "validation failure class");
  eq(classifyExecution({ gold: "g", pick: "g", result: bad, control: ok }).outcome, "goldFailed", "gold picked but failed");
  eq(classifyExecution({ gold: "g", pick: null, result: null, control: ok }).outcome, "noResult", "empty search");
  eq(classifyExecution({ gold: "g", pick: "g", result: null, control: bad }).outcome, "controlFailed", "gold refused its own intended args");
  eq(gateOutcome("success", true), "abstained", "gate stops a would-be success");
  eq(gateOutcome("wrongToolExecuted", false), "wrongToolExecuted", "gate off keeps the outcome");
  eq(gateOutcome("controlFailed", true), "controlFailed", "a broken control stays unscored under the gate");
  // Intended-argument builder is deterministic and schema-valid on every twin schema.
  for (const family of TWIN_FAMILIES) {
    const schema = family.schema();
    const a = intendedArgs(schema), b = intendedArgs(schema);
    eq(JSON.stringify(a), JSON.stringify(b), `intendedArgs deterministic for ${family.baseVerb}${family.suffix}`);
    eq(validateArguments(schema, a).valid, true, `intendedArgs valid for ${family.baseVerb}${family.suffix}`);
  }
  console.error("[eval-retrieval] validator self-test passed");
}

function scoreEngine(rows, latencies, { abstentionThreshold = ABSTENTION_THRESHOLD_DEFAULT } = {}) {
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
    // BINDING (reviewer-1 P1): observable system behavior only. The hub's
    // search API always returns up to `limit` hits and applies no rejection
    // threshold, so ANY nonempty hit list on a no-match query is a false
    // positive. No score threshold is involved in the binding rate.
    fpRate = noMatch.filter((r) => r.resultCount > 0).length / noMatch.length;
    fpDefinition = "fraction of no-match queries returning any hits (observable behavior; the API applies no rejection threshold)";
    noMatchTop1Mean = mean(noMatch.map((r) => r.top1Score));
  }

  // Binding metric = macro per-query recall; micro (gold-id weighted) kept
  // separately as microRecallAt{k} (reviewer-1 must-fix #1).
  const recalls = {};
  for (const k of [1, 3, 5, 10, 20]) recalls[`recallAt${k}`] = macroRecallAt(matched, k);
  const microRecalls = {};
  for (const k of [1, 3, 5, 10, 20]) microRecalls[`microRecallAt${k}`] = microRecallAt(matched, k);

  const lat = [...latencies].sort((a, b) => a - b);
  return {
    queryCount: rows.length,
    matchedCount: matched.length,
    recallDefinition: "macro: per-query |retrieved@k ∩ golds| / |golds|, mean across matched queries",
    ...microRecalls,
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
      // INFORMATIONAL ONLY (reviewer-1 P1): score separability, NOT a system
      // capability — the hub applies no threshold. Calibration and evaluation
      // are disjoint: threshold = P25 of matched-query top-1 scores; the rate
      // is measured on the held-out HALF of no-match rows (deterministic
      // index-parity split).
      scoreSeparability: noMatch.length > 1
        ? {
            informational: true,
            thresholdDefinition: "P25 of matched-query top-1 scores",
            threshold: matched.length ? Number(percentileOf(matched.map((r) => r.top1Score), 25).toFixed(4)) : null,
            fpRateHeldOut: (() => {
              const heldOut = noMatch.filter((_, i) => i % 2 === 0);
              if (heldOut.length === 0 || !matched.length) return null;
              const threshold = percentileOf(matched.map((r) => r.top1Score), 25);
              return heldOut.filter((r) => r.top1Score >= threshold).length / heldOut.length;
            })(),
            heldOutCount: noMatch.filter((_, i) => i % 2 === 0).length,
          }
        : null,
    },
    latency: {
      warmP50Ms: Number(percentileOf(lat, 50).toFixed(2)),
      warmP95Ms: Number(percentileOf(lat, 95).toFixed(2)),
      meanMs: Number(mean(lat).toFixed(2)),
      maxMs: Number(Math.max(...lat, 0).toFixed(2)),
    },
    responseTokensMean: Math.round(mean(rows.map((r) => r.responseTokens))),
    // Three distinct outcome metrics (item 1): the recall/MRR family above is
    // RETRIEVAL RANK; these two blocks are ABSTENTION and SUCCESSFUL
    // EXECUTION. None is derived from another.
    abstention: abstentionMetrics(rows, abstentionThreshold),
    execution: executionMetrics(rows),
    byDifficulty,
    bySubtype: mapValues(bySubtype, (rs) => coreMetrics(rs)),
    byKind,
  };
}

function coreMetrics(rows) {
  const matched = rows.filter((r) => r.expected !== null || (r.expectedAll?.length ?? 0) > 0);
  const multi = matched.filter((r) => (r.expectedAll?.length ?? 0) > 1);
  const out = { queryCount: rows.length };
  for (const k of [1, 3, 5, 10, 20]) out[`recallAt${k}`] = macroRecallAt(matched, k);
  for (const k of [1, 3, 5, 10, 20]) out[`microRecallAt${k}`] = microRecallAt(matched, k);
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
  // Abstention and execution per subset (only when the rows carry them), so
  // the by-subtype table shows e.g. how near-duplicate wrong picks fail.
  if (rows.some((r) => typeof r.abstained === "boolean")) {
    const abstainedMatched = matched.filter((r) => r.abstained === true).length;
    const noMatch = rows.filter((r) => r.expected === null && !r.expectedAll);
    out.abstention = {
      matchedAbstained: abstainedMatched,
      falseAbstainRate: matched.length ? abstainedMatched / matched.length : null,
      noMatchAbstained: noMatch.filter((r) => r.abstained === true).length,
      noMatchAbstainRate: noMatch.length ? noMatch.filter((r) => r.abstained === true).length / noMatch.length : null,
    };
  }
  if (rows.some((r) => r.execution)) {
    const ex = executionMetrics(rows);
    out.execution = {
      scoredCount: ex.scoredCount, successRate: ex.successRate,
      wrongToolExecutedRate: ex.wrongToolExecutedRate, wrongToolRejectedRate: ex.wrongToolRejectedRate,
      outcomes: ex.outcomes, failureClasses: ex.failureClasses,
      gatedByAbstention: { successRate: ex.gatedByAbstention.successRate, abstainedCount: ex.gatedByAbstention.abstainedCount },
    };
  }
  return out;
}

/**
 * Near-duplicate rows split by which side of a twin pair is the gold. A row
 * is twin-gold when its single gold is a twin name (archive_X_by_id,
 * delete_X_by_id, export_X_report); every other near-duplicate row is
 * base-gold (including generated-corpus rows, which carry no twins).
 */
function nearDuplicateByGoldDirection(rows) {
  const nd = rows.filter((r) => r.subtype === "near-duplicate" && typeof r.expected === "string");
  const out = {};
  for (const [label, subset] of [
    ["baseGold", nd.filter((r) => !isTwinName(r.expected.split(":")[1] ?? ""))],
    ["twinGold", nd.filter((r) => isTwinName(r.expected.split(":")[1] ?? ""))],
  ]) {
    if (subset.length === 0) { out[label] = null; continue; }
    const ex = subset.some((r) => r.execution) ? executionMetrics(subset) : null;
    out[label] = {
      n: subset.length,
      recallAt1: mean(subset.map((r) => (r.firstGoldRank === 1 ? 1 : 0))),
      execution: ex ? { scoredCount: ex.scoredCount, successRate: ex.successRate, wrongToolExecutedRate: ex.wrongToolExecutedRate, wrongToolRejectedRate: ex.wrongToolRejectedRate, outcomes: ex.outcomes } : null,
    };
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
const VALID_SUBTYPES = ["exact", "paraphrase", "goal-only", "near-duplicate", "noisy", "multi", "no-match"];
const VALID_DIFFICULTIES = ["exact", "paraphrase", "hard"];
// F52 rework (reviewer-2): subtype->difficulty is part of the contract, not a
// free pair. exact/paraphrase map to themselves; everything else is hard.
const SUBTYPE_DIFFICULTY = {
  exact: "exact",
  paraphrase: "paraphrase",
  "goal-only": "hard",
  "near-duplicate": "hard",
  noisy: "hard",
  multi: "hard",
  "no-match": "hard",
};

function validateGeneratedCorpus({ manifests, skills, queries, skillQueries, idMismatches, expectCounts = true }) {
  const errors = [];
  if (expectCounts) {
    // Count guards run only on REAL generated corpora; the self-test bypasses
    // them to exercise the row-shape rules on tiny synthetic fixtures.
    const toolCount = manifests.reduce((s, m) => s + m.tools.length, 0);
    if (manifests.length !== 44) errors.push(`expected 44 server manifests, got ${manifests.length}`);
    if (toolCount !== 10000) errors.push(`expected 10,000 tools, got ${toolCount}`);
    if (skills.length !== 5000) errors.push(`expected 5,000 skills, got ${skills.length}`);
    if (queries.length !== 1500) errors.push(`expected 1,500 tool queries, got ${queries.length}`);
    if (skillQueries?.length !== 500) errors.push(`expected 500 skill queries, got ${skillQueries?.length ?? 0}`);
    const mix = countBy(queries, (q) => q.subtype);
    const CONTRACT_MIX = { exact: 300, paraphrase: 300, "goal-only": 300, "near-duplicate": 375, multi: 150, "no-match": 75 };
    for (const [st, want] of Object.entries(CONTRACT_MIX)) {
      if ((mix[st] ?? 0) !== want) errors.push(`tool query mix ${st}: expected ${want}, got ${mix[st] ?? 0}`);
    }
  }
  if ((idMismatches ?? 0) !== 0) errors.push(`${idMismatches} skill id mismatches vs parseSkillContent`);
  for (const set of [queries, ...(skillQueries ? [skillQueries] : [])]) {
    for (const q of set) {
      if (typeof q.query !== "string" || q.query.trim() === "") { errors.push(`invalid query text: ${JSON.stringify(q).slice(0, 80)}`); break; }
      if (!VALID_DIFFICULTIES.includes(q.difficulty)) { errors.push(`unknown difficulty "${q.difficulty}" on: ${String(q.query).slice(0, 60)}`); break; }
      if (SUBTYPE_DIFFICULTY[q.subtype] !== q.difficulty) { errors.push(`subtype/difficulty mismatch: ${q.subtype} requires difficulty "${SUBTYPE_DIFFICULTY[q.subtype]}", got "${q.difficulty}" on: ${String(q.query).slice(0, 60)}`); break; }
      if (!VALID_SUBTYPES.includes(q.subtype)) { errors.push(`unknown subtype "${q.subtype}" on: ${String(q.query).slice(0, 60)}`); break; }
      const hasExpected = typeof q.expected === "string" || q.expected === null;
      const hasExpectedAll = Array.isArray(q.expectedAll);
      if (!hasExpected && !hasExpectedAll) { errors.push(`query without expected/expectedAll: ${String(q.query).slice(0, 60)}`); break; }
      if (hasExpectedAll && (q.expectedAll.length < 2 || q.expectedAll.length > 4 || q.expectedAll.some((g) => typeof g !== "string"))) {
        errors.push(`invalid expectedAll on: ${String(q.query).slice(0, 60)}`); break;
      }
      // Subtype semantics (reviewer-1): the label must match the row shape,
      // or the binding by-difficulty/by-subtype gates are unprotected.
      if (q.subtype === "no-match" && (q.expected !== null || hasExpectedAll)) { errors.push(`no-match row with a gold: ${String(q.query).slice(0, 60)}`); break; }
      if (q.subtype === "multi" && !(hasExpectedAll && q.expectedAll.length >= 2)) { errors.push(`multi row without 2-4 golds: ${String(q.query).slice(0, 60)}`); break; }
      // F52: single-gold rows require a NON-NULL string expected — the old
      // hasExpected accepted expected=null and let a goldless row pass.
      if (q.subtype !== "multi" && q.subtype !== "no-match" && !(typeof q.expected === "string" && q.expected.length > 0 && !hasExpectedAll)) { errors.push(`${q.subtype} row must have a non-empty single gold and no expectedAll: ${String(q.query).slice(0, 60)}`); break; }
      // Optional intended arguments for the execution probe (item 1): when a
      // row carries them they must be a plain object, and only a single-gold
      // tool row can carry them (a skill cannot be executed, a multi row has
      // no single intended call, a no-match row has nothing to execute).
      if (q.args !== undefined) {
        const plain = q.args !== null && typeof q.args === "object" && !Array.isArray(q.args);
        if (!plain) { errors.push(`args must be a plain object when present: ${String(q.query).slice(0, 60)}`); break; }
        if (q.subtype === "multi" || q.subtype === "no-match" || String(q.expected).startsWith("skill:")) { errors.push(`args only allowed on single-gold tool rows: ${String(q.query).slice(0, 60)}`); break; }
      }
    }
  }
  const uniqueQueries = new Set(queries.map((q) => q.query));
  if (uniqueQueries.size !== queries.length) errors.push(`duplicate query strings: ${queries.length - uniqueQueries.size}`);
  if (errors.length > 0) throw new Error(`generated corpus failed fail-closed validation:\n- ${errors.join("\n- ")}`);
}

async function runEval() {
  // Fail closed on a malformed flag before any corpus work (eval CLI contract).
  const abstentionThreshold = parseAbstentionThreshold(ARGV);
  const queryRewrite = parseQueryRewrite(ARGV);
  const scoreOpts = { abstentionThreshold, queryRewrite };

  // --- corpus ------------------------------------------------------------------
  let manifests, skills, queries, skillQueries = null, mode = "self-fixtures";
  let twinPairs = 0;
  const generated = loadGenerated();
  const idMismatches = generated?.idMismatches ?? 0;
  if (generated) {
    manifests = generated.manifests;
    skills = generated.skills;
    skillQueries = generated.skillQueries;
    queries = generated.toolQueries;
    mode = "full-generated";
    // Fail closed on malformed/partial full fixtures (reviewer-2 blocker 5).
    validateGeneratedCorpus({ manifests, skills, queries, skillQueries: generated.skillQueries, idMismatches: generated.idMismatches ?? 0 });
    console.error(`[eval-retrieval] using generated corpus: ${manifests.length} servers, ${skills.length} skills, ${queries.length} queries`);
  } else {
    ({ tools } = syntheticCatalog(QUICK ? 2 : DOMAINS.length));
    // Fail closed if any twin pair is not argument-incompatible both ways
    // (item 3): the loud-failure property is a fixture invariant.
    twinPairs = assertTwinsIncompatible(tools);
    manifests = groupTools(tools);
    skills = QUICK ? syntheticSkillPool(30) : syntheticSkillPool(1500);
    queries = selfQueries(tools);
    console.error(`[eval-retrieval] no generated corpus found; using self-fixtures (${tools.length} tools incl. ${twinPairs} incompatible-argument twin pairs, ${skills.length} skills, ${queries.length} queries)`);
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
  // The realistic fixture's gold ids exist only in the generated corpus; in
  // self-fixtures mode (clean-clone --quick smoke) they are absent by
  // construction, so the headline set is skipped with an explicit note
  // instead of failing closed on a known-good fixture (F52 ledger item 2).
  if (mode !== "full-generated") {
    console.error(`[eval-retrieval] realistic fixture skipped: self-fixtures mode has none of the realistic gold ids (full-generated corpus required)`);
  } else if (existsSync(REALISTIC_PATH)) {
    const raw = JSON.parse(readFileSync(REALISTIC_PATH, "utf8"));
    const list = Array.isArray(raw) ? raw : raw.queries;
    // Fail closed with the FULL v2 schema on the realistic fixture as well
    // (reviewer-1 must-fix #3): row shape, expectedAll 2-4 bounds/types,
    // subtype whitelist, mix counts, unique queries.
    const rErrors = [];
    if (list.length !== 121) rErrors.push(`expected 121 realistic rows, got ${list.length}`);
    const SUBTYPES = VALID_SUBTYPES;
    const EXPECTED_MIX = { paraphrase: 40, "goal-only": 30, "near-duplicate": 20, multi: 16, "no-match": 15 };
    const seenMix = {};
    for (const q of list) {
      if (typeof q.query !== "string" || q.query.trim() === "") { rErrors.push(`invalid realistic query text: ${JSON.stringify(q).slice(0, 80)}`); break; }
      if (!SUBTYPES.includes(q.subtype)) { rErrors.push(`unknown realistic subtype: ${q.subtype}`); break; }
      // F52: whitelist difficulty and enforce full subtype/shape semantics.
      if (!VALID_DIFFICULTIES.includes(q.difficulty)) { rErrors.push(`unknown realistic difficulty "${q.difficulty}": ${q.query.slice(0, 60)}`); break; }
      if (SUBTYPE_DIFFICULTY[q.subtype] !== q.difficulty) { rErrors.push(`subtype/difficulty mismatch: ${q.subtype} requires difficulty "${SUBTYPE_DIFFICULTY[q.subtype]}", got "${q.difficulty}": ${q.query.slice(0, 60)}`); break; }
      if (q.subtype === "no-match" && (q.expected !== null || "expectedAll" in q)) { rErrors.push(`realistic no-match row with a gold: ${q.query.slice(0, 60)}`); break; }
      if (q.subtype === "multi" && !(Array.isArray(q.expectedAll) && q.expectedAll.length >= 2 && q.expectedAll.length <= 4)) { rErrors.push(`realistic multi row without 2-4 golds: ${q.query.slice(0, 60)}`); break; }
      if (q.subtype !== "multi" && q.subtype !== "no-match" && !(typeof q.expected === "string" && q.expected.length > 0 && !("expectedAll" in q))) { rErrors.push(`realistic ${q.subtype} row must have a non-empty single gold and no expectedAll: ${q.query.slice(0, 60)}`); break; }
      const hasExpected = typeof q.expected === "string" || q.expected === null;
      const hasExpectedAll = Array.isArray(q.expectedAll);
      if (!hasExpected && !hasExpectedAll) { rErrors.push(`realistic row without expected/expectedAll: ${q.query.slice(0, 60)}`); break; }
      if (hasExpectedAll && (q.expectedAll.length < 2 || q.expectedAll.length > 4 || q.expectedAll.some((g) => typeof g !== "string"))) {
        rErrors.push(`realistic expectedAll out of 2-4 string bounds: ${q.query.slice(0, 60)}`); break;
      }
      if (q.subtype === "no-match" && q.expected !== null) { rErrors.push(`no-match realistic row must have expected=null: ${q.query.slice(0, 60)}`); break; }
      seenMix[q.subtype] = (seenMix[q.subtype] ?? 0) + 1;
    }
    for (const [st, want] of Object.entries(EXPECTED_MIX)) {
      if ((seenMix[st] ?? 0) !== want) rErrors.push(`realistic mix ${st}: expected ${want}, got ${seenMix[st] ?? 0}`);
    }
    const rUnique = new Set(list.map((q) => q.query));
    if (rUnique.size !== list.length) rErrors.push(`duplicate realistic queries: ${list.length - rUnique.size}`);
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
    const { hub, buildMs, embedding } = await buildEngine(name, manifests, skills, { warm: WARM });
    const engineBuildMs = Number((performance.now() - t0).toFixed(0));
    const { rows, latencies } = await warmAndTime(hub, fixedEvalSample, scoreOpts);
    const scored = scoreEngine(rows, latencies, scoreOpts);
    results[name] = {
      description: ENGINE_DESC[name], buildMs, engineBuildMs, embedding, ...scored,
      querySample: { size: fixedEvalSample.length, note: "identical fixed sample for all engines" },
    };
    console.error(`[eval-retrieval] ${name} (n=${fixedEvalSample.length}): recall@5=${scored.recallAt5?.toFixed?.(3)} mrr@10=${scored.mrrAt10?.toFixed?.(3)} exec=${fmt(scored.execution.successRate)} abstain(no-match)=${fmt(scored.abstention.noMatchAbstainRate)} p95=${scored.latency.warmP95Ms}ms`);
    await hub.close?.();
  }

  // Full-query-set runs for the GATE numbers (keyword + blend only; the
  // scorer engine is not needed at full scale and is excluded from gates).
  const gateRows = {};
  for (const name of SWEEP_ENGINES) {
    const { hub, buildMs, embedding } = await buildEngine(name, manifests, skills, { warm: WARM });
    const { rows, latencies } = await warmAndTime(hub, queries, scoreOpts);
    gateRows[name] = { scored: scoreEngine(rows, latencies, scoreOpts), rows, buildMs, embedding };
    console.error(`[eval-retrieval] gates ${name} (n=${queries.length}): recall@5=${gateRows[name].scored.recallAt5?.toFixed?.(3)} exec=${fmt(gateRows[name].scored.execution.successRate)} p95=${gateRows[name].scored.latency.warmP95Ms}ms`);
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
      const { rows, latencies } = await warmAndTime(hub, realistic, scoreOpts);
      const all = scoreEngine(rows, latencies, scoreOpts);
      const bySubtype = {};
      for (const st of Object.keys(realisticReport.mix)) {
        const sub = rows.filter((r) => r.subtype === st);
        if (sub.length > 0) {
          const scored = scoreEngine(sub, latencies.filter((_, i) => rows[i].subtype === st), scoreOpts);
          bySubtype[st] = { n: sub.length, recallAt5: scored.recallAt5, recallAt10: scored.recallAt10, mrrAt10: scored.mrrAt10, execution: scored.execution, abstention: scored.abstention };
        }
      }
      realisticReport.engines[name] = { recallAt5: all.recallAt5, recallAt10: all.recallAt10, mrrAt10: all.mrrAt10, noMatch: all.noMatch, abstention: all.abstention, execution: all.execution, latency: all.latency, bySubtype };
      await hub.close?.();
    }
    console.error(`[eval-retrieval] realistic: blend r@5=${realisticReport.engines.blend.recallAt5?.toFixed(3)} mrr@10=${realisticReport.engines.blend.mrrAt10?.toFixed(3)}`);
  }

  // --- skills regression section (skill queries vs the skill catalog) -------------
  let skillsReport = null;
  if (skillQueries && skillQueries.length > 0) {
    skillsReport = { queryCount: skillQueries.length, mix: countBy(skillQueries, (q) => q.subtype), engines: {} };
    for (const name of SWEEP_ENGINES) {
      const { hub } = await buildEngine(name, [], skills);
      // Skills cannot be executed, so the probe is off; abstention still applies.
      const { rows, latencies } = await warmAndTime(hub, skillQueries, { ...scoreOpts, execute: false });
      const scored = scoreEngine(rows, latencies, scoreOpts);
      skillsReport.engines[name] = {
        recallAt5: scored.recallAt5, recallAt10: scored.recallAt10, mrrAt10: scored.mrrAt10,
        ndcgAt10: scored.ndcgAt10, noMatch: scored.noMatch, abstention: scored.abstention, latency: scored.latency,
      };
      await hub.close?.();
    }
    console.error(`[eval-retrieval] skills: blend r@5=${skillsReport.engines.blend.recallAt5?.toFixed(3)} mrr@10=${skillsReport.engines.blend.mrrAt10?.toFixed(3)}`);
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
      // The sweep measures latency and rank against prefix sizes; the
      // execution probe is off here (it is scored on the full-set gate runs).
      const { rows, latencies } = await warmAndTime(hub, usable, { ...scoreOpts, execute: false });
      const scored = scoreEngine(rows, latencies, scoreOpts);
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
    gateChecks.noMatchFpRate = { target: GATES.noMatchFpRate, actual: blend.noMatch.fpRate, pass: blend.noMatch.fpRate !== null && blend.noMatch.fpRate <= GATES.noMatchFpRate, definition: blend.noMatch.fpDefinition };
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
    .map((r) => ({
      query: r.query, expected: r.expectedAll ?? r.expected, difficulty: r.difficulty, subtype: r.subtype, kind: r.kind, top3: r.top3,
      abstained: r.abstained, execution: r.execution ? { outcome: r.execution.outcome, pick: r.execution.pick, failureClass: r.execution.failureClass ?? null } : null,
    }));
  // Silent misfires (item 3): every wrong pick that EXECUTED. These are the
  // rows where only rank loss would have been visible before this probe.
  const silentMisfires = blendRows
    .filter((r) => r.execution?.outcome === "wrongToolExecuted")
    .slice(0, 20)
    .map((r) => ({ query: r.query, expected: r.expected, pick: r.execution.pick, subtype: r.subtype }));
  const loudWrongPicks = blendRows
    .filter((r) => r.execution?.outcome === "wrongToolRejected")
    .slice(0, 20)
    .map((r) => ({ query: r.query, expected: r.expected, pick: r.execution.pick, subtype: r.subtype, failureClass: r.execution.failureClass, error: String(r.execution.error ?? "").slice(0, 160) }));

  const summary = {
    script: "eval-retrieval",
    mode,
    queryRewrite: queryRewrite ?? "off",
    corpus: {
      servers: manifests.length,
      tools: manifests.reduce((s, m) => s + m.tools.length, 0),
      skills: skills.length,
      totalEntries: manifests.reduce((s, m) => s + m.tools.length, 0) + skills.length,
      queries: queries.length,
      queriesExcludedForMissingGolds: excluded,
      queryMix: countBy(queries, (q) => q.subtype),
      skillIdMismatches: idMismatches,
      incompatibleArgumentTwinPairs: twinPairs,
      rowsWithExplicitArgs: queries.filter((q) => q.args !== undefined).length,
    },
    // HEADLINE (item 1): the three outcome metrics side by side, from the
    // full-set blend gate run. Reported as three numbers, never combined.
    threeMetrics: {
      engine: "blend",
      querySet: "full",
      note: "retrieval rank, abstention, and successful execution are scored independently; a query can rank its gold first and still fail execution, or abstain correctly without ranking anything",
      embedding: gateRows.blend?.embedding ?? null,
      caveat: gateRows.blend?.embedding?.state === "cold"
        ? "blend measured on a COLD embedding index (embeddedDocs 0): every raw semantic score is 0, so the abstention replay abstains on every query and the blend ranking equals keyword; rerun with --warm-embeddings for the warm numbers"
        : null,
      retrievalRank: { recallAt1: blend.recallAt1, recallAt5: blend.recallAt5, recallAt10: blend.recallAt10, mrrAt10: blend.mrrAt10, matchedCount: blend.matchedCount },
      abstention: blend.abstention,
      execution: blend.execution,
      nearDuplicate: gateRows.blend?.scored.bySubtype["near-duplicate"]
        ? {
          execution: gateRows.blend.scored.bySubtype["near-duplicate"].execution ?? null,
          recallAt1: gateRows.blend.scored.bySubtype["near-duplicate"].recallAt1,
          // The two gold directions are different populations (base-gold rows
          // exercise a twin pick with base-shaped args; twin-gold rows carry
          // explicit twin-shaped args and exercise a base pick), so they are
          // reported separately as well as combined.
          byGoldDirection: nearDuplicateByGoldDirection(blendRows),
        }
        : null,
      silentMisfires,
      loudWrongPicks,
    },
    engines: results,
    sweep,
    gates: { definitions: GATES, checks: gateChecks, tokenSavings: { allDefinitionTokens: allDefTokens, meanReturnedDefinitionsTokens: Math.round(meanResponseTokens), searchToolDefTokens: tokens(SEARCH_TOOL_DEF), savings: Number(savings.toFixed(4)), formula: "1 - (search tool def + mean returned definitions per response) / (one eager definition payload of the full catalog); load() schema cost excluded" } },
    worstFailures: { engine: "blend", querySet: "full", items: worst },
    skillsRegression: skillsReport,
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

// Exposed for stress/eval-retrieval.test.mjs (fixture invariants, probe
// classification, abstention rule, metric blocks). Nothing runs at import.
export const __test = {
  syntheticCatalog, selfQueries, TWIN_FAMILIES, twinNameFor, isTwinName, assertTwinsIncompatible,
  intendedArgs, abstentionDecision, classifyExecution, gateOutcome, executeProbe, buildEngine, warmAndTime, GATED_EXECUTION_OUTCOMES,
  nearDuplicateByGoldDirection,
  scoreEngine, coreMetrics, abstentionMetrics, executionMetrics, validateGeneratedCorpus,
  parseAbstentionThreshold, parseQueryRewrite, percentileSelfTest, groupTools, EXECUTION_OUTCOMES, ABSTENTION_THRESHOLD_DEFAULT, OBJECTS, DOMAINS,
};

// Shared-harness failure envelope (PR 64): isolation, summary contract and
// exit code all come from stress/lib/harness.mjs. setupIsolation, the local
// withTimeout-guarded runner and the local write/exit logic are gone.
// Guarded so the unit tests can import this module without running the eval.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  harnessMain(async () => {
    // Isolate THIS process first: every checklist env var is replaced under one
    // fresh run root before any hub construction.
    const sandbox = createSandbox({ prefix: "action-hub-eval-" });
    Object.assign(process.env, sandbox.env);
    assertIsolated(process.env, sandbox.root);
    // Self-tests run INSIDE the harness finish path (reviewer-2 blocker 3): a
    // self-test regression must produce the final ok:false JSON + failure
    // artifact + nonzero exit, not a bare crash outside the contract.
    percentileSelfTest();
    return runEval();
  }, { resultsPath: join(RESULTS_DIR, "eval-retrieval.json") });
}
