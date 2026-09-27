/**
 * MIG2-R1 fault regressions (reviewer-1): a successful workload with FAILED
 * cleanup can never pass. Covers the load-bearing fold (foldCleanupVerdict)
 * and runTool's honest verdict mapping, including an END-TO-END fault: a
 * workload that exits 0 while the injected taskkill runner fails — the
 * exitP verdict must say groupEmpty:false and the fold must flip ok.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTool, foldCleanupVerdict } from "../serve.mjs";
import { killGroupAndVerify, registeredHandleFor } from "../../lib/harness.mjs";

test("foldCleanupVerdict: healthy group keeps ok", () => {
  const summary = { ok: true };
  foldCleanupVerdict(summary, { groupEmpty: true, survivors: [] }, "serve");
  assert.equal(summary.ok, true);
  assert.equal("cleanupFailures" in summary, false);
});

test("foldCleanupVerdict: groupEmpty false with EMPTY survivors fails (repro shape)", () => {
  // The reviewer's exact repro: code 0, groupEmpty:false, survivors:[] —
  // folding on survivors alone would be a false green; groupEmpty is the gate.
  const summary = { ok: true };
  foldCleanupVerdict(summary, { groupEmpty: false, survivors: [] }, "serve");
  assert.equal(summary.ok, false);
  assert.match(summary.cleanupFailures[0].problems[0], /groupEmpty !== true/);
});

test("foldCleanupVerdict: killError fails", () => {
  const summary = { ok: true };
  foldCleanupVerdict(summary, { groupEmpty: true, survivors: [], killError: "injected kill failure" }, "serve");
  assert.equal(summary.ok, false);
  assert.match(summary.cleanupFailures[0].problems[0], /killError/);
});

test("foldCleanupVerdict: survivors fail", () => {
  const summary = { ok: true };
  foldCleanupVerdict(summary, { groupEmpty: true, survivors: [4242] }, "serve");
  assert.equal(summary.ok, false);
  assert.match(summary.cleanupFailures[0].problems[0], /4242/);
});

test("foldCleanupVerdict: verdict error fails", () => {
  const summary = { ok: true };
  foldCleanupVerdict(summary, { groupEmpty: true, survivors: [], error: "fail closed: anchor not provably alive" }, "serve");
  assert.equal(summary.ok, false);
  assert.match(summary.cleanupFailures[0].problems[0], /fail closed/);
});

test("END-TO-END fault: successful workload + failed cleanup cannot pass", async () => {
  // Real runStep: the workload exits 0 cleanly; the injected taskkill runner
  // (win32 seam) fails the teardown -> the verdict must be groupEmpty:false
  // with the error surfaced, and the fold must flip ok. This is the exact
  // "green workload, broken cleanup" shape the migration must make
  // load-bearing.
  const res = await runTool(process.execPath, ["-e", "process.exit(0)"], {
    timeoutMs: 60_000,
    win32: "win32",
    taskkillRunner: () => ({ ok: false, status: 1, error: "injected taskkill failure" }),
  });
  const r = await res.exitP;
  assert.equal(r.code, 0, "the workload itself exited cleanly");
  assert.equal(r.timedOut, false);
  assert.notEqual(r.groupEmpty, true, "a failed teardown must NOT report groupEmpty:true");
  assert.ok(r.killError || (r.error && String(r.error).length > 0), "the kill/error evidence must ride on the verdict");
  const summary = { ok: r.code === 0 && !r.timedOut && !r.spawnError };
  assert.equal(summary.ok, true, "precondition: the row would be green on workload evidence alone");
  foldCleanupVerdict(summary, r, "step");
  assert.equal(summary.ok, false, "the fold must fail the row despite the green workload");
  // The contract keeps the non-green handle reappable: finish the cleanup
  // through the authoritative handle so the live anchor dissolves and the
  // test process can drain.
  const handle = registeredHandleFor(r.pgid);
  assert.ok(handle, "the failed-verdict handle must still be registered (non-terminal)");
  const retry = await killGroupAndVerify(handle);
  assert.equal(retry.groupEmpty, true, "the retry teardown must verify empty");
});

test("END-TO-END: anchor killed mid-flight -> fail-closed verdict -> fold fails the row", async () => {
  // The reviewer's repro shape: a live group whose anchor is SIGKILLed
  // during cleanup must yield groupEmpty:false with the fail-closed error
  // (zero signals at a possibly-recycled pgid), the workload pid survives
  // (the test owns and kills it), and the fold must flip the row's ok.
  const { spawnGroup, killGroupAndVerify } = await import("../../lib/harness.mjs");
  const handle = await spawnGroup(process.execPath, ["-e", "setInterval(() => {}, 500)"]);
  try {
    await new Promise((r) => setTimeout(r, 400)); // workload + anchor up
    process.kill(handle.pgid, "SIGKILL"); // kill the live anchor mid-flight
    // Determinism: wait until the anchor is actually gone before the
    // teardown, so the fail-closed gate cannot race a not-yet-delivered
    // SIGKILL (which would legitimately TERM the live group instead).
    for (let i = 0; i < 40; i++) {
      try { process.kill(handle.pgid, 0); await new Promise((r) => setTimeout(r, 50)); }
      catch { break; } // anchor confirmed dead
    }
    try { process.kill(handle.pgid, 0); assert.fail("anchor must be dead before the teardown"); } catch { /* confirmed */ }
    const verdict = await killGroupAndVerify(handle);
    assert.equal(verdict.groupEmpty, false, "a dead anchor must fail closed");
    assert.match(String(verdict.error ?? ""), /fail closed/, "the fail-closed error must be named");
    // The workload survived the anchor's death (repro): the owner kills it.
    process.kill(handle.pid, "SIGKILL");
    const summary = { ok: true };
    foldCleanupVerdict(summary, verdict, "serve");
    assert.equal(summary.ok, false, "the fold must fail the row on the fail-closed verdict");
  } finally {
    try { process.kill(handle.pid, "SIGKILL"); } catch { /* already gone */ }
    // The fail-closed path leaves the dead group's stdio pipes open (the
    // healthy path dissolves via the control channel); the test owns its
    // group's fds, so destroy them to let the loop drain.
    for (const s of [handle.stdin, handle.stdout, handle.stderr, handle.anchor?.stdio?.[3]]) {
      try { s?.destroy?.(); } catch { /* already closed */ }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
});

