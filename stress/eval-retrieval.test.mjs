/**
 * stress/eval-retrieval.test.mjs: regression tests for the r/mcp follow-up
 * items in stress/eval-retrieval.mjs:
 *   item 1: retrieval rank, abstention, and successful execution are three
 *           distinct metrics (abstention replay rule, execution probe
 *           classification, metric blocks, intended-argument rows)
 *   item 3: incompatible-argument near-duplicate twins in the synthetic
 *           catalog (a wrong pick between twins fails execution loudly; a
 *           wrong pick between same-shape rivals executes silently)
 * Run: npm run build && node --test stress/eval-retrieval.test.mjs
 * (Imports the eval module directly; the harness runner is argv-guarded, so
 * nothing runs at import. Needs packages/core/dist.)
 *
 * Every hub built here uses the eval's in-process fake clients: no external
 * server, process, or destructive tool is ever reached.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { validateArguments } from "../packages/core/dist/index.js";
import { __test } from "./eval-retrieval.mjs";

const {
  syntheticCatalog, selfQueries, TWIN_FAMILIES, twinNameFor, isTwinName, assertTwinsIncompatible,
  intendedArgs, abstentionDecision, classifyExecution, gateOutcome, executeProbe, buildEngine, warmAndTime, GATED_EXECUTION_OUTCOMES,
  scoreEngine, coreMetrics, abstentionMetrics, executionMetrics, validateGeneratedCorpus,
  parseAbstentionThreshold, percentileSelfTest, groupTools, EXECUTION_OUTCOMES, ABSTENTION_THRESHOLD_DEFAULT, OBJECTS,
} = __test;

// Two domains keep the hubs small; every test below is deterministic.
const { tools } = syntheticCatalog(2);
const manifests = groupTools(tools);
const byId = new Map(tools.map((t) => [`${t.serverId}:${t.name}`, t]));

// ---- item 3: incompatible-argument twins -------------------------------------

test("every archive/delete/export base tool has a same-server twin with an incompatible argument shape", () => {
  let pairs = 0;
  for (const t of tools) {
    const family = TWIN_FAMILIES.find((f) => t.name === `${f.baseVerb}_${t.name.split("_").slice(1).join("_")}` && !isTwinName(t.name));
    if (!family) continue;
    const object = t.name.slice(family.baseVerb.length + 1);
    const twin = byId.get(`${t.serverId}:${twinNameFor(family, object)}`);
    assert.ok(twin, `twin missing for ${t.serverId}:${t.name}`);
    pairs += 1;
    const baseArgs = intendedArgs(t.inputSchema);
    const twinArgs = intendedArgs(twin.inputSchema);
    assert.equal(validateArguments(t.inputSchema, baseArgs).valid, true, "base accepts its own args");
    assert.equal(validateArguments(twin.inputSchema, twinArgs).valid, true, "twin accepts its own args");
    assert.equal(validateArguments(twin.inputSchema, baseArgs).valid, false, `twin ${twin.name} must reject base-shaped args`);
    assert.equal(validateArguments(t.inputSchema, twinArgs).valid, false, `base ${t.name} must reject twin-shaped args`);
  }
  // 2 domains x every object x 3 families
  assert.equal(pairs, 2 * OBJECTS.length * 3);
  assert.equal(assertTwinsIncompatible(tools), pairs);
});

test("the twin check fails closed when a twin accepts base-shaped arguments", () => {
  const broken = tools.map((t) => (t.name === "archive_contacts_by_id" && t.serverId === "crm-main"
    ? { ...t, inputSchema: { type: "object", properties: { ids: { type: "array" } } } }
    : t));
  assert.throws(() => assertTwinsIncompatible(broken), /ACCEPTS base-shaped args/);
});

test("same-shape rivals stay argument-compatible (the silent-misfire class still exists)", () => {
  const archive = byId.get("crm-main:archive_contacts");
  const del = byId.get("crm-main:delete_contacts");
  const args = intendedArgs(archive.inputSchema);
  assert.equal(validateArguments(del.inputSchema, args).valid, true);
});

test("self-fixture near-duplicate rows include twin golds with explicit intended arguments", () => {
  const queries = selfQueries(tools, true);
  const twinRows = queries.filter((q) => typeof q.expected === "string" && isTwinName(q.expected.split(":")[1]));
  assert.ok(twinRows.length >= 6, `expected twin-gold rows, got ${twinRows.length}`);
  for (const q of twinRows) {
    assert.equal(q.subtype, "near-duplicate");
    assert.equal(q.difficulty, "hard");
    assert.ok(q.args && typeof q.args === "object", "twin rows carry intended args");
    const gold = byId.get(q.expected);
    assert.ok(gold, `gold ${q.expected} exists`);
    assert.equal(validateArguments(gold.inputSchema, q.args).valid, true, `args valid for ${q.expected}`);
    // The same-server base tool must REJECT the twin's intended arguments.
    const family = TWIN_FAMILIES.find((f) => gold.name.endsWith(f.suffix) && gold.name.startsWith(`${f.baseVerb}_`));
    const base = byId.get(`${gold.serverId}:${gold.name.slice(0, -family.suffix.length)}`);
    assert.equal(validateArguments(base.inputSchema, q.args).valid, false, `base ${base.name} rejects twin args`);
  }
  // Query strings stay unique and the rows pass the strict row-shape validator.
  assert.equal(new Set(queries.map((q) => q.query)).size, queries.length);
  validateGeneratedCorpus({ manifests: [], skills: [], queries, skillQueries: [], idMismatches: 0, expectCounts: false });
});

// ---- intended-argument builder ------------------------------------------------

test("intendedArgs is deterministic and schema-valid for every synthetic tool", () => {
  for (const t of tools) {
    const a = intendedArgs(t.inputSchema);
    const b = intendedArgs(t.inputSchema);
    assert.deepEqual(a, b);
    assert.equal(validateArguments(t.inputSchema, a).valid, true, `${t.name}: ${validateArguments(t.inputSchema, a).errors.join("; ")}`);
  }
});

test("intendedArgs honours enum, bounds, minItems, patterns and nested required keys", () => {
  const schema = {
    type: "object",
    required: ["mode", "count", "tags", "window"],
    properties: {
      mode: { type: "string", enum: ["fast", "slow"] },
      count: { type: "integer", minimum: 10, maximum: 20 },
      tags: { type: "array", items: { type: "string" }, minItems: 2 },
      when: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      window: { type: "object", required: ["from"], properties: { from: { type: "string" }, to: { type: "string" } }, additionalProperties: false },
    },
    additionalProperties: false,
  };
  const args = intendedArgs(schema);
  assert.equal(args.mode, "fast");
  assert.equal(args.count, 10);
  assert.equal(args.tags.length, 2);
  assert.equal(args.when, "2026-01-01");
  assert.equal(typeof args.window.from, "string");
  assert.equal(validateArguments(schema, args).valid, true);
});

// ---- item 1: abstention replay ------------------------------------------------

test("abstention replays the server rule: raw semantic first, fused score fallback, inclusive threshold", () => {
  assert.equal(abstentionDecision([], 0.8).abstained, true);
  assert.equal(abstentionDecision([], 0.8).basis, "none");
  assert.deepEqual(abstentionDecision([{ id: "a", score: 0.99, semantic: 0.5 }], 0.8), { abstained: true, confidence: 0.5, basis: "semantic" });
  assert.equal(abstentionDecision([{ id: "a", score: 0.1, semantic: 0.81 }], 0.8).abstained, false);
  assert.deepEqual(abstentionDecision([{ id: "a", score: 0.8 }], 0.8), { abstained: false, confidence: 0.8, basis: "score" });
  assert.equal(abstentionDecision([{ id: "a", score: 0.79 }], 0.8).abstained, true);
  assert.equal(abstentionDecision([{ id: "a", score: 0.79 }], 0).abstained, false, "threshold 0 never abstains on a hit");
});

test("--abstention-threshold parses a number in [0,1] and fails closed otherwise", () => {
  assert.equal(parseAbstentionThreshold(new Set([])), ABSTENTION_THRESHOLD_DEFAULT);
  assert.equal(parseAbstentionThreshold(new Set(["--abstention-threshold=0.65"])), 0.65);
  assert.equal(parseAbstentionThreshold(new Set(["--quick", "--abstention-threshold=0"])), 0);
  for (const bad of ["--abstention-threshold", "--abstention-threshold=", "--abstention-threshold=abc", "--abstention-threshold=1.5", "--abstention-threshold=-0.1"]) {
    assert.throws(() => parseAbstentionThreshold(new Set([bad])), /requires a number in \[0, 1\]/, bad);
  }
});

// ---- item 1: execution probe classification -----------------------------------

test("classifyExecution yields disjoint outcomes and success only for the gold; gateOutcome only adds abstained", () => {
  const ok = { ok: true };
  const invalid = { ok: false, error: "Invalid arguments: arguments.ids: required property is missing" };
  const skill = { ok: false, error: '"skill:x" is a skill and must be loaded, not executed' };
  assert.equal(classifyExecution({ gold: "g", pick: "g", result: ok, control: ok }).outcome, "success");
  assert.equal(classifyExecution({ gold: "g", pick: "w", result: ok, control: ok }).outcome, "wrongToolExecuted");
  const loud = classifyExecution({ gold: "g", pick: "w", result: invalid, control: ok });
  assert.equal(loud.outcome, "wrongToolRejected");
  assert.equal(loud.failureClass, "validation");
  assert.equal(classifyExecution({ gold: "g", pick: "skill:x", result: skill, control: ok }).failureClass, "skill");
  assert.equal(classifyExecution({ gold: "g", pick: "w", result: { ok: false, approval: { id: "t" } }, control: ok }).failureClass, "approval");
  assert.equal(classifyExecution({ gold: "g", pick: "g", result: invalid, control: ok }).outcome, "goldFailed");
  assert.equal(classifyExecution({ gold: "g", pick: null, result: null, control: ok }).outcome, "noResult");
  assert.equal(classifyExecution({ gold: "g", pick: "g", result: null, control: invalid }).outcome, "controlFailed");
  for (const o of ["success", "wrongToolExecuted", "wrongToolRejected", "goldFailed", "noResult", "controlFailed"]) {
    assert.ok(EXECUTION_OUTCOMES.includes(o));
    assert.ok(GATED_EXECUTION_OUTCOMES.includes(o));
    assert.equal(gateOutcome(o, false), o, "gate off keeps the unconditional outcome");
  }
  assert.ok(!EXECUTION_OUTCOMES.includes("abstained"));
  assert.ok(GATED_EXECUTION_OUTCOMES.includes("abstained"));
  assert.equal(gateOutcome("success", true), "abstained");
  assert.equal(gateOutcome("wrongToolExecuted", true), "abstained");
  assert.equal(gateOutcome("controlFailed", true), "controlFailed", "an unscored row stays unscored");
});

test("executeProbe runs the real hub path: gold succeeds, twin pick fails validation, rival pick executes silently", async () => {
  const { hub } = await buildEngine("keyword", manifests, []);
  try {
    const gold = "crm-main:archive_contacts";
    const twin = "crm-main:archive_contacts_by_id";
    const rival = "crm-main:delete_contacts";
    const success = await executeProbe(hub, { gold, pick: gold });
    assert.equal(success.outcome, "success");
    assert.deepEqual(Object.keys(success.args).sort(), ["filter", "limit"]);

    const loud = await executeProbe(hub, { gold, pick: twin });
    assert.equal(loud.outcome, "wrongToolRejected");
    assert.equal(loud.failureClass, "validation");
    assert.match(loud.error, /ids: required property is missing/);
    assert.match(loud.error, /filter: unexpected property/);

    const silent = await executeProbe(hub, { gold, pick: rival });
    assert.equal(silent.outcome, "wrongToolExecuted");

    // Mirror direction: twin gold with twin-shaped args, base picked.
    const mirror = await executeProbe(hub, { gold: twin, pick: gold, args: { ids: ["contacts-1"], reason: "stale" } });
    assert.equal(mirror.outcome, "wrongToolRejected");
    assert.equal(mirror.failureClass, "validation");

    // Empty search: nothing to execute.
    const none = await executeProbe(hub, { gold, pick: null });
    assert.equal(none.outcome, "noResult");

    // A skill pick cannot execute and is a loud failure.
    hub.replaceSkills([{ id: "skill:contact-hygiene", name: "Contact Hygiene", serverId: "skills", summary: "s", description: "d", tags: [] }]);
    const skillPick = await executeProbe(hub, { gold, pick: "skill:contact-hygiene" });
    assert.equal(skillPick.outcome, "wrongToolRejected");
    assert.equal(skillPick.failureClass, "skill");

    // The fake server never ran anything but acknowledgements: history is bounded and every
    // dispatched call was in-process.
    const history = hub.snapshot?.()?.history ?? [];
    for (const h of history) assert.ok(h.serverId.endsWith("-main") || h.serverId.endsWith("-mirror") || h.serverId === "skills");
  } finally {
    await hub.close();
  }
});

// ---- item 1: three distinct metric blocks -------------------------------------

test("warmAndTime rows carry abstention and execution; scoreEngine reports three independent blocks", async () => {
  const { hub } = await buildEngine("keyword", manifests, []);
  try {
    const queries = [
      // exact-name query: the exact-name invariant makes the gold top-1
      { query: "archive_contacts", expected: "crm-main:archive_contacts", difficulty: "exact", subtype: "exact" },
      { query: "archive these specific contacts by id in crm", expected: "crm-main:archive_contacts_by_id", difficulty: "hard", subtype: "near-duplicate", args: { ids: ["contacts-1"], reason: "stale" } },
      { query: "book a flight to Lisbon for two people next month", expected: null, difficulty: "hard", subtype: "no-match" },
    ];
    const { rows, latencies } = await warmAndTime(hub, queries, { abstentionThreshold: 0, execute: true });
    assert.equal(rows.length, 3);
    assert.equal(latencies.length, 3);
    for (const r of rows) {
      assert.equal(typeof r.abstained, "boolean");
      assert.equal(typeof r.confidence, "number");
    }
    assert.equal(rows[0].execution.outcome, "success", JSON.stringify(rows[0].execution));
    assert.ok(["success", "wrongToolRejected"].includes(rows[1].execution.outcome), "a wrong pick on the twin row must fail loudly");
    assert.equal(rows[2].execution, null, "no-match rows are not probed");

    const scored = scoreEngine(rows, latencies, { abstentionThreshold: 0 });
    // Existing metrics are preserved.
    for (const k of ["recallAt1", "recallAt5", "recallAt10", "mrrAt10", "ndcgAt10", "noMatch", "latency", "byDifficulty", "bySubtype", "byKind"]) {
      assert.ok(k in scored, `missing ${k}`);
    }
    // The three blocks are present and distinct.
    assert.equal(scored.abstention.threshold, 0);
    assert.equal(scored.abstention.falseAbstainRate, 0);
    assert.equal(scored.execution.probedCount, 2);
    assert.equal(scored.execution.scoredCount, 2);
    assert.equal(scored.execution.successCount + scored.execution.outcomes.wrongToolRejected + scored.execution.outcomes.wrongToolExecuted, 2);
    assert.ok(scored.bySubtype["near-duplicate"].execution, "by-subtype execution for near-duplicates");
    assert.equal(scored.bySubtype["no-match"].execution, undefined);

    // The keyword engine's fused score is unnormalized BM25 (reported in the
    // block's top1ConfidenceRange), so "strict" means above every observed
    // confidence: then everything abstains, rank is unchanged, the
    // UNCONDITIONAL execution numbers are unchanged too, and only the gated
    // view records abstained instead of executing. That is what makes the
    // three metrics independent.
    assert.ok(scored.abstention.top1ConfidenceRange.max > 1, "keyword fused scores are not on a [0,1] scale");
    assert.equal(scored.execution.gatedByAbstention.abstainedCount, 0);
    const strictThreshold = scored.abstention.top1ConfidenceRange.max + 1;
    const strict = await warmAndTime(hub, queries, { abstentionThreshold: strictThreshold, execute: true });
    const strictScored = scoreEngine(strict.rows, strict.latencies, { abstentionThreshold: strictThreshold });
    assert.equal(strictScored.recallAt1, scored.recallAt1, "retrieval rank is independent of abstention");
    assert.equal(strictScored.abstention.noMatchAbstainRate, 1);
    assert.equal(strictScored.abstention.falseAbstainRate, 1);
    assert.deepEqual(strictScored.execution.outcomes, scored.execution.outcomes, "unconditional execution is independent of abstention");
    assert.equal(strictScored.execution.successRate, scored.execution.successRate);
    assert.equal(strictScored.execution.gatedByAbstention.abstainedCount, 2);
    assert.equal(strictScored.execution.gatedByAbstention.outcomes.abstained, 2);
    assert.equal(strictScored.execution.gatedByAbstention.successRate, 0);
  } finally {
    await hub.close();
  }
});

test("abstentionMetrics and executionMetrics are pure over row shapes", () => {
  const matchedRow = (expected, abstained, outcome, failureClass) => ({
    expected, goldRanks: [1], firstGoldRank: 1, abstained, confidence: 0.5, confidenceBasis: "score",
    execution: { outcome, gatedOutcome: gateOutcome(outcome, abstained), ...(failureClass ? { failureClass } : {}) },
  });
  const rows = [
    matchedRow("a", false, "success"),
    matchedRow("b", false, "wrongToolExecuted"),
    matchedRow("c", false, "wrongToolRejected", "validation"),
    matchedRow("d", true, "success"),
    matchedRow("e", false, "controlFailed", "validation"),
    { expected: null, goldRanks: [], firstGoldRank: null, abstained: true, confidence: 0, confidenceBasis: "none" },
    { expected: null, goldRanks: [], firstGoldRank: null, abstained: false, confidence: 0.9, confidenceBasis: "score" },
  ];
  const a = abstentionMetrics(rows, 0.8);
  assert.equal(a.noMatchCount, 2);
  assert.equal(a.noMatchAbstainRate, 0.5);
  assert.equal(a.matchedCount, 5);
  assert.equal(a.falseAbstainRate, 0.2);
  assert.deepEqual(a.top1ConfidenceRange, { min: 0.5, max: 0.9, median: 0.5 });
  const e = executionMetrics(rows);
  assert.equal(e.probedCount, 5);
  assert.equal(e.scoredCount, 4, "controlFailed rows are excluded from the denominator");
  assert.equal(e.attemptedCount, 4);
  // Unconditional: two successes of four scored (row d abstains but still executed the gold).
  assert.equal(e.successRate, 0.5);
  assert.equal(e.wrongToolExecutedRate, 0.25);
  assert.equal(e.wrongToolRejectedRate, 0.25);
  assert.deepEqual(e.failureClasses, { validation: 2 });
  // Gated: row d becomes abstained, so one success of four.
  assert.equal(e.gatedByAbstention.abstainedCount, 1);
  assert.equal(e.gatedByAbstention.successRate, 0.25);
  assert.equal(e.gatedByAbstention.outcomes.success, 1);
  assert.equal(e.gatedByAbstention.outcomes.abstained, 1);
  // coreMetrics carries the same blocks for subsets.
  const core = coreMetrics(rows);
  assert.equal(core.execution.scoredCount, 4);
  assert.equal(core.execution.gatedByAbstention.abstainedCount, 1);
  assert.equal(core.abstention.falseAbstainRate, 0.2);
  // Rows without probe data: no execution block, recall intact.
  const bare = coreMetrics([{ expected: "a", goldRanks: [1], firstGoldRank: 1 }]);
  assert.equal(bare.execution, undefined);
  assert.equal(bare.recallAt1, 1);
});

test("validator accepts intended args only on single-gold tool rows", () => {
  const base = { manifests: [], skills: [], skillQueries: [], idMismatches: 0, expectCounts: false };
  validateGeneratedCorpus({ ...base, queries: [{ query: "q", expected: "s:t", subtype: "near-duplicate", difficulty: "hard", args: { ids: ["x"] } }] });
  assert.throws(() => validateGeneratedCorpus({ ...base, queries: [{ query: "q", expected: "s:t", subtype: "exact", difficulty: "exact", args: [] }] }), /plain object/);
  assert.throws(() => validateGeneratedCorpus({ ...base, queries: [{ query: "q", expected: null, subtype: "no-match", difficulty: "hard", args: {} }] }), /only allowed on single-gold tool rows/);
  assert.throws(() => validateGeneratedCorpus({ ...base, queries: [{ query: "q", expected: "skill:s", subtype: "exact", difficulty: "exact", args: {} }] }), /only allowed on single-gold tool rows/);
});

test("the in-file self-test still passes (percentile, validator, abstention, classification)", () => {
  assert.doesNotThrow(() => percentileSelfTest());
});
