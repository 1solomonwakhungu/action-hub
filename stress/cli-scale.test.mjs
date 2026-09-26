/**
 * stress/cli-scale.test.mjs — unit tests for stress/cli-scale.mjs internals.
 * Run: node --test stress/cli-scale.test.mjs
 * (Imports the ESM source directly; no dist build needed.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __test } from "./cli-scale.mjs";

const { writeToolManifests, buildConfigSkills, writeSkillFixtures, FAKE_STDIO_SERVER, SCALES } = __test;

test("fixture generation is deterministic for a fixed seed", () => {
  const dir1 = mkdtempSync(join(tmpdir(), "cli-scale-t1-"));
  const dir2 = mkdtempSync(join(tmpdir(), "cli-scale-t2-"));
  try {
    // Two independent runs of the same generation must be byte-identical;
    // the module PRNG is re-seeded between runs to simulate fresh processes.
    const run = (dir) => {
      __test.reseed(42);
      writeToolManifests(__test.SCALES.small, dir);
      writeSkillFixtures(__test.SCALES.small, join(dir, "skills"));
      const out = {};
      for (const f of readdirSync(join(dir, "tools"))) {
        out[f] = readFileSync(join(dir, "tools", f)).toString();
      }
      return out;
    };
    const a = run(dir1);
    const b = run(dir2);
    assert.deepEqual(Object.keys(a), Object.keys(b));
    for (const k of Object.keys(a)) assert.equal(a[k], b[k], `manifest ${k} differs between runs`);
  } finally {
    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
});

test("small-scale fixtures have the expected shape (contract formats)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-scale-t3-"));
  try {
    const serverIds = writeToolManifests(__test.SCALES.small, dir);
    const manifest = JSON.parse(readFileSync(join(dir, "tools", serverIds[0] + ".json"), "utf8"));
    assert.equal(manifest.serverId, serverIds[0]);
    assert.equal(manifest.tools.length, __test.SCALES.small.toolsPerServer);
    for (const tool of manifest.tools) {
      assert.ok(tool.name, "tool name present");
      assert.equal(tool.inputSchema.type, "object");
      assert.ok(tool.description.includes("(seeded fixture"), "description marks seeded fixtures");
    }
    const skills = buildConfigSkills({ skills: 5 });
    assert.equal(skills.length, 5);
    for (const s of skills) {
      assert.ok(s.id.startsWith("skill:"), "skill id uses skill:<slug> format");
      assert.ok(s.summary.length > 0 && s.description.length > 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inline fake stdio server answers initialize and tools/list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-scale-t4-"));
  try {
    const manifest = {
      serverId: "test-server",
      tools: [
        { name: "do_thing", description: "does a thing", inputSchema: { type: "object", properties: {} } },
      ],
    };
    const manifestPath = join(dir, "test-server.json");
    const serverPath = join(dir, "fake-stdio-server.mjs");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(serverPath, FAKE_STDIO_SERVER);

    const child = spawn(process.execPath, [serverPath, "--manifest", manifestPath], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    const responses = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (line.trim()) responses.push(JSON.parse(line));
      }
    });
    const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for responses")), 5000);
      const poll = setInterval(() => {
        if (responses.length >= 2) { clearInterval(poll); clearTimeout(timer); resolve(); }
      }, 25);
    });
    child.kill();
    assert.equal(responses[0].id, 1);
    assert.equal(responses[0].result.protocolVersion, "2025-06-18");
    assert.equal(responses[0].result.serverInfo.name, "test-server");
    assert.equal(responses[1].id, 2);
    assert.equal(responses[1].result.tools[0].name, "do_thing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// S8-R3 rework regressions (reviewer-2 MUST-FIX 1-4 + medium)
// ---------------------------------------------------------------------------

import { statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";

const { isoEnv, assertIsoEnv, ISOLATION_PATH_VARS, spawnStep, padTomlServers,
  observeFleet, validateFleet } = __test;

test("isolation: every path-bearing var is pinned inside the sandbox home", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "cli-scale-iso-"));
  try {
    // Simulate a caller whose environment carries REAL owner paths and a
    // Windows-style profile: the child env must replace every one of them.
    const hostileBase = {
      ...process.env,
      HOME: "/home/realowner",
      USERPROFILE: "C:\\Users\\realowner",
      APPDATA: "C:\\Users\\realowner\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\realowner\\AppData\\Local",
      XDG_CACHE_HOME: "/home/realowner/.cache",
      ACTION_HUB_CACHE: "/home/realowner/.cache/action-hub/catalog.json",
      ACTION_HUB_DAEMON_DIR: "/home/realowner/.action-hub/daemon",
      CODEX_HOME: "/home/realowner/.codex",
      CLAUDE_CONFIG_DIR: "/home/realowner/.claude",
    };
    const childEnv = isoEnv({ home: sandbox, configPath: join(sandbox, "servers.json") }, hostileBase);
    for (const name of ISOLATION_PATH_VARS) {
      const val = childEnv[name];
      assert.ok(val, name + " must be set");
      assert.ok(
        resolvePath(val) === resolvePath(sandbox) || resolvePath(val).startsWith(resolvePath(sandbox) + "/"),
        name + "=" + val + " must resolve inside the sandbox home"
      );
    }
    assert.equal(childEnv.USERPROFILE, sandbox, "Windows-style USERPROFILE must be replaced");
    assert.equal(childEnv.APPDATA, join(sandbox, "AppData", "Roaming"));
    assert.equal(childEnv.LOCALAPPDATA, join(sandbox, "AppData", "Local"));
    // The sentinel self-check used by runAll must accept this env...
    assert.doesNotThrow(() => assertIsoEnv(childEnv, sandbox));
    // ...and reject a leaked var.
    const leaky = { ...childEnv, XDG_STATE_HOME: "/home/realowner/.local/state" };
    assert.throws(() => assertIsoEnv(leaky, sandbox), /isolation sentinel violated/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("spawnStep: ok child, failing child and timeout all normalize", { timeout: 20_000 }, () => {
  const ok = spawnStep([process.execPath, "-e", "process.exit(0)"], { timeoutMs: 10_000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.exit, 0);

  const fail = spawnStep([process.execPath, "-e", "console.log('boom'); process.exit(3)"], { timeoutMs: 10_000 });
  assert.equal(fail.ok, false);
  assert.equal(fail.exit, 3);
  assert.ok(fail.stdout.includes("boom"));

  const slow = spawnStep([process.execPath, "-e", "setTimeout(() => {}, 60_000)"], { timeoutMs: 300 });
  assert.equal(slow.ok, false);
  assert.ok(slow.error, "timeout must produce an error field");
});

test("full-scale fallback fleet is exactly 44 manifests / 10,000 tools", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-scale-fleet-"));
  try {
    const serverIds = writeToolManifests(SCALES.full, dir);
    assert.equal(serverIds.length, 44, "full scale must be 44 manifests (4 big included)");
    let tools = 0;
    for (const id of serverIds) {
      const m = JSON.parse(readFileSync(join(dir, "tools", id + ".json"), "utf8"));
      tools += m.tools.length;
    }
    assert.equal(tools, 10_000, "full scale must be exactly 10,000 tools");

    // observeFleet/validateFleet on a synthetic config with relative manifest paths
    const configPath = join(dir, "servers.json");
    writeFileSync(configPath, JSON.stringify({
      autoDiscover: false,
      servers: serverIds.map((id) => ({
        id,
        transport: { type: "stdio", command: process.execPath, args: ["--manifest", join(dir, "tools", id + ".json")] },
      })),
      skills: Array.from({ length: 5_000 }, (_, i) => ({ id: "skill:s" + i })),
    }));
    const observed = observeFleet(configPath);
    assert.deepEqual(observed, { servers: 44, tools: 10_000, skills: 5_000 });
    assert.doesNotThrow(() => validateFleet(observed, { servers: 44, tools: 10_000, skills: 5_000 }));
    assert.throws(() => validateFleet(observed, { servers: 44, tools: 9_999, skills: 5_000 }), /fleet mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("padTomlServers: 10MB padding completes linearly (no quadratic byteLength loop)", { timeout: 30_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-scale-toml-"));
  try {
    const path = join(dir, "config.toml");
    const t0 = performance.now();
    const bytes = padTomlServers(path, 2_000, 10 << 20);
    const ms = performance.now() - t0;
    assert.ok(bytes >= 10 << 20, "result must reach the 10MB target");
    assert.ok(ms < 10_000, "padding must be linear, took " + Math.round(ms) + "ms");
    assert.equal(statSync(path).size, bytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup error (--scale bogus): nonzero exit and last stdout line is the JSON summary", { timeout: 60_000 }, () => {
  const script = resolvePath(import.meta.dirname, "cli-scale.mjs");
  const r = spawnSync(process.execPath, [script, "--scale", "bogus"], {
    encoding: "utf8",
    cwd: import.meta.dirname,
    timeout: 30_000,
  });
  assert.equal(r.status, 1, "setup failure must exit nonzero");
  const lines = (r.stdout ?? "").split("\n").filter((l) => l.trim().length > 0);
  assert.ok(lines.length > 0, "a summary must still be printed");
  const summary = JSON.parse(lines[lines.length - 1]); // last stdout line IS the summary
  assert.equal(summary.ok, false);
  assert.equal(summary.scale, "bogus");
  assert.ok(summary.error, "summary must carry the error");
});

test("invalid seed: fails loudly with a final summary", { timeout: 60_000 }, () => {
  const script = resolvePath(import.meta.dirname, "cli-scale.mjs");
  const r = spawnSync(process.execPath, [script, "--scale", "small", "--seed", "abc"], {
    encoding: "utf8",
    cwd: import.meta.dirname,
    timeout: 30_000,
  });
  assert.equal(r.status, 1);
  const lines = (r.stdout ?? "").split("\n").filter((l) => l.trim().length > 0);
  const summary = JSON.parse(lines[lines.length - 1]);
  assert.equal(summary.ok, false);
  assert.ok(/Invalid --seed/.test(summary.error ?? ""));
});

// Full small-scale integration: prompt completion + machine-readable last line.
test("small-scale end-to-end run completes promptly with ok summary", { timeout: 900_000 }, () => {
  const script = resolvePath(import.meta.dirname, "cli-scale.mjs");
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [script, "--scale", "small", "--seed", "7"], {
    encoding: "utf8",
    cwd: import.meta.dirname,
    timeout: 800_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const ms = performance.now() - t0;
  assert.equal(r.status, 0, "small run must exit 0; stderr: " + (r.stderr ?? "").slice(-500));
  assert.ok(ms < 800_000, "small run must complete promptly, took " + Math.round(ms) + "ms");
  const lines = (r.stdout ?? "").split("\n").filter((l) => l.trim().length > 0);
  const summary = JSON.parse(lines[lines.length - 1]);
  assert.equal(summary.ok, true);
  assert.ok(summary.fixtures, "summary must record observed fixture counts");
  // Shared corpus = the contract fleet (44/10,000/5,000) at any --scale;
  // self-generated small fixtures = 8/200/40.
  const expectedFleetCounts = summary.fixtures.source === "shared"
    ? { servers: 44, tools: 10_000, skills: 5_000 }
    : { servers: 8, tools: 200, skills: 40 };
  assert.deepEqual(
    { servers: summary.fixtures.servers, tools: summary.fixtures.tools, skills: summary.fixtures.skills },
    expectedFleetCounts,
  );
  assert.equal(summary.fixtures.source === "shared" || summary.fixtures.source === "self-generated", true);
});
