// Executes a produced Action Hub binary and asserts it behaves. Used by the
// release workflow on each build runner and available locally via
// `npm run smoke:binary`. Pass the binary path as the first argument, or let it
// default to the host-target binary under dist-bin/.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, accessSync, rmSync, readdirSync, appendFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repoRoot, binaryFileName, readCliVersion } from "./lib/util.mjs";

// Owner-state isolation (F34): every spawned binary gets the FULL
// ISOLATION.md variable set pointed at one fresh run root, so the smoke can
// never write the invoking user's real cache/config/harness state. The
// checklist and env builder are the single source of truth shared with the
// test preload (test-isolation.mjs), imported in library mode.
process.env["ACTION_HUB_TEST_ISOLATION_LIBRARY"] = "1";
const { ISOLATION_CHECKLIST, createRunRoot, buildIsolatedEnv, rmRunRoot, containedIn } = await import("../test-isolation.mjs");

function fail(message) {
  process.stderr.write(`SMOKE FAIL: ${message}\n`);
  process.exit(1);
}

function resolveBinary() {
  const provided = process.argv[2];
  const path = provided ? resolve(provided) : resolve(repoRoot, "dist-bin", binaryFileName());
  try {
    accessSync(path);
  } catch {
    fail(`binary not found at ${path}`);
  }
  return path;
}

let isolationEnv = {};
let runRoot = null;

/**
 * Validate the FINAL env handed to a spawn: every checklist variable must
 * resolve inside the run root, even after per-call overrides (ISOLATION.md
 * final-value rule). File-shaped vars that a check pins deliberately (e.g.
 * ACTION_HUB_CONFIG under the run root) must be inside the root too.
 */
function assertFinalEnvIsolated(env) {
  for (const name of ISOLATION_CHECKLIST) {
    const value = env[name];
    if (value === undefined || value === "") continue;
    if (!containedIn(value, runRoot)) {
      fail(`isolation violation: final ${name}=${value} is outside the run root ${runRoot}`);
    }
  }
}

function checkDir(name) {
  const dir = join(runRoot, "checks", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function runBinary(bin, args, env = {}) {
  const finalEnv = { ...process.env, ...isolationEnv, ...env };
  assertFinalEnvIsolated(finalEnv);
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    env: finalEnv,
    timeout: 30_000,
  });
  if (result.error) fail(`spawning ${bin} ${args.join(" ")} threw: ${result.error.message}`);
  return result;
}

/**
 * SEA embedding proof (review-2 round 3 MUST-FIX 1): the shipped binary must
 * load the vendored model through the SEA asset-extraction path and actually
 * score a query — a silent hashed-fallback must fail the smoke. One
 * machine-readable line is asserted.
 */
/**
 * Platform-safe cache-base suffix matching core's seaVendorRoot behavior
 * (core uses "unknown" when process.getuid is unavailable, i.e. Windows).
 */
function cacheBaseSuffix() {
  return typeof process.getuid === "function" ? String(process.getuid()) : "unknown";
}

function checkEmbeddingSelftest(bin) {
  const { status, stdout } = runBinary(bin, [], {
    ACTION_HUB_EMBEDDINGS_SELFTEST: "1",
  });
  const line = (stdout ?? "")
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("{"))
    .pop();
  let parsed;
  try {
    parsed = JSON.parse(line ?? "");
  } catch {
    fail(`embedding selftest printed no JSON line (status ${status}, stdout: ${String(stdout).slice(0, 200)})`);
  }
  const selftest = parsed?.embeddingSelftest;
  if (!selftest || selftest.ok !== true) fail(`embedding selftest failed: ${line}`);
  if (selftest.backend !== "wasm") fail(`embedding selftest backend is ${selftest.backend}, expected wasm`);
  if (selftest.dims !== 384 || Math.abs(selftest.norm - 1) > 0.01) {
    fail(`embedding selftest vector wrong (dims ${selftest.dims}, norm ${selftest.norm})`);
  }
  if (selftest.nativeAddons !== 0) fail(`embedding selftest loaded ${selftest.nativeAddons} native addons`);
  process.stderr.write(`  ok  embedding selftest (load ${selftest.loadMs}ms, norm ${selftest.norm})\n`);
}

/**
 * The standalone binary must carry the third-party terms internally
 * (review-1/2 round 4 MUST-FIX 3): `action-hub licenses` prints the
 * vendored provenance notice plus both license texts from the SEA assets.
 */
