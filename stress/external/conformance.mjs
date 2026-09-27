#!/usr/bin/env node
/**
 * Official MCP conformance runner (builder-10, stress/external/). Four-bar
 * compliant (S9-R5): port 0 + child-attested port + authenticated health,
 * full ISOLATION.md env, detached spawn with group kill, strict evidence
 * (positive parsed scenarios/checks and zero failing checks required — CLI
 * exit 0 alone is never green), last-line JSON on every path.
 *
 * Tool: @modelcontextprotocol/conformance (`npx`, official suite), server mode:
 *   npx @modelcontextprotocol/conformance server --url http://127.0.0.1:<port>/mcp
 *       --suite active --output-dir <dir> --verbose
 *
 * Known limitation (recorded in the summary): the suite has no bearer-token
 * flag and does not read one from the environment, so against a
 * token-protected `action-hub serve` every authenticated scenario reports
 * 401-driven failures. That 401 behavior is itself the evidence this runner
 * collects; the verdict is reported as-is, not massaged — a 401-driven
 * failure count therefore fails the run (ok:false), by design.
 */
import { mkdir, readdir, writeFile, copyFile, symlink, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildIsolatedEnv, assertFinalEnv } from "./isolation.mjs";
import { startServe, killTree, runTool, foldCleanupVerdict } from "./serve.mjs";
import { conformanceEvidence } from "./parsers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const genDir = resolve(here, "..", ".generated", "external");
const resultsDir = resolve(here, "..", ".generated", "results");
const outBase = join(genDir, "conformance");
const CONFORMANCE_VERSION = "0.1.16"; // pinned per contract reproducibility rule
const token = `stress-conformance-${Date.now().toString(36)}-${process.pid}`;

async function finish(summary) {
  await mkdir(resultsDir, { recursive: true }).catch(() => undefined);
  try {
    await writeFile(join(resultsDir, "external-conformance.json"), JSON.stringify(summary, null, 2) + "\n");
  } catch (writeCause) {
    // Contract: a run that cannot persist its artifact is not green.
    summary.ok = false;
    summary.artifactError = String(writeCause).slice(0, 200);
  }
  console.log(JSON.stringify(summary));
  process.exit(summary.ok === true ? 0 : 1);
}

