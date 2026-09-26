#!/usr/bin/env node
/**
 * mcp-fuzzer runner (builder-10, stress/external/).
 *
 * Tool: mcp-fuzzer (Python, MIT, pip-installed into /tmp/action-hub-stress/venv).
 * Flags per intake: --phase both (realistic + aggressive), --seed 42,
 * --security-audit; stdio additionally with --no-network --enable-safety-system.
 *
 * Targets:
 *   stdio — `node <repo>/packages/cli/dist/index.js start --config <cfg>`
 *           (fuzzer spawns it; fully isolated env)
 *   http  — `action-hub serve --config <cfg> --port 41712` (streamable HTTP,
 *           bearer token via MCP_API_KEY + MCP_PREFIX=Bearer + --auth-env)
 *
 * Writes a JSON summary as its last stdout line and to
 * stress/.generated/results/external-fuzzer.json.
 *
 * Usage: node stress/external/fuzz.mjs [--config <servers.json>] [--runs N]
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const genDir = resolve(here, "..", ".generated", "external");
const resultsDir = resolve(here, "..", ".generated", "results");
const FUZZER = process.env["FUZZER_BIN"] ?? "/tmp/action-hub-stress/venv/bin/mcp-fuzzer";
const FUZZER_VERSION = "0.7.0";
const SERVE_PORT = 41712;
const token = "stress-external-token-0f1e2d3c";
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");

function argNum(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] !== undefined ? Number(process.argv[i + 1]) : fallback;
}
const runs = argNum("--runs", 10); // small until the monster config lands
const runsPerType = argNum("--runs-per-type", 5);

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
  // serve must accept the exact token the fuzzer client sends.
  ACTION_HUB_HTTP_TOKEN: token,
  // mcp-fuzzer auth (http target): Authorization: Bearer <token>
  MCP_API_KEY: token,
  MCP_PREFIX: "Bearer",
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

function runFuzzer(args, label, extraEnv) {
  const started = Date.now();
  const outDir = join(genDir, `fuzz-${label}-${runStamp}`);
  const res = spawnSync(FUZZER, [...args, "--output-dir", outDir, "--log-level", "ERROR"], {
    encoding: "utf8",
    env: { ...isolatedEnv, ...extraEnv },
    timeout: 30 * 60_000,
  });
  const run = {
    label,
    command: [FUZZER, ...args].join(" "),
    tool: "mcp-fuzzer",
    version: FUZZER_VERSION,
    seed: 42,
    exitCode: res.status ?? -1,
    durationMs: Date.now() - started,
    ok: res.status === 0,
    outputDir: outDir,
    stderr: res.stderr?.slice(-3000),
    stdoutTail: res.stdout?.slice(-1500),
  };
  // Parse the fuzzer's own report: an auth-blocked or zero-tool run is a
  // failure, not a pass.
  try {
    const rs = JSON.parse(readFileSync(join(outDir, "run_summary.json"), "utf8"));
    run.blockedReason = rs.blocked_reason ?? (rs.status === "blocked" ? "blocked" : null);
    run.toolCount = rs.tool_discovery?.tool_count ?? rs.tools?.total ?? null;
    const findings = rs.findings ?? {};
    run.findingCounts = {
      total: findings.total ?? (findings.by_category ? Object.values(findings.by_category).reduce((a, b) => a + b, 0) : 0),
      byCategory: findings.by_category ?? {},
    };
    run.ok =
      run.exitCode === 0 &&
      !run.blockedReason &&
      (run.toolCount === null || run.toolCount > 0);
  } catch {
    run.ok = false;
    run.parseError = "run_summary.json missing or unreadable";
  }
  return run;
}

async function startServe() {
  const child = spawn(
    process.execPath,
    [join(repoRoot, "packages", "cli", "dist", "index.js"), "serve", "--config", configPath, "--port", String(SERVE_PORT)],
    { env: isolatedEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (!(await waitHealthy(SERVE_PORT))) {
    child.kill("SIGTERM");
    throw new Error("action-hub serve did not become healthy in 30s");
  }
  return child;
}

async function main() {
  const started = Date.now();
  await mkdir(resultsDir, { recursive: true });
  const fuzzRuns = [];

  // --- stdio target (no network, safety system on) ---
  const stdioCmd = [
    process.execPath,
    join(repoRoot, "packages", "cli", "dist", "index.js"),
    "start",
    "--config",
    configPath,
  ];
  fuzzRuns.push(
    runFuzzer(
      [
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
      ],
      "stdio",
      {},
    ),
  );

  // --- http target (streamable HTTP + bearer token) ---
  const serve = await startServe();
  try {
    fuzzRuns.push(
      runFuzzer(
        [
          "--protocol", "streamablehttp",
          "--endpoint", `http://127.0.0.1:${SERVE_PORT}/mcp`,
          "--auth-env",
          "--mode", "all",
          "--phase", "both",
          "--seed", "42",
          "--security-audit",
          "--runs", String(runs),
          "--runs-per-type", String(runsPerType),
        ],
        "http",
        {},
      ),
    );
  } finally {
    serve.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
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
    configPath,
    runs: fuzzRuns,
    ok: fuzzRuns.every((r) => r.ok),
    durationMs: Date.now() - started,
    at: new Date().toISOString(),
  };
  await writeFile(join(resultsDir, "external-fuzzer.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary));
  process.exit(summary.ok ? 0 : 1);
}

main().catch((cause) => {
  console.error(String(cause));
  process.exit(1);
});
