#!/usr/bin/env node
// Action Hub load & performance bench (stress packet S4, owner: builder-5).
//
// Contract: /tmp/action-hub-stress/CONTRACT.md + ISOLATION.md (binding).
// - Measures the hub over HTTP serve and stdio at any fixture scale: cold /
//   warm start, search & load latency with strict success counting, execute
//   throughput, cache behaviour, token cost, RSS (hub + children), and the
//   20-client daemon scenario.
// - Isolation: every spawned process gets a full fresh per-run env under one
//   temp root (ISOLATION.md checklist), never inherited owner state. The run
//   refuses to start if its root resolves inside the owner's app-state dirs.
// - Last stdout line is always a JSON summary (also on failure); it is
//   written to stress/.generated/results/bench-load.json. Exit code 1 when
//   the summary reports ok:false.
//
// Usage:
//   node stress/bench-load.mjs [--scale small|full] [--transports http,stdio]
//        [--concurrency 1,10,50,100] [--search-count 200] [--skip-daemon]
//        [--skip-cold] [--warm-only]

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createSandbox, assertIsolated, main as harnessMain, spawnGroup, killGroupAndVerify, FatalError } from "./lib/harness.mjs";

// ISOLATION.md "Benchmark window rule" (intake, 04:08Z; reviewer-1 rework,
// 15:35Z): heavy measurements take an EXCLUSIVE lock so concurrent runs cannot make numbers incomparable. mkdir is the atomic acquisition; the lock
// file records session/pid/purpose/UTC startedAt; released in finally. The
// lock is NEVER stolen automatically: an existing lock fails acquisition with
// the holder's identity. A stale lock (holder pid provably dead) is likewise
// refused — removal requires manual coordination with intake. Unreadable or
// malformed holder files fail closed and block acquisition like a live one.
const BENCH_LOCK_DIR = process.env.BENCH_LOCK_DIR_OVERRIDE ?? "/tmp/action-hub-stress/BENCH.lock";
const benchLock = { held: false };

// Holder identity comes from the environment, never a hard-coded seat name:
// the actual OpenRig session when present, else an explicit benchmark-session
// value, so runs by any operator are attributed correctly.
function benchLockSession() {
  return process.env.OPENRIG_SESSION_NAME || "unknown";
}

// Returns the parsed holder, or null when holder.json is unreadable or
// malformed. Null always means "fail closed" at the call sites.
function readBenchHolder() {
  let raw;
  try {
    raw = readFileSync(join(BENCH_LOCK_DIR, "holder.json"), "utf8");
  } catch {
    return null;
  }
  let holder;
  try {
    holder = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof holder?.pid !== "number" || holder.pid <= 0 ||
    typeof holder?.session !== "string" || holder.session === "" ||
    typeof holder?.purpose !== "string" || holder.purpose === "" ||
    typeof holder?.startedAt !== "string" || Number.isNaN(Date.parse(holder.startedAt))
  ) return null;
  return holder;
}

function acquireBenchLock() {
  mkdirSync(dirname(BENCH_LOCK_DIR), { recursive: true });
  try {
    mkdirSync(BENCH_LOCK_DIR, { recursive: false });
  } catch (cause) {
    if (cause.code !== "EEXIST") throw cause;
    // Held by someone else. Never stolen automatically — not even when the
    // holder pid is provably dead: the stale lock is refused, and removal
    // requires manual coordination with intake. Unreadable/malformed holder
    // files fail closed exactly like a live holder.
    const holder = readBenchHolder();
    let alive = null;
    if (holder) {
      try { process.kill(holder.pid, 0); alive = true; } catch (e) { alive = e.code !== "ESRCH"; }
    }
    throw new FatalError(
      `bench lock held: ${BENCH_LOCK_DIR}\n` +
      `holder: ${holder ? JSON.stringify(holder) : "unreadable or malformed holder.json (fail-closed)"}\n` +
      (alive === false
        ? "holder pid is DEAD — this lock is stale. Do not remove it silently: notify intake, coordinate removal manually, then retry.\n"
        : "heavy measurements require the exclusive window — retry later or coordinate with the holder session.\n"),
    );
  }
  writeFileSync(join(BENCH_LOCK_DIR, "holder.json"), JSON.stringify({
    session: benchLockSession(),
    pid: process.pid,
    purpose: "PR 58 bench-load (in-process/stdio/daemon measurements)",
    startedAt: new Date().toISOString(), // UTC
  }));
  benchLock.held = true;
}

function releaseBenchLock() {
  if (!benchLock.held) return;
  benchLock.held = false;
  // Release only our own lock: the holder on disk must still name this
  // session and pid. A replaced or foreign holder is never deleted here.
  let holder = null;
  try { holder = readBenchHolder(); } catch { /* fail closed */ }
  if (!holder || holder.pid !== process.pid || holder.session !== benchLockSession()) return;
  try {
    rmSync(BENCH_LOCK_DIR, { recursive: true, force: true });
  } catch { /* best effort */ }
}
// "What else was running": snapshot other live stress work on this box
// (scoped to stress workloads, never a broad sweep) at window start.
async function detectCoRunners() {
  try {
    const { stdout } = await run("pgrep", ["-f", "action-hub-stress|bench-load|k6|fake-mcp-server"]);
    const pids = stdout.split("\n").filter((x) => x && Number(x) !== process.pid);
    if (pids.length === 0) return [];
    const { stdout: psOut } = await run("ps", ["-o", "pid=,command=", "-p", pids.join(",")]).catch(() => ({ stdout: "" }));
    return psOut.split("\n").filter(Boolean).map((l) => l.trim().slice(0, 160));
  } catch {
    return []; // probe failure: recorded as unknown, never blocks
  }
}

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = realpathSync(resolve(SCRIPT_DIR, ".."));
const GENERATED = join(ROOT, "stress", ".generated");
const RESULTS_DIR = join(GENERATED, "results");
// Fresh root per run: sandbox + generated artifacts never carry state between
// runs (previous leaks taught us why).
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-") + "-" + process.pid;
// Set per-run inside runBench from the shared harness sandbox (PR 64);
// functions below read it after runBench has created the sandbox.
let RUN_ROOT = null;
const CLI_ENTRY = join(ROOT, "packages", "cli", "dist", "index.js");
const TOKEN = "stress-bench-token";

