import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { doctorCommand } from "../dist/commands/doctor.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../..");
const fakeServer = resolve(repoRoot, "stress/fake-mcp-server.mjs");

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
  };
  process.env["HOME"] = tempDir;
  process.env["XDG_CONFIG_HOME"] = join(tempDir, "xdg-config");
  process.env["XDG_CACHE_HOME"] = join(tempDir, "xdg-cache");
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
    // A minimal manifest for the fake MCP server.
    const manifestDir = join(tempDir, "manifests");
    await mkdir(manifestDir, { recursive: true });
    const manifest = { serverId: "healthy", tools: [{ name: "ping", description: "ping", inputSchema: { type: "object", properties: {} } }] };
    const manifestPath = join(manifestDir, "healthy.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const servers = ["h1", "h2"].map((id) =>
      stdioServer(id, [fakeServer, "--manifest", manifestPath], { timeoutMs: 5000 }),
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

test("doctor exit code is deterministic across 10 runs with a slow-start server (F17)", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ah-doctor-slow-"));
  try {
    const manifestDir = join(tempDir, "manifests");
    await mkdir(manifestDir, { recursive: true });
    const manifest = { serverId: "slow", tools: [{ name: "ping", description: "ping", inputSchema: { type: "object", properties: {} } }] };
    const manifestPath = join(manifestDir, "slow.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    // The server delays its first served request beyond the per-server
    // timeout, so the first probe times out; the doctor's bounded retry must
    // recover it (the process keeps running) and the exit code must be a
    // stable 0 — previously this flapped between 0 and 1 run to run.
    const servers = [
      stdioServer("slow", [fakeServer, "--manifest", manifestPath, "--chaos", "slow-start-ms=2000"], { timeoutMs: 1200 }),
      stdioServer("healthy", [fakeServer, "--manifest", manifestPath], { timeoutMs: 5000 }),
    ];
    const cfgPath = await makeFleet(tempDir, servers);

    const codes: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const { code, output } = await withIsolatedEnv(tempDir, () => runDoctor(cfgPath));
      codes.push(code);
      if (i === 0) {
        assert.match(output, /\[slow\]/);
        assert.match(output, /\[healthy\]/);
      }
    }
    assert.equal(codes.filter((c) => c === 0).length, RUNS, `expected all ${RUNS} runs exit 0, got ${codes.join(",")}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("doctor exit code is deterministic across 10 runs with a permanently down server (F17)", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ah-doctor-down-"));
  try {
    const manifestDir = await mkdtemp(join(tmpdir(), "ah-doctor-manifests-"));
    const manifest = { serverId: "healthy", tools: [{ name: "ping", description: "ping", inputSchema: { type: "object", properties: {} } }] };
    const manifestPath = join(manifestDir, "healthy.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    // A command that exits immediately: down on every attempt.
    const servers = [
      stdioServer("dead", [process.execPath, "-e", "process.exit(1)"], { timeoutMs: 5000 }),
      stdioServer("healthy", [fakeServer, "--manifest", manifestPath], { timeoutMs: 5000 }),
    ];
    const cfgPath = await makeFleet(tempDir, servers);

    const codes: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const { code } = await withIsolatedEnv(tempDir, () => runDoctor(cfgPath));
      codes.push(code);
    }
    assert.equal(codes.filter((c) => c === 1).length, RUNS, `expected all ${RUNS} runs exit 1, got ${codes.join(",")}`);
    await rm(manifestDir, { recursive: true, force: true });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
