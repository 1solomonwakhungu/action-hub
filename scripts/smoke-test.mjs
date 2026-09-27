// Executes a produced Action Hub binary and asserts it behaves. Used by the
// release workflow on each build runner and available locally via
// `npm run smoke:binary`. Pass the binary path as the first argument, or let it
// default to the host-target binary under dist-bin/.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, accessSync, rmSync } from "node:fs";
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
  } finally {
    rmRunRoot(runRoot);
  }
  process.stderr.write("SMOKE PASS\n");
}

main().catch((err) => {
  fail(err instanceof Error ? err.stack : String(err));
});
