#!/usr/bin/env node
/**
 * F18 diagnostic sampler (builder-10). Starts action-hub serve on the
 * full-scale config and samples, every second:
 *   - serve process CPU% and RSS
 *   - count of live downstream fake-mcp-server child processes
 *   - Node event-loop lag of the serve process (via a sidecar that can't
 *     attach to a running process, so instead we sample k6's view: this file
 *     only records external observables; event-loop lag is measured with
 *     --cpu-prof / inspector in a separate pass)
 * Usage: node stress/external/diag-sample.mjs --port 41731 --out results.json
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const genDir = resolve(here, "..", ".generated", "external");
const resultsDir = resolve(here, "..", ".generated", "results");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : fallback;
}
const port = arg("--port", 41731);
const token = "stress-external-token-0f1e2d3c";
const configPath = arg("--config", resolve(here, "..", ".generated", "servers.json"));
const sampleMs = Number(arg("--sample-ms", 1000));

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

const serve = spawn(process.execPath, [
  join(repoRoot, "packages", "cli", "dist", "index.js"),
  "serve", "--config", configPath, "--port", String(port),
], { env: isolatedEnv, stdio: ["ignore", "pipe", "pipe"] });
serve.stderr.on("data", (c) => process.stderr.write(`[serve] ${c}`));

async function waitHealthy() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function sample() {
  const out = spawnSync("ps", ["-o", "pid=,%cpu=,rss=,etime=", "-p", String(serve.pid)], { encoding: "utf8" });
  const kids = spawnSync("sh", ["-c", `pgrep -f fake-mcp-server.mjs | wc -l`], { encoding: "utf8" });
  const m = (out.stdout ?? "").trim().split(/\s+/);
  return {
    at: Date.now(),
    serveCpuPct: Number(m[1]) || 0,
    serveRssKb: Number(m[2]) || 0,
    downstreamProcs: Number((kids.stdout ?? "0").trim()) || 0,
  };
}

const samples = [];
let running = true;
const timer = setInterval(() => {
  if (!running) return;
  try { samples.push(sample()); } catch { /* best effort */ }
}, sampleMs);

process.on("SIGTERM", () => { running = false; serve.kill("SIGTERM"); });

const ok = await waitHealthy();
if (!ok) {
  running = false; clearInterval(timer); serve.kill("SIGTERM");
  console.error("serve not healthy");
  process.exit(1);
}
console.log(JSON.stringify({ diag: "sampling started", pid: serve.pid, port }));

// Wait for SIGINT/SIGTERM from the driver, then flush.
process.on("SIGINT", () => {
  running = false; clearInterval(timer); serve.kill("SIGTERM");
  flush();
});
function flush() {
  const file = join(resultsDir, arg("--out", "f18-diag.json"));
  return writeFile(file, JSON.stringify({ samples }, null, 2))
    .then(() => console.error(`diag wrote ${file}`));
}
process.on("exit", () => { /* sync flush fallback */ });
// Flush on a signal from the orchestrating shell:
process.stdin.resume();
process.stdin.on("data", async (chunk) => {
  if (String(chunk).trim() === "flush") {
    running = false; clearInterval(timer); serve.kill("SIGTERM");
    await flush();
    process.exit(0);
  }
});
