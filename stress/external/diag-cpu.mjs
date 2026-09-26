#!/usr/bin/env node
/**
 * F18 CPU profiling via the V8 inspector (builder-10).
 * Starts `action-hub serve` with --inspect=0, connects over the inspector
 * WebSocket, starts the CPU profiler, waits for "go" on stdin (or --seconds),
 * stops it, and writes the .cpuprofile to disk.
 * Usage: node stress/external/diag-cpu.mjs --port 41725 [--seconds 60]
 */
import { spawn } from "node:child_process";
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
const port = arg("--port", 41725);
const seconds = Number(arg("--seconds", 60));
const token = "stress-external-token-0f1e2d3c";
const configPath = arg("--config", resolve(here, "..", ".generated", "servers.json"));

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
  "--inspect=0",
  "--cpu-prof-interval=1000",
  join(repoRoot, "packages", "cli", "dist", "index.js"),
  "serve", "--config", configPath, "--port", String(port),
], { env: isolatedEnv, stdio: ["ignore", "pipe", "pipe"] });

let wsUrl = null;
serve.stderr.on("data", (chunk) => {
  const text = String(chunk);
  process.stderr.write(`[serve] ${text}`);
  const m = text.match(/ws:\/\/[^\s]+/);
  if (m) wsUrl = m[0];
});

async function waitInspector() {
  const deadline = Date.now() + 60_000;
  while (!wsUrl && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  if (!wsUrl) throw new Error("inspector URL not seen on stderr");
}

await waitInspector();
// Wait until /health answers.
const deadline = Date.now() + 60_000;
for (;;) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    if (res.ok) break;
  } catch { /* not yet */ }
  if (Date.now() > deadline) throw new Error("serve not healthy");
  await new Promise((r) => setTimeout(r, 300));
}

const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
function send(method, params) {
  return new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}
await send("Profiler.enable");
await send("Profiler.setSamplingInterval", { interval: 1000 });
await send("Profiler.start");
console.log(JSON.stringify({ profiling: "started", at: Date.now(), port, seconds }));

await new Promise((r) => setTimeout(r, seconds * 1000));
const stop = await send("Profiler.stop");
const profile = stop.result?.profile;
await mkdir(resultsDir, { recursive: true });
const out = join(resultsDir, `f18-serve-${Date.now()}.cpuprofile`);
await writeFile(out, JSON.stringify(profile, null, 0));
console.log(JSON.stringify({ profile: out, nodes: profile?.nodes?.length ?? 0 }));

ws.close();
serve.kill("SIGTERM");
process.exit(0);