function checkLicenses(bin) {
  const { status, stdout } = runBinary(bin, ["licenses"]);
  if (status !== 0) fail(`licenses exited ${status}`);
  const out = stdout ?? "";
  for (const needle of ["Vendored third-party provenance", "Apache License", "MIT License", "onnxruntime"]) {
    if (!out.includes(needle)) fail(`licenses output missing "${needle}"`);
  }
  process.stderr.write(`  ok  licenses prints VENDOR.md + Apache-2.0 + MIT texts\n`);
}

/**
 * SEA extraction must not leak a fresh 35MB tree per process
 * (review-1/2 round 4 MUST-FIX 2): the extraction is content-addressed, so
 * the first selftest creates exactly one cache tree and a second run REUSES
 * it — no growth.
 */
function checkExtractionCacheReuse(bin) {
  const tmpRoot = checkDir("sea-extraction");
  const env = { TMPDIR: tmpRoot, TMP: tmpRoot, TEMP: tmpRoot, ACTION_HUB_EMBEDDINGS_SELFTEST: "1" };
  const first = runBinary(bin, [], env);
  const cacheDirs = () => {
    const base = join(tmpRoot, `action-hub-cache-${cacheBaseSuffix()}`);
    try {
      return readdirSync(base).filter((n) => n.startsWith("vendor-"));
    } catch {
      return [];
    }
  };
  const trees = cacheDirs();
  if (trees.length !== 1) fail(`expected exactly 1 SEA extraction cache tree, found ${trees.length}`);
  const second = runBinary(bin, [], env);
  if (cacheDirs().length !== 1) fail(`second run created new extraction trees (leak); got ${cacheDirs().length}`);
  for (const r of [first, second]) {
    const line = (r.stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).pop();
    const parsed = JSON.parse(line ?? "{}");
    if (parsed?.embeddingSelftest?.ok !== true) fail(`SEA selftest not ok in cache-reuse check: ${line}`);
  }
  process.stderr.write(`  ok  SEA extraction is content-addressed and reused (1 tree, no growth)\n`);
}

/**
 * Explicit ACTION_HUB_EMBEDDINGS_MODEL precedence (review-1 round 4 HIGH):
 * an INVALID explicit override must fail clearly — no silent fallback to the
 * embedded model.
 */
function checkInvalidModelOverride(bin) {
  const { status, stdout } = runBinary(bin, [], {
    ACTION_HUB_EMBEDDINGS_MODEL: "/nonexistent/model/root",
    ACTION_HUB_EMBEDDINGS_SELFTEST: "1",
  });
  const line = (stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).pop();
  let parsed;
  try {
    parsed = JSON.parse(line ?? "{}");
  } catch {
    fail(`invalid-override selftest printed no JSON line (status ${status})`);
  }
  if (parsed?.embeddingSelftest?.ok !== false) {
    fail(`invalid explicit model override must fail, got ${line}`);
  }
  process.stderr.write(`  ok  invalid explicit model override fails clearly (no silent embedded fallback)\n`);
}

/**
 * Valid explicit model override (review-1 round 5 HIGH 2): pointing
 * ACTION_HUB_EMBEDDINGS_MODEL at a real model root must SUCCEED in SEA — the
 * embedded ORT runtime is still provided (model extraction is skipped, ORT
 * extraction is not).
 */
function checkValidModelOverride(bin) {
  const tmpRoot = checkDir("sea-valid-override");
  const env = {
    TMPDIR: tmpRoot, TMP: tmpRoot, TEMP: tmpRoot,
    ACTION_HUB_EMBEDDINGS_MODEL: resolve(repoRoot, "packages", "core", "vendor", "models"),
    ACTION_HUB_EMBEDDINGS_SELFTEST: "1",
  };
  const { status, stdout } = runBinary(bin, [], env);
  const line = (stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).pop();
  let parsed;
  try {
    parsed = JSON.parse(line ?? "{}");
  } catch {
    fail(`valid-override selftest printed no JSON line (status ${status})`);
  }
  if (parsed?.embeddingSelftest?.ok !== true) fail(`valid model override must succeed in SEA: ${line}`);
  // Only the ORT runtime (plus notices) may be extracted — NOT the embedded
  // 23MB model the caller already supplied.
  const base = join(tmpRoot, `action-hub-cache-${cacheBaseSuffix()}`);
  const trees = (readdirSync(base, { recursive: true, withFileTypes: true }) ?? []);
  const hasModelDir = trees.some((e) => e.isDirectory() && e.name === "models");
  if (hasModelDir) fail("valid-override run extracted the embedded model needlessly");
  process.stderr.write(`  ok  valid explicit model override succeeds (ORT only extracted)\n`);
}

