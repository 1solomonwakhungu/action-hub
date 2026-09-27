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
import { existsSync, mkdtempSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { main, FatalError } from "./lib/harness.mjs";

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
    metric: "record completeness",
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
    metric: "first touch time",
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

const QUALIFIERS = ["Blue-Green", "Canary", "Rolling", "Shadow", "Warm", "Cold"];

// --- Slug derivation (must match core parseSkillContent exactly) ---------------
// id = "skill:" + name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function slugOf(name) {
  return `skill:${name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")}`;
}

// --- FX17: per-domain detail fragments -----------------------------------------
// Object-agnostic but domain-anchored operational details, so every skill
// description + instruction body carries real domain signal. Selection is
// keyed by hash32(name) — no rnd consumption, so names/ids stay stable.
const DOMAIN_DETAILS = {
  devops: ["canary the change before full cutover", "capture rollback triggers before touching production", "reconcile live state against the declared config"],
  finance: ["tie every entry to a ledger account before posting", "lock the period before reconciling balances", "keep a paper trail for each adjustment"],
  legal: ["log privilege calls before sharing the file", "version every redaction with its justification", "confirm jurisdiction and retention class first"],
  cooking: ["weigh ingredients before starting the prep", "hold the chain of custody for raw proteins", "plate only after the temperature check"],
  security: ["preserve the evidence chain before remediation", "scope the blast radius before rotating credentials", "baseline normal traffic before hunting anomalies"],
  data: ["profile the dataset before any transformation", "reconcile row counts after each load", "version every schema change with a rollback plan"],
  design: ["pin the design tokens before exploring variants", "test contrast and spacing on real content", "keep the component library as the single source of truth"],
  sales: ["log every touchpoint against the account record", "qualify the deal stage before projecting numbers", "confirm budget and timeline before the demo"],
  medicine: ["verify patient identity and allergies first", "document vitals before every intervention", "escalate abnormal readings immediately"],
  marketing: ["A/B test one variable at a time", "attribute results back to the campaign source", "watch frequency caps across channels"],
  support: ["reproduce the issue before escalating", "link every reply to the ticket thread", "watch the SLA clock while triaging"],
  education: ["set the objective before building the lesson", "check understanding before moving on", "keep the rubric visible to learners"],
};

// --- Generation ------------------------------------------------------------------
// Uniqueness comes from content, not serials: each skill index maps through a
// mixed-radix decode over the combinatorial banks (subject x object x qualifier
// x type = 6*6*6*4 = 864 combos per domain >= ceil(5000/12) = 417), so every
// name is unique while same-domain siblings still share most vocabulary — the
// deliberate near-duplicates.

// --- FX17: run body wrapped in the shared-lib finish path ---
// HYG2 (F46, rework per review): on ANY failure the run-owned skills dir is
// removed fail-closed (the dir is reconciled/wiped at startup, so a pre-write
// failure also clears any prior corpus this generator owns). The cleanup
// verdict is verified, never assumed: removedPartialSkillsDir is true only
// when rm succeeded AND the dir is verifiably absent; on rm failure the
// summary reports false + cleanupError and preserves the original error.
async function cleanupPartialSkillsDir(dir = SKILLS_DIR, rmImpl = rm) {
  try {
    await rmImpl(dir, { recursive: true, force: true });
  } catch (err) {
    return { removedPartialSkillsDir: false, cleanupError: String(err?.message ?? err) };
  }
  if (existsSync(dir)) {
    return { removedPartialSkillsDir: false, cleanupError: "skills dir still present after rm" };
  }
  return { removedPartialSkillsDir: true, cleanupError: null };
}

async function runSkills() {
  try {
    return await runSkillsInner();
  } catch (err) {
    const cleanup = await cleanupPartialSkillsDir();
    return {
      ok: false,
      error: String(err?.message ?? err),
      cleanup,
    };
  }
}

