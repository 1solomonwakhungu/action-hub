#!/usr/bin/env node
/**
 * stress/eval-asof-execution.mjs: fixture-backed execution eval for an
 * as-of (point-in-time) revenue request, end to end through the real
 * ActionHub search -> load -> execute path (r/mcp thread 1x2u6sb, comment
 * pgu7igi).
 *
 * Scenario (pinned to 2025; nothing reads the clock): filing A accepted
 * 2025-01-10 reports revenue 100; amendment B accepted 2025-02-10 reports
 * 110. As of 2025-01-31 the answer is 100 with A's ID; on or after
 * 2025-02-10 it is 110 with B's ID; before 2025-01-10 it is an explicit
 * no-data result, never zero. A control company genuinely reports revenue 0,
 * and an unknown company is a tool error, so the three can be told apart.
 *
 * Scope: Action Hub is a router, not a finance parser. The as-of logic lives
 * in the deterministic fixture server (stress/asof-fixture-server.mjs, a
 * real stdio MCP server spawned through the CLI's SDK client factory, the
 * same adapter the shipped CLI uses). No live data is read or graded. Per
 * row, the eval grades only Action Hub's part of the path:
 *   1. selection          the natural-language query's top-1 search hit is
 *                         the as-of tool, not a decoy (get_latest_revenue
 *                         takes no cutoff and has an incompatible shape, so
 *                         a wrong pick fails loudly; get_net_income_as_of has
 *                         the same shape, so a wrong pick would run silently
 *                         and is caught by result fidelity instead)
 *   2. load               load() of the pick exposes a schema that accepts
 *                         every argument the row carries
 *   3. argument fidelity  the arguments the fixture server received (echoed
 *                         back under `received`) deep-equal the arguments
 *                         given to execute(); the cutoff string is unchanged
 *   4. result fidelity    status, value and source filing ID come back
 *                         exactly as the fixture produced them
 *   5. no-data distinct   a pre-history cutoff yields ok:true with status
 *                         no_data and value null: not 0, not an error, not
 *                         an empty or unparseable result
 * The arguments per row are fixed in the fixture (the eval does not grade an
 * LLM's argument extraction). Engines: keyword (pure BM25) and the shipped
 * default blend with the vendored embedding index awaited warm.
 *
 * Selection probes (NOT gated): extra phrasings from review are searched and
 * their top-1 reported per engine, so the known misfire class stays visible.
 *
 * Grader controls: the same grader is run against deliberate misfires (each
 * decoy executed with the rows' arguments, or with arguments it accepts) and
 * must FAIL every one, so a passing row cannot come from a vacuous check.
 *
 * Offline and deterministic: vendored embedding model, no network, no API
 * keys. Output: JSON summary as the LAST stdout line, also written to
 * stress/.generated/results/eval-asof-execution.json.
 * Unit tests: stress/eval-asof-execution.test.mjs (part of root npm test).
 */

import { isDeepStrictEqual } from "node:util";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ActionHub } from "../packages/core/dist/index.js";
import { createSdkClientFactory } from "../packages/cli/dist/client-factory.js";
import { DEFAULT_FIXTURE, loadFixture } from "./asof-fixture-server.mjs";
import { createSandbox, assertIsolated, main as harnessMain } from "./lib/harness.mjs";

const STRESS_DIR = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(STRESS_DIR, "..");
const SERVER_SCRIPT = join(STRESS_DIR, "asof-fixture-server.mjs");
const RESULTS_PATH = join(STRESS_DIR, ".generated", "results", "eval-asof-execution.json");

export const ENGINES = {
  keyword: { semanticScorer: null, warm: false, desc: "pure BM25 (semanticScorer: null)" },
  blend: { semanticScorer: undefined, warm: true, desc: "shipped default blend, vendored embedding index awaited warm" },
};

export async function buildHub(engine, fixture, fixturePath = DEFAULT_FIXTURE) {
  const spec = ENGINES[engine];
  if (!spec) throw new Error(`unknown engine "${engine}"`);
  const hub = new ActionHub({
    servers: [{
      id: fixture.serverId,
      transport: { type: "stdio", command: process.execPath, args: [SERVER_SCRIPT, "--fixture", fixturePath] },
      trust: "trusted",
    }],
    bundles: [],
    clientFactory: createSdkClientFactory(),
    semanticScorer: spec.semanticScorer,
  });
  try {
    const [indexed] = await hub.indexAll();
    const tools = hub.serverStates().find((s) => s.id === fixture.serverId)?.toolCount;
    if (tools !== fixture.tools.length) {
      throw new Error(`fixture server indexed ${tools ?? 0} tool(s), expected ${fixture.tools.length} (${JSON.stringify(indexed)})`);
    }
    if (spec.warm) await hub.semanticReady();
  } catch (err) {
    await hub.close().catch(() => {});
    throw err;
  }
  const embeddedDocs = hub.embeddedDocs ?? 0;
  const embedding = { state: spec.semanticScorer === null ? "n/a" : embeddedDocs > 0 ? "warm" : "cold", embeddedDocs };
  return { hub, embedding };
}

