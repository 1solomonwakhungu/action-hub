#!/usr/bin/env node
/**
 * @hasmcp/mcp-spec-test runner (builder-10, stress/external/).
 *
 * MCP conformance suite over both transports:
 *   stdio — `-c "node <repo>/packages/cli/dist/index.js start --config <cfg>"`
 *   http  — `-u http://127.0.0.1:<port>/mcp -t <bearer token>`
 *
 * Intake flags honored: --disable-telemetry=1, JSON output
 * (--output json --output-folder). Version pinned for reproducibility.
 *
 * Writes a JSON summary as its last stdout line and to
 * stress/.generated/results/external-spec-test.json; suite reports (one JSON
 * file per run) are written under stress/.generated/external/spec-test/.
 *
 * Usage: node stress/external/spec-test.mjs [--config <servers.json>]
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const genDir = resolve(here, "..", ".generated", "external");
const resultsDir = resolve(here, "..", ".generated", "results");
const reportsDir = join(genDir, "spec-test");
const SPEC_VERSION = "0.1.5";
const SERVE_PORT = 41713;
const token = "stress-external-token-0f1e2d3c";

const configPath = resolve(
  process.argv.includes("--config")
    ? process.argv[process.argv.indexOf("--config") + 1]
    : join(genDir, "servers.json"),
);

// Full isolation per contract hard rules.
const isolatedEnv = {
  ...process.env,
  HOME: join(genDir, "home"),
  XDG_CACHE_HOME: join(genDir, "cache"),
  XDG_CONFIG_HOME: join(genDir, "config"),
  ACTION_HUB_CONFIG: configPath,
  ACTION_HUB_SKILLS_DIR: join(genDir, "skills"),
  PI_CODING_AGENT_DIR: join(genDir, "pi"),
  MCP_DISABLE_TELEMETRY: "1",
};

async function waitHealthy(port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function runSpec(args, label, extraEnv) {
  const started = Date.now();
  const res = spawnSync(
    "npx",
    ["--yes", `@hasmcp/mcp-spec-test@${SPEC_VERSION}`, ...args],
    { encoding: "utf8", env: { ...isolatedEnv, ...extraEnv }, timeout: 30 * 60_000 },
  );
  return {
    label,
    command: ["npx", `@hasmcp/mcp-spec-test@${SPEC_VERSION}`, ...args].join(" "),
    tool: "@hasmcp/mcp-spec-test",
    version: SPEC_VERSION,
    exitCode: res.status ?? -1,
    ok: res.status === 0,
    durationMs: Date.now() - started,
    stdoutTail: res.stdout?.slice(-2000),
    stderr: res.stderr?.slice(-3000),
  };
}

async function main() {
  const started = Date.now();
  await mkdir(reportsDir, { recursive: true });
  await mkdir(resultsDir, { recursive: true });
  const runs = [];

  // --- stdio target ---
  const cmd = [
    process.execPath,
    join(repoRoot, "packages", "cli", "dist", "index.js"),
    "start",
    "--config",
    configPath,
  ].join(" ");
  runs.push(
    runSpec(
      ["-c", cmd, "--output", "json", "--output-folder", reportsDir],
      "stdio",
      {},
    ),
  );

  // --- http target ---
  const serve = spawn(
    process.execPath,
    [join(repoRoot, "packages", "cli", "dist", "index.js"), "serve", "--config", configPath, "--port", String(SERVE_PORT)],
    { env: isolatedEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    if (!(await waitHealthy(SERVE_PORT))) throw new Error("serve not healthy in 30s");
    runs.push(
      runSpec(
        [
          "-u", `http://127.0.0.1:${SERVE_PORT}/mcp`,
          "-t", token,
          "--output", "json",
          "--output-folder", reportsDir,
        ],
        "http",
        {},
      ),
    );
  } finally {
    serve.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
  }

  const summary = {
    script: "spec-test.mjs",
    tool: "@hasmcp/mcp-spec-test",
    version: SPEC_VERSION,
    configPath,
    reportsDir,
    runs,
    ok: runs.every((r) => r.ok),
    durationMs: Date.now() - started,
    at: new Date().toISOString(),
  };
  await writeFile(join(resultsDir, "external-spec-test.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary));
  process.exit(summary.ok ? 0 : 1);
}

main().catch((cause) => {
  console.error(String(cause));
  process.exit(1);
});
