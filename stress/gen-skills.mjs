#!/usr/bin/env node
/**
 * stress/gen-skills.mjs — deterministic generator of 5,000 SKILL.md files
 * (Action Hub stress S1), plus 500 retrieval queries.
 *
 * Contract (see stress/CONTRACT.md):
 *   - Output:  stress/.generated/skills/<slug>/SKILL.md
 *     ---
 *     name: <Human Name>
 *     description: <one sentence>
 *     ---
 *     <exactly 4 sentences of instructions>
 *   - Action id = skill:<slug> exactly as core parseSkillContent derives it
 *     (verified in-process against packages/core/dist).
 *   - Queries: stress/.generated/skills-queries.json
 *     [{ query, expected, difficulty: "exact|paraphrase|hard" }]
 *     200 exact-ish, 200 paraphrase, 100 hard (synonyms, no shared keywords).
 *   - Deterministic: seeded PRNG (--seed, default 1337). No network, no LLM.
 *   - Last stdout line: machine-readable JSON summary; also written to
 *     stress/.generated/results/gen-skills.json.
 *
 * Usage: node stress/gen-skills.mjs [--seed 1337] [--count 5000] [--out .generated]
 */

import { mkdir, writeFile, readdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const startedAt = Date.now();

// --- CLI ---------------------------------------------------------------------
const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}
const SEED = Number(argValue("--seed", 1337));
const COUNT = Number(argValue("--count", 5000));
const OUT_REL = argValue("--out", ".generated");
const OUT_DIR = resolve(scriptDir, OUT_REL);
const SKILLS_DIR = join(OUT_DIR, "skills");
const QUERIES_PATH = join(OUT_DIR, "skills-queries.json");
const RESULTS_DIR = join(OUT_DIR, "results");

