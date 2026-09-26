#!/usr/bin/env node
/**
 * @hasmcp/mcp-spec-test runner (builder-10, stress/external/). Four-bar
 * compliant (S9-R5): port 0 + child-attested port + authenticated health,
 * full ISOLATION.md env, detached spawns with group kill, strict evidence
 * (positive passed count required), last-line JSON on every path.
 *
 * MCP conformance suite over both transports:
 *   stdio — `-c "node <repo>/packages/cli/dist/index.js start --config <cfg>"`
 *   http  — `-u http://127.0.0.1:<port>/mcp -t <bearer token>`
 *
 * Usage: node stress/external/spec-test.mjs [--config <servers.json>]
 */
import { mkdir, readdir, writeFile, copyFile, symlink, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIsolatedEnv, assertFinalEnv } from "./isolation.mjs";
import { startServe, killTree, runTool } from "./serve.mjs";
import { specEvidence } from "./parsers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const genDir = resolve(here, "..", ".generated", "external");
const resultsDir = resolve(here, "..", ".generated", "results");
const reportsDir = join(genDir, "spec-test");
const SPEC_VERSION = "0.1.5";
const token = `stress-spec-${Date.now().toString(36)}-${process.pid}`;

async function finish(summary) {
  await mkdir(resultsDir, { recursive: true }).catch(() => undefined);
  try {
    await writeFile(join(resultsDir, "external-spec-test.json"), JSON.stringify(summary, null, 2) + "\n");
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
  await mkdir(resultsDir, { recursive: true });

  const { env: isolatedEnv, root, assertFinal } = buildIsolatedEnv({
    MCP_DISABLE_TELEMETRY: "1",
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

  const runs = [];

  // --- stdio target ---
  const cmd = [
    process.execPath,
    join(repoRoot, "packages", "cli", "dist", "index.js"),
    "start",
    "--config",
    stagedConfig,
  ].join(" ");
  runs.push(
    await runSpec(isolatedEnv, ["-c", cmd, "--output", "json", "--output-folder", join(reportsDir, `stdio-${runStamp}`)], "stdio"),
  );

  // --- http target (port 0, child-attested port) ---
  const serve = await startServe({
    configPath: stagedConfig,
    token,
    skillsDir: stagedSkills,
    env: isolatedEnv,
    root,
    repoRoot,
  });
  try {
    runs.push(
      await runSpec(isolatedEnv, [
        "-u", `http://127.0.0.1:${serve.port}/mcp`,
        "-t", token,
        "--output", "json",
        "--output-folder", join(reportsDir, `http-${runStamp}`),
      ], "http"),
    );
  } finally {
    await killTree(serve.child, serve.exitP);
  }

  const summary = {
    script: "spec-test.mjs",
    tool: "@hasmcp/mcp-spec-test",
    version: SPEC_VERSION,
    configPath: stagedConfig,
    servePort: serve.port,
    serveChildPid: serve.child.pid,
    reportsDir,
    runs,
    ok: runs.length === 2 && runs.every((r) => r.ok),
    durationMs: Date.now() - started,
    at: new Date().toISOString(),
  };
  await finish(summary);
}

async function runSpec(env, args, label) {
  const outDir = args[args.indexOf("--output-folder") + 1];
  await mkdir(outDir, { recursive: true });
  const res = await runTool(
    "npx",
    ["--yes", `@hasmcp/mcp-spec-test@${SPEC_VERSION}`, ...args],
    { env, timeoutMs: 30 * 60_000 },
  ).exitP;
  const run = {
    label,
    command: ["npx", `@hasmcp/mcp-spec-test@${SPEC_VERSION}`, ...args].join(" "),
    tool: "@hasmcp/mcp-spec-test",
    version: SPEC_VERSION,
    exitCode: res.code,
    timedOut: res.timedOut,
    reportDir: outDir,
    durationMs: res.durationMs,
    stdoutTail: res.stdoutTail.slice(-2000),
    stderr: res.stderrTail.slice(-3000),
    spawnError: res.spawnError,
  };
  // Strict evidence parse: positive passed count, zero failed, no auth blocks.
  try {
    const { readFileSync, readdirSync } = await import("node:fs");
    const files = readdirSync(outDir).filter((f) => f.endsWith(".json"));
    run.reportFiles = [...files];
    const latest = [...files].sort().pop();
    const report = JSON.parse(readFileSync(join(outDir, latest), "utf8"));
    run.verdict = report.verdict?.code ?? null;
    run.counts = report.counts ?? null;
    const notVerified = report.cases?.notVerified ?? [];
    run.notVerifiedReasons = notVerified.slice(0, 10).map((c) => ({
      section: c.section,
      reason: (c.reason ?? c.detail ?? "").slice(0, 200),
    }));
    const authBlocked = notVerified.filter((c) => /401|unauthor|auth/i.test(`${c.reason ?? ""}${c.detail ?? ""}`)).length;
    run.authBlockedCases = authBlocked;
    const evidence = specEvidence(report);
    run.evidence = { ok: evidence.ok, reason: evidence.reason, passed: evidence.passed, failed: evidence.failed, executed: evidence.executed };
    run.ok = res.code === 0 && !res.timedOut && !res.spawnError && evidence.ok === true && authBlocked === 0;
    if (!run.ok && evidence.reason) run.evidenceReason = evidence.reason;
  } catch (cause) {
    run.ok = false;
    run.parseError = String(cause).slice(0, 200);
  }
  return run;
}

main().catch(async (cause) => {
  const summary = {
    script: "spec-test.mjs",
    ok: false,
    error: String(cause?.stack ?? cause).slice(-2000),
    at: new Date().toISOString(),
  };
  await finish(summary);
});
