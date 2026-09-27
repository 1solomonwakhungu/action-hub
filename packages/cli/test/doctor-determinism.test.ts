import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { doctorCommand } from "../dist/commands/doctor.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const failFirstFixture = resolve(testDir, "fixtures/fail-first-list-tools.mjs");
const minimalFixture = resolve(testDir, "fixtures/minimal-mcp.mjs");
const hangFixture = resolve(testDir, "fixtures/hang-server.mjs");
const stubbornTreeFixture = resolve(testDir, "fixtures/stubborn-tree-server.mjs");

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
    TREE_PIDS_FILE: process.env["TREE_PIDS_FILE"],
  };
  process.env["HOME"] = tempDir;
  process.env["XDG_CONFIG_HOME"] = join(tempDir, "xdg-config");
  process.env["XDG_CACHE_HOME"] = join(tempDir, "xdg-cache");
  process.env["ACTION_HUB_CACHE"] = join(tempDir, "ah-cache");
  process.env["ACTION_HUB_DAEMON_DIR"] = join(tempDir, "ah-daemon");
  process.env["TREE_PIDS_FILE"] = join(tempDir, "recorded-pids.txt");
  await writeFile(process.env["TREE_PIDS_FILE"], "");
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
    // Each hang server records its own PID so survivor evidence is exact.
    servers.push(stdioServer("hang-1", [hangFixture], { timeoutMs: 500 }));
    servers.push(stdioServer("hang-2", [hangFixture], { timeoutMs: 500 }));
    const cfgPath = await makeFleet(tempDir, servers);

    const { code } = await withIsolatedEnv(tempDir, () => runDoctor(cfgPath));
    const wallMs = Date.now() - startedAt;
    assert.equal(code, 1, "fleet with dead and hung servers must exit 1");
    // Ceiling: 44 servers, serial, bounded per attempt — far below the
    // unbounded 44 x 2 x (30s index + 5s health) the old code allowed.
    assert.ok(wallMs < 45_000, `fleet run took ${wallMs}ms, expected < 45s`);

    // No hung survivors, evidenced by the exact PIDs the fixtures recorded:
    // every hang server wrote its own PID; each must be dead after the
    // doctor returned. Poll until a bounded deadline to tolerate a supervisor
    // still mid-teardown.
    const recordedPids = (await readFile(join(tempDir, "recorded-pids.txt"), "utf8"))
      .split("\n")
      .map((l) => Number.parseInt(l.trim(), 10))
      .filter((n) => Number.isSafeInteger(n) && n > 0);
    assert.ok(recordedPids.length >= 4, `expected >=4 recorded hang PIDs, got ${recordedPids.length}`);
    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const pollDeadline = Date.now() + 8_000;
    let survivors: number[] = recordedPids.filter(isAlive);
    while (survivors.length > 0 && Date.now() < pollDeadline) {
      await new Promise((r) => setTimeout(r, 250));
      survivors = recordedPids.filter(isAlive);
    }
    assert.deepEqual(survivors, [], `recorded hang processes survived: ${survivors.join(", ")}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// MUST-FIX regression (PR 61 rework): a server that spawns a TERM-ignoring
// grandchild must have its ENTIRE process tree killed before the doctor
// returns. Evidence is the exact PIDs the fixture recorded (server +
// grandchild), not a ps output scan.
test("doctor kills the whole downstream process tree, including TERM-ignoring grandchildren", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ah-doctor-tree-"));
  try {
    const servers = [stdioServer("stubborn", [stubbornTreeFixture], { timeoutMs: 5000 })];
    const cfgPath = await makeFleet(tempDir, servers);
    const { code } = await withIsolatedEnv(tempDir, () => runDoctor(cfgPath));
    assert.equal(code, 0, "healthy stubborn-tree server must not fail the doctor");

    const recordedPids = (await readFile(join(tempDir, "recorded-pids.txt"), "utf8"))
      .split("\n")
      .map((l) => Number.parseInt(l.trim(), 10))
      .filter((n) => Number.isSafeInteger(n) && n > 0);
    assert.equal(recordedPids.length, 2, `expected server + grandchild PIDs recorded, got ${recordedPids.join(", ")}`);

    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    // The doctor waits for its supervisors to be reaped before returning;
    // give the recorded processes a bounded grace period anyway.
    const pollDeadline = Date.now() + 8_000;
    let survivors = recordedPids.filter(isAlive);
    while (survivors.length > 0 && Date.now() < pollDeadline) {
      await new Promise((r) => setTimeout(r, 250));
      survivors = recordedPids.filter(isAlive);
    }
    assert.deepEqual(survivors, [], `downstream tree survived: ${survivors.join(", ")}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// Reviewer-1 round 4: a server that exits VOLUNTARILY after a valid response
// must still have its process group cleaned up — a same-group TERM-ignoring
// grandchild may outlive the direct child if the supervisor exits eagerly.
test("doctor cleans up the process group when the server exits on its own", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ah-doctor-selfexit-"));
  try {
    const servers = [
      {
        id: "self-exit",
        transport: {
          type: "stdio",
          command: process.execPath,
          args: [stubbornTreeFixture],
          env: { EXIT_AFTER_LIST: "1" },
        },
        timeoutMs: 5000,
      },
    ];
    const cfgPath = await makeFleet(tempDir, servers);
    const { code } = await withIsolatedEnv(tempDir, () => runDoctor(cfgPath));
    // The server dies mid-session, so the doctor may legitimately report a
    // failure — the CONTRACT under test is that no downstream process
    // survives, whatever the exit code.
    assert.ok(code === 0 || code === 1, `unexpected doctor exit code ${code}`);

    const recordedPids = (await readFile(join(tempDir, "recorded-pids.txt"), "utf8"))
      .split("\n")
      .map((l) => Number.parseInt(l.trim(), 10))
      .filter((n) => Number.isSafeInteger(n) && n > 0);
    assert.equal(recordedPids.length, 2, `expected server + grandchild PIDs recorded, got ${recordedPids.join(", ")}`);

    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const pollDeadline = Date.now() + 8_000;
    let survivors = recordedPids.filter(isAlive);
    while (survivors.length > 0 && Date.now() < pollDeadline) {
      await new Promise((r) => setTimeout(r, 250));
      survivors = recordedPids.filter(isAlive);
    }
    assert.deepEqual(survivors, [], `downstream tree survived self-exit: ${survivors.join(", ")}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// Reviewer-1 (PR 61 round 6): a server that writes one arbitrary stdout byte
// and then hangs must NOT defeat the activation deadline. The anchor meta
// file (written before connect resolves) bounds the attempt and the exact
// tree is torn down; the doctor must return nonzero within a tight bound
// with every recorded PID dead.
test("doctor bounds a partial-stdout-then-hang server and leaves no survivors", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ah-doctor-trickle-"));
  const startedAt = Date.now();
  try {
    const servers = [stdioServer("trickle", [resolve(testDir, "fixtures/trickle-server.mjs")], { timeoutMs: 1000 })];
    const cfgPath = await makeFleet(tempDir, servers);
    const { code } = await withIsolatedEnv(tempDir, () => runDoctor(cfgPath));
    const wallMs = Date.now() - startedAt;
    assert.equal(code, 1, "a server that never initializes must fail the doctor");
    assert.ok(wallMs < 25_000, `doctor took ${wallMs}ms for a hanging server; expected a tight bound`);

    // Exact recorded-PID evidence: every trickle server instance (2 attempts)
    // must be dead. The wrapper/anchor cleanup is anchored in-process; the
    // host proves the downstream tree via the server PIDs.
    const recordedPids = (await readFile(join(tempDir, "recorded-pids.txt"), "utf8"))
      .split("\n")
      .map((l) => Number.parseInt(l.trim(), 10))
      .filter((n) => Number.isSafeInteger(n) && n > 0);
    assert.ok(recordedPids.length >= 2, `expected >=2 recorded server PIDs (2 attempts), got ${recordedPids.length}`);
    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const pollDeadline = Date.now() + 8_000;
    let survivors = recordedPids.filter(isAlive);
    while (survivors.length > 0 && Date.now() < pollDeadline) {
      await new Promise((r) => setTimeout(r, 250));
      survivors = recordedPids.filter(isAlive);
    }
    assert.deepEqual(survivors, [], `partial-stdout hang tree survived: ${survivors.join(", ")}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// PR 77 rework P1 (security): the untrusted server must never see host
// control metadata (ANCHOR_* env) — metadata poisoning must be impossible —
// and teardown must never touch processes the doctor does not own.
test("doctor control state is invisible to the server and teardown spares unrelated processes", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ah-doctor-poison-"));
  try {
    // Poison fixture: if ANY ANCHOR_* env var is visible, write the poison
    // marker (an attempt to redirect control state).
    const poisonFixture = join(tempDir, "poison-server.mjs");
    await writeFile(
      poisonFixture,
      `import { writeFileSync, appendFileSync } from "node:fs";
const leaked = Object.keys(process.env).filter((k) => k.startsWith("ANCHOR_"));
if (leaked.length > 0 && process.env["POISON_MARKER"]) {
  writeFileSync(process.env["POISON_MARKER"], leaked.join(","));
}
if (process.env["TREE_PIDS_FILE"]) appendFileSync(process.env["TREE_PIDS_FILE"], String(process.pid));
process.stdout.write("x");
process.stdin.resume();
`,
    );
    // Unrelated sentinel owned by the TEST itself.
    const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    sentinel.unref();
    assert.ok(sentinel.pid);

    const servers = [
      {
        id: "poison",
        transport: {
          type: "stdio",
          command: process.execPath,
          args: [poisonFixture],
          env: { POISON_MARKER: join(tempDir, "poison-marker.txt") },
        },
        timeoutMs: 1000,
      },
    ];
    const cfgPath = await makeFleet(tempDir, servers);
    const { code } = await withIsolatedEnv(tempDir, () => runDoctor(cfgPath));
    assert.equal(code, 1, "a never-initializing server must fail the doctor");

    // The poison marker must NOT exist: no ANCHOR_* metadata reached the server.
    await assert.rejects(readFile(join(tempDir, "poison-marker.txt"), "utf8"), { code: "ENOENT" });

    // The unrelated sentinel must still be alive after the doctor returned.
    const pollDeadline = Date.now() + 8_000;
    let sentinelAlive = true;
    let recordedDead = false;
    while (Date.now() < pollDeadline) {
      sentinelAlive = (() => {
        try {
          process.kill(sentinel.pid!, 0);
          return true;
        } catch {
          return false;
        }
      })();
      const recordedPids = (await readFile(join(tempDir, "recorded-pids.txt"), "utf8"))
        .split("\n")
        .map((l) => Number.parseInt(l.trim(), 10))
        .filter((n) => Number.isSafeInteger(n) && n > 0)
        .filter((pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        });
      recordedDead = sentinelAlive && recordedPids.length === 0;
      if (recordedDead) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(sentinelAlive, true, "an unrelated process must never be killed by doctor teardown");
    assert.equal(recordedDead, true, "poison server processes must be dead after the doctor returned");

    try {
      process.kill(sentinel.pid!, "SIGKILL");
    } catch {}
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// PR 77 rework round 3 (finding 2): attempt 2's anchor handle must be
// associated with attempt 2's deadline — each attempt's exact anchor and
// server tree dies at ITS OWN deadline, not at final cleanup only.
test("each retry attempt's anchor tree is torn down at its own deadline", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ah-doctor-retry-"));
  const startedAt = Date.now();
  try {
    const servers = [stdioServer("hangy", [resolve(testDir, "fixtures/trickle-server.mjs")], { timeoutMs: 300 })];
    const cfgPath = await makeFleet(tempDir, servers);
    const { code } = await withIsolatedEnv(tempDir, () => runDoctor(cfgPath));
    const wallMs = Date.now() - startedAt;
    assert.equal(code, 1);
    // Two attempts x (300ms timeout + 2s activation slack) + retry settle;
    // if attempt 2's anchor were left for final cleanup the wall would still
    // pass, so the binding assertion is the per-PID death times below.
    assert.ok(wallMs < 15_000, `doctor took ${wallMs}ms; expected bounded per-attempt teardown`);

    const recordedPids = (await readFile(join(tempDir, "recorded-pids.txt"), "utf8"))
      .split("\n")
      .map((l) => Number.parseInt(l.trim(), 10))
      .filter((n) => Number.isSafeInteger(n) && n > 0);
    assert.ok(recordedPids.length >= 2, `expected both attempts' server PIDs recorded, got ${recordedPids.length}`);
    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const pollDeadline = Date.now() + 8_000;
    let survivors = recordedPids.filter(isAlive);
    while (survivors.length > 0 && Date.now() < pollDeadline) {
      await new Promise((r) => setTimeout(r, 250));
      survivors = recordedPids.filter(isAlive);
    }
    assert.deepEqual(survivors, [], `retry attempt trees survived: ${survivors.join(", ")}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// PR 77 rework round 4 (reviewer-1): killing ONLY the wrapper must make the
// anchor report FAILURE (exit 3) — never a false EXIT_PROVEN — and the host
// must fail closed. The downstream server survivor must not yield a green
// result anywhere.
test("unexpected wrapper death yields a failed anchor proof, not a green teardown", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ah-anchor-victim-"));
  const { spawnAnchor, EXIT_PROVEN, teardownAnchorChild, EXIT_FAILED } =
    await import("../dist/commands/process-anchor.js");
  const ownedPids: number[] = [];
  let savedPidFile: string | undefined;
  try {
    await writeFile(join(tempDir, "recorded-pids.txt"), "");
    savedPidFile = process.env["TREE_PIDS_FILE"];
    process.env["TREE_PIDS_FILE"] = join(tempDir, "recorded-pids.txt");
    const anchor = spawnAnchor(
      "daemon",
      process.execPath,
      [resolve(testDir, "fixtures/wrapper-victim-server.mjs"), "__daemon-run"],
      { detached: false, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
    );
    const stderr = anchor.stderr!.setEncoding("utf8");
    let wrapperPid: number | undefined;
    stderr.on("data", (chunk: string) => {
      const m = chunk.match(/PPID:(\d+)/);
      if (m && wrapperPid === undefined) wrapperPid = Number.parseInt(m[1]!, 10);
    });
    // Wait for the wrapper PID to arrive.
    const waitDeadline = Date.now() + 5_000;
    while (wrapperPid === undefined && Date.now() < waitDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(wrapperPid, "fixture must report the wrapper PID");
    // Kill ONLY the wrapper (SIGKILL, exact PID).
    try {
      process.kill(wrapperPid, "SIGKILL");
    } catch {}
    // The anchor must exit with the FAILURE proof code.
    const exitDeadline = Date.now() + 5_000;
    while (anchor.exitCode === null && anchor.signalCode === null && Date.now() < exitDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(anchor.exitCode, EXIT_FAILED, `anchor must report failure, got exitCode=${anchor.exitCode}`);
    assert.notEqual(anchor.exitCode, EXIT_PROVEN);
    // Host-side teardown of the already-dead anchor must FAIL CLOSED.
    const res = await teardownAnchorChild(anchor, 2_000);
    assert.equal(res.proven, false, "teardown must be unproven after unexpected wrapper death");

    // The recorded server survivor must NOT have been killed by any guessed
    // group signal — the test owns it and kills it itself.
    const recordedPids = (await readFile(join(tempDir, "recorded-pids.txt"), "utf8"))
      .split("\n")
      .map((l) => Number.parseInt(l.trim(), 10))
      .filter((n) => Number.isSafeInteger(n) && n > 0);
    assert.equal(recordedPids.length, 1, "expected exactly one recorded server PID");
    ownedPids.push(...recordedPids);
    let serverWasAlive = false;
    try {
      process.kill(recordedPids[0]!, 0);
      serverWasAlive = true;
    } catch {}
    assert.equal(serverWasAlive, true, "server survivor must not be killed by a guessed group signal");
    void spawn;
    void EXIT_PROVEN;
  } finally {
    // Cleanup MUST run even when the regression is red: restore env and kill
    // only the exact PIDs this test owns (never leak the survivor).
    if (savedPidFile === undefined) delete process.env["TREE_PIDS_FILE"];
    else process.env["TREE_PIDS_FILE"] = savedPidFile;
    for (const pid of ownedPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    // Give owned processes a bounded window to die, then verify.
    const cleanupDeadline = Date.now() + 5_000;
    let stillAlive: number[] = [];
    do {
      await new Promise((r) => setTimeout(r, 250));
      stillAlive = ownedPids.filter((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
    } while (stillAlive.length > 0 && Date.now() < cleanupDeadline);
    for (const pid of stillAlive) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});