test("CALLER-LEVEL: every production runTool call site folds its verdict", async () => {
  // Reviewer MIG2-R1: runTool returning honest verdicts is not enough — the
  // PRODUCTION runners must fold them. This regression reads the runner
  // sources and requires every runTool call site to be matched by a
  // foldCleanupVerdict call (removing a fold makes this red).
  const { readFile } = await import("node:fs/promises");
  const dir = new URL("../", import.meta.url).pathname;
  const counts = [];
  for (const f of ["run-external.mjs", "conformance.mjs", "fuzz.mjs", "inspector-smoke.mjs", "spec-test.mjs"]) {
    const src = await readFile(dir + f, "utf8");
    const calls = (src.match(/runTool\(/g) ?? []).length;
    const folds = (src.match(/foldCleanupVerdict\(/g) ?? []).length;
    counts.push(`${f}: runTool=${calls} folds=${folds}`);
    assert.ok(folds >= calls, `${f} must fold every runTool verdict (runTool=${calls}, folds=${folds})`);
  }
});

test("CALLER-LEVEL: aggregateRuns fails a row with cleanup failures", async () => {
  const { aggregateRuns } = await import("../verdict.mjs");
  const ok = aggregateRuns([{ label: "clean", requiresSummary: true, exitCode: 0, summary: { ok: true } }]);
  assert.equal(ok.ok, true);
  const bad = aggregateRuns([{
    label: "green-workload-broken-cleanup",
    requiresSummary: true,
    exitCode: 0,
    summary: { ok: true },
    cleanupFailures: [{ label: "k6", problems: ["groupEmpty !== true (false)"] }],
  }]);
  assert.equal(bad.ok, false, "a cleanup-failed row must fail the aggregate even with exit 0 + summary ok");
  assert.match(bad.failures[0], /cleanup/);
});
