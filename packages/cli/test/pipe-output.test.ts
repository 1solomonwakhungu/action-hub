import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listCommand } from "../dist/commands/list.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const cliBin = resolve(testDir, "../dist/index.js");
const fixture = resolve(testDir, "fixtures/counting-mcp.mjs");

function captureConsole(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => void logs.push(args.join(" "));
  console.error = (...args: unknown[]) => void logs.push(args.join(" "));
  return {
    logs,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

// F10 regression: stdout to a pipe must not be truncated at 64 KiB. The bundle
// export is a single >1 MiB console.log write; with process.exit() pending
// writes used to be dropped at exactly 65,536 bytes.
test("CLI output over 64 KiB to a pipe is complete (F10)", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ah-pipe-"));
  const cfgPath = join(tempDir, "servers.json");
  const actionIds = Array.from({ length: 80_000 }, (_, i) => `srv:tool-${String(i).padStart(6, "0")}`);
  await writeFile(
    cfgPath,
    JSON.stringify({
      servers: [],
      bundles: [{ id: "big", displayName: "Big", description: "x", actionIds }],
      autoDiscover: false,
    }),
  );
  try {
    const res = spawnSync("node", [cliBin, "bundle", "--export", "big", "--config", cfgPath], {
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, HOME: tempDir },
    });
    assert.equal(res.status, 0, String(res.stderr));
    const out = res.stdout as Buffer;
    assert.ok(out.byteLength > 1_000_000, `expected >1MB, got ${out.byteLength}`);
    const parsed = JSON.parse(out.toString("utf8"));
    assert.equal(parsed.id, "big");
    assert.equal(parsed.actionIds.length, 80_000);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// F12 regression: list --server X must index only X, not the whole fleet.
test("list --server indexes only the requested server (F12)", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ah-list-srv-"));
  const countA = join(tempDir, "count-a");
  const countB = join(tempDir, "count-b");
  const cfgPath = join(tempDir, "servers.json");
  await writeFile(
    cfgPath,
    JSON.stringify({
      servers: [
        {
          id: "srv-a",
          transport: { type: "stdio", command: process.execPath, args: [fixture], env: { COUNT_FILE: countA } },
        },
        {
          id: "srv-b",
          transport: { type: "stdio", command: process.execPath, args: [fixture], env: { COUNT_FILE: countB } },
        },
      ],
      autoDiscover: false,
    }),
  );

  try {
    // Hermetic isolation: listCommand probes ACTION_HUB_SKILLS_DIR (default
    // ~/.action-hub/skills); point HOME at the temp dir so the test never
    // reads real owner state.
    const savedHome = process.env["HOME"];
    const savedSkillsDir = process.env["ACTION_HUB_SKILLS_DIR"];
    process.env["HOME"] = tempDir;
    delete process.env["ACTION_HUB_SKILLS_DIR"];
    const captured = captureConsole();
    try {
      const code = await listCommand({ configPath: cfgPath, server: "srv-a" });
      assert.equal(code, 0);
    } finally {
      captured.restore();
      if (savedHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = savedHome;
      if (savedSkillsDir === undefined) delete process.env["ACTION_HUB_SKILLS_DIR"];
      else process.env["ACTION_HUB_SKILLS_DIR"] = savedSkillsDir;
    }
    const spawnsA = (await readFile(countA, "utf8")).trim().split("\n").filter(Boolean);
    assert.equal(spawnsA.length, 1, `srv-a spawned once, got ${spawnsA.length}`);
    // srv-b must never have been contacted.
    let contacted = false;
    try {
      await readFile(countB, "utf8");
      contacted = true;
    } catch {
      contacted = false;
    }
    assert.equal(contacted, false, "srv-b must not be indexed by list --server srv-a");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// F11 regression: list --kind skill must include config.skills entries and the
// skills directory, exactly like the runtime registers them.
test("list --kind skill registers config and directory skills (F11)", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ah-list-skill-"));
  const cfgPath = join(tempDir, "servers.json");
  const skillsDir = join(tempDir, "skills");
  await mkdir(join(skillsDir, "dir-skill"), { recursive: true });
  await writeFile(
    join(skillsDir, "dir-skill", "SKILL.md"),
    "---\nname: Dir Skill\ndescription: A skill from the skills directory\n---\nBody\n",
  );
  await writeFile(
    cfgPath,
    JSON.stringify({
      servers: [],
      skills: [
        {
          id: "config-skill",
          name: "Config Skill",
          summary: "A skill from config",
          description: "config",
        },
      ],
      autoDiscover: false,
    }),
  );

  try {
    // Hermetic isolation: never probe the real owner's ~/.action-hub/skills or
    // config paths during tests.
    const savedEnv = {
      HOME: process.env["HOME"],
      XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"],
      XDG_CACHE_HOME: process.env["XDG_CACHE_HOME"],
      ACTION_HUB_SKILLS_DIR: process.env["ACTION_HUB_SKILLS_DIR"],
      ACTION_HUB_CONFIG: process.env["ACTION_HUB_CONFIG"],
    };
    process.env["HOME"] = tempDir;
    process.env["XDG_CONFIG_HOME"] = join(tempDir, "xdg-config");
    process.env["XDG_CACHE_HOME"] = join(tempDir, "xdg-cache");
    process.env["ACTION_HUB_SKILLS_DIR"] = skillsDir;
    delete process.env["ACTION_HUB_CONFIG"];
    const captured = captureConsole();
    try {
      const code = await listCommand({ configPath: cfgPath, kind: "skill" });
      assert.equal(code, 0);
      const output = captured.logs.join("\n");
      assert.match(output, /Config Skill/);
      assert.match(output, /Dir Skill/);
      assert.equal(code, 0);
    } finally {
      captured.restore();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// Daemon connect handshake failure must not leave the socket open: a fake
// daemon that accepts and never responds must not keep the CLI process alive.
test("connect destroys the socket on handshake failure (MUST-FIX)", async () => {
  const net = await import("node:net");
  const { spawn } = await import("node:child_process");
  const { chmod } = await import("node:fs/promises");
  let accepted = false;
  const server = net.createServer((sock) => {
    // Accept and never respond; keep the socket open.
    accepted = true;
    sock.on("error", () => {});
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;

  const tempDir = await mkdtemp(join(tmpdir(), "ah-connect-"));
  const daemonDir = join(tempDir, "daemon");
  await mkdir(daemonDir, { recursive: true, mode: 0o700 });
  await writeFile(join(daemonDir, "daemon.json"), JSON.stringify({
    version: 1,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    endpoint: { kind: "tcp", host: "127.0.0.1", port },
  }));
  await writeFile(join(daemonDir, "auth-token"), "0".repeat(64));
  // assertPrivate refuses 0644 state files; the real daemon writes 0600.
  await chmod(join(daemonDir, "daemon.json"), 0o600);
  await chmod(join(daemonDir, "auth-token"), 0o600);

  try {
    // Async spawn: spawnSync would block this same process's server callback.
    const child = spawn("node", [cliBin, "connect", "--daemon-dir", daemonDir], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderrChunks: Buffer[] = [];
    child.stderr?.on("data", (c: Buffer) => stderrChunks.push(c));
    const exitCode = await Promise.race([
      new Promise<number | null>((done) => child.once("exit", (code) => done(code))),
      new Promise<"timeout">((done) => setTimeout(() => done("timeout"), 15_000)),
    ]);
    // The fake daemon must have accepted the connection AND the CLI must have
    // exited 1 promptly after the read timeout (a live process at this point
    // is the hang this regression guards against).
    assert.equal(accepted, true, "fake daemon must have accepted the connection");
    assert.equal(exitCode, 1, `expected exit 1, got ${exitCode}; stderr=${Buffer.concat(stderrChunks).toString().slice(0, 200)}`);
    assert.match(Buffer.concat(stderrChunks).toString(), /could not connect to daemon/);
    if (exitCode === null) child.kill("SIGKILL");
  } finally {
    server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

// kind=skill must never contact any MCP server: tool records would be filtered
// out immediately, so indexing the fleet is pure waste.
test("list --kind skill never contacts MCP servers (HIGH)", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ah-skill-nosrv-"));
  const countFile = join(tempDir, "count");
  const cfgPath = join(tempDir, "servers.json");
  await writeFile(
    cfgPath,
    JSON.stringify({
      servers: [{
        id: "srv-a",
        transport: { type: "stdio", command: process.execPath, args: [fixture], env: { COUNT_FILE: countFile } },
      }],
      skills: [{ id: "c1", name: "C1", summary: "from config", description: "config" }],
      autoDiscover: false,
    }),
  );

  try {
    const savedHome = process.env["HOME"];
    const savedSkillsDir = process.env["ACTION_HUB_SKILLS_DIR"];
    process.env["HOME"] = tempDir;
    process.env["ACTION_HUB_SKILLS_DIR"] = join(tempDir, "empty-skills");
    await mkdir(join(tempDir, "empty-skills"), { recursive: true });
    const captured = captureConsole();
    try {
      const code = await listCommand({ configPath: cfgPath, kind: "skill" });
      assert.equal(code, 0);
      assert.match(captured.logs.join("\n"), /C1/);
    } finally {
      captured.restore();
      if (savedHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = savedHome;
      if (savedSkillsDir === undefined) delete process.env["ACTION_HUB_SKILLS_DIR"];
      else process.env["ACTION_HUB_SKILLS_DIR"] = savedSkillsDir;
    }
    // The counting server must never have been spawned.
    let contacted = false;
    try {
      await readFile(countFile, "utf8");
      contacted = true;
    } catch {
      contacted = false;
    }
    assert.equal(contacted, false, "list --kind skill must not index MCP servers");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// Combined flags: --kind skill --server X must never index any MCP server and
// must still list the local skills (FX4-R HIGH).
test("list --kind skill --server never indexes servers and still lists skills", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ah-skill-srv-"));
  const countFile = join(tempDir, "count");
  const cfgPath = join(tempDir, "servers.json");
  await writeFile(
    cfgPath,
    JSON.stringify({
      servers: [{
        id: "srv-a",
        transport: { type: "stdio", command: process.execPath, args: [fixture], env: { COUNT_FILE: countFile } },
      }],
      skills: [{ id: "c1", name: "C1", summary: "from config", description: "config" }],
      autoDiscover: false,
    }),
  );

  try {
    const savedHome = process.env["HOME"];
    const savedSkillsDir = process.env["ACTION_HUB_SKILLS_DIR"];
    process.env["HOME"] = tempDir;
    process.env["ACTION_HUB_SKILLS_DIR"] = join(tempDir, "empty-skills");
    await mkdir(join(tempDir, "empty-skills"), { recursive: true });
    const captured = captureConsole();
    try {
      const code = await listCommand({ configPath: cfgPath, server: "srv-a", kind: "skill" });
      assert.equal(code, 0);
      assert.match(captured.logs.join("\n"), /C1/);
    } finally {
      captured.restore();
      if (savedHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = savedHome;
      if (savedSkillsDir === undefined) delete process.env["ACTION_HUB_SKILLS_DIR"];
      else process.env["ACTION_HUB_SKILLS_DIR"] = savedSkillsDir;
    }
    let contacted = false;
    try {
      await readFile(countFile, "utf8");
      contacted = true;
    } catch {
      contacted = false;
    }
    assert.equal(contacted, false, "--kind skill --server X must not index MCP servers");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