/**
 * Cache tamper (review-2 round 5 P1/F65): a sentinel written into the cached
 * ORT JS must NEVER be executed — the next run must detect the hash mismatch
 * (vs the bytes embedded in the binary) and re-extract cleanly.
 */
function checkTamperedCache(bin) {
  const tmpRoot = checkDir("sea-tamper");
  const env = { TMPDIR: tmpRoot, TMP: tmpRoot, TEMP: tmpRoot, ACTION_HUB_EMBEDDINGS_SELFTEST: "1" };
  const runSelftest = () => {
    const { status, stdout } = runBinary(bin, [], env);
    const line = (stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).pop();
    let parsed;
    try {
      parsed = JSON.parse(line ?? "{}");
    } catch {
      fail(`tamper selftest printed no JSON line (status ${status})`);
    }
    return parsed?.embeddingSelftest;
  };
  if (runSelftest()?.ok !== true) fail("tamper check: first clean run failed");
  const base = join(tmpRoot, `action-hub-cache-${cacheBaseSuffix()}`);
  const findFile = (name) => {
    const hits = readdirSync(base, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name === name)
      .map((e) => join(e.parentPath ?? "", e.name));
    return hits[0];
  };
  const ortJs = findFile("ort.wasm.mjs");
  if (!ortJs) fail("tamper check: cached ort.wasm.mjs not found");
  appendFileSync(ortJs, "\n// sentinel-evil() — must never execute\n");
  if (runSelftest()?.ok !== true) fail("tamper check: tampered cache must be detected and re-extracted (ok:true)");
  if ((readFileSync(ortJs, "utf8") ?? "").includes("sentinel-evil")) {
    fail("tamper check: tampered ORT JS survived — the sentinel tree was reused instead of re-extracted");
  }
  process.stderr.write(`  ok  tampered cache is detected and re-extracted (sentinel never executes)\n`);
}

/**
 * Foreign/loose-mode cache base (intake round 5): a pre-existing base dir
 * with 0777 must NOT be reused or chmod'ed — the run falls back to a private
 * mkdtemp and still succeeds.
 */
function checkForeignCacheBase(bin) {
  const tmpRoot = checkDir("sea-foreign-base");
  const base = join(tmpRoot, `action-hub-cache-${cacheBaseSuffix()}`);
  mkdirSync(base, { recursive: true, mode: 0o777 });
  const { stdout } = runBinary(bin, [], { TMPDIR: tmpRoot, TMP: tmpRoot, TEMP: tmpRoot, ACTION_HUB_EMBEDDINGS_SELFTEST: "1" });
  const line = (stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).pop();
  let parsed;
  try {
    parsed = JSON.parse(line ?? "{}");
  } catch {
    fail(`foreign-base selftest printed no JSON line`);
  }
  if (parsed?.embeddingSelftest?.ok !== true) fail(`foreign/loose-mode cache base must fall back to a private mkdtemp: ${line}`);
  const st = statSync(base);
  if (!(st.mode & 0o077)) fail("foreign cache base was chmod'ed instead of bypassed");
  process.stderr.write(`  ok  foreign/0777 cache base is bypassed (private mkdtemp fallback)\n`);
}

/**
 * Both cache-base candidates hostile (review-2 round 5 MUST-FIX 1): with the
 * tmp base AND the user-cache base pre-created loose (0777), the run must
 * NOT extract anywhere — hashed fallback with ok:false and no import of a
 * swappable tree.
 */
