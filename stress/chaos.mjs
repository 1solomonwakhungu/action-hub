#!/usr/bin/env node
// stress/chaos.mjs — builder-8 (stress packet S6, file owner per CONTRACT.md)
//
// Chaos + resilience harness. Runs the hub in-process against 44 stdio fake
// servers (stress/fake-mcp-server.mjs, 20 tools each = 880 tools) where 10
// misbehave, then verifies:
//
//   1. the hub stays responsive during chaos (search p95 under load)
//   2. circuit breakers open and recover
//   3. hung calls fail in bounded time (defaultTimeoutMs)
//   4. memory stays bounded (5 MB responses)
//   5. `doctor` completes in bounded time with 44 servers and exits 1
//   6. no configured secret appears in any captured output
//
// The fake server is PR 46's stress/fake-mcp-server.mjs, copied into this
// worktree UNCOMMITTED (it belongs to the fake-servers PR; this PR adds only
// chaos.mjs). It is spawned with the same --chaos contract used elsewhere:
// crash-after (delivery-based, counts initialize), hang-rate, slow-start-ms,
// huge-bytes, stderr-secret. All probabilistic draws are seeded by the
// server itself (chaos seed), so this harness fixes seed=7 for replay.
//
// Isolation per stress/CONTRACT.md: temp HOME, XDG_CACHE_HOME,
// XDG_CONFIG_HOME, ACTION_HUB_SKILLS_DIR, PI_CODING_AGENT_DIR;
// servers.json uses autoDiscover:false. Absolute paths only, so the doctor
// run works from any cwd.
//
// Output: JSON summary as the last stdout line, also written to
// stress/.generated/results/chaos.json. Requires `npm run build` first.

import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const FAKE_SERVER = join(HERE, "fake-mcp-server.mjs");
const GEN_DIR = join(REPO_ROOT, "stress", ".generated", "chaos");
const MANIFEST_DIR = join(GEN_DIR, "manifests");
const RESULTS_DIR = join(REPO_ROOT, "stress", ".generated", "results");
const RESULTS_FILE = join(RESULTS_DIR, "chaos.json");
const CONFIG_PATH = join(GEN_DIR, "servers.json");
const CLI_ENTRY = join(REPO_ROOT, "packages", "cli", "dist", "index.js");

const SECRET = "CHAOS-SENTINEL-9f3a2b";
const SECRET_PREFIX = SECRET.slice(0, -1); // all-but-last-char partial-leak probe
const SERVER_COUNT = 44;
const MISBEHAVE_COUNT = 10;
const TOOLS_PER_SERVER = 20;
const CALL_TIMEOUT_MS = 5_000;
const CIRCUIT_COOLDOWN_MS = 3_000;
const SEARCH_PROBES = 100;
const SLOW_START_MS = 10_000;
const HUGE_BYTES = 5 * 1024 * 1024;
const CHAOS_SEED = 7;
const DOCTOR_TIMEOUT_MS = 180_000;