// HYG2 rework: Darwin-runnable regression for the cleanup failure branch.
// Fails loudly (exit 1) if the cleanup verdict ever turns green while the
// partial tree survives. --self-test-cleanup <dir>
async function selfTestCleanup(baseDir) {
  // The test owns a private parent dir so the read-only chmod in part 2
  // never touches a shared tmp root.
  const parent = baseDir
    ? join(baseDir, "selftest-" + Date.now())
    : mkdtempSync(join(tmpdir(), "hyg2-selftest-"));
  await mkdir(parent, { recursive: true });
  const targetDir = join(parent, "skills");
  const failures = [];
  let r2 = null; // set only if the E2E probe actually ran — no claimed
  let childSurvived = null; // evidence from a skipped probe
  let child = null;
  // 1. Unit: an rm implementation that rejects must yield removed:false +
  //    cleanupError, with the dir verifiably still present (sentinel intact).
  const sentinel = join(targetDir, "SKILL.md");
  await mkdir(targetDir, { recursive: true });
  await writeFile(sentinel, "sentinel", "utf8");
  const boom = new Error("forced rm failure");
  const r1 = await cleanupPartialSkillsDir(targetDir, async () => {
    throw boom;
  });
  if (r1.removedPartialSkillsDir !== false || !r1.cleanupError || !existsSync(sentinel)) {
    failures.push(`failing-rm verdict wrong: ${JSON.stringify({ ...r1, sentinelPresent: existsSync(sentinel) })}`);
  }
  // 2. End-to-end with a real refusal: read-only parent prevents rm of the
  //    child dir. Skipped when the platform has no getuid (Windows) or the
  //    process runs as root (chmod is moot) — the summary must then say
  //    skipped:true and claim NO survival evidence.
  const probeRan = e2eProbeEnabled();
  if (probeRan) {
    child = join(parent, "ro-child");
    await mkdir(child, { recursive: true });
    await writeFile(join(child, "SKILL.md"), "sentinel", "utf8");
    chmodSync(parent, 0o555);
    try {
      r2 = await cleanupPartialSkillsDir(child);
      childSurvived = existsSync(child);
      if (r2.removedPartialSkillsDir !== false || !childSurvived) {
        failures.push(`read-only-parent verdict wrong: ${JSON.stringify({ ...r2, childPresent: childSurvived })}`);
      }
    } finally {
      chmodSync(parent, 0o755);
      rmSync(child, { recursive: true, force: true });
    }
  }
  // 3. Regression for the skip branch itself (HYG2 rework 3): with no
  //    getuid (Windows-style) or a root-style uid 0, the probe decision must
  //    be "skip" — this check runs even when the probe above was skipped, so
  //    the branch is exercised through the same finish path on every platform.
  const savedGetuid = process.getuid;
  let noGetuidSkipped = false;
  let rootStyleSkipped = false;
  try {
    delete process.getuid;
    noGetuidSkipped = !e2eProbeEnabled();
    process.getuid = () => 0;
    rootStyleSkipped = !e2eProbeEnabled();
  } finally {
    if (savedGetuid === undefined) delete process.getuid;
    else process.getuid = savedGetuid;
  }
  if (!noGetuidSkipped) failures.push("no-getuid branch did not decide skip");
  if (!rootStyleSkipped) failures.push("root-style uid=0 branch did not decide skip");
  if (failures.length > 0) {
    throw new FatalError(`HYG2 cleanup self-test FAILED: ${failures.join(" | ")}`);
  }
  return {
    failingRm: { verdict: r1, sentinelSurvived: existsSync(sentinel) },
    readOnlyParent: probeRan
      ? { verdict: r2, childSurvived, skipped: false }
      : { verdict: null, childSurvived: null, skipped: true },
    skipBranchRegression: { noGetuidSkipped, rootStyleSkipped },
  };
}

// Whether the read-only-parent E2E probe can produce meaningful evidence on
// this platform: needs a getuid (not Windows) and a non-root uid (chmod 555
// is moot for root, who bypasses permission checks).
function e2eProbeEnabled() {
  return typeof process.getuid === "function" && process.getuid() !== 0;
}

