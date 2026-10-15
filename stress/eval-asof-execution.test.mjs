/**
 * stress/eval-asof-execution.test.mjs: tests for the fixture-backed as-of
 * execution eval (stress/eval-asof-execution.mjs) and its fixture server.
 *   - fixture invariants (pinned year, decoy argument shapes)
 *   - fixture server semantics (the as-of rule the eval relies on)
 *   - grader negatives: every check can fail (reformatted cutoff, lost
 *     source ID, zero / error / empty in place of no-data)
 *   - one end-to-end run over the real stdio transport, both engines
 * Run: npm run build && node --import ./test-isolation.mjs --test stress/eval-asof-execution.test.mjs
 * (part of root `npm test`). Offline: the only process spawned is the local
 * fixture server.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { validateArguments } from "../packages/core/dist/index.js";
import { answer, loadFixture } from "./asof-fixture-server.mjs";
import { distinctness, gradeRow, observedStatus, readOutcome, runEval } from "./eval-asof-execution.mjs";

const fixture = loadFixture();
const tool = (name) => fixture.tools.find((t) => t.name === name);
const row = (id) => fixture.rows.find((r) => r.id === id);
const GOLD = `${fixture.serverId}:${fixture.goldTool}`;
const goldLoaded = { inputSchema: tool(fixture.goldTool).inputSchema };
const textResult = (payload) => ({ ok: true, content: [{ type: "text", text: JSON.stringify(payload) }] });

// ---- fixture invariants ------------------------------------------------------

test("fixture pins its dates: year 2025, plus one 2024-12-31 pre-history cutoff", () => {
  assert.equal(fixture.year, 2025);
  const dates = [
    ...Object.values(fixture.entities).flatMap((e) => e.filings.map((f) => f.acceptedDate)),
    ...fixture.rows.map((r) => r.args.asOf),
  ];
  for (const d of dates) assert.ok(d.startsWith("2025-") || d === "2024-12-31", d);
  assert.equal(new Set(fixture.rows.map((r) => r.id)).size, fixture.rows.length, "row ids are unique");
});

test("the latest-value decoy rejects as-of arguments (a wrong pick fails loudly)", () => {
  const latest = tool("get_latest_revenue").inputSchema;
  for (const r of fixture.rows) {
    const v = validateArguments(latest, r.args);
    assert.equal(v.valid, false, r.id);
    assert.ok(v.errors.some((e) => e.includes("asOf")), v.errors.join("; "));
  }
});

test("the same-shape decoy accepts as-of arguments (a wrong pick would run silently)", () => {
  const netIncome = tool("get_net_income_as_of").inputSchema;
  for (const r of fixture.rows) assert.equal(validateArguments(netIncome, r.args).valid, true, r.id);
});

// ---- fixture server semantics ------------------------------------------------

test("fixture server: Jan 31 returns 100 from A; Feb 10 and later return 110 from B", () => {
  const at = (asOf) => answer(fixture, "get_revenue_as_of", { entity: "ACME", asOf }).payload;
  assert.deepEqual([at("2025-01-31").value, at("2025-01-31").sourceId], [100, "A-2025-01-10"]);
  assert.deepEqual([at("2025-01-10").value, at("2025-01-10").sourceId], [100, "A-2025-01-10"], "acceptance day is inclusive");
  assert.deepEqual([at("2025-02-10").value, at("2025-02-10").sourceId], [110, "B-2025-02-10"]);
  assert.deepEqual([at("2025-03-01").value, at("2025-03-01").sourceId], [110, "B-2025-02-10"]);
});

test("fixture server: a cutoff before any filing is explicit no_data, not zero", () => {
  const { isError, payload } = answer(fixture, "get_revenue_as_of", { entity: "ACME", asOf: "2025-01-09" });
  assert.equal(isError, false);
  assert.equal(payload.status, "no_data");
  assert.equal(payload.value, null);
  assert.equal(payload.sourceId, null);
  const zero = answer(fixture, "get_revenue_as_of", { entity: "ZEROCO", asOf: "2025-01-31" }).payload;
  assert.deepEqual([zero.status, zero.value, zero.sourceId], ["ok", 0, "Z-2025-01-05"]);
});

test("fixture server: an unknown entity is a tool error and echoes what it received", () => {
  const args = { entity: "NOSUCHCO", asOf: "2025-01-31" };
  const { isError, payload } = answer(fixture, "get_revenue_as_of", args);
  assert.equal(isError, true);
  assert.deepEqual(payload.received, args);
});

// ---- grader: each check can fail -----------------------------------------------

test("grader passes the correct Jan 31 answer", () => {
  const r = row("jan31-original");
  const outcome = readOutcome(textResult(answer(fixture, "get_revenue_as_of", r.args).payload));
  const g = gradeRow({ fixture, row: r, pick: GOLD, loaded: goldLoaded, outcome });
  assert.equal(g.pass, true, JSON.stringify(g.checks));
});

test("grader: a reformatted or dropped cutoff fails argument fidelity", () => {
  const r = row("jan31-original");
  for (const asOf of ["2025-01-31T00:00:00.000Z", "01/31/2025", undefined]) {
    const received = asOf === undefined ? { entity: "ACME" } : { entity: "ACME", asOf };
    const outcome = readOutcome(textResult({ ...answer(fixture, "get_revenue_as_of", r.args).payload, received }));
    const g = gradeRow({ fixture, row: r, pick: GOLD, loaded: goldLoaded, outcome });
    assert.equal(g.checks.argumentFidelity.pass, false, String(asOf));
    assert.equal(g.pass, false);
  }
});

test("grader: a lost source ID or a changed value fails result fidelity", () => {
  const r = row("jan31-original");
  const good = answer(fixture, "get_revenue_as_of", r.args).payload;
  for (const bad of [{ ...good, sourceId: undefined }, { ...good, sourceId: "B-2025-02-10" }, { ...good, value: "100" }, { ...good, value: 110 }]) {
    const g = gradeRow({ fixture, row: r, pick: GOLD, loaded: goldLoaded, outcome: readOutcome(textResult(bad)) });
    assert.equal(g.checks.resultFidelity.pass, false, JSON.stringify(bad));
  }
});

test("grader: zero, error, empty and unparseable results all fail the no-data row", () => {
  const r = row("jan09-before-any-filing");
  const good = answer(fixture, "get_revenue_as_of", r.args).payload;
  const candidates = {
    zero: textResult({ ...good, status: "ok", value: 0, sourceId: "A-2025-01-10" }),
    zeroNoStatus: textResult({ ...good, status: undefined, value: 0 }),
    error: { ok: false, error: `Downstream error: ${JSON.stringify({ status: "error", received: r.args })}` },
    empty: { ok: true, content: [] },
    unparseable: { ok: true, content: [{ type: "text", text: "no data" }] },
  };
  for (const [name, result] of Object.entries(candidates)) {
    const outcome = readOutcome(result);
    const g = gradeRow({ fixture, row: r, pick: GOLD, loaded: goldLoaded, outcome });
    assert.equal(g.pass, false, name);
    assert.equal(g.checks.noDataDistinct.pass, false, name);
  }
  const ok = gradeRow({ fixture, row: r, pick: GOLD, loaded: goldLoaded, outcome: readOutcome(textResult(good)) });
  assert.equal(ok.pass, true, JSON.stringify(ok.checks));
  assert.equal(observedStatus(readOutcome(candidates.empty)), "empty");
});

test("grader: a decoy pick fails selection and load", () => {
  const r = row("jan31-original");
  const g = gradeRow({
    fixture, row: r, pick: `${fixture.serverId}:get_latest_revenue`,
    loaded: { inputSchema: tool("get_latest_revenue").inputSchema },
    outcome: { kind: "error", message: "Invalid arguments: arguments.asOf: unexpected property", payload: null },
  });
  assert.equal(g.checks.selection.pass, false);
  assert.equal(g.checks.load.pass, false);
  assert.equal(g.checks.argumentFidelity.pass, false, "the call never reached the fixture");
});

test("distinctness fails when a no-data row looks like the zero control", () => {
  const fake = (id, status, value) => ({ id, status, checks: { resultFidelity: { observed: { value } } } });
  const rows = [fake("jan09-before-any-filing", "ok", 0), fake("zero-revenue-control", "ok", 0), fake("unknown-entity-error-control", "error", null)];
  assert.equal(distinctness(rows, fixture).pass, false);
  rows[0] = fake("jan09-before-any-filing", "no_data", null);
  assert.equal(distinctness(rows, fixture).pass, true);
});

// ---- end to end ----------------------------------------------------------------

test("end to end over the real stdio transport: every row passes on both engines and every grader control is caught", async () => {
  const summary = await runEval();
  for (const [engine, e] of Object.entries(summary.engines)) {
    const failing = e.rows.filter((r) => !r.pass).map((r) => `${r.id}: ${JSON.stringify(r.checks)}`);
    assert.deepEqual(failing, [], `${engine} failing rows`);
    assert.equal(e.rowsPassed, fixture.rows.length);
    assert.equal(e.distinctness.pass, true, engine);
  }
  assert.equal(summary.engines.blend.embedding.state, "warm", "blend engine must be graded on a warm embedding index");
  for (const c of summary.graderControls.cases) assert.equal(c.pass, true, `${c.name}: ${JSON.stringify(c)}`);
  assert.equal(summary.ok, true);
});
