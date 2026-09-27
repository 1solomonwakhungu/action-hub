/**
 * stress/cli-scale.test.mjs — unit tests for stress/cli-scale.mjs internals.
 * Run: node --test stress/cli-scale.test.mjs
 * (Imports the ESM source directly; no dist build needed.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  let child = null;
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

    child = spawn(process.execPath, [serverPath, "--manifest", manifestPath], { stdio: ["pipe", "pipe", "pipe"] });
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
    assert.equal(responses[0].id, 1);
    assert.equal(responses[0].result.protocolVersion, "2025-06-18");
    assert.equal(responses[0].result.serverInfo.name, "test-server");
    assert.equal(responses[1].id, 2);
    assert.equal(responses[1].result.tools[0].name, "do_thing");
  } finally {
    // S8-R6 (S8-R5 blocker 3): the child's open stdio pipes kept the test
    // process alive (the reported 7.5h hang). Kill ONLY this pid, await its
    // close with a bounded SIGKILL escalation, and destroy every stream.
    if (child) {
      try { child.stdin?.end(); } catch { /* already closed */ }
      if (child.exitCode === null && !child.killed) {
        try { child.kill("SIGTERM"); } catch { /* already dead */ }
      }
      const closed = new Promise((resolveClose) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolveClose();
        child.once("close", resolveClose);
        setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* already dead */ }
          child.once("close", resolveClose);
        }, 2000);
      });
      await closed;
      try { child.stdout?.destroy(); child.stderr?.destroy(); } catch { /* noop */ }
    }
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