async function runSkillsInner() {
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
    // FX17: description + instructions are built ONLY from the skill's own
    // subject/object/qualifier/type plus its domain's context, metric, tool,
    // and detail fragments — a random sibling object can no longer contradict
    // the name. Selection is hash32(name)-keyed, so names/ids stay stable.
    const objectLc = object.toLowerCase();
    const detail = DOMAIN_DETAILS[domain.name] ?? [];
    if (detail.length === 0) throw new Error(`FX17: no DOMAIN_DETAILS pool for domain "${domain.name}"`);
    const h = hash32(name);
    const d1 = detail[h % detail.length];
    const d2pool = detail.filter((d) => d !== d1);
    const d2 = d2pool.length ? d2pool[(h >>> 5) % d2pool.length] : d1;

    // One sentence, led by the type word, entity in plain words.
    const description = `${type} for ${qualifier.toLowerCase()} ${subject.toLowerCase()} ${objectLc} work in ${domain.context}: ${d1}; success is measured by ${domain.metric}.`
      .replace(/\s+/g, " ")
      .trim();

    // Exactly 4 sentences of instructions, every one about THIS skill's object.
    const s1 = `Prepare the ${qualifier.toLowerCase()} ${objectLc} in ${domain.context} and record the starting state.`;
    const s2 = `Use ${domain.tool} to execute each step and compare against the ${domain.metric}.`;
    const s3 = `${d2.charAt(0).toUpperCase()}${d2.slice(1)}.`;
    const s4 = `If any check fails, restart from step one and escalate before the next ${objectLc}.`;
    const instructions = [s1, s2, s3, s4].join(" ");

    skills.push({ name, slug, description, instructions, domain: domain.name, subject, object, qualifier, type });
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
  const indexedRecords = []; // parsed records, reused for the SearchEngine negative check
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
    indexedRecords.push(parsed);
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
    // FX13-R3: every generated row is synthetic regression data — the flag is
    // part of the row schema for BOTH generators (enforced by the file's
    // validate(); README documents the split from the realistic fixture).
    queries.push({ ...q, synthetic: true });
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

  // 20% paraphrase (100) — FX13 (F31): natural user phrasing built from the
  // domain's plain-English synonym tables. The old construction paraphrased
  // `goalOnlyQuery` (name deleted mid-sentence, leaving "for against" debris)
  // and appended the name's first word as an opaque token; both defects are
  // gone: the query is one grammatical question with no deletion and no append.
  const PARAPHRASE_OPENERS = [
    "How do I",
    "What's the right way to",
    "Can you show me how to",
    "I need to know how to",
    "Help me",
  ];
  const paraphraseCleanTexts = [];
  for (const s of take(400)) {
    if (queries.filter((q) => q.subtype === "paraphrase").length >= 100) break;
    const domain = DOMAINS.find((d) => d.name === s.domain);
    const [subject, object] = s.name.split(" ");
    const synOf = (word) => (domain.synonyms?.[word] ?? word).toLowerCase();
    const clean = `${pick(PARAPHRASE_OPENERS)} handle the ${synOf(object)} for our ${synOf(subject)} in ${domain.context}?`;
    paraphraseCleanTexts.push(clean);
    // Typo noise only: fragmentation would truncate the question into exactly
    // the function-word debris FX13 bans ("I need to", "How do I handle").
    let q = clean;
    if (rand() < 0.12) {
      counters.typo++;
      q = applyTypo(clean, rand);
    }
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
  // name + summary + the 4-sentence body as description, plus tags and the
  // serverId the runtime assigns skills), not the raw template.
  for (const doc of indexedDocs.values()) for (const t of doc) corpusTokens.add(t);
  for (const rec of indexedRecords) {
    if (rec.tags) for (const t of token(rec.tags.join(" "))) corpusTokens.add(t);
  }
  for (const t of token("skills custom")) corpusTokens.add(t); // runtime serverIds
  const noMatchCount = (() => {
    // Fixed, documented English stopword list (intake contract v2): content-token
    // overlap is evaluated after removing these from the FINAL emitted query.
    const STOPWORDS = new Set([
      "the", "a", "an", "of", "for", "to", "in", "on", "with", "and", "or",
      "how", "find", "my", "me", "i", "is", "what", "do",
    ]);
    const contentTokens = (q) => token(q).filter((t) => !STOPWORDS.has(t));
    let count = 0;
    for (const seed of NO_MATCH_SEEDS) {
      if (count >= 25) break;
      // Natural queries (intake decision): wrap with common English words, then
      // validate the FINAL emitted query — after stopword removal — for zero
      // content-token overlap with the actual indexed inputs. "skill" is NOT a
      // wrapper here: it is content in this corpus.
      let finalQuery = null;
      for (const head of ["find the", "locate the", ""]) {
        const candidate = withNoise(
          `${head ? head + " " : ""}${seed}`,
          rand,
          0.2,
          counters,
        );
        const tokens = contentTokens(candidate);
        if (tokens.some((t) => corpusTokens.has(t))) continue;
        finalQuery = candidate;
        break;
      }
      if (finalQuery === null) continue; // every wrapper variant overlaps: skip seed
      if (
        !tryPush({
          query: finalQuery,
          expected: null,
          difficulty: "hard",
          subtype: "no-match",
        })
      ) {
        continue;
      }
      count++;
    }
    return { count, STOPWORDS, contentTokens };
  })();
  const noMatchMeta = noMatchCount;
  const noMatchTotal = noMatchCount.count;

  // Final invariant over emitted no-match rows: after removing the documented
  // stopword list, every content token of every emitted query must be absent
  // from all indexed inputs (name, summary, description, tags, serverId).
  // SearchEngine hit counts are recorded for the evaluator (hits caused ONLY by
  // stopwords are a search defect to be measured, not a fixture defect) and a
  // non-stopword overlap fails generation.
  const searchEngineHitCounts = [];
  {
    const { Catalog } = await import(
      new URL("file://" + join(repoRoot, "packages/core/dist/catalog/catalog.js")).href
    );
    const { SearchEngine } = await import(
      new URL("file://" + join(repoRoot, "packages/core/dist/search/search.js")).href
    );
    const catalog = new Catalog();
    catalog.addAll(
      indexedRecords.map((rec) => ({
        id: rec.id,
        kind: "skill",
        serverId: "skills",
        name: rec.name,
        summary: rec.summary,
        description: rec.description,
        tags: rec.tags,
        trust: rec.trust ?? "trusted",
      })),
    );
    const engine = new SearchEngine(catalog);
    for (const row of queries.filter((q) => q.subtype === "no-match")) {
      const content = noMatchMeta.contentTokens(row.query);
      if (content.some((t) => corpusTokens.has(t))) {
        throw new Error(`no-match row has non-stopword content overlap: ${row.query}`);
      }
      searchEngineHitCounts.push({
        query: row.query,
        hits: (await engine.search(row.query)).length,
      });
    }
  }

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

  // --- FX13 query-quality self-check ------------------------------------------------
  // Lint the CLEAN paraphrase texts (before noise/typos) so the gate measures
  // generator phrasing, not injected noise. Zero lint hits is the gate.
  const SKILL_STOPWORDS = new Set([
    "how", "do", "i", "what", "the", "right", "way", "to", "help", "me", "need",
    "know", "can", "you", "show", "handle", "our", "for", "in", "and", "or", "a",
    "an", "of", "with", "on", "at", "is", "are", "s",
  ]);
  const skillVocab = new Set(SKILL_STOPWORDS);
  for (const d of DOMAINS) {
    for (const w of token(d.name)) skillVocab.add(w);
    for (const w of [
      ...d.subjects, ...d.objects, ...d.types, d.context, d.metric, d.tool,
      ...Object.keys(d.synonyms ?? {}), ...Object.values(d.synonyms ?? {}),
    ]) {
      for (const t of token(w)) skillVocab.add(t.toLowerCase());
    }
  }
  const skillLint = { debris: 0, doubleSpace: 0, malformed: 0, unknownVocab: 0, ambiguous: 0 };
  for (const clean of paraphraseCleanTexts) {
    // Debris = two consecutive PREPOSITIONS (the "for against" class left
    // by mid-sentence deletions). Article/verb pairs like "in the" or
    // "to know" are grammatical and must not count.
    if (/\b(?:for|against|with|of|to|in)\s+(?:for|against|with|of|to|in)\b/i.test(clean)) skillLint.debris += 1;
    if (/ {2,}/.test(clean)) skillLint.doubleSpace += 1;
    if (!/^[A-Z]/.test(clean) || !/\?$/.test(clean)) skillLint.malformed += 1;
    const unknown = token(clean).filter((t) => !skillVocab.has(t));
    if (unknown.length > 0) skillLint.unknownVocab += 1;
  }
  // Skill names are enforced unique at construction (usedNames), so a single
  // gold slug is never ambiguous by construction; assert it anyway.
  skillLint.ambiguous = skills.length - usedNames.size;

  // FX17 quality lint (same bar as PR 76 for tools):
  //  - coverage: every description contains >= 1 real DOMAIN_DETAILS fragment
  //  - consistency: description carries the skill's own type + object; NO
  //    other domain object appears anywhere in description + instructions
  //  - distinctness is reported (count of distinct descriptions)
  const domainByName = new Map(DOMAINS.map((d) => [d.name, d]));
  const descLint = { coverage: 0, ownObject: 0, ownType: 0, foreignObject: 0 };
  const foreignSamples = [];
  for (const skill of skills) {
    const d = domainByName.get(skill.domain);
    const text = `${skill.description} ${skill.instructions}`.toLowerCase();
    if (!(DOMAIN_DETAILS[skill.domain] ?? []).some((f) => skill.description.toLowerCase().includes(f.toLowerCase()))) descLint.coverage += 1;
    const parts = skill.name.split(" ");
    const objectLc = parts[1].toLowerCase();
    const typeLc = parts[3].toLowerCase();
    const ownObject = skill.object.toLowerCase();
    if (!skill.description.toLowerCase().includes(ownObject)) descLint.ownObject += 1;
    if (!skill.description.toLowerCase().includes(skill.type.toLowerCase())) descLint.ownType += 1;
    const foreign = d.objects.filter((o) => o.toLowerCase() !== ownObject && text.includes(o.toLowerCase()));
    if (foreign.length > 0) {
      descLint.foreignObject += 1;
      if (foreignSamples.length < 10) foreignSamples.push(`${skill.name} <- ${foreign.join(",")}`);
    }
  }
  const distinctDescriptions = new Set(skills.map((sk) => sk.description)).size;
  const descLintTotal = descLint.coverage + descLint.ownObject + descLint.ownType + descLint.foreignObject;
  const skillLintTotal = Object.values(skillLint).reduce((a, b) => a + b, 0);

  // 30 random paraphrase samples (deterministic pick from the emitted band).
  const emittedParaphrases = queries.filter((q) => q.subtype === "paraphrase");
  const sampleStride = Math.max(1, Math.floor(emittedParaphrases.length / 30));
  const paraphraseSamples = emittedParaphrases
    .filter((_, i) => i % sampleStride === 0)
    .slice(0, 30)
    .map((q) => q.query);
  console.log("--- FX13 skill paraphrase samples (30) ---");
  for (const sample of paraphraseSamples) console.log("  " + sample);
  console.log("--- FX13 skill lint counts (clean text, gate = all zero) ---");
  console.log(JSON.stringify(skillLint));
  if (skillLintTotal > 0 || descLintTotal > 0) {
    // Failure contract: remove the partial skills dir so no stale/partial
    // data survives, then hand a failure summary to the shared finish path
    // (ok is reserved and respected).
    await rm(SKILLS_DIR, { recursive: true, force: true });
    return {
      ok: false,
      error: `FX17 lint gate failed: skills ${JSON.stringify(skillLint)} descriptions ${JSON.stringify(descLint)}`,
      lint: { skills: skillLint, descriptions: descLint, distinctDescriptions, foreignSamples },
    };
  }
  await writeFile(
    join(RESULTS_DIR, "query-quality-skills.json"),
    JSON.stringify({ generatorVersion: 3, lint: skillLint, samples: paraphraseSamples }, null, 2),
    "utf8",
  );

  // --- Summary --------------------------------------------------------------------
  const durationMs = Date.now() - startedAt;
  // FX13-R3: every generated row must be marked synthetic (README documents
  // that both generated sets are synthetic regression data, so the claim is
  // enforced here, not just documented).
  const unflagged = queries.filter((q) => q.synthetic !== true).length;
  if (unflagged > 0) throw new Error(`FX13-R3: ${unflagged} generated skill rows missing synthetic:true`);

  const summary = {
    script: "gen-skills.mjs",
    generatorVersion: 3,
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
      noMatchFailed: 25 - noMatchTotal,
      noMatchInvariant:
        "after removing the documented stopword list (the,a,an,of,for,to,in,on,with,and,or,how,find,my,me,i,is,what,do) from the FINAL emitted query, zero content tokens overlap the actual indexed inputs (parsed record name, summary, description body, tags, serverId); SearchEngine hits caused only by stopwords are a search defect to be measured, not a fixture defect",
      noMatchSearchEngineHits: searchEngineHitCounts.reduce(
        (acc, x) => {
          acc.total += x.hits;
          acc.queriesWithHits += x.hits > 0 ? 1 : 0;
          return acc;
        },
        { total: 0, queriesWithHits: 0 },
      ),
    },
    generationMs: durationMs,
    totalBytes,
    skillsDir: SKILLS_DIR,
    queryQuality: { generatorVersion: 3, lint: skillLint, lintHits: skillLintTotal, sampleCount: paraphraseSamples.length },
    descriptionQuality: { lint: descLint, lintHits: descLintTotal, distinctDescriptions, sampleCount: 20 },
    syntheticRows: queries.length - unflagged,
    ok:
      skillLintTotal === 0 &&
      descLintTotal === 0 &&
      unflagged === 0 &&
      verifiedIds.size === skills.length &&
      mismatches === 0 &&
      claimedIds.size === skills.length &&
      usedQueryText.size === queries.length,
  };
  // 20-sample of name + description (FX17 paste requirement).
  summary.descriptionSamples = skills
    .filter((_, i) => i % Math.max(1, Math.floor(skills.length / 20)) === 0)
    .slice(0, 20)
    .map((sk) => `${sk.name}: ${sk.description}`);
  console.log("--- FX17 description samples (20) ---");
  for (const sample of summary.descriptionSamples) console.log("  " + sample);
  console.log("--- FX17 description lint (gate = all zero) ---");
  console.log(JSON.stringify({ ...descLint, distinctDescriptions }));
  // gen-skills.json is written by the shared finish path (resultsPath).
  return summary;
}

// --- FX17: shared-lib entry point ----------------------------------------------
// One finish path via stress/lib/harness.mjs main(): stale-result removal,
// reserved ok/error fields, guarded durable artifact write, exactly one
// compact JSON summary as the last stdout line, nonzero exit on failure.
// HYG2 rework: the cleanup self-test runs through the SAME finish path
// (compact JSON last line, durable artifact, exit derived from ok) — no
// process.exit() and no human-text last line.
if (args.includes("--self-test-cleanup")) {
  const selfTestRun = async () => {
    let tmpParent = null;
    try {
      const dirArg = args[args.indexOf("--self-test-cleanup") + 1];
      const target = dirArg ?? (tmpParent = mkdtempSync(join(tmpdir(), "hyg2-selftest-")));
      const checks = await selfTestCleanup(target);
      return { ok: true, mode: "self-test-cleanup", checks };
    } finally {
      if (tmpParent) {
        try { rmSync(tmpParent, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
  };
  await main(selfTestRun, { resultsPath: join(RESULTS_DIR, "gen-skills-selftest.json") });
} else {
  await main(runSkills, { resultsPath: join(RESULTS_DIR, "gen-skills.json") });
}