async function main() {
  const started = Date.now();
  const configPath = resolve(
    process.argv.includes("--config")
      ? process.argv[process.argv.indexOf("--config") + 1]
      : join(genDir, "servers.json"),
  );
  if (!existsSync(configPath)) throw new Error(`config not found: ${configPath}`);
  const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(outBase, `run-${runStamp}`); // fresh per run; parse only this
  await mkdir(outDir, { recursive: true });
  await mkdir(resultsDir, { recursive: true });

  const { env: isolatedEnv, root, assertFinal } = buildIsolatedEnv({
    ACTION_HUB_HTTP_TOKEN: token,
  });
  const stagedConfig = join(root, "config", "servers.json");
  await mkdir(join(root, "config"), { recursive: true });
  await copyFile(configPath, stagedConfig);
  isolatedEnv["ACTION_HUB_CONFIG"] = stagedConfig;
  const stagedSkills = join(root, "skills");
  // buildIsolatedEnv pre-creates the skills dir; remove it (dir or
  // symlink) before pointing the final var at the fixture.
  await rm(stagedSkills, { recursive: true, force: true });
  const fixtureSkills = join(genDir, "skills");
  if (existsSync(fixtureSkills)) await symlink(fixtureSkills, stagedSkills);
  else await mkdir(stagedSkills, { recursive: true });
  isolatedEnv["ACTION_HUB_SKILLS_DIR"] = stagedSkills;
  assertFinal(isolatedEnv);

  const serve = await startServe({
    configPath: stagedConfig,
    token,
    skillsDir: stagedSkills,
    env: isolatedEnv,
    root,
    repoRoot,
  });

  let run;
    let serveCleanup = null; // captured kill verdict — folded into ok (MIG2-R1)
  try {
    const res = await runTool(
      "npx",
      [
        "--yes",
        `@modelcontextprotocol/conformance@${CONFORMANCE_VERSION}`,
        "server",
        "--url",
        `http://127.0.0.1:${serve.port}/mcp`,
        "--suite",
        "active",
        "--output-dir",
        outDir,
        "--verbose",
      ],
      { env: isolatedEnv, timeoutMs: 60 * 60_000 },
    ).exitP;
    run = {
      label: "http-server-suite",
      tool: "@modelcontextprotocol/conformance",
      version: CONFORMANCE_VERSION,
      command: `npx @modelcontextprotocol/conformance@${CONFORMANCE_VERSION} server --url http://127.0.0.1:${serve.port}/mcp --suite active --output-dir ${outDir} --verbose`,
      exitCode: res.code,
      timedOut: res.timedOut,
      durationMs: res.durationMs,
      servePort: serve.port,
      serveChildPid: serve.child.pid,
      ok: false, // set from parsed evidence below; CLI exit alone is not green
      note: "Suite has no bearer-token flag; token-protected 401 responses drive the verdict below.",
      stderr: res.stderrTail.slice(-3000),
      stdoutTail: res.stdoutTail.slice(-2000),
      spawnError: res.spawnError,
      // MIG2-R1: the step verdict rides on the run row and is folded below.
      stepVerdict: res,
    };
  } finally {
    serveCleanup = serve ? await killTree(serve.handle) : null;
  }

  // Parse per-scenario result files: the suite writes one directory per
  // scenario containing checks.json.
  const scenarios = [];
  try {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    for (const f of readdirSync(outDir)) {
      const p = join(outDir, f);
      if (!statSync(p).isDirectory()) continue;
      try {
        const checks = JSON.parse(readFileSync(join(p, "checks.json"), "utf8"));
        const list = Array.isArray(checks) ? checks : (checks.checks ?? []);
        if (list.length > 0) scenarios.push({ name: f, checks: list });
      } catch {
        scenarios.push({ name: f, checks: [] }); // unreadable scenario = failure
      }
    }
  } catch {
    /* parse below reports zero scenarios as a failure */
  }
  run.resultFiles = await readdir(outDir).catch(() => []);
  run.scenarioCount = scenarios.length;
  run.scenarios = scenarios.length;
  const evidence = conformanceEvidence(scenarios);
  // MIG2-R1 (ordering): the step-verdict fold happens INSIDE the evaluator,
  // BEFORE run.ok is derived — valid evidence with a failed cleanup can
  // never be green (reviewer-1's exact remaining case).
  evaluateConformanceRun(run, evidence);

  const summary = {
    script: "conformance.mjs",
    tool: "@modelcontextprotocol/conformance",
    version: CONFORMANCE_VERSION,
    configPath: stagedConfig,
    outputDir: outDir,
    runs: [run],
    ok: run.ok,
    durationMs: Date.now() - started,
    at: new Date().toISOString(),
  };
  foldCleanupVerdict(summary, serveCleanup, "serve");
  await finish(summary);
}

/**
 * Pure evaluator (reviewer-1 MIG2-R1.5): derives the run row's verdict from
 * workload evidence AND the folded step verdict — the fold happens BEFORE
 * ok is computed, so valid evidence + a failed teardown is red. Exported
 * for the discriminating caller-level regression.
 */
export function evaluateConformanceRun(run, evidence) {
  run.counts = { success: evidence.success, failure: evidence.failure, warning: evidence.warning, scenarios: run.scenarios };
  run.evidence = { ok: evidence.ok, reason: evidence.reason };
  // Workload evidence first, THEN the fold (which sets run.ok=false and
  // attaches cleanupFailures on any cleanup problem), then ok is the CONJUNCTION —
  // the fold's false must survive the evidence derivation.
  const workloadOk =
    run.exitCode === 0 &&
    !run.timedOut &&
    !run.spawnError &&
    evidence.ok === true;
  foldCleanupVerdict(run, run.stepVerdict, "conformance suite");
  // Derive from the FOLD'S OWN evidence, never from a prior run.ok value
  // (reviewer-1 non-blocking false-negative: main constructs the row with a
  // placeholder ok:false; a healthy cleanup must be able to become green).
  const cleanupGreen = !(Array.isArray(run.cleanupFailures) && run.cleanupFailures.length > 0);
  run.ok = workloadOk && cleanupGreen;
  if (!run.ok && evidence.reason && !evaluatedCleanup(run)) run.evidenceReason = evidence.reason;
  return run;
}

function evaluatedCleanup(run) {
  return Array.isArray(run.cleanupFailures) && run.cleanupFailures.length > 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(async (cause) => {
  const summary = {
    script: "conformance.mjs",
    ok: false,
    error: String(cause?.stack ?? cause).slice(-2000),
    at: new Date().toISOString(),
  };
  await finish(summary);
  });
}
