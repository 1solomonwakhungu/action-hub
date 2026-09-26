#!/usr/bin/env node
/**
 * MCP Inspector CLI smoke tests against both Action Hub transports
 * (builder-10, stress/external/).
 *
 * Targets (verified against the Inspector CLI docs, modelcontextprotocol/inspector
 * clients/cli/README.md + docs/cli-smoke-testing.md):
 *   stdio:  npx @modelcontextprotocol/inspector --cli <cmd...> -- --method ...
 *           (everything before `--` is the spawned target; after is Inspector's)
 *   http:   --transport http --server-url http://127.0.0.1:<port>/mcp --header ...
 *
 * Exit codes (Inspector v2): 0 ok, 1 usage, 3 auth, 4 unreachable, 5 tool error.
 *
 * Every assertion is one probe: `initialize` (connect-only) and `tools/list`.
 * Results are accumulated into a JSON summary, printed as the last stdout
 * line and written to stress/.generated/results/external-inspector.json
 * (contract rule).
 *
 * Usage: node stress/external/inspector-smoke.mjs [--config <servers.json>]
 * Requires the repo build (packages dist dirs) and network-free npx cache, or
 * network access to fetch @modelcontextprotocol/inspector once.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIsolatedEnv } from "./isolation.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const genDir = resolve(here, "..", ".generated", "external");
const resultsDir = resolve(here, "..", ".generated", "results");
const INSPECTOR_VERSION = "2.5.0"; // pinned per Inspector CI guidance

function cliFlag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const configPath = resolve(cliFlag("--config", join(genDir, "servers.json")));
const port = Number(cliFlag("--port", 41710));
const token = "stress-external-token-0f1e2d3c";

// Full isolation per contract hard rules.
const { env: isolatedEnv } = buildIsolatedEnv({
  ACTION_HUB_CONFIG: configPath,
  ACTION_HUB_SKILLS_DIR: join(genDir, "skills"),
  ACTION_HUB_HTTP_TOKEN: token,
});

const CLI = ["npx", "--yes", `@modelcontextprotocol/inspector@${INSPECTOR_VERSION}`, "--cli"];

function runInspector(args, label) {
  const started = Date.now();
  const res = spawnSync(CLI[0], [...CLI.slice(1), ...args], {
    encoding: "utf8",
    env: isolatedEnv,
    timeout: 120_000,
  });
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout.trim().split("\n").pop());
  } catch {
    // non-JSON output recorded raw below
  }
  return {
    label,
    command: [...CLI, ...args].join(" "),
    inspectorVersion: INSPECTOR_VERSION,
    exitCode: res.status ?? -1,
    durationMs: Date.now() - started,
    ok: res.status === 0 && parsed !== null,
    parsed,
    stderr: res.stderr?.slice(0, 2000),
  };
}

async function startServe() {
  const child = spawn(
    process.execPath,
    [join(repoRoot, "packages", "cli", "dist", "index.js"), "serve", "--config", configPath, "--port", String(port)],
    { env: isolatedEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  // Wait for /health (unauthenticated liveness).
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return child;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill("SIGTERM");
  throw new Error("action-hub serve did not become healthy in 30s");
}

async function main() {
  const started = Date.now();
  await mkdir(genDir, { recursive: true });
  await mkdir(resultsDir, { recursive: true });

  const run = [];

  // --- stdio: action-hub start (foreground stdio MCP server) ---
  const startCmd = [
    process.execPath,
    join(repoRoot, "packages", "cli", "dist", "index.js"),
    "start",
    "--config",
    configPath,
    "--",
    "--method",
  ];
  run.push(runInspector([...startCmd, "initialize", "--format", "json"], "stdio initialize"));
  run.push(runInspector([...startCmd, "tools/list", "--format", "json"], "stdio tools/list"));

  // --- http: action-hub serve (streamable HTTP, bearer token) ---
  const serve = await startServe();
  try {
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
    run.push(runInspector([...httpArgs, "initialize", "--format", "json"], "http initialize"));
    run.push(runInspector([...httpArgs, "tools/list", "--format", "json"], "http tools/list"));
  } finally {
    serve.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
  }

  const toolsSeen = run
    .filter((r) => r.parsed?.result?.tools)
    .map((r) => r.parsed.result.tools.length);

  const summary = {
    script: "inspector-smoke.mjs",
    inspectorVersion: INSPECTOR_VERSION,
    configPath,
    port,
    probes: run,
    toolsSeen,
    ok: run.every((r) => r.ok),
    durationMs: Date.now() - started,
    at: new Date().toISOString(),
  };
  await writeFile(join(resultsDir, "external-inspector.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary));
  process.exit(summary.ok ? 0 : 1);
}

main().catch((cause) => {
  console.error(String(cause));
  process.exit(1);
});
