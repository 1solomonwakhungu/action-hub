#!/usr/bin/env node
/**
 * mcp-fuzzer runner (builder-10, stress/external/). Four-bar compliant (S9-R5).
 *
 * Tool: mcp-fuzzer (Python, MIT, pip-installed into /tmp/action-hub-stress/venv).
 * Flags per intake: --phase both (realistic + aggressive), --seed 42,
 * --security-audit; stdio additionally with --no-network --enable-safety-system.
 *
 * Targets:
 *   stdio — `node <repo>/packages/cli/dist/index.js start --config <cfg>`
 *           (fuzzer spawns it; fully isolated env)
 *   http  — `action-hub serve --config <cfg> --port 0` (streamable HTTP;
 *           the child's ACTUAL port is parsed from its stdout and health is
 *           proven to belong to that child; bearer token via MCP_API_KEY +
 *           MCP_PREFIX=Bearer + --auth-env)
 *
 * Strict evidence: a run is green only with a positive numeric discovered
 * tool count, no blocked status, exit 0, and no timeout (see parsers.mjs).
 *
 * Usage: node stress/external/fuzz.mjs [--config <servers.json>] [--runs N]
 */
import { mkdir, readdir, writeFile, copyFile, symlink, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIsolatedEnv, assertFinalEnv } from "./isolation.mjs";
import { startServe, killTree, runTool, foldCleanupVerdict } from "./serve.mjs";
import { fuzzEvidence } from "./parsers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const genDir = resolve(here, "..", ".generated", "external");
const resultsDir = resolve(here, "..", ".generated", "results");
const FUZZER = process.env["FUZZER_BIN"] ?? "/tmp/action-hub-stress/venv/bin/mcp-fuzzer";
const FUZZER_VERSION = "0.7.0";
const token = `stress-fuzz-${Date.now().toString(36)}-${process.pid}`;

function argNum(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] !== undefined ? Number(process.argv[i + 1]) : fallback;
}
const runs = argNum("--runs", 10);
const runsPerType = argNum("--runs-per-type", 5);

async function finish(summary) {
  await mkdir(resultsDir, { recursive: true }).catch(() => undefined);
  try {
    await writeFile(join(resultsDir, "external-fuzzer.json"), JSON.stringify(summary, null, 2) + "\n");
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
  await mkdir(resultsDir, { recursive: true });
  const runStamp = new Date().toISOString().replace(/[:.]/g, "-");

  const { env: isolatedEnv, root, assertFinal } = buildIsolatedEnv({
    // mcp-fuzzer auth (http target): Authorization: Bearer <token>
    MCP_API_KEY: token,
    MCP_PREFIX: "Bearer",
  });
  // Stage the config into the run root (bar 2).
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

  const fuzzRuns = [];

  // --- stdio target (no network, safety system on) ---
  const stdioCmd = [
    process.execPath,
    join(repoRoot, "packages", "cli", "dist", "index.js"),
    "start",
    "--config",
    stagedConfig,
  ];
  fuzzRuns.push(
    await runFuzzer(isolatedEnv, [
      "--protocol", "stdio",
      "--endpoint", stdioCmd.join(" "),
      "--mode", "all",
      "--phase", "both",
      "--seed", "42",
      "--security-audit",
      "--no-network",
      "--enable-safety-system",
      "--runs", String(runs),
      "--runs-per-type", String(runsPerType),
    ], "stdio", runStamp),
  );

  // --- http target (streamable HTTP + bearer token; port 0) ---
  const serve = await startServe({
    configPath: stagedConfig,
    token,
    skillsDir: stagedSkills,
    env: isolatedEnv,
    root,
    repoRoot,
  });
    let serveCleanup = null; // captured kill verdict — folded into ok (MIG2-R1)
  try {
    fuzzRuns.push(
      await runFuzzer(isolatedEnv, [
        "--protocol", "streamablehttp",
        "--endpoint", `http://127.0.0.1:${serve.port}/mcp`,
        "--auth-env",
        "--mode", "all",
        "--phase", "both",
        "--seed", "42",
        "--security-audit",
        "--runs", String(runs),
        "--runs-per-type", String(runsPerType),
      ], "http", runStamp),
    );
  } finally {
    serveCleanup = serve ? await killTree(serve.handle) : null;
  }

  // Collect fuzzer output file names (paths recorded; contents stay in .generated).
  for (const run of fuzzRuns) {
    try {
      run.reportFiles = await readdir(run.outputDir);
    } catch {
      run.reportFiles = [];
    }
  }

  const summary = {
    script: "fuzz.mjs",
    tool: "mcp-fuzzer",
    version: FUZZER_VERSION,
    configPath: stagedConfig,
    servePort: serve.port,
    serveChildPid: serve.child.pid,
    runs: fuzzRuns,
    ok: fuzzRuns.length === 2 && fuzzRuns.every((r) => r.ok),
    durationMs: Date.now() - started,
    at: new Date().toISOString(),
  };
  foldCleanupVerdict(summary, serveCleanup, "serve");
  // MIG2-R1: the tool step's own cleanup verdict is load-bearing too.
  foldCleanupVerdict(summary, res, "step");
  await finish(summary);
}

async function runFuzzer(env, args, label, runStamp) {
  const outDir = join(genDir, `fuzz-${label}-${runStamp}`);
  const res = await runTool(FUZZER, [...args, "--output-dir", outDir, "--log-level", "ERROR"], {
    env, timeoutMs: 30 * 60_000,
  }).exitP;
  const run = {
    label,
    command: [FUZZER, ...args].join(" "),
    tool: "mcp-fuzzer",
    version: FUZZER_VERSION,
    seed: 42,
    exitCode: res.code,
    timedOut: res.timedOut,
    durationMs: res.durationMs,
    outputDir: outDir,
    stderr: res.stderrTail.slice(-3000),
    stdoutTail: res.stdoutTail.slice(-1500),
    spawnError: res.spawnError,
  };
  // Strict evidence parse: positive tool count, not blocked, exit 0, no timeout.
  let report = null;
  try {
    report = JSON.parse(await (await import("node:fs/promises")).readFile(join(outDir, "run_summary.json"), "utf8"));
  } catch {
    run.parseError = "run_summary.json missing or unreadable";
  }
  const evidence = fuzzEvidence(report);
  run.toolCount = evidence.toolCount ?? null;
  run.blockedReason = evidence.reason?.startsWith("run blocked") ? evidence.reason : null;
  run.findingCounts = {
    total: evidence.findingTotal ?? 0,
    byCategory: evidence.byCategory ?? {},
  };
  run.ok =
    res.code === 0 &&
    !res.timedOut &&
    !res.spawnError &&
    evidence.ok === true;
  if (!run.ok && !run.parseError && evidence.reason) run.evidenceReason = evidence.reason;
  return run;
}

main().catch(async (cause) => {
  const summary = {
    script: "fuzz.mjs",
    ok: false,
    error: String(cause?.stack ?? cause).slice(-2000),
    at: new Date().toISOString(),
  };
  await finish(summary);
});
