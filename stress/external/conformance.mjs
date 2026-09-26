#!/usr/bin/env node
/**
 * Official MCP conformance runner (builder-10, stress/external/).
 *
 * Tool: @modelcontextprotocol/conformance (`npx`, official suite), server mode:
 *   npx @modelcontextprotocol/conformance server --url http://127.0.0.1:<port>/mcp
 *       --suite active --output-dir <dir> --verbose
 *
 * Known limitation (recorded in the summary): the suite has no bearer-token
 * flag and does not read one from the environment, so against a
 * token-protected `action-hub serve` every authenticated scenario reports
 * 401-driven failures. That 401 behavior is itself the evidence this runner
 * collects; the verdict is reported as-is, not massaged.
 *
 * Writes a JSON summary as its last stdout line and to
 * stress/.generated/results/external-conformance.json.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const genDir = resolve(here, "..", ".generated", "external");
const resultsDir = resolve(here, "..", ".generated", "results");
const outDir = join(genDir, "conformance");
const SERVE_PORT = 41714;
const token = "stress-external-token-0f1e2d3c";

const configPath = resolve(
  process.argv.includes("--config")
    ? process.argv[process.argv.indexOf("--config") + 1]
    : join(genDir, "servers.json"),
);

const isolatedEnv = {
  ...process.env,
  HOME: join(genDir, "home"),
  XDG_CACHE_HOME: join(genDir, "cache"),
  XDG_CONFIG_HOME: join(genDir, "config"),
  ACTION_HUB_CONFIG: configPath,
  ACTION_HUB_SKILLS_DIR: join(genDir, "skills"),
  PI_CODING_AGENT_DIR: join(genDir, "pi"),
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

async function main() {
  const started = Date.now();
  await mkdir(outDir, { recursive: true });
  await mkdir(resultsDir, { recursive: true });

  const serve = spawn(
    process.execPath,
    [join(repoRoot, "packages", "cli", "dist", "index.js"), "serve", "--config", configPath, "--port", String(SERVE_PORT)],
    { env: isolatedEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (!(await waitHealthy(SERVE_PORT))) {
    serve.kill("SIGTERM");
    throw new Error("action-hub serve did not become healthy in 30s");
  }

  let run;
  try {
    const t = Date.now();
    const res = spawnSync(
      "npx",
      [
        "--yes",
        "@modelcontextprotocol/conformance",
        "server",
        "--url",
        `http://127.0.0.1:${SERVE_PORT}/mcp`,
        "--suite",
        "active",
        "--output-dir",
        outDir,
        "--verbose",
      ],
      { encoding: "utf8", env: isolatedEnv, timeout: 60 * 60_000 },
    );
    run = {
      label: "http-server-suite",
      tool: "@modelcontextprotocol/conformance",
      command: `npx @modelcontextprotocol/conformance server --url http://127.0.0.1:${SERVE_PORT}/mcp --suite active --output-dir ${outDir} --verbose`,
      exitCode: res.status ?? -1,
      durationMs: Date.now() - t,
      ok: res.status === 0,
      note: "Suite has no bearer-token flag; token-protected 401 responses drive the verdict below.",
      stderr: res.stderr?.slice(-3000),
      stdoutTail: res.stdout?.slice(-2000),
    };
  } finally {
    serve.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
  }

  try {
    run.resultFiles = await readdir(outDir);
  } catch {
    run.resultFiles = [];
  }

  const summary = {
    script: "conformance.mjs",
    tool: "@modelcontextprotocol/conformance",
    configPath,
    outputDir: outDir,
    runs: [run],
    ok: run.ok,
    durationMs: Date.now() - started,
    at: new Date().toISOString(),
  };
  await writeFile(join(resultsDir, "external-conformance.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary));
  process.exit(summary.ok ? 0 : 1);
}

main().catch((cause) => {
  console.error(String(cause));
  process.exit(1);
});
