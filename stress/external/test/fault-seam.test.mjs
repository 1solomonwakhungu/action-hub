/**
 * MIG2-R1.3 BEHAVIORAL seam regressions (intake/reviewer-1): one env hook
 * (STRESS_RUNTOOL_FAULT) poisons EVERY runTool verdict with green workload
 * evidence (code 0, parseable ok:true child summary) and a FAILED cleanup
 * (groupEmpty:false + killError). Each production runner is then executed
 * END TO END through its real main; only a correctly-placed, correctly-
 * ordered fold can make it red. Catches branch bugs (the --k6 smoke fold)
 * and order bugs (summary.ok snapshotted before the row fold) that source
 * counting cannot.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = resolve(new URL("..", import.meta.url).pathname);

// A REAL fixture once (no seam): sub-runners need a config path.
const tmp = mkdtempSync(join("/tmp", "fault-seam-"));
const gen = spawnSync(process.execPath, [join(dir, "make-fixture.mjs")], {
  encoding: "utf8", timeout: 120_000,
});
let configPath = null;
try {
  const genSummary = JSON.parse(gen.stdout.trim().split("\n").pop());
  configPath = join(genSummary.outDir, "servers.json");
} catch { /* covered by the assertions below */ }

after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const runSeamed = (script, args, timeoutMs = 240_000) => {
  const r = spawnSync(process.execPath, [join(dir, script), ...args], {
    env: { ...process.env, STRESS_RUNTOOL_FAULT: "1" },
    encoding: "utf8",
    timeout: timeoutMs,
  });
  const lines = String(r.stdout ?? "").split("\n").filter((l) => l.startsWith("{"));
  let last = null;
  try { last = JSON.parse(lines[lines.length - 1]); } catch { last = null; }
  return { code: r.status, last, stdoutTail: String(r.stdout ?? "").slice(-300), stderrTail: String(r.stderr ?? "").slice(-300) };
};

test("seam: run-external default goes red (green workload, failed cleanup)", () => {
  const r = runSeamed("run-external.mjs", []);
  assert.notEqual(r.code, 0, `must exit nonzero; stdout=${r.stdoutTail} stderr=${r.stderrTail}`);
  assert.equal(r.last?.ok, false, "the final summary must be ok:false");
});

test("seam: run-external --k6 goes red", () => {
  const r = runSeamed("run-external.mjs", ["--k6"]);
  assert.notEqual(r.code, 0);
  assert.equal(r.last?.ok, false);
});

test("seam: conformance goes red", () => {
  assert.ok(configPath, "fixture generation must have produced a config");
  const r = runSeamed("conformance.mjs", ["--config", configPath]);
  assert.notEqual(r.code, 0);
  assert.equal(r.last?.ok, false);
});

test("seam: fuzz goes red", () => {
  const r = runSeamed("fuzz.mjs", ["--config", configPath, "--runs", "2"]);
  assert.notEqual(r.code, 0);
  assert.equal(r.last?.ok, false);
});

test("seam: spec-test goes red", () => {
  const r = runSeamed("spec-test.mjs", ["--config", configPath]);
  assert.notEqual(r.code, 0);
  assert.equal(r.last?.ok, false);
});

test("seam: inspector-smoke goes red", () => {
  const r = runSeamed("inspector-smoke.mjs", ["--config", configPath]);
  assert.notEqual(r.code, 0);
  assert.equal(r.last?.ok, false);
});
