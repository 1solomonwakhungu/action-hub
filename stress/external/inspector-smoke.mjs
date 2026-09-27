#!/usr/bin/env node
/**
 * MCP Inspector CLI smoke tests against both Action Hub transports
 * (builder-10, stress/external/). Four-bar compliant (S9-R5):
 *  - serve binds port 0; the child's actual port is parsed from its stdout;
 *  - health is proven to belong to THAT child (authenticated initialize);
 *  - full ISOLATION.md env; detached spawns with group kill in finally;
 *  - every path (incl. spawn failure/exception) writes the artifact and
 *    prints ONE compact JSON last line, ok:false on failure, exit nonzero.
 *
 * Targets (verified against the Inspector CLI docs, modelcontextprotocol/inspector
 * clients/cli/README.md + docs/cli-smoke-testing.md):
 *   stdio:  npx @modelcontextprotocol/inspector --cli <cmd...> -- --method ...
 *   http:   --transport http --server-url http://127.0.0.1:<port>/mcp --header ...
 *
 * Usage: node stress/external/inspector-smoke.mjs [--config <servers.json>]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIsolatedEnv, assertFinalEnv } from "./isolation.mjs";
import { startServe, killTree, runTool } from "./serve.mjs";
import { copyFile, symlink, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const genDir = resolve(here, "..", ".generated", "external");
const resultsDir = resolve(here, "..", ".generated", "results");
const INSPECTOR_VERSION = "2.5.0"; // pinned per Inspector CI guidance

function cliFlag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

// Per-run token: any HTTP evidence must come from a server that accepted
// THIS run's credentials.
const token = `stress-inspector-${Date.now().toString(36)}-${process.pid}`;

async function finish(summary) {
  await mkdir(resultsDir, { recursive: true }).catch(() => undefined);
  try {
    await writeFile(join(resultsDir, "external-inspector.json"), JSON.stringify(summary, null, 2) + "\n");
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
  const configPath = resolve(cliFlag("--config", join(genDir, "servers.json")));
  if (!existsSync(configPath)) throw new Error(`config not found: ${configPath}`);

  const { env: isolatedEnv, root, assertFinal } = buildIsolatedEnv({
    ACTION_HUB_HTTP_TOKEN: token,
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

  const run = [];

  // --- stdio: action-hub start (foreground stdio MCP server) ---
  const startCmd = [
    process.execPath,
    join(repoRoot, "packages", "cli", "dist", "index.js"),
    "start",
    "--config",
    stagedConfig,
    "--",
    "--method",
  ];
  run.push(await runInspector(isolatedEnv, [...startCmd, "initialize", "--format", "json"], "stdio initialize"));
  run.push(await runInspector(isolatedEnv, [...startCmd, "tools/list", "--format", "json"], "stdio tools/list"));

  // --- http: action-hub serve (streamable HTTP, bearer token) ---
  const serve = await startServe({
    configPath: stagedConfig,
    token,
    skillsDir: stagedSkills,
    env: isolatedEnv,
    root,
    repoRoot,
  });
  let port = null;
  try {
    port = serve.port;
    const httpArgs = [
      "--transport",
      "http",
      "--server-url",
      `http://127.0.0.1:${port}/mcp`,
      "--header",
      `Authorization: Bearer ${token}`,
      "--connect-timeout",
      "15000",
      "--method",
    ];
    run.push(await runInspector(isolatedEnv, [...httpArgs, "initialize", "--format", "json"], "http initialize"));
    run.push(await runInspector(isolatedEnv, [...httpArgs, "tools/list", "--format", "json"], "http tools/list"));
  } finally {
    await killTree(serve.handle);
  }

  const toolsSeen = run
    .filter((r) => r.parsed?.result?.tools)
    .map((r) => r.parsed.result.tools.length);

  const summary = {
    script: "inspector-smoke.mjs",
    inspectorVersion: INSPECTOR_VERSION,
    configPath: stagedConfig,
    port,
    serveChildPid: serve.child.pid,
    probes: run,
    toolsSeen,
    ok: run.length === 4 && run.every((r) => r.ok),
    durationMs: Date.now() - started,
    at: new Date().toISOString(),
  };
  await finish(summary);
}

const CLI = ["npx", "--yes", `@modelcontextprotocol/inspector@${INSPECTOR_VERSION}`, "--cli"];

async function runInspector(env, args, label) {
  const res = await runTool(CLI[0], [...CLI.slice(1), ...args], { env, timeoutMs: 120_000 }).exitP;
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdoutTail.trim().split("\n").pop());
  } catch {
    // non-JSON output recorded raw below
  }
  // Strict evidence (R6): a parsed envelope alone is not success.
  //  - initialize probes must return an error-free result with serverInfo;
  //  - tools/list probes must return a non-empty tools array.
  const isInitialize = args.includes("initialize");
  const isToolsList = args.includes("tools/list");
  let evidenceOk = false;
  let evidenceReason = null;
  if (isInitialize) {
    evidenceOk = !!parsed && !parsed.error && !!parsed.result?.serverInfo;
    if (!evidenceOk) evidenceReason = parsed?.error ? `initialize error: ${JSON.stringify(parsed.error).slice(0, 200)}` : "initialize returned no result.serverInfo";
  } else if (isToolsList) {
    const tools = parsed?.result?.tools;
    evidenceOk = Array.isArray(tools) && tools.length > 0;
    if (!evidenceOk) evidenceReason = `tools/list returned ${Array.isArray(tools) ? 0 : "no"} tools`;
  } else {
    evidenceReason = "unrecognized probe (no strict evidence rule)";
  }
  return {
    label,
    command: [...CLI, ...args].join(" "),
    inspectorVersion: INSPECTOR_VERSION,
    exitCode: res.code,
    timedOut: res.timedOut,
    durationMs: res.durationMs,
    ok: res.code === 0 && !res.timedOut && evidenceOk,
    evidenceReason,
    parsed,
    stderr: res.stderrTail.slice(-2000),
  };
}

main().catch(async (cause) => {
  const summary = {
    script: "inspector-smoke.mjs",
    ok: false,
    error: String(cause?.stack ?? cause).slice(-2000),
    at: new Date().toISOString(),
  };
  await finish(summary);
});