// --- Seeded PRNG (mulberry32) -------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
function pick(arr) {
  return arr[Math.floor(rand() * arr.length)];
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// --- Domain template banks -----------------------------------------------------
// Near-duplicates are deliberate: within a domain most names share 3 of 4
// content words and differ only by number/qualifier, which stresses retrieval.
const DOMAINS = [
  {
    name: "devops",
    subjects: ["Kubernetes", "Terraform", "Jenkins", "Docker", "Ansible", "Nomad"],
    objects: ["Rollout", "Migration", "Drift", "Backfill", "Failover", "Upgrade"],
    types: ["Runbook", "Playbook", "Checklist", "Guide"],
    context: "the production cluster",
    metric: "deploy success rate",
    tool: "the deploy pipeline",
    synonyms: {
      Kubernetes: "container orchestration",
      Terraform: "infrastructure as code",
      Docker: "containers",
      Rollout: "release",
      Failover: "switchover",
      production: "live",
    },
  },
  {
    name: "finance",
    subjects: ["Revenue", "Payroll", "Invoice", "Expense", "Budget", "Tax"],
    objects: ["Reconciliation", "Forecast", "Audit", "Closing", "Review", "Filing"],
    types: ["Procedure", "Playbook", "Walkthrough", "Checklist"],
    context: "the general ledger",
    metric: "close cycle time",
    tool: "the accounting system",
    synonyms: {
      Revenue: "income",
      Invoice: "billing",
      Audit: "inspection",
      Reconciliation: "matching",
      ledger: "books",
      Tax: "duties",
    },
  },
  {
    name: "legal",
    subjects: ["Contract", "Trademark", "Compliance", "Privacy", "Licensing", "Discovery"],
    objects: ["Review", "Renewal", "Filing", "Negotiation", "Assessment", "Response"],
    types: ["Checklist", "Procedure", "Guide", "Runbook"],
    context: "the counsel desk",
    metric: "turnaround time",
    tool: "the matter management system",
    synonyms: {
      Contract: "agreement",
      Trademark: "brand mark",
      Compliance: "regulatory adherence",
      Privacy: "data protection",
      counsel: "attorneys",
      Filing: "submission",
    },
  },
  {
    name: "cooking",
    subjects: ["Sourdough", "Pastry", "Braise", "Ferment", "Roast", "Charcuterie"],
    objects: ["Starter", "Lamination", "Tempering", "Curing", "Resting", "Brining"],
    types: ["Recipe", "Method", "Guide", "Walkthrough"],
    context: "the station prep list",
    metric: "doneness accuracy",
    tool: "the mise en place",
    synonyms: {
      Sourdough: "wild yeast bread",
      Pastry: "dough work",
      Ferment: "culture",
      Roast: "oven cook",
      curing: "preserving",
      station: "kitchen section",
    },
  },
  {
    name: "security",
    subjects: ["Phishing", "Credential", "Firewall", "Malware", "Insider", "Patch"],
    objects: ["Triage", "Containment", "Hardening", "Sweep", "Rotation", "Response"],
    types: ["Runbook", "Checklist", "Procedure", "Playbook"],
    context: "the security operations center",
    metric: "mean time to detect",
    tool: "the SIEM console",
    synonyms: {
      Phishing: "social engineering",
      Credential: "login secret",
      Malware: "hostile software",
      Patch: "update",
      containment: "isolation",
      "security operations center": "soc",
    },
  },
  {
    name: "data",
    subjects: ["Warehouse", "Pipeline", "Model", "Dataset", "Feature", "Dashboard"],
    objects: ["Backfill", "Migration", "Validation", "Refresh", "Rollout", "Debugging"],
    types: ["Runbook", "Guide", "Playbook", "Checklist"],
    context: "the analytics platform",
    metric: "freshness SLA",
    tool: "the orchestrator",
    synonyms: {
      Warehouse: "columnar store",
      Pipeline: "data flow",
      Dataset: "table set",
      Validation: "quality checks",
      freshness: "recency",
      orchestrator: "scheduler",
    },
  },
  {
    name: "design",
    subjects: ["Design System", "Typography", "Accessibility", "Prototype", "Iconography", "Motion"],
    objects: ["Audit", "Handoff", "Refactor", "Review", "Spec", "Documentation"],
    types: ["Guide", "Checklist", "Procedure", "Playbook"],
    context: "the product surface",
    metric: "usability score",
    tool: "the design library",
    synonyms: {
      Typography: "type setting",
      Accessibility: "inclusive use",
      Prototype: "mockup",
      "Design System": "component library",
      handoff: "developer delivery",
      motion: "animation",
    },
  },
  {
    name: "sales",
    subjects: ["Pipeline", "Renewal", "Upsell", "Territory", "Quota", "Proposal"],
    objects: ["Forecast", "Review", "Handoff", "Outreach", "Negotiation", "Planning"],
    types: ["Playbook", "Guide", "Procedure", "Checklist"],
    context: "the regional account list",
    metric: "win rate",
    tool: "the CRM workspace",
    synonyms: {
      Pipeline: "deal flow",
      Renewal: "rebooking",
      Upsell: "expansion",
      Quota: "target",
      outreach: "prospecting",
      CRM: "customer database",
    },
  },
  {
    name: "medicine",
    subjects: ["Intake", "Triage", "Discharge", "Medication", "Sterile", "Rounds"],
    objects: ["Protocol", "Reconciliation", "Handoff", "Checks", "Documentation", "Review"],
    types: ["Procedure", "Checklist", "Guide", "Protocol"],
    context: "the ward unit",
    metric: "documentation completeness",
    tool: "the charting system",
    synonyms: {
      Triage: "priority sorting",
      Medication: "pharmaceuticals",
      Sterile: "aseptic",
      Intake: "admission",
      ward: "patient floor",
      charting: "records",
    },
  },
  {
    name: "marketing",
    subjects: ["Campaign", "Brand", "Newsletter", "Webinar", "Funnel", "Attribution"],
    objects: ["Launch", "Brief", "Retro", "Segmentation", "Testing", "Reporting"],
    types: ["Playbook", "Guide", "Checklist", "Procedure"],
    context: "the growth calendar",
    metric: "conversion lift",
    tool: "the automation platform",
    synonyms: {
      Campaign: "push",
      Brand: "identity",
      Newsletter: "digest",
      Funnel: "conversion path",
      launch: "go-live",
      segmentation: "audience split",
    },
  },
  {
    name: "support",
    subjects: ["Escalation", "Outage", "Ticket", "Onboarding", "Refund", "Callback"],
    objects: ["Triage", "Response", "Follow-up", "Review", "Rotation", "Handoff"],
    types: ["Runbook", "Checklist", "Procedure", "Guide"],
    context: "the help desk",
    metric: "first response time",
    tool: "the ticketing queue",
    synonyms: {
      Escalation: "elevated case",
      Outage: "service interruption",
      Ticket: "request",
      Refund: "repayment",
      "help desk": "support line",
      triage: "sorting",
    },
  },
  {
    name: "education",
    subjects: ["Curriculum", "Assessment", "Enrollment", "Grading", "Workshop", "Tutoring"],
    objects: ["Design", "Calibration", "Session", "Rollout", "Review", "Planning"],
    types: ["Guide", "Checklist", "Procedure", "Playbook"],
    context: "the term calendar",
    metric: "learner outcomes",
    tool: "the learning platform",
    synonyms: {
      Curriculum: "course plan",
      Assessment: "testing",
      Enrollment: "registration",
      Grading: "scoring",
      learner: "student",
      tutoring: "coaching",
    },
  },
];

const INSTRUCTION_VERBS = [
  "Confirm",
  "Capture",
  "Verify",
  "Stage",
  "Record",
  "Cross-check",
  "Escalate",
  "Schedule",
];
const INSTRUCTION_CONDITIONS = [
  "before the next handoff",
  "when the threshold is crossed",
  "at the start of the shift",
  "after every change window",
  "before the weekly review",
  "once the queue is drained",
];
const INSTRUCTION_ACTIONS = [
  "Update the tracking sheet and tag the owner",
  "Announce the status in the shared channel",
  "Log the outcome against the current cycle",
  "Attach the evidence to the running doc",
  "Summarize the deltas for the next reviewer",
  "Archive the artifacts under the dated folder",
];

// --- Slug derivation (must match core parseSkillContent exactly) ---------------
// id = "skill:" + name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
function slugOf(name) {
  return `skill:${name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")}`;
}

// --- Generation ------------------------------------------------------------------
const PER_DOMAIN = Math.ceil(COUNT / DOMAINS.length); // 12 domains
const skills = [];
const usedNames = new Set();

for (let i = 0; i < COUNT; i++) {
  const domain = DOMAINS[i % DOMAINS.length];
  const serial = Math.floor(i / DOMAINS.length) + 1; // 1..PER_DOMAIN per domain
  // Base name: <Subject> <Object> <Type> <serial> — most vocabulary repeats
  // across ~<PER_DOMAIN> siblings in the same domain (deliberate near-duplicates).
  const subject = domain.subjects[serial % domain.subjects.length];
  const object = domain.objects[Math.floor(serial / domain.subjects.length) % domain.objects.length];
  const type = domain.types[(serial * 7) % domain.types.length];
  const name = `${subject} ${object} ${type} ${serial}`;
  if (usedNames.has(name)) throw new Error(`non-unique name generated: ${name}`);
  usedNames.add(name);

  const slug = slugOf(name);
  // One-sentence description: domain vocabulary, unique via the serial tail.
  const description = `${pick(INSTRUCTION_CONDITIONS).replace(/^\w/, (c) => c.toUpperCase())}, run the ${domain.name} ${pick(domain.objects).toLowerCase()} for ${name} against ${domain.context} and report ${domain.metric}.`
    .replace(/\s+/g, " ")
    .trim();

  // Exactly 4 sentences of instructions.
  const s1 = `${pick(INSTRUCTION_VERBS)} the current ${pick(domain.objects).toLowerCase()} in ${domain.context} ${pick(INSTRUCTION_CONDITIONS)}.`;
  const s2 = `Use ${domain.tool} to ${pick(INSTRUCTION_VERBS).toLowerCase()} each step and compare against ${domain.metric}.`;
  const s3 = `${pick(INSTRUCTION_ACTIONS)} ${pick(INSTRUCTION_CONDITIONS)}.`;
  const s4 = `If anything fails validation, restart from step one and escalate before the next ${pick(domain.objects).toLowerCase()}.`;
  const instructions = [s1, s2, s3, s4].join(" ");

  skills.push({ name, slug, description, instructions, domain: domain.name });
}

// --- Write SKILL.md files ---------------------------------------------------------
await mkdir(SKILLS_DIR, { recursive: true });
await mkdir(RESULTS_DIR, { recursive: true });

let totalBytes = 0;
for (const skill of skills) {
  const file = [
    "---",
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    "---",
    "",
    skill.instructions,
    "",
  ].join("\n");
  const bytes = Buffer.byteLength(file, "utf8");
  totalBytes += bytes;
  await mkdir(join(SKILLS_DIR, skill.slug.replace(/^skill:/, "")), { recursive: true });
  await writeFile(join(SKILLS_DIR, skill.slug.replace(/^skill:/, ""), "SKILL.md"), file, "utf8");
}

// --- Verify with core parseSkillContent ----------------------------------------
const { parseSkillContent } = await import(
  new URL("file://" + join(repoRoot, "packages/core/dist/discovery/auto-discovery.js")).href
);

const onDisk = await readdir(SKILLS_DIR, { withFileTypes: true });
const claimedIds = new Set(skills.map((s) => s.slug));
const verifiedIds = new Set();
let mismatches = 0;
for (const entry of onDisk) {
  if (!entry.isDirectory()) continue;
  const path = join(SKILLS_DIR, entry.name, "SKILL.md");
  const { readFile } = await import("node:fs/promises");
  const parsed = parseSkillContent(await readFile(path, "utf8"), path, "custom");
  verifiedIds.add(parsed.id);
  if (parsed.id !== `skill:${entry.name}` || !claimedIds.has(parsed.id)) mismatches++;
}
if (verifiedIds.size !== skills.length || mismatches !== 0) {
  throw new Error(
    `id verification failed: verified=${verifiedIds.size} expected=${skills.length} mismatches=${mismatches}`,
  );
}
if (claimedIds.size !== skills.length) throw new Error("claimed ids are not unique");

// --- Queries: 200 exact-ish, 200 paraphrase, 100 hard ------------------------------
const token = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter(Boolean);

function buildExact(skills_) {
  return shuffle(skills_).slice(0, 200).map((s) => ({
    query: s.name,
    expected: s.slug,
    difficulty: "exact",
  }));
}

const PARAPHRASE_MAP = [
  ["run", "execute"],
  ["review", "go-over"],
  ["procedure", "process"],
  ["playbook", "game plan"],
  ["checklist", "to-do sheet"],
  ["report", "surface"],
  ["verify", "double-check"],
  ["escalate", "flag upward"],
  ["update", "refresh"],
  ["against", "versus"],
];
function paraphrase(text) {
  let out = text;
  for (const [from, to] of PARAPHRASE_MAP) {
    const re = new RegExp(`\\b${from}\\b`, "gi");
    out = out.replace(re, to);
  }
  return out;
}
function buildParaphrase(skills_) {
  return shuffle(skills_)
    .slice(0, 200)
    .map((s) => {
      const q = `${paraphrase(s.description)}`.split(/(?<=\.)\s/)[0];
      return { query: q.replace(/\.$/, ""), expected: s.slug, difficulty: "paraphrase" };
    });
}

function buildHard(skills_) {
  // Synonym queries: rewrite the name using the domain's synonym map and keep
  // probing until the query shares no tokens with the skill's name/description.
  const results = [];
  const shuffled = shuffle(skills_);
  for (const s of shuffled) {
    if (results.length >= 100) break;
    let q = s.name;
    for (const [from, to] of Object.entries(
      DOMAINS.find((d) => d.name === s.domain).synonyms,
    )) {
      const re = new RegExp(`\\b${from}\\b`, "gi");
      q = q.replace(re, to);
    }
    // Still contains some shared tokens (e.g. the type word) — replace them.
    for (const typeWord of ["Runbook", "Playbook", "Checklist", "Guide", "Procedure", "Recipe", "Method", "Protocol", "Walkthrough"]) {
      const re = new RegExp(`\\b${typeWord}\\b`, "i");
      if (re.test(q)) q = q.replace(re, "instructions");
    }
    // Numbers are neutral shared tokens — replace with the ordinal word.
    q = q.replace(/\b\d+\b/, (m) => ["single", "pair", "trio", "quad"][Number(m) % 4] ?? "set");
    const qTokens = new Set(token(q));
    const skillTokens = new Set([...token(s.name), ...token(s.description)]);
    const overlap = [...qTokens].filter((t) => skillTokens.has(t));
    if (overlap.length > 0) continue; // keep probing for a clean synonym query
    results.push({ query: q, expected: s.slug, difficulty: "hard" });
  }
  return results;
}

const queries = [
  ...buildExact(skills),
  ...buildParaphrase(skills),
  ...buildHard(skills),
];
await writeFile(QUERIES_PATH, JSON.stringify(queries, null, 2), "utf8");

// --- Summary --------------------------------------------------------------------
const durationMs = Date.now() - startedAt;
const summary = {
  script: "gen-skills.mjs",
  seed: SEED,
  skills: skills.length,
  uniqueIds: verifiedIds.size,
  idMismatches: mismatches,
  queries: {
    total: queries.length,
    exact: queries.filter((q) => q.difficulty === "exact").length,
    paraphrase: queries.filter((q) => q.difficulty === "paraphrase").length,
    hard: queries.filter((q) => q.difficulty === "hard").length,
  },
  generationMs: durationMs,
  totalBytes,
  skillsDir: SKILLS_DIR,
};
await writeFile(join(RESULTS_DIR, "gen-skills.json"), JSON.stringify(summary, null, 2), "utf8");
console.log(JSON.stringify(summary));
