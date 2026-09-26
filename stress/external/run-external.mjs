#!/usr/bin/env node
/**
 * Orchestrator for external stress testing (builder-10, stress/external/).
 *
 * 1. Generates the small fixture set (make-fixture.mjs) — or uses an
 *    externally provided config (full-scale monster config later).
 * 2. Starts `action-hub serve` under full isolation, samples its RSS while
 *    load runs.
 * 3. Runs the configured external tools and collects their JSON reports:
 *      - MCP Inspector CLI smoke (both transports)      [always]
 *      - k6 HTTP load                                    [--k6]
 *      - mcp-fuzzer (python venv)                        [--fuzz]
 *      - @hasmcp/mcp-spec-test (npx)                     [--spec]
 * 4. Prints one machine-readable JSON summary as the last stdout line and
 *    writes it to stress/.generated/results/external.json (contract rule).
 *
 * Usage:
 *   node stress/external/run-external.mjs [--config <servers.json>] [--k6] [--fuzz] [--spec]
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const genDir = resolve(here, "..", ".generated", "external");
const resultsDir = resolve(here, "..", ".generated", "results");
const K6_BIN = process.env["K6_BIN"] ?? "/tmp/action-hub-stress/bin/k6";
const SERVE_PORT = 41711;

function flag(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] ?? true : undefined;
}
const hasFlag = (name) => process.argv.includes(name);

const configPath = resolve(flag("--config") ?? join(genDir, "servers.json"));
const token = "stress-external-token-0f1e2d3c";

// Full isolation per contract hard rules.
const isolatedEnv = {
  ...process.env,
  HOME: join(genDir, "home"),
  XDG_CACHE_HOME: join(genDir, "cache"),
  XDG_CONFIG_HOME: join(genDir, "config"),
  ACTION_HUB_CONFIG: configPath,
  ACTION_HUB_SKILLS_DIR: join(genDir, "skills"),
  PI_CODING_AGENT_DIR: join(genDir, "pi"),
  ACTION_HUB_HTTP_TOKEN: token,
};

async function waitHealthy() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${SERVE_PORT}/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  const t0 = Date.now();
  await mkdir(resultsDir, { recursive: true });

  const runs = [];

  // 1. Small fixture unless an external config is provided.
  if (!flag("--config")) {
    const gen = spawnSync("node", [join(here, "make-fixture.mjs")], { encoding: "utf8", timeout: 60_000 });
    runs.push({ label: "make-fixture", exitCode: gen.status, stdout: gen.stdout?.trim() });
  }

  // 2. Start serve + RSS sampler.
  const serve = spawn(
    process.execPath,
    [join(repoRoot, "packages", "cli", "dist", "index.js"), "serve", "--config", configPath, "--port", String(SERVE_PORT)],
    { env: isolatedEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  const rssSamples = [];
  const sampler = setInterval(() => {
    if (serve.pid) {
      try {
        const out = spawnSync("ps", ["-o", "rss=", "-p", String(serve.pid)], { encoding: "utf8" });
        const kb = Number(out.stdout.trim());
        if (kb > 0) rssSamples.push({ at: Date.now() - t0, rssKb: kb });
      } catch {
        /* sampler best-effort */
      }
    }
  }, 2000);

  const healthy = await waitHealthy();
  if (!healthy) {
    serve.kill("SIGTERM");
    throw new Error("action-hub serve did not become healthy");
  }

  try {
    // 3a. Inspector smoke (both transports).
    const smoke = spawnSync("node", [join(here, "inspector-smoke.mjs"), "--config", configPath], {
      encoding: "utf8",
      env: isolatedEnv,
      timeout: 300_000,
    });
    let smokeSummary = null;
    try {
      smokeSummary = JSON.parse(smoke.stdout.trim().split("\n").pop());
    } catch {
      /* recorded raw */
    }
    runs.push({
      label: "inspector-smoke",
      exitCode: smoke.status,
      summary: smokeSummary,
      stderr: smoke.stderr?.slice(0, 2000),
    });

    // 3b. k6 load.
    if (hasFlag("--k6")) {
      const profile = hasFlag("--k6-full") ? "full" : "quick";
      const summaryOut = join(resultsDir, "external-k6-summary.json");
      const started = Date.now();
      const k6 = spawnSync(K6_BIN, ["run", "--summary-export", summaryOut, join(here, "k6-mcp.js")], {
        encoding: "utf8",
        env: {
          ...isolatedEnv,
          K6_URL: `http://127.0.0.1:${SERVE_PORT}`,
          K6_TOKEN: token,
          K6_PROFILE: profile,
        },
        timeout: 20 * 60_000,
      });
      runs.push({
        label: "k6",
        tool: "k6",
        profile,
        exitCode: k6.status,
        durationMs: Date.now() - started,
        summaryExport: summaryOut,
        stderr: k6.stderr?.slice(-3000),
      });
    }

    // 3c. mcp-fuzzer (python venv) — wired once the venv exists.
    if (hasFlag("--fuzz")) {
      const venvPy = "/tmp/action-hub-stress/venv/bin/python";
      runs.push({ label: "mcp-fuzzer", status: "runner-not-wired-yet", venv: venvPy });
    }

    // 3d. @hasp/mcp-spec-test (npx) — wired in its own runner.
    if (hasFlag("--spec")) {
      runs.push({ label: "mcp-spec-test", status: "runner-not-wired-yet" });
    }
  } finally {
    clearInterval(sampler);
    serve.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
  }

  const summary = {
    script: "run-external.mjs",
    configPath,
    servePort: SERVE_PORT,
    healthy,
    runs,
    rssSamples,
    rssPeakKb: rssSamples.length ? Math.max(...rssSamples.map((s) => s.rssKb)) : null,
    durationMs: Date.now() - t0,
    ok: runs.every((r) => r.exitCode === 0 || r.exitCode === undefined || r.status !== undefined),
    at: new Date().toISOString(),
  };
  await writeFile(join(resultsDir, "external.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary));
  process.exit(summary.ok ? 0 : 1);
}

main().catch((cause) => {
  console.error(String(cause));
  process.exit(1);
});