function parseArgs(argv) {
  const args = { scale: "small", transports: "http,stdio", concurrency: "1,10,50,100", searchCount: 200 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--scale") args.scale = next();
    else if (a === "--transports") args.transports = next();
    else if (a === "--concurrency") args.concurrency = next();
    else if (a === "--search-count") args.searchCount = Number(next());
    else if (a === "--skip-daemon") args.skipDaemon = true;
    else if (a === "--skip-cold") args.skipCold = true;
    else if (a === "--warm-only") { args.skipCold = true; args.warmOnly = true; }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------- isolation

// ISOLATION.md (revised): REPLACE the full env checklist under one fresh root;
// determine the real owner home independently of $HOME and refuse to run if
// any resolved path lands inside the owner's app-state or harness dirs.
// Containment is separator-safe (path.relative + isAbsolute/'..').

// ------------------------------------------------- fallback fixture builders
// Contract-shaped minimal fixtures so the bench can run before builder-1/2/4's
// generators have produced the corpus. At full scale the corpus must match
// exactly (44 servers / 10,000 tools); a mismatch is a hard error, never a
// silent wrong-scale benchmark (reviewer blocker 6).

const SCALES = {
  small: { toolServers: 2, toolsPerServer: 10, bigServers: 0, bigTools: 0, skills: 10 },
  full: { toolServers: 40, toolsPerServer: 200, bigServers: 4, bigTools: 500, skills: 5000 },
};

function fixtureDirFor(scale) {
  return scale === "full" ? join(GENERATED, "tools") : join(GENERATED, "fixtures", "small", "tools");
}

function fakeTool(index) {
  return {
    name: `action_${index}`,
    description: `Fixture tool ${index}: performs fixture operation ${index} over fixture records.`,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "record id" },
        limit: { type: "number", description: "max results" },
        query: { type: "string", description: "filter text" },
      },
    },
    annotations: { readOnlyHint: index % 2 === 0 },
    // index 0 is zero-latency readOnly errorRate-0: the cache probe target.
    behavior: { latencyMs: index === 0 ? 0 : 5, errorRate: 0, responseBytes: 512 },
  };
}

async function countDirs(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

async function ensureToolFixtures() {
  const dir = fixtureDirFor(args.scale);
  await mkdir(dir, { recursive: true });
  const { readdir: rd } = await import("node:fs/promises");
  const existing = (await rd(dir)).filter((f) => f.endsWith(".json"));
  const manifests = [];
  for (const f of existing) {
    const m = JSON.parse(await readFile(join(dir, f), "utf8"));
    if (m.serverId && Array.isArray(m.tools)) manifests.push(m);
  }
  const scale = SCALES[args.scale];
  const expectedTools = scale.toolServers * scale.toolsPerServer + scale.bigServers * scale.bigTools;
  const corpusTools = manifests.reduce((a, m) => a + m.tools.length, 0);
  if (args.scale === "full") {
    // The full corpus is builder-4's; validate, never approximate.
    if (manifests.length !== SCALES.full.toolServers + SCALES.full.bigServers || corpusTools !== expectedTools) {
      throw new Error(
        `full-scale corpus mismatch: found ${manifests.length} manifests / ${corpusTools} tools, expected ${SCALES.full.toolServers + SCALES.full.bigServers} / ${expectedTools}. Run stress/gen-tools.mjs first.`,
      );
    }
    return manifests;
  }
  // small: generate exactly what the scale defines (idempotent).
  if (manifests.length !== scale.toolServers + scale.bigServers || corpusTools !== expectedTools) {
    for (const f of existing) await rm(join(dir, f), { force: true });
    manifests.length = 0;
    const add = async (serverId, count) => {
      const manifest = { serverId, tools: [] };
      for (let i = 0; i < count; i++) manifest.tools.push(fakeTool(i));
      manifests.push(manifest);
      await writeFile(join(dir, `${serverId}.json`), JSON.stringify(manifest, null, 2));
    };
    for (let s = 0; s < scale.toolServers; s++) await add(`fixture-srv-${String(s).padStart(3, "0")}`, scale.toolsPerServer);
    for (let s = 0; s < scale.bigServers; s++) await add(`fixture-big-${String(s).padStart(2, "0")}`, scale.bigTools);
  }
  return manifests;
}

async function ensureSkillFixtures() {
  const dir = join(RUN_ROOT, "skills");
  const scale = SCALES[args.scale];
  const sourceDir = join(GENERATED, "skills");
  if (args.scale === "full") {
    // Validate the SOURCE corpus (the run root starts empty by design).
    const sourceCount = await countDirs(sourceDir);
    if (sourceCount !== scale.skills) {
      throw new Error(
        `full-scale skills mismatch: found ${sourceCount}, expected ${scale.skills}. Run stress/gen-skills.mjs first.`,
      );
    }
    // Copy the real corpus into the run root so isolation holds.
    const { cp } = await import("node:fs/promises");
    await cp(sourceDir, dir, { recursive: true });
    return;
  }
  await mkdir(dir, { recursive: true });
  const existing = await countDirs(dir);
  for (let i = existing; i < scale.skills; i++) {
    const slug = `fixture-skill-${String(i).padStart(4, "0")}`;
    await mkdir(join(dir, slug), { recursive: true });
    await writeFile(
      join(dir, slug, "SKILL.md"),
      `---\nname: Fixture Skill ${i}\ndescription: Fixture skill number ${i} for load testing the catalog.\n---\nSentence one about fixture skill ${i}. Sentence two describing when to use it. Sentence three with procedural detail. Sentence four closing the instructions.\n`,
    );
  }
}

async function ensureFakeServer() {
  const owned = join(SCRIPT_DIR, "fake-mcp-server.mjs");
  if (await stat(owned).then(() => true, () => false)) return owned;
  // builder-2's file is absent: materialize a contract-compatible stdio fake
  // server under the run root (gitignored) rather than silently skipping.
  const fallback = join(RUN_ROOT, "fallback-fake-mcp-server.mjs");
  await writeFile(
    fallback,
    `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
const manifestPath = process.argv[process.argv.indexOf("--manifest") + 1];
const { tools } = JSON.parse(await readFile(manifestPath, "utf8"));
const rl = createInterface({ input: process.stdin });
const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const reply = (result) => write({ jsonrpc: "2.0", id: msg.id, result });
  if (msg.method === "initialize") reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0.0.1" } });
  else if (msg.method === "tools/list") reply({ tools: tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) });
  else if (msg.method === "tools/call") {
    const tool = tools.find((t) => t.name === msg.params?.name) ?? tools[0];
    const b = tool?.behavior ?? { latencyMs: 5, responseBytes: 512 };
    setTimeout(() => reply({ content: [{ type: "text", text: "x".repeat(b.responseBytes) }], isError: false }), b.latencyMs ?? 0);
  }
  else if (msg.id !== undefined) write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not found" } });
});
`,
  );
  return fallback;
}

async function ensureBenchConfig(manifests, isolatedEnv) {
  // Bench-private config: always freshly written for THIS run from the actual
  // manifests, never a reused shared servers.json (reviewer blocker 6).
  const fakeServer = await ensureFakeServer();
  const servers = manifests.map((m) => ({
    id: m.serverId,
    displayName: m.serverId,
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [fakeServer, "--manifest", join(fixtureDirFor(args.scale), `${m.serverId}.json`)],
    },
    // Load bench, not policy bench: explicit trusted so execute measures the
    // hub, not approval gating. make-config's output (if present) is untouched.
    trust: "trusted",
    enabled: true,
  }));
  const target = isolatedEnv.ACTION_HUB_CONFIG;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify({ servers, autoDiscover: false }, null, 2));
  return target;
}