function checkHostileCacheBases(bin) {
  const tmpRoot = checkDir("sea-hostile-bases");
  const suffix = cacheBaseSuffix();
  mkdirSync(join(tmpRoot, `action-hub-cache-${suffix}`), { recursive: true, mode: 0o777 });
  const fakeCache = join(tmpRoot, "fake-xdg");
  mkdirSync(join(fakeCache, "action-hub"), { recursive: true, mode: 0o777 });
  const { stdout } = runBinary(bin, [], {
    TMPDIR: tmpRoot, TMP: tmpRoot, TEMP: tmpRoot,
    XDG_CACHE_HOME: fakeCache,
    ACTION_HUB_EMBEDDINGS_SELFTEST: "1",
  });
  const line = (stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).pop();
  let parsed;
  try {
    parsed = JSON.parse(line ?? "{}");
  } catch {
    fail(`hostile-bases selftest printed no JSON line`);
  }
  if (parsed?.embeddingSelftest?.ok !== false) {
    fail(`both-hostile cache bases must fail closed (no extraction): ${line}`);
  }
  // No extraction tree anywhere under either hostile parent.
  const base = join(tmpRoot, `action-hub-cache-${suffix}`);
  const planted = readdirSync(base, { recursive: true, withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("vendor-"));
  if (planted.length > 0) fail(`extraction happened under a hostile cache base (${planted.length} trees)`);
  process.stderr.write(`  ok  both-hostile cache bases fail closed (no extraction, no import)\n`);
}

/**
 * The CJS bundle (non-SEA distribution) must also serve `licenses` — the
 * texts are inlined at bundle time (review-1 round 5 HIGH 1).
 */
function checkBundleLicenses() {
  const bundlePath = resolve(repoRoot, "build", "action-hub.cjs");
  try {
    accessSync(bundlePath);
  } catch {
    process.stderr.write("  ok  bundle licenses SKIPPED (no bundle built in this job)\n");
    return;
  }
  const { status, stdout } = spawnSync(process.execPath, [bundlePath, "licenses"], { encoding: "utf8", timeout: 30_000 });
  const out = stdout ?? "";
  for (const needle of ["Vendored third-party provenance", "Apache License", "MIT License"]) {
    if (!out.includes(needle)) fail(`bundle licenses output missing "${needle}" (exit ${status})`);
  }
  process.stderr.write(`  ok  CJS bundle licenses prints the embedded texts\n`);
}

function checkVersion(bin, version) {
  const { status, stdout } = runBinary(bin, ["--version"]);
  const out = (stdout ?? "").trim();
  if (status !== 0) fail(`--version exited ${status}`);
  if (out !== `action-hub ${version}`) fail(`--version printed "${out}", expected "action-hub ${version}"`);
  process.stderr.write(`  ok  --version -> ${out}\n`);
}

function checkHelp(bin) {
  const { status, stdout } = runBinary(bin, ["--help"]);
  const out = stdout ?? "";
  if (status !== 0) fail(`--help exited ${status}`);
  if (!out.includes("USAGE") || !out.includes("action-hub")) fail(`--help output missing expected sections`);
  process.stderr.write(`  ok  --help\n`);
}

function checkDoctor(bin) {
  const dir = checkDir("doctor");
  const cfg = join(dir, "servers.json");
  writeFileSync(cfg, JSON.stringify({ servers: [], skills: [], bundles: [], autoDiscover: false }));
  const { status, stdout } = runBinary(bin, ["doctor", "--config", cfg]);
  if (status !== 0) fail(`\`doctor\` exited ${status}: ${stdout ?? ""}`);
  if (!(stdout ?? "").includes("System Diagnostics")) fail(`\`doctor\` output missing diagnostics header`);
  process.stderr.write(`  ok  doctor (empty config, bundled binary)\n`);
}

function checkLightweightCommand(bin) {
  const dir = checkDir("list");
  const cfg = join(dir, "servers.json");
  writeFileSync(cfg, JSON.stringify({ servers: [], skills: [], bundles: [], autoDiscover: false }));
  const { status, stdout } = runBinary(bin, ["list"], { ACTION_HUB_CONFIG: cfg });
  if (status !== 0) fail(`\`list\` exited ${status}`);
  if (!(stdout ?? "").includes("Action Hub Catalog")) fail(`\`list\` output missing catalog header`);
  process.stderr.write(`  ok  list (empty catalog)\n`);
}

// The SEA binary must emit a snippet whose command is the binary itself with
// args ["start"] — never a node invocation of a nonexistent CLI path.
function checkHarnessExport(bin) {
  const { status, stdout, stderr } = runBinary(bin, ["harness", "cursor", "--json"]);
  if (status !== 0) fail(`\`harness cursor --json\` exited ${status}: ${stderr ?? ""}`);
  let doc;
  try {
    doc = JSON.parse(stdout ?? "");
  } catch {
    fail(`\`harness cursor --json\` did not print valid JSON`);
  }
  const entry = doc?.mcpServers?.["action-hub"];
  if (!entry) fail(`harness snippet missing mcpServers["action-hub"]`);
  if (entry.command !== bin) fail(`harness command should be the binary (${bin}), got ${entry.command}`);
  if (JSON.stringify(entry.args) !== JSON.stringify(["start"])) fail(`harness args should be ["start"], got ${JSON.stringify(entry.args)}`);
  process.stderr.write(`  ok  harness cursor --json (binary + ["start"])\n`);
}

function checkDaemonLifecycle(bin) {
  const dir = checkDir("daemon");
  const cfg = join(dir, "servers.json");
  const runtime = join(dir, "runtime");
  writeFileSync(cfg, JSON.stringify({ servers: [], skills: [], bundles: [], autoDiscover: false }));
  // Standalone contract (docs/releasing.md): the binary must not need a system
  // node. PATH is stripped of every node-capable interpreter for the daemon
  // lifecycle so all three OS jobs prove the anchored tree spawns in-binary.
  const nodeLessPath = process.platform === "win32"
    ? "C:\\Windows\\System32"
    : "/usr/bin:/bin";
  const env = { ACTION_HUB_CONFIG: cfg, ACTION_HUB_DAEMON_DIR: runtime, PATH: nodeLessPath };

  try {
    const start = runBinary(bin, ["daemon", "start"], env);
    if (start.status !== 0) fail(`\`daemon start\` exited ${start.status}: ${start.stderr ?? ""}`);

    const status = runBinary(bin, ["daemon", "status"], env);
    if (status.status !== 0 || !(status.stdout ?? "").includes("is running")) {
      fail(`\`daemon status\` failed: ${status.stderr ?? status.stdout ?? ""}`);
    }

    const stop = runBinary(bin, ["daemon", "stop"], env);
    if (stop.status !== 0) fail(`\`daemon stop\` exited ${stop.status}: ${stop.stderr ?? ""}`);
    process.stderr.write("  ok  daemon lifecycle\n");
  } finally {
    runBinary(bin, ["daemon", "stop"], env);
    rmSync(dir, { recursive: true, force: true });
  }
}

// Boots the bundled MCP server over stdio and runs a minimal JSON-RPC
// handshake. This is the load-bearing check that the MCP server entry point
// was bundled into the binary correctly.
function checkMcpHandshake(bin) {
  return new Promise((resolvePromise) => {
    const dir = checkDir("mcp");
    const cfg = join(dir, "servers.json");
    writeFileSync(cfg, JSON.stringify({ servers: [], skills: [], bundles: [], autoDiscover: false }));

    const child = spawn(bin, ["start"], {
      env: { ...process.env, ...isolationEnv, ACTION_HUB_CONFIG: cfg },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buffer = "";
    let step = 0;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail("MCP handshake timed out");
    }, 20_000);

    const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);

    child.on("error", (err) => fail(`starting MCP server threw: ${err.message}`));
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1 && step === 0) {
          step = 1;
          if (msg.result?.serverInfo?.name !== "action-hub") fail(`unexpected serverInfo: ${JSON.stringify(msg.result?.serverInfo)}`);
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        } else if (msg.id === 2 && step === 1) {
          step = 2;
          clearTimeout(timer);
          const names = (msg.result?.tools ?? []).map((t) => t.name);
          child.kill("SIGTERM");
          if (!names.includes("action_hub")) fail(`tools/list missing action_hub: [${names.join(", ")}]`);
          process.stderr.write(`  ok  MCP handshake (initialize + tools/list)\n`);
          resolvePromise();
        }
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
    });
  });
}

async function main() {
  const bin = resolveBinary();
  const version = await readCliVersion();
  runRoot = createRunRoot();
  isolationEnv = buildIsolatedEnv(runRoot);
  process.stderr.write(`Smoke testing ${bin} (expecting v${version}); isolated run root: ${runRoot}\n`);
  try {
    checkVersion(bin, version);
    checkHelp(bin);
    checkLightweightCommand(bin);
    checkHarnessExport(bin);
    checkDoctor(bin);
    checkDaemonLifecycle(bin);
    await checkMcpHandshake(bin);
    checkEmbeddingSelftest(bin);
    checkLicenses(bin);
    checkExtractionCacheReuse(bin);
    checkInvalidModelOverride(bin);
    checkValidModelOverride(bin);
    checkTamperedCache(bin);
    checkForeignCacheBase(bin);
    checkHostileCacheBases(bin);
    checkBundleLicenses();
  } finally {
    rmRunRoot(runRoot);
  }
  process.stderr.write("SMOKE PASS\n");
}

main().catch((err) => {
  fail(err instanceof Error ? err.stack : String(err));
});
