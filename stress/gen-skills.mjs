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
 *   - Queries: stress/.generated/skills-queries.json (schema v2)
 *     [{ query, expected, difficulty, subtype, expectedAll? }]
 *     500 rows in the contract-v2 mix: 100 exact, 100 paraphrase, 100 goal-only,
 *     125 near-duplicate (distractors mined by term overlap), 50 multi
 *     (expectedAll, 2-4 ids), 25 no-match (expected null); some typos/fragments.
 *     Invariant: unique query text, one expected id per query (fail otherwise).
 *   - Deterministic: seeded PRNG (--seed, default 1337). No network, no LLM.
 *   - Last stdout line: machine-readable JSON summary; also written to
 *     stress/.generated/results/gen-skills.json.
 *
 * Usage: node stress/gen-skills.mjs [--seed 1337] [--count 5000] [--out .generated]
 */

import { mkdir, writeFile, readdir, readFile, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const startedAt = Date.now();
// Tokenizer shared by generation and all overlap invariants (lowercased
// alphanumeric words — the same shape the core search inputs use).
const token = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter(Boolean);

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
const QUALIFIERS = ["Blue-Green", "Canary", "Rolling", "Shadow", "Warm", "Cold"];

// --- Slug derivation (must match core parseSkillContent exactly) ---------------
// id = "skill:" + name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
function slugOf(name) {
  return `skill:${name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")}`;
}

// --- Generation ------------------------------------------------------------------
// Uniqueness comes from content, not serials: each skill index maps through a
// mixed-radix decode over the combinatorial banks (subject x object x qualifier
// x type = 6*6*6*4 = 864 combos per domain >= ceil(5000/12) = 417), so every
// name is unique while same-domain siblings still share most vocabulary — the
// deliberate near-duplicates.
const PER_DOMAIN = Math.ceil(COUNT / DOMAINS.length);
const skills = [];
const usedNames = new Set();

for (let i = 0; i < COUNT; i++) {
  const domain = DOMAINS[i % DOMAINS.length];
  const s = Math.floor(i / DOMAINS.length); // 0..PER_DOMAIN-1 within domain
  const subject = domain.subjects[s % domain.subjects.length];
  const object = domain.objects[Math.floor(s / 6) % domain.objects.length];
  const qualifier = QUALIFIERS[Math.floor(s / 36) % QUALIFIERS.length];
  const type = domain.types[Math.floor(s / 216) % domain.types.length];
  const name = `${subject} ${object} ${qualifier} ${type}`;
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
// Reconcile the owned directory: remove stale skill dirs so --count reruns in
// the same output path stay repeatable. Sibling generated artifacts/results
// elsewhere under .generated/ are untouched.
await rm(SKILLS_DIR, { recursive: true, force: true });
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
const indexedDocs = new Map(); // slug -> Set(tokens of the fields SearchEngine indexes)
let mismatches = 0;
for (const entry of onDisk) {
  if (!entry.isDirectory()) continue;
  const path = join(SKILLS_DIR, entry.name, "SKILL.md");
  const parsed = parseSkillContent(await readFile(path, "utf8"), path, "custom");
  verifiedIds.add(parsed.id);
  indexedDocs.set(
    parsed.id,
    new Set([...token(parsed.name), ...token(parsed.summary), ...token(parsed.description)]),
  );
  if (parsed.id !== `skill:${entry.name}` || !claimedIds.has(parsed.id)) mismatches++;
}
if (verifiedIds.size !== skills.length || mismatches !== 0) {
  throw new Error(
    `id verification failed: verified=${verifiedIds.size} expected=${skills.length} mismatches=${mismatches}`,
  );
}
if (claimedIds.size !== skills.length) throw new Error("claimed ids are not unique");

// --- Query helpers --------------------------------------------------------------
function termOverlap(a, b) {
  const A = new Set(token(a));
  let n = 0;
  for (const t of token(b)) if (A.has(t)) n++;
  return n;
}

// Deterministic typo: swap two adjacent letters inside one longer word.
function applyTypo(text, rnd) {
  const words = text.split(" ");
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const letters = w.replace(/[^a-zA-Z]/g, "");
    if (letters.length >= 4) {
      const pos = Math.floor(rnd() * (letters.length - 2)) + 1;
      const swapped =
        letters.slice(0, pos) + letters[pos + 1] + letters[pos] + letters.slice(pos + 2);
      words[i] = w.replace(letters, swapped);
      return words.join(" ");
    }
  }
  return text;
}

// Deterministic fragment: keep a prefix of the words.
function applyFragment(text, rnd) {
  const words = text.split(" ");
  if (words.length <= 4) return text;
  const keep = 3 + Math.floor(rnd() * 2); // 3-4 words
  return words.slice(0, keep).join(" ");
}

function withNoise(query, rnd, noiseRate, counters) {
  const roll = rnd();
  if (roll < noiseRate * 0.6) {
    counters.typo++; // typo stays; still typed as its base subtype
    return applyTypo(query, rnd);
  }
  if (roll < noiseRate) {
    counters.fragment++;
    return applyFragment(query, rnd);
  }
  return query;
}

// Goal-only query: the intent without the skill's name tokens.
function goalOnlyQuery(skill) {
  return skill.description
    .replace(skill.name, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+\./g, ".")
    .trim();
}

const skillTokens = new Map(); // name -> Set(tokens of name+description)
for (const s of skills) skillTokens.set(s.name, new Set([...token(s.name), ...token(s.description)]));

// Nearest non-gold neighbour by term overlap (mined within the same domain so
// the scan stays O(skills x domain-size) instead of O(skills²)).
function nearestNeighbour(target) {
  let best = null;
  let bestScore = 0;
  for (const s of skills) {
    if (s.domain !== target.domain || s.name === target.name) continue;
    const score = termOverlap(s.name + " " + s.description, target.name + " " + target.description);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return { skill: best, score: bestScore };
}

const counters = { typo: 0, fragment: 0 };
const queries = [];
const usedQueryText = new Set();
function tryPush(q) {
  const key = q.query.trim().toLowerCase();
  if (usedQueryText.has(key)) return false;
  usedQueryText.add(key);
  queries.push(q);
  return true;
}
const shuffled = shuffle(skills);
let idx = 0;
const take = (n) => shuffled.slice(idx, (idx += n));

// 20% exact (100)
for (const s of take(100)) {
  tryPush({
    query: withNoise(s.name, rand, 0.2, counters),
    expected: s.slug,
    difficulty: "exact",
    subtype: "exact",
  });
}

// 20% paraphrase (100)
const PARAPHRASE_MAP = [
  ["run", "execute"],
  ["review", "go over"],
  ["report", "surface"],
  ["compare against", "measure against"],
  ["confirm", "double-check"],
  ["escalate", "flag upward"],
  ["update", "refresh"],
  ["verify", "validate"],
];
function paraphrase(text) {
  let out = text;
  for (const [from, to] of PARAPHRASE_MAP) out = out.replace(new RegExp(`\\b${from}\\b`, "gi"), to);
  return out;
}
for (const s of take(300)) {
  if (queries.filter((q) => q.subtype === "paraphrase").length >= 100) break;
  const firstWord = s.name.split(" ")[0];
  const q = withNoise(
    paraphrase(goalOnlyQuery(s)) + " " + firstWord.toLowerCase(),
    rand,
    0.2,
    counters,
  );
  // Invariants (review HIGH-3): paraphrases must not leak the literal target
  // name or any number. Documented overlap ceiling: a paraphrase may cover at
  // most half of the gold document's tokens (inDoc / docTokens <= 0.5) — it
  // restates the goal with domain vocabulary, never recites the document.
  if (/\d{2,}/.test(q)) continue; // numeric leakage: skip this candidate
  if (q.toLowerCase().includes(s.name.toLowerCase())) continue;
  const doc = indexedDocs.get(s.slug);
  const qTokens = new Set(token(q));
  const inDoc = [...qTokens].filter((t) => doc.has(t)).length;
  if (inDoc / doc.size > 0.5) continue;
  tryPush({
    query: q,
    expected: s.slug,
    difficulty: "paraphrase",
    subtype: "paraphrase",
  });
}

// 20% goal-only (100) — the goal without the skill's name. Candidate texts
// repeat across same-domain siblings, so fill the band retry-style: the first
// claim on a text wins and later conflicting candidates are skipped.
for (const s of take(220)) {
  if (queries.filter((q) => q.subtype === "goal-only").length >= 100) break;
  tryPush({
    query: withNoise(goalOnlyQuery(s), rand, 0.15, counters),
    expected: s.slug,
    difficulty: "hard",
    subtype: "goal-only",
  });
}

// 25% near-duplicate (125) — targets whose nearest non-gold neighbours are
// same-domain vocabulary siblings (mined with term overlap); the query keeps
// the serial cue but drops the type word so siblings score almost as high.
let mined = 0;
for (const s of shuffled) {
  if (mined >= 125) break;
  const nn = nearestNeighbour(s);
  if (!nn.skill || nn.score < 8) continue;
  const typeWords = DOMAINS.find((d) => d.name === s.domain).types;
  let q = s.description.replace(new RegExp(`\\b(${typeWords.join("|")})\\b`, "gi"), "");
  q = q.replace(/\s{2,}/g, " ").trim();
  if (
    tryPush({
      query: withNoise(q, rand, 0.15, counters),
      expected: s.slug,
      difficulty: "hard",
      subtype: "near-duplicate",
    })
  ) {
    mined++;
  }
}
while (mined < 125) {
  // Fallback: any skill, still typed as near-duplicate with its type word dropped.
  const s = shuffled[(idx + mined) % shuffled.length];
  const typeWords = DOMAINS.find((d) => d.name === s.domain).types;
  const q = s.description
    .replace(new RegExp(`\\b(${typeWords.join("|")})\\b`, "gi"), "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (
    tryPush({
      query: q,
      expected: s.slug,
      difficulty: "hard",
      subtype: "near-duplicate",
    })
  ) {
    mined++;
  } else {
    mined++; // guard against infinite loops on pathological collisions
  }
}

// 10% multi (50) — 2-4 skill ids from one confusable family: same
// subject+object+type, differing only by qualifier (the corpus near-duplicates).
function familyMembers(s) {
  const words = s.name.split(" ");
  const qualifierIndex = words.findIndex((w) => QUALIFIERS.includes(w));
  if (qualifierIndex === -1) return [];
  const stem = [...words.slice(0, qualifierIndex), ...words.slice(qualifierIndex + 1)].join(" ");
  return skills.filter(
    (x) =>
      x.domain === s.domain &&
      x.name !== s.name &&
      (() => {
        const w = x.name.split(" ");
        const qi = w.findIndex((q) => QUALIFIERS.includes(q));
        return qi !== -1 && [...w.slice(0, qi), ...w.slice(qi + 1)].join(" ") === stem;
      })(),
  );
}
let multiCount = 0;
for (const s of shuffled) {
  if (multiCount >= 50) break;
  const family = familyMembers(s);
  if (family.length < 1) continue;
  const group = [s, ...family].slice(0, 2 + Math.floor(rand() * 3));
  if (group.length < 2) continue;
  const words = group[0].name.split(" ");
  const qualifierIndex = words.findIndex((w) => QUALIFIERS.includes(w));
  const qualifiers = group.map((g) => g.name.split(" ")[qualifierIndex]);
  const stem = [...words.slice(0, qualifierIndex), ...words.slice(qualifierIndex + 1)].join(" ");
  const list = qualifiers.slice(0, -1).join(", ") + " and " + qualifiers[qualifiers.length - 1];
  if (
    tryPush({
      query: `handle the ${list} variants of ${stem}`,
      expected: group[0].slug,
      expectedAll: group.map((g) => g.slug),
      difficulty: "hard",
      subtype: "multi",
    })
  ) {
    multiCount++;
  }
}

// 5% no-match (25) — capabilities the corpus cannot contain; verified to share
// no tokens with any skill's name/description.
const NO_MATCH_SEEDS = [
  "origami folding routine",
  "bonsai pruning schedule",
  "aquarium salinity cycling",
  "stargazing session planning",
  "pottery kiln firing",
  "beekeeping hive harvest",
  "knitting gauge swatch",
  "fencing footwork drills",
  "puppet stagecraft build",
  "calligraphy inking practice",
  "puzzle speed solving",
  "candle wick trimming",
  "campfire ember cooking",
  "skate sharpening ritual",
  "kite tuning checklist",
  "whittling grain reading",
  "tarot spread memorization",
  "surf break forecasting",
  "yarn dye batching",
  "pigeon racing loft",
  "cheese cave turning",
  "lock picking drills",
  "rainwater barrel plumbing",
  "fermentation crock weights",
  "glassblowing annealing cycle",
  "mosaic grouting cleanup",
  "seedling hardening schedule",
  "saddle fitting checks",
  "sail reefing procedure",
  "caving rope ladder",
  "origami crane folding",
  "bonsai wiring shaping",
  "aquarium planting trimming",
  "telescope collimation evening",
  "pottery glaze mixing",
  "apiary smoker lighting",
  "sewing pattern grading",
  "falconry lure swinging",
  "metallurgy crucible pouring",
  "cartography legend drafting",
  "homebrew bottling day",
  "rockhounding field pouch",
  "puzzle cryptic clues",
  "whistle repair bench",
  "taxidermy mount posing",
];
const corpusTokens = new Set();
// Validate against the fields the engine actually indexes (parsed record:
// name + summary + the 4-sentence body as description), not the raw template.
for (const doc of indexedDocs.values()) for (const t of doc) corpusTokens.add(t);
const noMatchQueries = [];
for (const seed of NO_MATCH_SEEDS) {
  if (noMatchQueries.length >= 25) break;
  if (token(seed).some((t) => corpusTokens.has(t))) continue;
  if (
    tryPush({
      query: withNoise(`find the ${seed} skill`, rand, 0.2, counters),
      expected: null,
      difficulty: "hard",
      subtype: "no-match",
    })
  ) {
    noMatchQueries.push(true);
  }
}
const noMatchCount = noMatchQueries.length;

// --- Invariants (review HIGH-1): every query text is unique and resolves to
// exactly one expected id (multi queries may additionally carry expectedAll;
// no-match uses expected null). tryPush already guarantees unique text; this
// final pass re-checks and fails generation on any violation.
const byQueryText = new Map();
for (const q of queries) {
  const key = q.query.trim().toLowerCase();
  const prev = byQueryText.get(key);
  if (prev !== undefined) {
    throw new Error(
      `duplicate query text: "${q.query}" (${q.subtype}, expected ${q.expected}) conflicts with ${prev}`,
    );
  }
  byQueryText.set(key, q.expected);
}

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
    bySubtype: queries.reduce((acc, q) => {
      acc[q.subtype] = (acc[q.subtype] ?? 0) + 1;
      return acc;
    }, {}),
    withTypos: counters.typo,
    withFragments: counters.fragment,
    noMatchFailed: 25 - noMatchCount,
  },
  generationMs: durationMs,
  totalBytes,
  skillsDir: SKILLS_DIR,
};
await writeFile(join(RESULTS_DIR, "gen-skills.json"), JSON.stringify(summary, null, 2), "utf8");
console.log(JSON.stringify(summary));