// ------------------------------------------------------------------ clients

class HttpMcpClient {
  constructor(port) {
    this.base = `http://127.0.0.1:${port}/mcp`;
    this.headers = {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
      accept: "application/json, text/event-stream",
    };
    this.nextId = 1;
  }
  async call(method, params, timeoutMs = 60_000) {
    const id = this.nextId++;
    const res = await fetch(this.base, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const text = await res.text();
    const dataLine = text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data:")) : text;
    const body = JSON.parse(dataLine.startsWith("data:") ? dataLine.slice(5).trim() : dataLine);
    if (body.error) throw new Error(body.error.message);
    return body.result;
  }
}

class StdioMcpClient {
  constructor(handle) {
    // Design C: stdin/stdout are anchor-relayed pipe ends on the handle.
    this.handle = handle;
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    handle.stdout.setEncoding("utf8");
    handle.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            this.pending.get(msg.id)(msg);
            this.pending.delete(msg.id);
          }
        } catch { /* partial line */ }
      }
    });
  }
  async call(method, params, timeoutMs = 120_000) {
    const id = this.nextId++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.pending.delete(id); rej(new Error(`timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) rej(new Error(msg.error.message ?? "rpc error"));
        else res(msg.result);
      });
      try {
        this.handle.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch (cause) {
        clearTimeout(timer);
        this.pending.delete(id);
        rej(cause);
      }
    });
  }
}

// All child processes spawn through the shared lib's spawnGroup (PR 64 +
// LIB2): detached fresh group with ownership proof, auto-registered, and
// interrupt-safe (the lib's main() signal handling sweeps every registered
// group). Handles are kept here so failure paths can kill+verify each one.
const ownedHandles = new Set();

// The real hub daemon is spawned detached by the product launcher (daemon
// start), so it can NEVER have an owned handle — instead its recorded pid
// is kept here. The lib's main() extraInterruptCleanup hook kills+verifies
// it inline when an interrupt settles (no handle fabrication).
let recordedDaemonPid = null;

async function spawnNode(cmdArgs, env, stdio) {
  // spawnGroup (LIB2 Design C): async — resolves only after the workload
  // spawn is confirmed over the anchor's control channel. Handle fields:
  // pid (workload), pgid (anchor), stdin/stdout/stderr (relays), exited
  // (workload exit; anchorDied:true + error if the anchor died unreported).
  const handle = await spawnGroup(process.execPath, cmdArgs, { env, cwd: ROOT, stdio });
  ownedHandles.add(handle);
  return handle;
}

// Interrupt gate: after a signal, spawnGroup refuses new work — probe it at
// every phase boundary so the fn settles FAST and the lib's interrupt
// serializer (one writer) owns the final summary. Without this, a caught
// daemon-phase error lets the fn complete and race the sweep (reviewer
// round 7, 2).
async function assertNotInterrupted() {
  const probe = await spawnNode(["-e", "process.exit(0)"], process.env);
  await probe.exited;
  // The ANCHOR outlives a natural workload exit by design — only
  // killGroupAndVerify dissolves it. A lingering anchor keeps the event
  // loop alive, so every naturally-exited handle must be dissolved.
  await killGroupAndVerify(probe);
  ownedHandles.delete(probe);
}

// Reaps every group recorded by THIS run (LIB2 killGroupAndVerify: TERM ->
// bounded -> SIGKILL -> poll kill(-pgid,0) until ESRCH; refuses bare pgids).
// Called before the summary and on every failure path.
async function reapAllOwned() {
  const survivors = [];
  for (const handle of [...ownedHandles]) {
    const result = await killGroupAndVerify(handle);
    // Only a verified-empty group drops its handle (reviewer round 7, 1).
    if (result.groupEmpty) {
      ownedHandles.delete(handle);
    } else {
      survivors.push(handle.pgid);
      if (Array.isArray(result.survivors) && result.survivors.length > 0) survivors.push(...result.survivors);
    }
  }
  return survivors;
}

// ------------------------------------------------------------ RSS sampling

function rssOf(pid) {
  return new Promise((res) => {
    const ps = spawn("ps", ["-o", "rss=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    ps.stdout.on("data", (d) => (out += d));
    ps.on("close", () => res(Number(out.trim().split("\n")[0]) || 0));
    ps.on("error", () => res(0));
  });
}

async function childPidsOf(pid) {
  // pgrep -P is portable (macOS ps lacks --ppid).
  try {
    const { stdout } = await run("pgrep", ["-P", String(pid)]);
    return stdout.split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

// Samples the hub AND its recursive child tree each tick. Reports the peak
// SIMULTANEOUS tree total (sum across the whole tree within one tick — the
// honest headline) plus per-process independent peaks explicitly labelled as
// an upper bound, never as a simultaneous total (reviewer blocker 8).
async function rssSampler(rootPid, intervalMs = 250) {
  let running = true;
  let peakSimultaneousTreeRssKb = 0;
  let peakTreeSize = 0;
  const perProcessPeaks = new Map();
  async function treeSnapshot(root) {
    const pids = [];
    const queue = [root];
    const visited = new Set();
    while (queue.length > 0) {
      const pid = queue.shift();
      if (visited.has(pid)) continue;
      visited.add(pid);
      pids.push(pid);
      for (const childPid of await childPidsOf(pid)) queue.push(childPid);
    }
    let total = 0;
    for (const pid of pids) total += await rssOf(pid);
    return { pids, total };
  }
  const loop = (async () => {
    while (running) {
      const { pids, total } = await treeSnapshot(rootPid);
      if (total > peakSimultaneousTreeRssKb) peakSimultaneousTreeRssKb = total;
      if (pids.length > peakTreeSize) peakTreeSize = pids.length;
      for (const pid of pids) {
        // rssOf already ran inside the snapshot; reuse via a per-pid peak map
        // needs a second read — cheap enough and bounded by tree size.
        const kb = await rssOf(pid);
        if (kb > (perProcessPeaks.get(pid) ?? 0)) perProcessPeaks.set(pid, kb);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop.catch(() => undefined);
      const upperBoundSumOfIndependentPeaksKb = [...perProcessPeaks.values()].reduce((a, b) => a + b, 0);
      return {
        // Observed peak of hub+children RSS summed within a single tick.
        peakSimultaneousTreeRssKb,
        // Upper bound only: each process's own peak, summed — these peaks may
        // never have occurred at the same moment. NOT a simultaneous total.
        upperBoundSumOfIndependentPeaksKb,
        hubPeakRssKb: perProcessPeaks.get(rootPid) ?? 0,
        peakTreeSize,
        sampledPids: perProcessPeaks.size,
      };
    },
  };
}

// ------------------------------------------------------------- measurement

const percentile = (sorted, p) => {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
};

async function runConcurrent(workers, concurrency, task) {
  const results = [];
  let cursor = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, workers)) }, async () => {
    while (cursor < workers) {
      const i = cursor++;
      results.push(await task(i));
    }
  });
  await Promise.all(lanes);
  return results;
}

function argsHash(actionId, params) {
  return createHash("sha1").update(actionId + JSON.stringify(params ?? {})).digest("hex").slice(0, 12);
}

// Intake lesson (PR 47 review): HTTP 200 alone proves nothing. A call is
// successful only if the JSON-RPC response carries no error, the tool result
// is not isError, and (for search) it actually returned results.
function parseToolResult(res) {
  const text = res.content?.[0]?.text ?? "";
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { payload: {}, ok: false, reason: "unparseable result" };
  }
  if (res.isError === true) return { payload, ok: false, reason: "isError" };
  if (typeof payload.ok !== "boolean") return { payload, ok: false, reason: "no ok field" };
  return { payload, ok: payload.ok === true && (payload.count === undefined || payload.count > 0) };
}

// Minimal valid arguments for a JSON Schema: fill required properties per
// primitive type (full-scale fixtures have required fields).
function schemaArgs(schema) {
  const out = {};
  if (!schema || schema.type !== "object" || !schema.properties) return out;
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (!(schema.required ?? []).includes(key)) continue;
    switch (prop?.type) {
      case "string": out[key] = "bench"; break;
      case "number":
      case "integer": out[key] = 1; break;
      case "boolean": out[key] = true; break;
      case "array": out[key] = []; break;
      case "object": out[key] = {}; break;
      default: out[key] = null;
    }
  }
  return out;
}

// ------------------------------------------------------------------- main

function validateInputs() {
  // Reviewer round 7, 3: reject empty/invalid measurement inputs before any
  // work (an empty list silently produced ok:true with zero measurements,
  // and an unknown transport silently ran stdio under a wrong label).
  const requested = args.transports.split(",").filter(Boolean);
  const valid = ["http", "stdio"];
  const unknown = requested.filter((t) => !valid.includes(t));
  if (requested.length === 0 || unknown.length > 0) {
    throw new FatalError(`--transports invalid: requested=${JSON.stringify(args.transports)} (nonempty subset of ${valid.join(",")} required; unknown=${JSON.stringify(unknown)})`);
  }
  if (!["small", "full"].includes(args.scale)) {
    throw new FatalError(`--scale invalid: ${JSON.stringify(args.scale)} (small|full)`);
  }
  if (!Number.isFinite(args.searchCount) || args.searchCount <= 0) {
    throw new FatalError(`--search-count invalid: ${JSON.stringify(args.searchCount)}`);
  }
  if (!args.concurrency.split(",").map(Number).every((n) => Number.isFinite(n) && n > 0)) {
    throw new FatalError(`--concurrency invalid: ${JSON.stringify(args.concurrency)}`);
  }
}

async function runBench() {
  validateInputs();
  const coRunners = await detectCoRunners();
  acquireBenchLock();
  const t0 = Date.now();
  const gate = async () => {
    await assertNotInterrupted();
  };
  await mkdir(RESULTS_DIR, { recursive: true });
  // Shared harness (PR 64): run root, full ISOLATION.md env, sentinel.
  const sandbox = createSandbox({ prefix: "bench-load-", mkdir: ["skills"] });
  RUN_ROOT = sandbox.root;
  const env = {
    ...sandbox.env,
    ACTION_HUB_HTTP_TOKEN: TOKEN,
  };
  // Bench-private config lives in the run root (validated again after overrides).
  assertIsolated(env, RUN_ROOT);
  // Reviewer blocker 8: never leave a stale successful result behind.
  await rm(join(RESULTS_DIR, "bench-load.json"), { force: true });

  // BENCH_INJECT_ORPHAN_GROUP: deterministic regression (reviewer round 5) —
  // a detached group leader exits while a same-group descendant sleeps on;
  // reapAllOwned must still signal the group and gate on ESRCH.
  if (process.env.BENCH_INJECT_ORPHAN_GROUP) {
    const leader = await spawnNode(
      ["-e", `const { spawn } = require("node:child_process"); spawn("sleep", ["2997"], { stdio: "ignore" }); setTimeout(() => process.exit(0), 50);`],
      env,
    );
    await leader.exited;
    // Anchor dissolution is owned by the final reapAllOwned sweep.
    console.error("bench-load: injected orphan group (leader exited, sleep 2997 descendant alive; final reapAllOwned must verify-kill it)");
  }
  const summary = {
    bench: "bench-load",
    ok: false,
    scale: args.scale,
    runRoot: RUN_ROOT,
    startedAt: new Date(t0).toISOString(),
    fixtures: {},
    coldStart: null,
    warmStart: null,
    search: {},
    load: {},
    execute: {},
    cache: {},
    tokenCost: {},
    daemon: null,
    memory: {},
    flags: [],
  };
  const flagIf = (cond, msg) => { if (cond) summary.flags.push(msg); };

  // -- fixtures -------------------------------------------------------------
  const manifests = await ensureToolFixtures();
  await ensureSkillFixtures();
  await ensureBenchConfig(manifests, env);
  const manifestToolCount = manifests.reduce((a, m) => a + m.tools.length, 0);
  const skillsCount = await countDirs(env.ACTION_HUB_SKILLS_DIR);
  summary.fixtures = { servers: manifests.length, tools: manifestToolCount, skills: skillsCount };
  console.error(`bench-load: fixtures ready (${manifests.length} servers, ${manifestToolCount} tools, ${skillsCount} skills)`);

  // Tool ids per server, from the actual manifests; readOnly + errorRate-0
  // tools are the only ones that execute without approval or fixture-injected
  // errors — throughput and cache probes use those.
  const toolsByServer = manifests.map((m) => ({ serverId: m.serverId, tools: m.tools.map((t) => t.name) }));
  const readOnlyTools = manifests.map((m) => ({
    serverId: m.serverId,
    tools: m.tools
      .filter((t) => t.annotations?.readOnlyHint === true && (t.behavior?.errorRate ?? 0) === 0)
      .map((t) => t.name),
  }));
  const schemaByAction = new Map(
    manifests.flatMap((m) => m.tools.map((t) => [`${m.serverId}:${t.name}`, t.inputSchema])),
  );
  const probeAction = (serverIndex, toolIndex) =>
    `${manifests[serverIndex].serverId}:${manifests[serverIndex].tools[toolIndex % manifests[serverIndex].tools.length].name}`;
  const actionSchema = (actionId) => schemaByAction.get(actionId);

  // -- hub lifecycle ---------------------------------------------------------
  function appendHubLog(path, text) {
    try { appendFileSync(path, text); } catch { /* best effort */ }
  }

  async function bootHub(transport) {
    console.error(`bench-load: booting hub (${transport})`);
    const started = Date.now();
    const hubLog = join(RESULTS_DIR, `hub-${transport}-${RUN_ID}.log`);
    let port;
    let client;
    let handle;
    if (transport === "http") {
      handle = await spawnNode([CLI_ENTRY, "serve", "--port", "0"], env);
      handle.stderr.setEncoding("utf8");
      handle.stderr.on("data", (d) => appendHubLog(hubLog, d));
      port = await new Promise((res, rej) => {
        let acc = "";
        const onData = (d) => {
          acc += d.toString();
          const m = acc.match(/127\.0\.0\.1:(\d+)/);
          if (m) { handle.stderr.off("data", onData); res(Number(m[1])); }
        };
        handle.stderr.on("data", onData);
        // No orphaned hub: every rejection path kills the spawned group.
        const rejectWithKill = (cause) => {
          clearTimeout(neverBoundTimer);
          void killGroupAndVerify(handle);
          rej(cause);
        };
        let settleEarly = null;
        handle.exited.then(({ code }) => { if (settleEarly) settleEarly(code); });
        settleEarly = (code) => rejectWithKill(new Error(`serve exited early (${code ?? "?"}): ${acc}`));
        const neverBoundTimer = setTimeout(
          () => rejectWithKill(new Error(`serve never bound a port: ${acc}`)),
          120_000,
        );
        neverBoundTimer.unref();
      });
      client = new HttpMcpClient(port);
    } else {
      // The stdio hub speaks MCP over stdin/stdout: stdin must be piped.
      handle = await spawnNode([CLI_ENTRY, "start"], env, ["pipe", "pipe", "pipe"]);
      handle.stderr.setEncoding("utf8");
      handle.stderr.on("data", (d) => appendHubLog(hubLog, d));
      client = new StdioMcpClient(handle);
    }
    handle.exited.then(({ code, signal }) => appendHubLog(hubLog, `\n[HUB EXITED code=${code} signal=${signal}]\n`));
    return { handle, client, started, transport, port, hubLog };
  }

  async function stopHub(hub) {
    // LIB2 killGroupAndVerify: gates every negative-pgid signal on the
    // anchor being provably live; healthy teardown dissolves via the control
    // channel with NO signal; dead anchor fails closed. A failed verdict
    // keeps the handle registered for the final sweep (reviewer round 7, 1).
    const verdict = await killGroupAndVerify(hub.handle);
    if (!verdict.groupEmpty) {
      throw new Error(`stopHub: group ${hub.handle.pgid} not verified empty after kill (${JSON.stringify(verdict.survivors ?? [])})`);
    }
    ownedHandles.delete(hub.handle);
  }

  async function awaitReady(hub) {
    await hub.client.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bench", version: "0" } }, 180_000);
    const t = Date.now();
    for (;;) {
      try {
        const res = await hub.client.call("tools/call", {
          name: "action_hub",
          arguments: { operation: "search", query: "fixture", limit: 1 },
        }, 60_000);
        const payload = JSON.parse(res.content?.[0]?.text ?? "{}");
        if (payload.ok) return { ms: Date.now() - t, results: payload.count ?? 0 };
      } catch (cause) {
        if (Date.now() - t > 300_000) throw cause;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // -- cold / warm start ------------------------------------------------------
  await gate();
  if (!args.skipCold) {
    const hub = await bootHub("http");
    const sampler = await rssSampler(hub.handle.pid);
    try {
      const cold = await awaitReady(hub);
      summary.coldStart = { ...cold, bootToReadyMs: Date.now() - hub.started };
      const searchRes = await hub.client.call("tools/call", {
        name: "action_hub",
        arguments: { operation: "search", query: "fixture operation", limit: 10 },
      });
      const searchText = searchRes.content?.[0]?.text ?? "";
      summary.tokenCost.search10 = { chars: searchText.length, tokensEstimate: Math.ceil(searchText.length / 4) };
      const loadRes = await hub.client.call("tools/call", {
        name: "action_hub",
        arguments: { operation: "load", action_id: probeAction(0, 0) },
      });
      const loadText = loadRes.content?.[0]?.text ?? "";
      summary.tokenCost.load = { chars: loadText.length, tokensEstimate: Math.ceil(loadText.length / 4) };
      summary.memory.coldStart = await sampler.stop();
    } finally {
      await stopHub(hub);
    }
  }

  if (summary.coldStart || args.warmOnly) {
    const hub = await bootHub("http");
    try {
      const warm = await awaitReady(hub);
      summary.warmStart = { ...warm, bootToReadyMs: Date.now() - hub.started };
    } finally {
      await stopHub(hub);
    }
  }

  // -- per-transport scenarios -----------------------------------------------
  const concurrencyLevels = args.concurrency.split(",").map(Number).filter(Boolean);
  // Reviewer blocker 1: a FIXED sample count per band, always >= requested
  // concurrency, so c50/c100 really run 50/100 concurrent lanes.
  const perBand = Math.max(args.searchCount, ...concurrencyLevels);

  // Reviewer-noted hazard: other agents' cleanup sweeps SIGTERM live hubs.
  // Detect an externally-terminated hub and retry the scenario once.
  for (const transport of args.transports.split(",").filter(Boolean)) {
    for (let attempt = 1; ; attempt++) {
      const externallyKilled = await runTransportScenario(transport);
      if (!externallyKilled) break;
      if (attempt >= 2) {
        // Reviewer round 4: a second external termination must not produce a
        // green summary — fail the run outright instead of breaking quietly.
        throw new Error(`${transport}: hub externally terminated (SIGTERM) twice — refusing to retry again`);
      }
      summary.flags.push(
        `${transport}: hub killed by an external SIGTERM mid-run (likely another agent's cleanup sweep); attempt ${attempt} discarded, retrying`,
      );
    }
  }

  /**
   * Runs the full search/load/execute/cache/memory scenario for one transport.
   * Returns true only if the hub was killed by an external signal mid-run
   * (internal failures throw / record flags as usual).
   */
  async function runTransportScenario(transport) {
    let externallyKilled = false;
    let stopping = false;
      const hub = await bootHub(transport);
      const sampler = await rssSampler(hub.handle.pid);
      let hubAlive = true;
      hub.handle.exited.then(() => { hubAlive = false; });
      // Intake: retries must not mask real crashes. Mark external kills
      // explicitly; the retry itself is recorded as a flag in the results.
      hub.handle.exited.then(({ signal, anchorDied }) => {
        // Only an actual SIGTERM is external interference (intake rule).
        // Any other unexpected exit (self-exit, crash, SIGKILL) must NOT be
        // masked as external — the catch rethrows and the run fails.
        // anchorDied:true is the ANCHOR's death, not the workload's exit.
        if (!stopping && !anchorDied && signal === "SIGTERM") externallyKilled = true;
      });
      try {
        await hub.client.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bench", version: "0" } }, 180_000);
        await awaitReady(hub);
        // BENCH_INJECT_SELF_EXIT: deterministic regression — SIGKILLs the hub
        // mid-band. A SIGKILL is NOT an external SIGTERM, so the run must fail
        // (ok=false, exit 1) rather than retry (reviewer round 4, finding 1).
        if (process.env.BENCH_INJECT_SELF_EXIT) {
          await new Promise((r) => setTimeout(r, 100));
          await killGroupAndVerify(hub.handle);
        }

        // search latency: fixed sample count per band
        const searchStats = {};
        for (const c of concurrencyLevels) {
          console.error(`bench-load: ${transport} search c${c} (${perBand} reqs) starting`);
          const lat = await runConcurrent(perBand, c, async (i) => {
            // BENCH_INJECT_SEARCH_ERROR: test hook — one injected failed
            // request proves partial-failure gating (ok=false, exit 1).
            if (process.env.BENCH_INJECT_SEARCH_ERROR && i === 5) {
              return { ms: 0, ok: false, errType: "injected-test-error", hubAliveAtError: true };
            }
            const q = `fixture op ${argsHash("search", { t: transport, c, i })}`;
            const t = performance.now();
            try {
              const res = await hub.client.call("tools/call", {
                name: "action_hub",
                arguments: { operation: "search", query: q, limit: 10 },
              });
              const ms = performance.now() - t;
              const parsed = parseToolResult(res);
              return { ms, ok: parsed.ok, errType: parsed.ok ? null : parsed.reason };
            } catch (cause) {
              // F29 evidence: classify failures and snapshot hub liveness —
              // ECONNRESET with a live hub is endpoint failure, not process death.
              return {
                ms: performance.now() - t,
                ok: false,
                errType: cause.cause?.code ?? cause.message,
                hubAliveAtError: hubAlive,
              };
            }
          });
          const ok = lat.filter((x) => x.ok);
          const sorted = ok.map((x) => x.ms).sort((a, b) => a - b);
          const errBreakdown = {};
          for (const x of lat.filter((y) => !y.ok)) errBreakdown[x.errType] = (errBreakdown[x.errType] ?? 0) + 1;
          const hubAliveAtError = lat.some((x) => x.hubAliveAtError === true);
          searchStats[`c${c}`] = {
            requests: perBand,
            concurrency: c, // actual lane count (perBand >= c guaranteed)
            successful: ok.length,
            errors: lat.length - ok.length,
            errBreakdown: Object.keys(errBreakdown).length > 0 ? errBreakdown : undefined,
            hubAliveAtError: hubAliveAtError || undefined,
            p50: +percentile(sorted, 50).toFixed(1),
            p95: +percentile(sorted, 95).toFixed(1),
            p99: +percentile(sorted, 99).toFixed(1),
          };
          flagIf(ok.length === 0, `${transport} search c${c}: zero successful calls`);
          if (lat.length - ok.length > 0) {
            flagIf(true, `search ${transport} c${c}: ${lat.length - ok.length} failed (${JSON.stringify(errBreakdown)})${hubAliveAtError ? " with hub ALIVE — endpoint-level failure (F29 candidate)" : " with hub process dead"}`);
          }
        }
        summary.search[transport] = searchStats;

        // load latency: percentiles over successful requests only
        console.error(`bench-load: ${transport} load starting`);
        const loadLat = await runConcurrent(perBand, 10, async (i) => {
          const entry = toolsByServer[i % toolsByServer.length];
          const action = `${entry.serverId}:${entry.tools[i % entry.tools.length]}`;
          const t = performance.now();
          const res = await hub.client.call("tools/call", {
            name: "action_hub",
            arguments: { operation: "load", action_id: action },
          });
          return { ms: performance.now() - t, ok: parseToolResult(res).ok };
        });
        const loadOk = loadLat.filter((x) => x.ok);
        const loadSorted = loadOk.map((x) => x.ms).sort((a, b) => a - b);
        summary.load[transport] = {
          requests: perBand,
          successful: loadOk.length,
          errors: loadLat.length - loadOk.length,
          p50: +percentile(loadSorted, 50).toFixed(1),
          p95: +percentile(loadSorted, 95).toFixed(1),
          p99: +percentile(loadSorted, 99).toFixed(1),
        };
        flagIf(loadOk.length === 0, `${transport} load: zero successful calls`);

        // execute throughput: successful calls / elapsed (failures reported, not
        // silently folded into throughput)
        console.error(`bench-load: ${transport} execute starting`);
        const execStart = performance.now();
        const exec = await runConcurrent(300, 10, async (i) => {
          const entry = readOnlyTools[i % readOnlyTools.length];
          const action = `${entry.serverId}:${entry.tools[i % entry.tools.length]}`;
          const res = await hub.client.call("tools/call", {
            name: "action_hub",
            arguments: { operation: "execute", action_id: action, arguments: schemaArgs(actionSchema(action)) },
          });
          return parseToolResult(res).ok;
        });
        const execSecs = (performance.now() - execStart) / 1000;
        const execOk = exec.filter(Boolean).length;
        summary.execute[transport] = {
          calls: 300,
          successful: execOk,
          errors: 300 - execOk,
          throughputOpsPerSec: +(execOk / execSecs).toFixed(2),
        };
        flagIf(execOk === 0, `${transport} execute: zero successful calls`);

        // cache behaviour: indirect (the dispatch layer drops ExecuteResult.cached
        // — see flags). Compare identical-args repeats against distinct-args
        // calls of the SAME zero-latency readOnly tool; a hit shows as repeat
        // latency collapsing toward ~0 while uncached stays at round-trip cost.
        const cacheTool = (() => {
          const manifest = manifests.find((m) => m.tools.some((t) => t.annotations?.readOnlyHint === true && (t.behavior?.errorRate ?? 0) === 0 && (t.behavior?.latencyMs ?? 0) === 0));
          const tool = manifest?.tools.find((t) => t.annotations?.readOnlyHint === true && (t.behavior?.errorRate ?? 0) === 0 && (t.behavior?.latencyMs ?? 0) === 0);
          return tool ? { serverId: manifest.serverId, name: tool.name } : null;
        })();
        if (cacheTool) {
          const action = `${cacheTool.serverId}:${cacheTool.name}`;
          const schema = actionSchema(action);
          const repeats = await runConcurrent(100, 10, async (ri) => {
            // BENCH_INJECT_CACHE_ERROR: test hook — one injected failed cache
            // request proves the cache success contract (ok=false, exit 1).
            if (process.env.BENCH_INJECT_CACHE_ERROR && ri === 5) return { ms: 0, ok: false };
            const t = performance.now();
            const res = await hub.client.call("tools/call", {
              name: "action_hub",
              arguments: { operation: "execute", action_id: action, arguments: schemaArgs(schema) },
            });
            return { ms: performance.now() - t, ok: parseToolResult(res).ok };
          });
          const baseline = await runConcurrent(100, 10, async (i) => {
            const t = performance.now();
            const res = await hub.client.call("tools/call", {
              name: "action_hub",
              arguments: { operation: "execute", action_id: action, arguments: { ...schemaArgs(schema), unique: `u${i}` } },
            });
            return { ms: performance.now() - t, ok: parseToolResult(res).ok };
          });
          const repOk = repeats.filter((x) => x.ok).map((x) => x.ms).sort((a, b) => a - b);
          const baseOk = baseline.filter((x) => x.ok).map((x) => x.ms).sort((a, b) => a - b);
          const medRepeat = percentile(repOk, 50);
          const medBase = percentile(baseOk, 50);
          summary.cache[transport] = {
            method: "indirect-latency (cached flag dropped by dispatch)",
            repeatsRequested: repeats.length,
            repeats: repOk.length,
            repeatsErrors: repeats.length - repOk.length,
            distinctRequested: baseline.length,
            distinctCalls: baseOk.length,
            distinctErrors: baseline.length - baseOk.length,
            medianRepeatMs: +medRepeat.toFixed(2),
            medianDistinctMs: +medBase.toFixed(2),
            speedup: medBase > 0 ? +(medBase / Math.max(medRepeat, 0.01)).toFixed(2) : null,
          };
          flagIf(repOk.length === 0 || baseOk.length === 0, `${transport} cache probe: zero successful calls`);
        } else {
          summary.cache[transport] = { method: "skipped: no zero-latency readOnly errorRate-0 tool in corpus" };
        }

        summary.memory[transport] = await sampler.stop();
        flagIf(
          summary.memory[transport].peakSimultaneousTreeRssKb > 1_500_000,
          `${transport} peak simultaneous hub+tree RSS ${(summary.memory[transport].peakSimultaneousTreeRssKb / 1024).toFixed(0)}MB > 1.5GB`,
        );
      } catch (cause) {
        // Mid-scenario hub death (e.g. external SIGTERM): retry only when we
        // positively saw an external kill; real crashes rethrow and fail the run.
        if (externallyKilled) return true;
        throw cause;
      } finally {
        stopping = true;
        await stopHub(hub);
      }
      return externallyKilled;
  }


  // -- daemon mode: 20 concurrent connect clients -----------------------------
  await gate();
  if (!args.skipDaemon) {
    const daemonConnects = [];
    const daemonEnv = env;
    let daemonPid;
    try {
      console.error(`bench-load: daemon scenario starting`);
      // No early polling resolve (reviewer blocker 2): resolve ONLY from the
      // launcher's exit message, which carries the real daemon pid.
      const startDaemon = async () => {
        const launcherHandle = await spawnNode([CLI_ENTRY, "daemon", "start"], daemonEnv);
        let out = "";
        launcherHandle.stdout.setEncoding("utf8");
        launcherHandle.stderr.setEncoding("utf8");
        launcherHandle.stdout.on("data", (d) => (out += d));
        launcherHandle.stderr.on("data", (d) => (out += d));
        const exited = launcherHandle.exited.then(({ code }) => code);
        const timer = new Promise((rej2) => {
          setTimeout(() => {
            void killGroupAndVerify(launcherHandle); // no orphaned launcher on timeout
            rej2(new Error(`daemon start timed out: ${out}`));
          }, 180_000).unref();
        });
        const code = await Promise.race([exited, timer]);
        if (code instanceof Error) throw code;
        const started = out.match(/started \(pid (\d+)\)/);
        if (started) {
          // Launcher exited naturally; dissolve its (empty) group so the
          // anchor cannot hold the event loop open.
          const verdict = await killGroupAndVerify(launcherHandle);
          ownedHandles.delete(launcherHandle);
          if (!verdict.groupEmpty) throw new Error(`daemon launcher group survived dissolution: ${JSON.stringify(verdict.survivors ?? [])}`);
          return { pid: Number(started[1]) };
        }
        const m = out.match(/already running \(pid (\d+)\)/);
        if (m) {
          try { process.kill(Number(m[1]), "SIGTERM"); } catch { /* gone */ }
        }
        throw Object.assign(new Error(`daemon launcher exited (${code}): ${out.trim()}`), { stalePid: m?.[1] });
      };
      try {
        daemonPid = (await startDaemon()).pid;
        recordedDaemonPid = daemonPid;
      } catch (cause) {
        if (!cause.stalePid) throw cause;
        await new Promise((r) => setTimeout(r, 1500));
        daemonPid = (await startDaemon()).pid;
        recordedDaemonPid = daemonPid;
      }

      // 20 clients boot; each initialize must answer.
      const clientStart = performance.now();
      const clients = await runConcurrent(20, 20, async (i) => {
        const connectHandle = await spawnNode([CLI_ENTRY, "connect"], daemonEnv, ["pipe", "pipe", "pipe"]);
        const client = new StdioMcpClient(connectHandle);
        daemonConnects.push({ handle: connectHandle });
        await client.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bench", version: "0" } }, 120_000);
        return { client, i };
      });
      const connectMs = performance.now() - clientStart;
      if (clients.length !== 20) throw new Error(`only ${clients.length}/20 connect clients booted`);

      // each client searches concurrently; results must be valid
      const lat = await runConcurrent(20, 20, async (idx) => {
        const { client } = clients[idx];
        const t = performance.now();
        const res = await client.call("tools/call", {
          name: "action_hub",
          arguments: { operation: "search", query: `daemon probe ${argsHash("daemon", { idx })}`, limit: 10 },
        });
        const ms = performance.now() - t;
        return { ms, ok: parseToolResult(res).ok };
      });
      const ok = lat.filter((x) => x.ok);
      const sorted = ok.map((x) => x.ms).sort((a, b) => a - b);

      const daemonRssBeforeStop = await rssOf(daemonPid);
      summary.daemon = {
        clients: 20,
        connected: clients.length,
        successfulSearches: ok.length,
        errors: lat.length - ok.length,
        connectAllMs: +connectMs.toFixed(1),
        searchP50: +percentile(sorted, 50).toFixed(1),
        searchP95: +percentile(sorted, 95).toFixed(1),
        searchP99: +percentile(sorted, 99).toFixed(1),
        daemonRssKb: daemonRssBeforeStop,
      };
      flagIf(ok.length < 20, `daemon: only ${ok.length}/20 concurrent searches succeeded`);
      flagIf(daemonRssBeforeStop > 1_500_000, `daemon RSS ${(daemonRssBeforeStop / 1024).toFixed(0)}MB > 1.5GB`);
    } catch (cause) {
      summary.daemon = { error: cause instanceof Error ? cause.message : String(cause) };
      summary.flags.push(`daemon: failed — ${summary.daemon.error}`);
    } finally {
      // Cleanup ALWAYS runs, even mid-failure (reviewer blocker 2).
      for (const { handle } of daemonConnects) await killGroupAndVerify(handle);
      // The daemon itself was spawned by the launcher (outside any group we
      // own): direct recorded-pid signals, then verified gone.
      if (typeof daemonPid === "number") {
        try { process.kill(daemonPid, "SIGTERM"); } catch { /* gone */ }
      }
      let stopHandle = null;
      try {
        stopHandle = await spawnNode([CLI_ENTRY, "daemon", "stop"], daemonEnv);
      } catch (cause) {
        if (!String(cause?.message ?? cause).includes("interrupt received")) throw cause;
        // Post-interrupt: the lib's sweep owns cleanup from here.
      }
      if (stopHandle) {
        await Promise.race([stopHandle.exited, new Promise((r) => setTimeout(r, 15_000))]);
        await killGroupAndVerify(stopHandle);
      }
      // Verify the recorded daemon pid is actually gone; SIGKILL + fail the
      // run flag if a survivor remains (reviewer blocker 6).
      if (typeof daemonPid === "number") {
        for (let attempt = 0; attempt < 3; attempt++) {
          let alive = false;
          try { process.kill(daemonPid, 0); alive = true; } catch { alive = false; }
          if (!alive) break;
          try { process.kill(daemonPid, "SIGKILL"); } catch { /* gone */ }
          await new Promise((r) => setTimeout(r, 500));
        }
        try {
          process.kill(daemonPid, 0);
          summary.flags.push(`daemon: recorded pid ${daemonPid} survived stop — orphan`);
        } catch { /* confirmed gone */ }
      }
      for (const { handle } of daemonConnects) {
        const { code, signal } = await handle.exited;
        if (code === null && signal === null) {
          summary.flags.push(`daemon: connect handle did not report a clean exit (pid ${handle.pid})`);
        }
      }
    }
  }

  await gate();

  // -- bottleneck flags -------------------------------------------------------
  for (const [transport, stats] of Object.entries(summary.search)) {
    for (const [level, s] of Object.entries(stats)) {
      flagIf(s.p99 > 2000, `search ${transport} ${level}: p99 ${s.p99}ms > 2s`);
    }
  }
  if (summary.coldStart && summary.warmStart) {
    flagIf(
      summary.warmStart.bootToReadyMs >= summary.coldStart.bootToReadyMs * 0.8,
      `warm start not meaningfully faster than cold (${summary.warmStart.bootToReadyMs} vs ${summary.coldStart.bootToReadyMs}ms)`,
    );
  }

  // Reviewer blocker 5: gate every requested stage on its declared success
  // contract. Partial failures anywhere make the run fail — no silent greens.
  const requestedTransports = args.transports.split(",").filter(Boolean);
  const transportsProduced = requestedTransports.filter((t) => summary.search[t] && summary.load[t] && summary.execute[t]);
  if (transportsProduced.length < requestedTransports.length) {
    summary.flags.push(`stages: ${requestedTransports.length - transportsProduced.length} requested transport(s) produced no result`);
  }
  // Reviewer round 4, finding 2: survivors of this run's owned pids/groups
  // fail the run — a green summary may never ship with leaked processes.
  const survivors = await reapAllOwned();
  if (survivors.length > 0) {
    summary.flags.push(`orphans: ${survivors.length} owned process(es) survived cleanup (pids ${survivors.join(",")})`);
  }
  const daemonContractOk = args.skipDaemon ||
    (summary.daemon && summary.daemon.connected === 20 && summary.daemon.successfulSearches === 20 && summary.daemon.errors === 0);
  if (!args.skipDaemon && !daemonContractOk && summary.daemon && !summary.daemon.error) {
    summary.flags.push(`daemon: success contract not met (connected=${summary.daemon.connected}, successfulSearches=${summary.daemon.successfulSearches}, errors=${summary.daemon.errors})`);
  }
  // Cache success contract: EVERY cache request must succeed (no silent
  // partial-failure green). An explicit skip stays allowed.
  const cacheOk = Object.values(summary.cache).every(
    (c) => (typeof c.method === "string" && c.method.startsWith("skipped")) ||
      (c.repeats === c.repeatsRequested && c.distinctCalls === c.distinctRequested),
  );
  summary.durationMs = Date.now() - t0;
  summary.completedAt = new Date().toISOString();
  // Benchmark window rule: every performance number carries lock context.
  summary.lockHeld = benchLock.held ? "yes" : "no";
  summary.lock = {
    held: benchLock.held ? "yes" : "no",
    ...(coRunners.length > 0 ? { coRunners } : { coRunners: [] }),
  };
  summary.ok =
    transportsProduced.length === requestedTransports.length &&
    Object.values(summary.search).every((t) => Object.values(t).every((s) => s.errors === 0)) &&
    Object.values(summary.load).every((s) => s.errors === 0) &&
    Object.values(summary.execute).every((s) => s.errors === 0) &&
    cacheOk &&
    daemonContractOk &&
    !summary.flags.some((f) => f.startsWith("daemon: failed") || f.startsWith("daemon: recorded pid") || f.startsWith("daemon: connect child") || f.startsWith("stages:") || f.startsWith("orphans:"));

  return summary;
}

