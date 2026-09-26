import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { doctorCommand } from "../dist/commands/doctor.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const failFirstFixture = resolve(testDir, "fixtures/fail-first-list-tools.mjs");
const minimalFixture = resolve(testDir, "fixtures/minimal-mcp.mjs");

function captureConsole(): { logs: string[]; errors: string[]; restore: () => void } {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => void logs.push(args.join(" "));
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
  return {
    logs,
    errors,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

async function withIsolatedEnv<T>(tempDir: string, fn: () => Promise<T>): Promise<T> {
  const saved = {
    HOME: process.env["HOME"],
    XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"],
    XDG_CACHE_HOME: process.env["XDG_CACHE_HOME"],
    ACTION_HUB_CONFIG: process.env["ACTION_HUB_CONFIG"],
    ACTION_HUB_SKILLS_DIR: process.env["ACTION_HUB_SKILLS_DIR"],
    ACTION_HUB_CACHE: process.env["ACTION_HUB_CACHE"],
    ACTION_HUB_DAEMON_DIR: process.env["ACTION_HUB_DAEMON_DIR"],
  };
  process.env["HOME"] = tempDir;
  process.env["XDG_CONFIG_HOME"] = join(tempDir, "xdg-config");
  process.env["XDG_CACHE_HOME"] = join(tempDir, "xdg-cache");
  process.env["ACTION_HUB_CACHE"] = join(tempDir, "ah-cache");
  process.env["ACTION_HUB_DAEMON_DIR"] = join(tempDir, "ah-daemon");
  delete process.env["ACTION_HUB_CONFIG"];
  delete process.env["ACTION_HUB_SKILLS_DIR"];
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function stdioServer(id: string, args: string[], extra: Record<string, unknown> = {}) {
  return {
    id,
    transport: { type: "stdio", command: process.execPath, args, ...extra },
  };
}



async function makeFleet(tempDir: string, servers: unknown[]): Promise<string> {
  const cfgPath = join(tempDir, "servers.json");
  await writeFile(cfgPath, JSON.stringify({ servers, autoDiscover: false }));
  return cfgPath;
}

async function runDoctor(cfgPath: string): Promise<{ code: number; output: string }> {
  const captured = captureConsole();
  try {
    const code = await doctorCommand({ configPath: cfgPath, checkConnectivity: true });
    return { code, output: captured.logs.join("\n") };
  } finally {
    captured.restore();
  }
}

const RUNS = 10;

test("doctor exit code is deterministic across 10 runs on a healthy fleet (F17)", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ah-doctor-det-"));
  try {
    const servers = ["h1", "h2"].map((id) =>
      stdioServer(id, [minimalFixture], { timeoutMs: 5000 }),
    );
    const cfgPath = await makeFleet(tempDir, servers);

    const codes: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const { code } = await withIsolatedEnv(tempDir, () => runDoctor(cfgPath));
      codes.push(code);
    }
    assert.equal(codes.filter((c) => c === 0).length, RUNS, `expected all ${RUNS} runs exit 0, got ${codes.join(",")}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// Deterministic fail-first-listTools fixture: the FIRST tools/list request is
// delayed beyond the probe timeout, every later one is immediate. Red/green:
// attempt 1 must fail (timeout), attempt 2 must succeed via the doctor's
// bounded retry, and the final-attempt status must control the exit code.
test("doctor retries a fail-first-listTools server and exits 0 (F17/FX8-R2)", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ah-doctor-failfirst-"));
  try {
    const cfgPath = await makeFleet(tempDir, [
      stdioServer("flaky", [failFirstFixture], {
        timeoutMs: 500,
        env: { ...process.env, FAIL_MS: "3000" },
      }),
    ]);

    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const { code, output } = await withIsolatedEnv(tempDir, () => runDoctor(cfgPath));
      codes.push(code);
      if (i === 0) {
        // Attempt 1 failed and attempt 2 succeeded: the recovered-on-retry
        // note is only printed when the bounded retry actually engaged.
        assert.match(output, /\[flaky\].*\(recovered on retry\)/);
        assert.doesNotMatch(output, /still failing after retry/);
      }
    }
    assert.equal(codes.filter((c) => c === 0).length, 5, `expected 5/5 exit 0, got ${codes.join(",")}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("doctor exit code is deterministic across 10 runs with a permanently down server (F17)", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ah-doctor-down-"));
  try {
    // A command that exits immediately: down on every attempt. Note the args
    // do NOT repeat process.execPath — the transport's command already is it.
    const servers = [
      stdioServer("dead", ["-e", "process.exit(1)"], { timeoutMs: 5000 }),
      stdioServer("healthy", [minimalFixture], { timeoutMs: 5000 }),
    ];
    const cfgPath = await makeFleet(tempDir, servers);

    const codes: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const { code, output } = await withIsolatedEnv(tempDir, () => runDoctor(cfgPath));
      codes.push(code);
      if (i === 0) assert.match(output, /\[dead\].*still failing after retry/);
    }
    assert.equal(codes.filter((c) => c === 1).length, RUNS, `expected all ${RUNS} runs exit 1, got ${codes.join(",")}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// Full-fleet boundedness (FX8-R2): 44 servers, several permanent failures AND
// hangs. The per-attempt deadline plus the total budget must keep the whole
// run far below 44 x 2 x timeout, and no hung child may survive the doctor.
test("44-server fleet with failures and hangs finishes within a wall-time ceiling, exit 1, no survivors", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ah-doctor-fleet-"));
  const startedAt = Date.now();
  try {
    const servers: unknown[] = [];
    for (let i = 0; i < 40; i++) {
      servers.push(stdioServer(`s${i}`, [minimalFixture], { timeoutMs: 500 }));
    }
    // Permanent failures: exit immediately (args are NOT prefixed with the
    // command again — the transport command is already process.execPath).
    servers.push(stdioServer("dead-1", ["-e", "process.exit(1)"], { timeoutMs: 500 }));
    servers.push(stdioServer("dead-2", ["-e", "process.exit(1)"], { timeoutMs: 500 }));
    // Permanent hangs: never answer; the per-attempt deadline must bound them.
    servers.push(stdioServer("hang-1", ["-e", "process.stdin.resume()"], { timeoutMs: 500 }));
    servers.push(stdioServer("hang-2", ["-e", "process.stdin.resume()"], { timeoutMs: 500 }));
    const cfgPath = await makeFleet(tempDir, servers);

    const { code } = await withIsolatedEnv(tempDir, () => runDoctor(cfgPath));
    const wallMs = Date.now() - startedAt;
    assert.equal(code, 1, "fleet with dead and hung servers must exit 1");
    // Ceiling: 44 servers, serial, bounded per attempt — far below the
    // unbounded 44 x 2 x (30s index + 5s health) the old code allowed.
    assert.ok(wallMs < 45_000, `fleet run took ${wallMs}ms, expected < 45s`);

    // No hung child survivors: every process still running our hang marker
    // after the doctor returned would be a leaked transport. Late circuit
    // restarts can legitimately be mid-shutdown, so poll until a deadline.
    let survivors: string[] = [];
    const pollDeadline = Date.now() + 8_000;
    do {
      await new Promise((r) => setTimeout(r, 500));
      const ps = spawnSync("ps", ["-eo", "pid,args"], { encoding: "utf8" });
      survivors = (ps.stdout ?? "")
        .split("\n")
        .filter((l) => l.includes("process.stdin.resume()") && !l.includes("grep"));
    } while (survivors.length > 0 && Date.now() < pollDeadline);
    assert.equal(survivors.length, 0, `hung server processes survived: ${survivors.join(" | ")}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