test("spawnStep: ok child, failing child and timeout all normalize", { timeout: 20_000 }, async () => {
  const ok = await spawnStep([process.execPath, "-e", "process.exit(0)"], { timeoutMs: 10_000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.exit, 0);

  const fail = await spawnStep([process.execPath, "-e", "console.log('boom'); process.exit(3)"], { timeoutMs: 10_000 });
  assert.equal(fail.ok, false);
  assert.equal(fail.exit, 3);
  assert.ok(fail.stdout.includes("boom"));

  const slow = await spawnStep([process.execPath, "-e", "setTimeout(() => {}, 60_000)"], { timeoutMs: 300 });
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

// Shared helper: every CLI invocation announces its per-run root with a plain
// "run root: <path>" line, and the LAST stdout line is the one JSON summary.
function parseRunOutput(stdout) {
  const lines = String(stdout ?? "").split("\n").filter((l) => l.trim().length > 0);
  const rootLine = lines.find((l) => l.startsWith("run root: "));
  return {
    runRoot: rootLine ? rootLine.slice("run root: ".length) : null,
    lineCount: lines.length,
    summary: JSON.parse(lines[lines.length - 1]),
  };
}

// S8-R6 R2 blocker 3: a PRESENT but VALUELESS flag is a usage error, not an
// absent flag — every case must fail inside the guarded finish path with one
// compact ok:false JSON, nonzero exit, and ARTIFACT PARITY (the durable
// artifact exists in the SAFE per-run root with ok:false — never under
// --generated, which this test also asserts directly).
test("valueless --scale / --seed / --generated and bogus scale all fail with one ok:false JSON + artifact parity", { timeout: 120_000 }, () => {
  const script = resolvePath(import.meta.dirname, "cli-scale.mjs");
  const cases = [
    { argv: [script, "--scale"], error: /--scale requires a value/, useGen: false },
    { argv: [script, "--seed"], error: /--seed requires a value/, useGen: false },
    { argv: [script, "--generated"], error: /--generated requires a value/, useGen: false },
    { argv: [script, "--scale", "bogus"], error: /Unknown --scale value/, useGen: true },
    { argv: [script, "--scale", "small", "--seed", "abc"], error: /Invalid --seed/, useGen: true },
  ];
  for (const c of cases) {
    const gen = c.useGen ? mkdtempSync(join(tmpdir(), "cli-scale-usage-")) : null;
    // Valueless-flag cases must NOT get a trailing value that could be
    // consumed as the missing value; --generated is appended only when the
    // primary flag already has its value.
    const fullArgv = c.useGen ? [...c.argv, "--generated", gen] : [...c.argv];
    const r = spawnSync(process.execPath, fullArgv, {
      encoding: "utf8",
      cwd: import.meta.dirname,
      timeout: 60_000,
    });
    assert.equal(r.status, 1, fullArgv.join(" ") + " must exit nonzero");
    const parsed = parseRunOutput(r.stdout);
    assert.equal(parsed.summary.ok, false, fullArgv.join(" ") + " must be ok:false");
    assert.match(String(parsed.summary.error ?? ""), c.error, fullArgv.join(" "));
    // Artifact parity: the failure artifact lives under the per-run root and
    // carries the same ok:false.
    assert.ok(parsed.runRoot, "run root must be announced on stdout");
    const artifactPath = join(parsed.runRoot, "results", "cli-scale.json");
    assert.ok(existsSync(artifactPath), "failure artifact must exist at " + artifactPath);
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    assert.equal(artifact.ok, false, "failure artifact must be ok:false");
    // And --generated itself was never written to or wiped.
    if (gen) assert.ok(existsSync(gen), "--generated dir must survive a usage failure");
    if (gen) rmSync(gen, { recursive: true, force: true });
  }
});

// S8-R6 R2 blocker 1 (e2e half): the durable artifact is NEVER derived from
// --generated anymore, so a pre-existing file at <generated>/results/... must
// survive a failing run byte-for-byte. (The owner-protected half is covered
// by the predicate regression below plus the entry-order guarantee: the
// resultsPath is computed from the per-run tmp root before main() runs.)
test("failing run never writes under --generated: sentinel bytes unchanged", { timeout: 60_000 }, () => {
  const script = resolvePath(import.meta.dirname, "cli-scale.mjs");
  const gen = mkdtempSync(join(tmpdir(), "cli-scale-guard-"));
  mkdirSync(join(gen, "results"), { recursive: true });
  const sentinel = join(gen, "results", "cli-scale.json");
  writeFileSync(sentinel, "SENTINEL-BYTES");
  const r = spawnSync(process.execPath, [script, "--scale", "bogus", "--generated", gen], {
    encoding: "utf8",
    cwd: import.meta.dirname,
    timeout: 30_000,
  });
  assert.equal(r.status, 1);
  assert.equal(readFileSync(sentinel, "utf8"), "SENTINEL-BYTES", "protected results file must be byte-identical after a run");
  const parsed = parseRunOutput(r.stdout);
  assert.ok(parsed.runRoot && parsed.runRoot.startsWith(tmpdir()), "durable artifact must live under the per-run tmp root, not --generated");
  rmSync(gen, { recursive: true, force: true });
});

// S8-R6 R2 blocker 1 (predicate half): the owner-state refusal must fire for
// a path inside the REAL app-state layout and must never touch that path —
// proven with an injected real home (the real one is never written to).
test("owner-state predicate refuses protected layout with bytes untouched", () => {
  const { insideOwnerProtectedState } = __test;
  const fakeHome = mkdtempSync(join(tmpdir(), "cli-scale-owner-"));
  const protectedResults = join(fakeHome, ".cache", "action-hub", "results", "cli-scale.json");
  mkdirSync(dirname(protectedResults), { recursive: true });
  writeFileSync(protectedResults, "OWNER-SENTINEL");
  const verdict = insideOwnerProtectedState(protectedResults, fakeHome);
  assert.ok(verdict, "a path inside the protected app-state layout must be refused: " + String(verdict));
  assert.equal(readFileSync(protectedResults, "utf8"), "OWNER-SENTINEL", "protected file bytes must be unchanged");
  // A plain tmp path is NOT owner state (being under home alone is fine on
  // platforms where tmpdir is under USERPROFILE).
  const plainTmp = mkdtempSync(join(tmpdir(), "cli-scale-notowner-"));
  assert.ok(!insideOwnerProtectedState(plainTmp, fakeHome), "a plain tmp path is not owner state");
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(plainTmp, { recursive: true, force: true });
});

// S8-R6 R3 MUST-FIX 2: a spawned CLI child is OWNED from the moment of
// spawn — error listener attached immediately (an 'error' event with no
// listener would crash the test process), output collected, the close wait is
// BOUNDED, and the finally ladder is TERM -> bounded wait -> (SIGCONT +)
// KILL -> awaited close, with stdio streams destroyed. A SIGSTOPped child
// cannot receive SIGTERM until continued, so the ladder escalates with
// SIGCONT before SIGKILL (SIGKILL works on stopped processes).
function attachChildIO(child, sink) {
  child.on("error", (err) => { sink.err += "\n[spawn error] " + err.message; });
  child.stdout?.on("data", (d) => { sink.out += d; });
  child.stderr?.on("data", (d) => { sink.err += d; });
}

/** Bounded close wait: resolves {code, signal, timedOut}. Never hangs. */
function awaitClose(child, timeoutMs) {
  return new Promise((res) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return res({ code: child.exitCode, signal: child.signalCode, timedOut: false });
    }
    const timer = setTimeout(() => res({ code: child.exitCode, signal: child.signalCode, timedOut: true }), timeoutMs);
    child.once("close", (code, signal) => { clearTimeout(timer); res({ code, signal, timedOut: false }); });
  });
}

/** Ownership teardown ladder: TERM -> bounded wait -> CONT+KILL -> awaited. */
async function terminateChildren(children) {
  for (const c of children) {
    if (c.exitCode !== null || c.signalCode !== null) continue;
    try { c.kill("SIGTERM"); } catch { /* already dead */ }
    const first = await awaitClose(c, 3000);
    if (first.timedOut && c.exitCode === null && c.signalCode === null) {
      try { c.kill("SIGCONT"); } catch { /* noop */ }
      try { c.kill("SIGKILL"); } catch { /* already dead */ }
      await awaitClose(c, 3000);
    }
    try { c.stdout?.destroy(); c.stderr?.destroy(); } catch { /* noop */ }
  }
}

// S8-R6 R2 blocker 2: two OVERLAPPING runs from the same checkout (different
// seeds, forced fallback fixtures) must not mutate each other — each run
// publishes its own artifact under its own per-run root with its own seed.
test("overlapping runs are isolated: per-run fixtures + per-run artifacts, no cross-run mutation", { timeout: 600_000 }, async () => {
  const script = resolvePath(import.meta.dirname, "cli-scale.mjs");
  const dirs = [mkdtempSync(join(tmpdir(), "cli-scale-ovl-a-")), mkdtempSync(join(tmpdir(), "cli-scale-ovl-b-"))];
  const children = dirs.map((d, i) => spawn(process.execPath, [script, "--scale", "small", "--seed", String(11 + i), "--generated", d], {
    stdio: ["ignore", "pipe", "pipe"],
  }));
  const outs = children.map(() => ({ out: "", err: "" }));
  // Own both children IMMEDIATELY (error listeners before any await).
  children.forEach((c, i) => attachChildIO(c, outs[i]));
  let closes = null;
  try {
    // Bounded wait: a stalled child resolves timedOut instead of hanging the
    // suite; the finally ladder then reaps it for real.
    closes = await Promise.all(children.map((c) => awaitClose(c, 540_000)));
    for (let i = 0; i < 2; i++) {
      assert.equal(closes[i].timedOut, false, "run " + i + " must finish within the bound; stderr: " + outs[i].err.slice(-400));
      assert.equal(closes[i].code, 0, "run " + i + " must exit 0; stderr: " + outs[i].err.slice(-400));
      const parsed = parseRunOutput(outs[i].out);
      assert.equal(parsed.summary.ok, true, "run " + i + " must be ok");
      assert.equal(parsed.summary.seed, 11 + i, "run " + i + " must record ITS OWN seed");
      const artifact = JSON.parse(readFileSync(join(parsed.runRoot, "results", "cli-scale.json"), "utf8"));
      assert.equal(artifact.seed, 11 + i, "run " + i + " artifact must carry its own seed");
      assert.notEqual(parsed.runRoot, parseRunOutput(outs[1 - i].out).runRoot, "run roots must be distinct");
    }
  } finally {
    // Proven, not assumed: even on assertion failure, timeout, or a stalled
    // child, both children are reaped with the bounded ladder.
    await terminateChildren(children);
    for (let i = 0; i < 2; i++) {
      assert.ok(children[i].exitCode !== null || children[i].signalCode !== null, "run " + i + " must be fully reaped");
    }
    rmSync(dirs[0], { recursive: true, force: true });
    rmSync(dirs[1], { recursive: true, force: true });
  }
});

// S8-R6 R3 MUST-FIX 1: run-root creation happens BEFORE harness main(), so a
// hostile TMPDIR must still produce one compact ok:false JSON, nonzero exit,
// and a best-effort durable failure artifact under a fallback root — never an
// uncaught crash with zero stdout.
test("hostile TMPDIR (=/dev/null): one ok:false JSON + nonzero + fallback artifact", { timeout: 60_000 }, () => {
  const script = resolvePath(import.meta.dirname, "cli-scale.mjs");
  const r = spawnSync(process.execPath, [script, "--scale", "bogus"], {
    encoding: "utf8",
    cwd: import.meta.dirname,
    timeout: 30_000,
    env: { ...process.env, TMPDIR: "/dev/null", TMP: "/dev/null", TEMP: "/dev/null" },
  });
  assert.equal(r.status, 1, "hostile TMPDIR must exit nonzero");
  assert.ok((r.stdout ?? "").trim().length > 0, "stdout must not be empty on a pre-main failure");
  const lines = String(r.stdout).split("\n").filter((l) => l.trim().length > 0);
  const summary = JSON.parse(lines[lines.length - 1]);
  assert.equal(summary.ok, false);
  assert.match(String(summary.error ?? ""), /run root creation failed/);
  // Artifact parity: a best-effort failure artifact must exist under a usable
  // fallback root and carry the same ok:false.
  assert.ok(existsSync("/tmp"), "fallback root sanity");
  const matches = String(r.stderr ?? "").match(/failure artifact \(best effort\): (\S+)/);
  assert.ok(matches, "stderr must announce the fallback artifact path");
  const artifact = JSON.parse(readFileSync(matches[1], "utf8"));
  assert.equal(artifact.ok, false, "fallback failure artifact must be ok:false");
});

// Forced-hang control (S8-R6 R3 MUST-FIX 2): prove the teardown ladder, not
// just the green path. A real cli-scale run is SIGSTOPped mid-flight; the
// ladder must TERM (undeliverable while stopped), escalate CONT+KILL, and
// leave the child reaped — the same ownership contract the overlap test uses.
test("forced-hang control: SIGSTOPped run child is reaped by the bounded ladder", { timeout: 120_000 }, async () => {
  const script = resolvePath(import.meta.dirname, "cli-scale.mjs");
  const dir = mkdtempSync(join(tmpdir(), "cli-scale-hangctl-"));
  const sink = { out: "", err: "" };
  const child = spawn(process.execPath, [script, "--scale", "small", "--seed", "13", "--generated", dir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  attachChildIO(child, sink);
  try {
    // Let it reach the bench phase, then freeze it mid-run.
    await awaitClose(child, 1) ; // not expected to exit; just pacing
    await new Promise((r) => setTimeout(r, 2000));
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGSTOP");
    }
    if (child.exitCode === null && child.signalCode === null) {
      await terminateChildren([child]);
    }
    assert.ok(child.exitCode !== null || child.signalCode !== null, "stopped child must be reaped by the ladder");
  } finally {
    await terminateChildren([child]);
    rmSync(dir, { recursive: true, force: true });
  }
});

// Full small-scale integration against a FIXTURE-FREE generated dir: this
// forces the fallback path (ambient stress/.generated state must not be able
// to silently select shared mode and mask a broken fallback).
test("small-scale end-to-end run (forced fixture-free fallback) completes with ok summary", { timeout: 1_800_000 }, () => {
  const script = resolvePath(import.meta.dirname, "cli-scale.mjs");
  const emptyGenerated = mkdtempSync(join(tmpdir(), "cli-scale-fallback-"));
  // The CLI dist is a build product: on a truly clean clone (no node_modules,
  // no dist) build it once so the regression runs the real binary instead of
  // failing on a missing file.
  if (!existsSync(resolvePath(import.meta.dirname, "..", "packages", "cli", "dist", "index.js"))) {
    const repo = resolvePath(import.meta.dirname, "..");
    const ci = spawnSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: repo, encoding: "utf8", timeout: 600_000 });
    assert.equal(ci.status, 0, "npm ci must succeed on a clean clone: " + (ci.stderr ?? "").slice(-300));
    const build = spawnSync("npm", ["run", "build", "--workspaces"], { cwd: repo, encoding: "utf8", timeout: 600_000 });
    assert.equal(build.status, 0, "workspace build must succeed: " + (build.stderr ?? "").slice(-300));
  }
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [script, "--scale", "small", "--seed", "7", "--generated", emptyGenerated], {
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
  // This run is FORCED fallback: the counts must be the small self-generated
  // fleet, never the shared corpus.
  assert.equal(summary.fixtures.source, "self-generated");
  const expectedFleetCounts = { servers: 8, tools: 200, skills: 40 };
  assert.deepEqual(
    { servers: summary.fixtures.servers, tools: summary.fixtures.tools, skills: summary.fixtures.skills },
    expectedFleetCounts,
  );
  assert.equal(summary.fixtures.source === "shared" || summary.fixtures.source === "self-generated", true);
});