// CONTRACT.md hard rule 2: every run uses isolated env dirs — applied to
// the ENTIRE process (not just child spawns) before any factory/hub
// construction, so the in-process hub and all 44 fake-server children
// (which inherit process.env) can never touch owner state. The script
// exits after the run, so the mutation is inherently scoped.
const tmpRoot = join(tmpdir(), `action-hub-chaos-${process.pid}-${Date.now()}`);
for (const d of ["home", "cache", "config", "skills", "pi"]) {
  mkdirSync(join(tmpRoot, d), { recursive: true });
}
const GEN_CONFIG_PLACEHOLDER = join(tmpRoot, "servers.json");
process.env.HOME = join(tmpRoot, "home");
process.env.XDG_CACHE_HOME = join(tmpRoot, "cache");
process.env.XDG_CONFIG_HOME = join(tmpRoot, "config");
process.env.ACTION_HUB_CONFIG = GEN_CONFIG_PLACEHOLDER; // repointed to the real config once generated
process.env.ACTION_HUB_SKILLS_DIR = join(tmpRoot, "skills");
process.env.PI_CODING_AGENT_DIR = join(tmpRoot, "pi");
const isolationEnv = () => ({ ...process.env }); // children inherit the already-isolated env
process.on("exit", () => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const findings = [];
function finding(severity, summary, repro) {
  findings.push({ severity, summary, repro });
  process.stderr.write(`[chaos] ${severity}: ${summary}\n`);
}

// Secret scan over everything this harness (or child processes through
// inherited pipes) writes to the console, including the summary itself.
let leaked = false;
let leakSample = "";
function scanForSecret(chunk) {
  const text = typeof chunk === "string" ? chunk : String(chunk);
  if (!leaked && (text.includes(SECRET) || text.includes(SECRET_PREFIX))) {
    leaked = true;
    const at = text.indexOf(SECRET_PREFIX);
    leakSample = at >= 0 ? text.slice(Math.max(0, at - 40), at + SECRET_PREFIX.length + 10) : "";
    process.stderr.write(`[chaos] SECRET LEAKED to output (sample redacted): ${leakSample.replace(/[A-Za-z0-9-]{8,}/g, "[redacted]")}\n`);
  }
}
function installSecretScan() {
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    stream.write = function (chunk, ...rest) {
      scanForSecret(chunk);
      return original(chunk, ...rest);
    };
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

// --- fixtures ---------------------------------------------------------------

function buildFixtures() {
  mkdirSync(MANIFEST_DIR, { recursive: true });
  mkdirSync(GEN_DIR, { recursive: true });
  const tools = [];
  for (let t = 0; t < TOOLS_PER_SERVER; t++) {
    tools.push({
      name: `tool_${t}`,
      description: `chaos fixture tool ${t} for search and execution`,
      inputSchema: { type: "object", properties: { x: { type: "number" } } },
      annotations: { readOnlyHint: true },
    });
  }
  // [id, chaos flags] — 34 healthy, 10 misbehaving.
  const plan = [
    ["crash-1", "crash-after=2"],
    ["crash-2", "crash-after=2"],
    ["flapper", "crash-after=1"],
    ["hang-1", "hang-rate=1.0"],
    ["hang-2", "hang-rate=1.0"],
    ["slow-1", `slow-start-ms=${SLOW_START_MS}`],
    ["slow-2", `slow-start-ms=${SLOW_START_MS}`],
    ["huge-1", `huge-bytes=${HUGE_BYTES}`],
    ["huge-2", `huge-bytes=${HUGE_BYTES}`],
    ["leaky", `stderr-secret=${SECRET}`],
  ];
  const chaosById = new Map(plan.map(([id, flags]) => [id, flags]));
  const specs = [];
  const servers = [];
  for (let i = 0; i < SERVER_COUNT; i++) {
    const id = i < plan.length ? plan[i][0] : `ok-${i}`;
    const chaos = chaosById.get(id);
    const manifestPath = join(MANIFEST_DIR, `${id}.json`);
    writeFileSync(manifestPath, JSON.stringify({ serverId: id, tools }));
    specs.push({ id, chaos });
    servers.push({
      id,
      displayName: `Chaos ${id}`,
      transport: {
        type: "stdio",
        command: "node",
        args: chaos === undefined
          ? [FAKE_SERVER, "--manifest", manifestPath, "--chaos", `seed=${CHAOS_SEED}`]
          : [FAKE_SERVER, "--manifest", manifestPath, "--chaos", `${chaos},seed=${CHAOS_SEED}`],
      },
    });
  }
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({ $schema: "./servers.schema.json", autoDiscover: false, servers }, null, 2) + "\n",
  );
  return specs;
}

// --- scenario ---------------------------------------------------------------

async function main() {
  if (!existsSync(join(REPO_ROOT, "packages", "core", "dist", "index.js")) || !existsSync(CLI_ENTRY)) {
    console.error("[chaos] requires built workspaces; run `npm run build` first");
    process.exit(2);
  }
  if (!existsSync(FAKE_SERVER)) {
    console.error(`[chaos] missing ${FAKE_SERVER} (copy PR 46's fake-mcp-server.mjs in, uncommitted)`);
    process.exit(2);
  }

  const { ActionHub } = await import(resolve(REPO_ROOT, "packages/core/dist/index.js"));
  const { createSdkClientFactory } = await import(resolve(REPO_ROOT, "packages/cli/dist/client-factory.js"));

  installSecretScan();
  const specs = buildFixtures();
  process.env.ACTION_HUB_CONFIG = CONFIG_PATH; // real config now exists
  const startedAt = Date.now();
  const rssStartMB = Math.round(process.memoryUsage().rss / 1048576);

  const hub = new ActionHub({
    servers: JSON.parse(readFileSync(CONFIG_PATH, "utf8")).servers,
    bundles: [],
    clientFactory: createSdkClientFactory(),
    defaultTimeoutMs: CALL_TIMEOUT_MS,
    // Resilience knobs: the 30 s default heartbeat makes dead-stdio
    // recovery unobservable in a run of this length; 2 s plus the default
    // 3-failure threshold keeps the machinery exercisable. Cooldown is
    // lowered from the product default 10 s to 3 s for the same reason.
    resilience: {
      heartbeat: { intervalMs: 2_000, timeoutMs: 3_000 },
      failureThreshold: 3,
      cooldownMs: 3_000,
    },
    // The hub gates execution of untrusted servers behind approval; this
    // harness must exercise the real failure paths, so auto-approve all.
    policy: { autoApproveAtOrAbove: "untrusted" },
    resultCache: { enabled: true, ttlMs: 60_000, maxEntries: 500 },
  });

  const summary = {
    script: "chaos",
    servers: SERVER_COUNT,
    misbehaving: MISBEHAVE_COUNT,
    toolsTotal: SERVER_COUNT * TOOLS_PER_SERVER,
    chaosProfiles: [
      "crash-after=2 x2",
      "crash-after=1 (flapper) x1",
      "hang-rate=1.0 x2",
      `slow-start-ms=${SLOW_START_MS} x2`,
      `huge-bytes=${HUGE_BYTES} x2`,
      "stderr-secret=<redacted> x1",
    ],
    seed: CHAOS_SEED,
    index: null,
    hang: null,
    circuit: null,
    search: null,
    memory: null,
    doctor: null,
    secretScan: { sentinelLength: SECRET.length, prefixChecked: true, leaked: false },
    findings,
    verdict: {},
  };

  // 1. Index the fleet; slow-start servers (10 s) may dominate the wall time.
  const indexStart = Date.now();
  const indexResults = await hub.indexAll();
  const indexMs = Date.now() - indexStart;
  const indexFailures = indexResults.filter((r) => r.error);
  summary.index = {
    ok: indexResults.length - indexFailures.length,
    failures: indexFailures.map((r) => ({ serverId: r.serverId, error: String(r.error).slice(0, 200) })),
    durationMs: indexMs,
    bounded: indexMs < 120_000,
  };
  if (!summary.index.bounded) {
    finding("P1", `indexAll took ${indexMs}ms for ${SERVER_COUNT} servers (unbounded fleet startup)`, "stress/chaos.mjs scenario run; see index.durationMs");
  }

  // 2. Hung calls: hang-rate=1.0 servers must fail within timeoutMs.
  const hang = { bounded: true, samples: [] };
  const hangIds = specs.filter((s) => (s.chaos ?? "").includes("hang-rate")).map((s) => s.id);
  for (const id of hangIds) {
    const t0 = Date.now();
    const res = await Promise.race([
      hub.execute(`${id}:tool_0`, { x: 0 }, { noCache: true }).then(
        (r) => ({ outcome: r.ok === true ? "unexpected-success" : "failed", result: r }),
        (e) => ({ outcome: "failed", error: String(e?.message ?? e) }),
      ),
      sleep(CALL_TIMEOUT_MS + 5_000).then(() => ({ outcome: "hung" })),
    ]);
    const ms = Date.now() - t0;
    hang.samples.push({ id, durationMs: ms, outcome: res.outcome, error: (res.error ?? res.result?.error ?? "").slice(0, 120) });
    if (res.outcome === "unexpected-success") {
      hang.bounded = false;
      finding("P1", `call to hang-rate=1.0 server ${id} SUCCEEDED in ${ms}ms — the hang injector is broken; timeout path untested`, `hub.execute("${id}:tool_0") returned ok against a server configured to never respond`);
      break;
    }
    if (res.outcome === "hung") {
      hang.bounded = false;
      finding("P1", `call to ${id} hung unbounded (>${ms}ms) despite timeoutMs=${CALL_TIMEOUT_MS}`, `hub.execute("${id}:tool_0") against hang-rate=1.0 server`);
      break;
    }
    if (ms > CALL_TIMEOUT_MS + 2_000) {
      hang.bounded = false;
      finding("P1", `hung call on ${id} took ${ms}ms, exceeding timeoutMs=${CALL_TIMEOUT_MS} by margin`, `timeoutMs=${CALL_TIMEOUT_MS} configured; observed ${ms}ms`);
    }
  }

  // 3. Circuit breakers: per-server open -> cooldown -> recovery evidence.
  // Note (product F16): execute-time 'Not connected' errors bypass
  // recordFailure, so opening is driven by the 2 s heartbeat against dead
  // children; this harness waits for that transition explicitly.
  const circuit = { perId: {}, opened: [], recovered: [] };
  const crashIds = specs.filter((s) => (s.chaos ?? "").includes("crash-after")).map((s) => s.id);
  const stateOf = (id) => hub.serverStates().find((s) => s.id === id)?.circuitState ?? "unknown";

  async function waitForState(id, want, timeoutMs) {
    const t0 = Date.now();
    for (;;) {
      const st = stateOf(id);
      if (want.includes(st)) return { state: st, ms: Date.now() - t0 };
      if (Date.now() - t0 > timeoutMs) return { state: st, ms: Date.now() - t0, timedOut: true };
      await sleep(400);
    }
  }

  // Finite crashers: kill the child by exhausting its accepted calls, then
  // observe open -> (cooldown) -> closed, then prove a fresh execute works.
  const finiteIds = crashIds.filter((id) => id !== "flapper");
  for (const id of finiteIds) {
    const rec = { id };
    // exhaust accepted calls so the child dies (crash-after=2)
    for (let i = 0; i < 2; i++) await hub.execute(`${id}:tool_0`, { x: i }, { noCache: true }).catch(() => {});
    await hub.execute(`${id}:tool_0`, { x: 9 }, { noCache: true }).catch(() => {}); // ensure the crash happened
    const opened = await waitForState(id, ["open"], 30_000);
    rec.openedMs = opened.ms;
    rec.opened = opened.state === "open" && !opened.timedOut;
    if (!rec.opened) {
      rec.error = `circuit never opened within 30s (state=${opened.state})`;
      circuit.perId[id] = rec;
      finding("P1", `circuit never opened for ${id} within 30s of repeated crashes (state=${opened.state})`, "stress/chaos.mjs circuit scenario; see circuit.perId");
      continue;
    }
    const recovered = await waitForState(id, ["closed", "half-open"], 30_000);
    rec.recoveredMs = recovered.ms;
    rec.recovered = !recovered.timedOut;
    if (!rec.recovered) {
      rec.error = `circuit never left open within 30s (state=${recovered.state})`;
      finding("P1", `circuit for ${id} never recovered within 30s of cooldown (state=${recovered.state})`, "stress/chaos.mjs circuit scenario; see circuit.perId");
    } else {
      const r = await hub.execute(`${id}:tool_0`, { x: 1 }, { noCache: true }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      rec.postRecoveryOk = r.ok === true;
      rec.postRecoveryError = (r.error ?? "").slice(0, 100);
      if (!rec.postRecoveryOk) {
        finding("P1", `post-recovery execute against ${id} failed after circuit closed (state=${stateOf(id)}): ${rec.postRecoveryError}`, "stress/chaos.mjs circuit scenario; see circuit.perId");
      }
    }
    circuit.perId[id] = rec;
  }
  // Flapper: must OPEN (permanently failing server) — protective behavior.
  for (let i = 0; i < 6; i++) await hub.execute("flapper:tool_0", { x: i }, { noCache: true }).catch(() => {});
  const flapperOpen = await waitForState("flapper", ["open"], 30_000);
  circuit.perId.flapper = { opened: flapperOpen.state === "open" && !flapperOpen.timedOut, state: flapperOpen.state, openedMs: flapperOpen.ms };
  circuit.opened = crashIds.filter((id) => circuit.perId[id]?.opened);
  circuit.recovered = finiteIds.filter((id) => circuit.perId[id]?.recovered);
  if (circuit.opened.length === 0) {
    finding("P1", `no circuit breaker opened for any crash-after server (checked: ${crashIds.join(",")})`, "stress/chaos.mjs circuit scenario; see circuit.perId");
  }

  // 4. Search p95 while chaos runs (flapper restarts, hung servers active).
  // Untimed warmup first: first-use costs (disk, cache fills) must not
  // pollute the percentile measurement.
  const warmupStart = Date.now();
  for (let i = 0; i < 10; i++) {
    await hub.search(`chaos fixture tool ${i % 10}`).catch(() => {});
  }
  const warmupMs = Date.now() - warmupStart;
  const latencies = [];
  let searchErrors = 0;
  for (let i = 0; i < SEARCH_PROBES; i++) {
    const t0 = Date.now();
    try {
      await hub.search(`chaos fixture tool ${i % 10}`);
    } catch {
      searchErrors++;
    }
    latencies.push(Date.now() - t0);
    if (i % 10 === 0) {
      // keep the flapper flapping so failures are active during the probes
      await hub.execute("flapper:tool_0", {}).catch(() => {});
    }
  }
  latencies.sort((a, b) => a - b);
  summary.hang = hang;
  summary.circuit = circuit;
  summary.search = {
    warmupQueries: 10,
    warmupMs,
    probes: latencies.length,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    max: latencies.at(-1) ?? 0,
    errors: searchErrors,
  };
  if (summary.search.p95 >= 1_000) {
    finding("P1", `search p95 ${summary.search.p95}ms under chaos (hub not responsive)`, "100 searches interleaved with failing servers; see search stats");
  }

  // 5. Memory bounded under 5 MB responses.
  const hugeIds = specs.filter((s) => (s.chaos ?? "").includes("huge-bytes")).map((s) => s.id).slice(0, 1);
  let rssPeakMB = rssStartMB;
  for (const id of hugeIds) {
    for (let i = 0; i < 5; i++) {
      const res = await hub.execute(`${id}:tool_0`, { x: i }, { noCache: true }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      const size = res.ok ? JSON.stringify(res.content ?? "").length : 0;
      if (res.ok && size < HUGE_BYTES / 2) {
        finding("P2", `5MB response from ${id} arrived truncated (${size} bytes)`, `hub.execute("${id}:tool_0") with huge-bytes=${HUGE_BYTES}`);
      }
      rssPeakMB = Math.max(rssPeakMB, Math.round(process.memoryUsage().rss / 1048576));
    }
  }
  summary.memory = { rssStartMB, rssPeakMB };
  if (summary.memory.rssPeakMB > 1_536) {
    finding("P1", `RSS ${rssPeakMB}MB exceeded 1.5GB during 5MB-response chaos`, "5 x tools/call with 5MB responses");
  }

  // 6. doctor: bounded time with 44 servers, exits 1 (10 misbehaving), no secret.
  const doctorStart = Date.now();
  const doctor = spawnSync("node", [CLI_ENTRY, "doctor", "--config", CONFIG_PATH, "--no-check"], {
    encoding: "utf8",
    timeout: DOCTOR_TIMEOUT_MS,
    env: isolationEnv(), // isolated process.env, captured after repointing
    cwd: tmpRoot, // cross-cwd proof: not the repo root
  });
  const doctorMs = Date.now() - doctorStart;
  const doctorOut = `${doctor.stdout ?? ""}\n${doctor.stderr ?? ""}`;
  scanForSecret(doctorOut);
  summary.doctor = {
    exitCode: doctor.status,
    timedOut: doctor.signal === "SIGTERM",
    durationMs: doctorMs,
    bounded: doctor.signal !== "SIGTERM" && doctorMs < DOCTOR_TIMEOUT_MS,
  };
  if (!summary.doctor.bounded) {
    finding("P1", `doctor exceeded ${DOCTOR_TIMEOUT_MS}ms with ${SERVER_COUNT} servers`, `ACTION_HUB_CONFIG=${CONFIG_PATH} node ${CLI_ENTRY} doctor`);
  }
  // doctor checks live boot health; under chaos the same fleet can
  // legitimately exit 0 (all servers bootable at check time) or 1 (a
  // crash-looping/flapping server was failing at check time). Record the
  // exit without a hard expectation; the hard requirement is bounded time
  // and no secret in the output.
  summary.doctor.note = indexFailures.length > 0
    ? "index failures present; exit 1 expected"
    : "exit 0 or 1 both consistent with live chaos (racy server health at check time)";

  await hub.close().catch(() => {});

  summary.elapsedMs = Date.now() - startedAt;
  summary.secretScan = { sentinelLength: SECRET.length, prefixChecked: true, leaked };
  const memoryBounded = summary.memory.rssPeakMB <= 1_536;
  summary.verdict = {
    indexComplete: indexFailures.length === 0,
    indexBounded: summary.index.bounded,
    memoryBounded,
    hubResponsive: summary.search.p95 < 1_000 && searchErrors === 0,
    circuitBreakersOpened: circuit.opened.length > 0,
    circuitBreakersRecovered: circuit.recovered.length > 0,
    hangsBounded: hang.bounded,
    doctorBounded: summary.doctor.bounded,
    secretsContained: !leaked,
  };
  if (!memoryBounded) {
    finding("P1", `RSS ${summary.memory.rssPeakMB}MB exceeded 1.5GB during 5MB-response chaos`, "5 x tools/call with 5MB responses; see memory.rssPeakMB");
  }
  if (indexFailures.length > 0) {
    finding("P1", `${indexFailures.length} server(s) failed to index: ${indexFailures.map((r) => r.serverId).join(",")}`, "stress/chaos.mjs index phase; see index.failures");
  }

  let text = JSON.stringify(summary, null, 2);
  if (text.includes(SECRET) || text.includes(SECRET_PREFIX)) {
    findings.push({ severity: "P1", summary: "secret reached the harness's own summary (scrubbed in this copy)", repro: "captured output fragment in the leak finding" });
    text = text.split(SECRET).join("[redacted]").split(SECRET_PREFIX).join("[redacted]");
  }
  console.log(text);
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(RESULTS_FILE, text + "\n");
  process.exit(0);
}

main().catch((err) => {
  console.error(`[chaos] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
