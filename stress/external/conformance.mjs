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
import { fileURLToPath } from "node:url";
import { buildIsolatedEnv, assertFinalEnv } from "./isolation.mjs";
import { startServe, killTree, runTool } from "./serve.mjs";
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
    };
  } finally {
    await killTree(serve.handle);
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
  run.counts = { success: evidence.success, failure: evidence.failure, warning: evidence.warning, scenarios: scenarios.length };
  run.evidence = { ok: evidence.ok, reason: evidence.reason };
  run.ok =
    run.exitCode === 0 &&
    !run.timedOut &&
    !run.spawnError &&
    evidence.ok === true;
  if (!run.ok && evidence.reason) run.evidenceReason = evidence.reason;

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
  await finish(summary);
}

main().catch(async (cause) => {
  const summary = {
    script: "conformance.mjs",
    ok: false,
    error: String(cause?.stack ?? cause).slice(-2000),
    at: new Date().toISOString(),
  };
  await finish(summary);
});
