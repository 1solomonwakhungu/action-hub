#!/usr/bin/env node
/**
 * CLI-contract regressions for the search-quality evaluators (SQ2-R4 review):
 * valueless flags must NOT bypass the shared finish path. Each case spawns the
 * real script with a present-but-valueless flag and asserts, for BOTH
 * split-eval and latency-eval:
 *   - exit code 1
 *   - exactly ONE stdout line, valid JSON, ok:false
 *   - the stale artifact (pre-seeded with a sentinel) is overwritten by the
 *     failure summary (artifact parity: artifact JSON === last stdout JSON)
 * Cases: --corpus (both scripts), --split (split-eval), --passes (latency-eval).
 * Correctness check (no benchmark) — does not take BENCH.lock.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FatalError, main } from "./lib/harness.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const resultsPath = join(repoRoot, "stress", ".generated", "results", "eval-cli-selftest.json");

await main(async () => {
  const cases = [
    { script: "stress/split-eval.mjs", flag: "--corpus", artifact: join(repoRoot, "stress", ".generated", "results", "split-eval.json") },
    { script: "stress/split-eval.mjs", flag: "--split", artifact: join(repoRoot, "stress", ".generated", "results", "split-eval.json") },
    { script: "stress/latency-eval.mjs", flag: "--corpus", artifact: join(repoRoot, "stress", ".generated", "results", "latency-eval.json") },
    { script: "stress/latency-eval.mjs", flag: "--passes", artifact: join(repoRoot, "stress", ".generated", "results", "latency-eval.json") },
  ];
  const checks = [];
  const failures = [];
  for (const c of cases) {
    // Pre-seed a STALE artifact: the failure run must overwrite it.
    writeFileSync(c.artifact, JSON.stringify({ stale: true }), "utf8");
    const r = spawnSync(process.execPath, [join(repoRoot, c.script), c.flag], { encoding: "utf8", timeout: 60000 });
    const lines = (r.stdout || "").split("\n").filter((l) => l.trim().length > 0);
    let lastJson = null;
    try { lastJson = JSON.parse(lines[lines.length - 1]); } catch { /* fallthrough */ }
    let artifact = null;
    try { artifact = JSON.parse(readFileSync(c.artifact, "utf8")); } catch { /* fallthrough */ }
    const problems = [];
    if (r.status !== 1) problems.push(`exit ${r.status} != 1`);
    if (lines.length !== 1) problems.push(`stdout lines ${lines.length} != 1`);
    if (!lastJson || lastJson.ok !== false) problems.push(`last line not ok:false JSON: ${(lines[lines.length - 1] || "").slice(0, 80)}`);
    if (!artifact || artifact.stale === true) problems.push("artifact NOT overwritten (stale sentinel survived)");
    else if (lastJson && JSON.stringify(artifact) !== JSON.stringify(lastJson)) problems.push("artifact != last stdout JSON (parity)");
    checks.push({ script: c.script, flag: c.flag, exit: r.status, ok: lastJson?.ok ?? null, artifactOverwritten: artifact?.stale !== true, pass: problems.length === 0 });
    if (problems.length > 0) failures.push(`${c.script} ${c.flag}: ${problems.join("; ")}`);
  }
  if (failures.length > 0) {
    throw new FatalError(`eval CLI contract regressions FAILED: ${failures.join(" | ")}`);
  }
  return { ok: true, mode: "eval-cli-selftest", checks };
}, { resultsPath });