/** Text of an MCP content array (what the SDK adapters return), or null. */
function contentText(content) {
  if (!Array.isArray(content)) return null;
  return content.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Normalizes an ExecuteResult into what an agent would see:
 *   kind "payload"      ok:true with a JSON object payload
 *   kind "empty"        ok:true with no text content
 *   kind "unparseable"  ok:true with text that is not a JSON object
 *   kind "error"        ok:false; `payload` is the fixture's error JSON when
 *                       the message carries it intact
 */
export function readOutcome(result) {
  if (!result.ok) {
    const message = String(result.error ?? "");
    const start = message.indexOf("{");
    const payload = start === -1 ? undefined : parseJson(message.slice(start));
    return { kind: "error", message, payload: payload && typeof payload === "object" ? payload : null };
  }
  const text = contentText(result.content);
  if (text === null || text.trim() === "") return { kind: "empty" };
  const payload = parseJson(text);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { kind: "unparseable", text: text.slice(0, 200) };
  return { kind: "payload", payload };
}

/** Status an agent would act on: the payload's own status, or the outcome kind. */
export function observedStatus(outcome) {
  if (outcome.kind === "payload") return typeof outcome.payload.status === "string" ? outcome.payload.status : "missing-status";
  return outcome.kind;
}

/**
 * Grades one executed row. Pure: `pick` and `loaded` describe what search and
 * load returned, `outcome` is readOutcome(execute result). Returns the five
 * checks; a check that does not apply to the row is null.
 */
export function gradeRow({ fixture, row, pick, loaded, outcome }) {
  const gold = `${fixture.serverId}:${fixture.goldTool}`;
  const expect = row.expect;
  const status = observedStatus(outcome);
  const payload = outcome.kind === "payload" ? outcome.payload : outcome.kind === "error" ? outcome.payload : null;

  const selection = { pass: pick === gold, pick };

  const props = loaded?.inputSchema?.properties ?? {};
  const required = loaded?.inputSchema?.required ?? [];
  const missing = Object.keys(row.args).filter((k) => !(k in props));
  const load = {
    pass: loaded !== null && missing.length === 0 && required.includes("asOf"),
    ...(missing.length ? { unknownArgs: missing } : {}),
    ...(loaded && !required.includes("asOf") ? { note: "loaded schema does not require an as-of cutoff" } : {}),
  };

  const received = payload && typeof payload === "object" ? payload.received : undefined;
  const argumentFidelity = received === undefined
    ? { pass: false, note: "upstream echo not observable (call never reached the fixture or the result lost it)" }
    : { pass: isDeepStrictEqual(received, row.args), sentAsOf: row.args.asOf, receivedAsOf: received.asOf };

  let resultFidelity;
  if (expect.status === "ok") {
    resultFidelity = {
      pass: status === "ok" && payload.metric === "revenue" && payload.value === expect.value && payload.sourceId === expect.sourceId,
      expected: { status: "ok", value: expect.value, sourceId: expect.sourceId },
      observed: { status, metric: payload?.metric, value: payload?.value, sourceId: payload?.sourceId },
    };
  } else if (expect.status === "no_data") {
    resultFidelity = {
      pass: status === "no_data" && payload.metric === "revenue" && payload.value === null && payload.sourceId === null,
      expected: { status: "no_data", value: null, sourceId: null },
      observed: { status, metric: payload?.metric, value: payload?.value, sourceId: payload?.sourceId },
    };
  } else {
    resultFidelity = {
      pass: outcome.kind === "error" && payload?.status === "error",
      expected: { status: "error" },
      observed: { status, ...(outcome.kind === "error" ? { message: outcome.message.slice(0, 160) } : {}) },
    };
  }

  const noDataDistinct = expect.status === "no_data"
    ? {
      pass: outcome.kind === "payload" && status === "no_data" && payload.value === null,
      notZero: payload?.value !== 0,
      notError: outcome.kind !== "error",
      notEmpty: outcome.kind !== "empty" && outcome.kind !== "unparseable",
    }
    : null;

  const checks = { selection, load, argumentFidelity, resultFidelity, noDataDistinct };
  const pass = Object.values(checks).every((c) => c === null || c.pass);
  return { pass, status, checks };
}

/** search -> load -> execute for one row, then grade. Execution is unconditional of selection. */
export async function runRow(hub, fixture, row) {
  const hits = await hub.search(row.query, { limit: 5 });
  const pick = hits[0]?.id ?? null;
  let loaded = null;
  let outcome = { kind: "error", message: "no search result; nothing executed", payload: null };
  if (pick !== null) {
    loaded = hub.load(pick);
    // execute gets a copy: grading compares the upstream echo against the
    // untouched fixture args, so an in-place rewrite by the hub is visible.
    outcome = readOutcome(await hub.execute(pick, structuredClone(row.args), { noCache: true }));
  }
  const graded = gradeRow({ fixture, row, pick, loaded, outcome });
  const misfire = pick !== null && !graded.checks.selection.pass
    ? (outcome.kind === "error" ? "loud" : "silent")
    : null;
  return { id: row.id, query: row.query, args: row.args, ranked: hits.map((h) => h.id), ...graded, ...(misfire ? { misfire } : {}) };
}

/**
 * Cross-row distinctness: what an agent sees for no-data cutoffs must differ
 * from the genuine-zero control and from the tool-error control.
 */
export function distinctness(rows, fixture) {
  const sig = (r) => ({ status: r.status, value: r.checks.resultFidelity.observed?.value ?? null });
  const byStatus = (s) => rows.filter((r) => fixture.rows.find((f) => f.id === r.id)?.expect.status === s);
  const noData = byStatus("no_data").map(sig);
  const zero = rows.filter((r) => fixture.rows.find((f) => f.id === r.id)?.expect.value === 0).map(sig);
  const error = byStatus("error").map(sig);
  const key = (s) => JSON.stringify(s);
  const pass = noData.length > 0 && zero.length > 0 && error.length > 0 &&
    noData.every((n) => zero.every((z) => key(n) !== key(z)) && error.every((e) => key(n) !== key(e)));
  return { pass, noData, zero, error };
}

/**
 * Grader controls: deliberate misfires through the same real path. Each must
 * be FAILED by gradeRow, proving the row checks are not vacuous.
 */
export async function graderControls(hub, fixture) {
  const row = fixture.rows.find((r) => r.id === "jan31-original");
  const id = (name) => `${fixture.serverId}:${name}`;
  const cases = [
    { name: "latest-tool-with-asof-args", pick: id("get_latest_revenue"), args: row.args, expectKind: "error" },
    { name: "latest-tool-with-accepted-args", pick: id("get_latest_revenue"), args: { entity: row.args.entity }, expectKind: "payload" },
    { name: "same-shape-wrong-metric", pick: id("get_net_income_as_of"), args: row.args, expectKind: "payload" },
  ];
  const out = [];
  for (const c of cases) {
    const loaded = hub.load(c.pick);
    const outcome = readOutcome(await hub.execute(c.pick, structuredClone(c.args), { noCache: true }));
    // Graded against the jan31 row: the misfire answers a different question.
    const graded = gradeRow({ fixture, row: { ...row, args: c.args }, pick: c.pick, loaded, outcome });
    const failedChecks = Object.entries(graded.checks).filter(([, v]) => v && !v.pass).map(([k]) => k);
    // A selection failure alone proves nothing (the pick is wrong by
    // construction); a downstream check must reject the misfire on its own.
    const caughtDownstream = failedChecks.some((k) => k !== "selection");
    out.push({
      name: c.name,
      pick: c.pick,
      outcomeKind: outcome.kind,
      observed: graded.checks.resultFidelity.observed,
      graderRejected: !graded.pass,
      failedChecks,
      caughtDownstream,
      pass: caughtDownstream && outcome.kind === c.expectKind,
    });
  }
  return out;
}

/**
 * Non-gated selection probes: search only, top-1 per phrasing. Reported so
 * the known misfire class (revenue synonyms losing to the same-shape
 * net-income tool) stays reproducible; never feeds `pass`.
 */
export async function selectionProbes(hub, fixture) {
  const gold = `${fixture.serverId}:${fixture.goldTool}`;
  const items = [];
  for (const p of fixture.selectionProbes ?? []) {
    const top1 = (await hub.search(p.query, { limit: 1 }))[0]?.id ?? null;
    items.push({ id: p.id, query: p.query, top1, gold: top1 === gold });
  }
  return { gated: false, pickedGold: items.filter((i) => i.gold).length, of: items.length, items };
}

export async function runEval({ fixturePath = DEFAULT_FIXTURE, engines = Object.keys(ENGINES) } = {}) {
  const fixture = loadFixture(fixturePath);
  const engineResults = {};
  let controls = null;
  for (const engine of engines) {
    const { hub, embedding } = await buildHub(engine, fixture, fixturePath);
    try {
      const rows = [];
      for (const row of fixture.rows) rows.push(await runRow(hub, fixture, row));
      const checkNames = ["selection", "load", "argumentFidelity", "resultFidelity", "noDataDistinct"];
      const perCheck = Object.fromEntries(checkNames.map((k) => {
        const applicable = rows.filter((r) => r.checks[k] !== null);
        return [k, { passed: applicable.filter((r) => r.checks[k].pass).length, of: applicable.length }];
      }));
      const dist = distinctness(rows, fixture);
      engineResults[engine] = {
        desc: ENGINES[engine].desc,
        embedding,
        rowsPassed: rows.filter((r) => r.pass).length,
        rowsTotal: rows.length,
        perCheck,
        distinctness: dist,
        pass: rows.every((r) => r.pass) && dist.pass,
        rows,
        selectionProbes: await selectionProbes(hub, fixture),
      };
      if (controls === null) controls = await graderControls(hub, fixture);
    } finally {
      await hub.close();
    }
  }
  const controlsPass = controls !== null && controls.every((c) => c.pass);
  return {
    script: "eval-asof-execution",
    fixture: { path: relative(REPO_ROOT, fixturePath), year: fixture.year, asOfRule: fixture.asOfRule, gold: `${fixture.serverId}:${fixture.goldTool}`, rows: fixture.rows.length },
    graded: "Action Hub routing only: selection, load, argument fidelity, result fidelity, no-data distinctness",
    notGraded: "finance parsing, as-of computation (owned by the fixture server), live upstream data, LLM argument extraction, approval gate (fixture server is trusted), result cache (noCache: true)",
    engines: engineResults,
    graderControls: { pass: controlsPass, cases: controls },
    ok: Object.values(engineResults).every((e) => e.pass) && controlsPass,
  };
}

/** One line per row per engine, for humans; the JSON summary stays the last stdout line. */
export function formatTable(summary) {
  const lines = [];
  const mark = (c) => (c === null ? "  -  " : c.pass ? "pass " : "FAIL ");
  for (const [engine, e] of Object.entries(summary.engines)) {
    lines.push(`[${engine}] ${e.desc}; embedding ${e.embedding.state} (${e.embedding.embeddedDocs} docs); rows ${e.rowsPassed}/${e.rowsTotal}; distinctness ${e.distinctness.pass ? "pass" : "FAIL"}`);
    lines.push("  row                           sel   load  args  result nodata status");
    for (const r of e.rows) {
      const c = r.checks;
      lines.push(`  ${r.id.padEnd(30)}${mark(c.selection)} ${mark(c.load)} ${mark(c.argumentFidelity)} ${mark(c.resultFidelity)}  ${mark(c.noDataDistinct)} ${r.status}${r.misfire ? ` (misfire: ${r.misfire}, pick ${r.checks.selection.pick})` : ""}`);
    }
    const sp = e.selectionProbes;
    lines.push(`  selection probes (NOT gated): ${sp.pickedGold}/${sp.of} pick the gold`);
    for (const p of sp.items) lines.push(`    ${p.id.padEnd(28)}${p.gold ? "gold   " : "MISS   "}${p.top1 ?? "(no result)"}`);
  }
  lines.push(`[grader controls] ${summary.graderControls.pass ? "pass" : "FAIL"}: ${summary.graderControls.cases.map((c) => `${c.name} ${c.graderRejected ? "rejected" : "ACCEPTED"} (${c.failedChecks.join(",") || "none"})`).join("; ")}`);
  lines.push(`[eval-asof-execution] ok=${summary.ok}`);
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  harnessMain(async () => {
    const sandbox = createSandbox({ prefix: "action-hub-asof-eval-" });
    Object.assign(process.env, sandbox.env);
    assertIsolated(process.env, sandbox.root);
    const summary = await runEval();
    console.log(formatTable(summary));
    return summary;
  }, { resultsPath: RESULTS_PATH });
}