// Shared harness final-summary contract (PR 64): stale results file removed
// at start, one compact JSON last stdout line (also on failure), durable
// results write, exit code derived from the final object.
async function main() {
  try {
    return await runBench();
  } finally {
    // Every failure path reaps owned pids/groups BEFORE any output/exit.
    await reapAllOwned();
    releaseBenchLock();
  }
}

// PR 94 hook: the lib's interrupt sweep owns every REGISTRY group; this
// hook covers the one product-spawned process no handle can ever own — the
// detached hub daemon. Runs AFTER the registry loop, BEFORE the one
// summary; survivors merge into that summary (fail-closed evidence).
const extraInterruptCleanup = async () => {
  const survivors = [];
  if (typeof recordedDaemonPid === "number") {
    try { process.kill(recordedDaemonPid, "SIGTERM"); } catch { /* gone */ }
    // Bounded settle: TERM is already in flight; KILL after the deadline.
    await new Promise((r) => setTimeout(r, 2_000));
    try { process.kill(recordedDaemonPid, "SIGKILL"); } catch { /* gone */ }
    for (let attempt = 0; attempt < 10; attempt++) {
      try { process.kill(recordedDaemonPid, 0); survivors.push(recordedDaemonPid); break; }
      catch { /* gone */ }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return { survivors };
};

await harnessMain(main, { resultsPath: join(RESULTS_DIR, "bench-load.json"), extraInterruptCleanup, extraCleanupTimeoutMs: 15_000 }).then((final) => {
  // Shared lib contract: exitCode only, no force-exit (S3-R7).
  process.exitCode = final.ok ? 0 : 1;
});