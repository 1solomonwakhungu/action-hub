import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as tomlParse } from "smol-toml";
import { HARNESS_DEFS } from "../dist/commands/harness.js";
import { initCommand, type InitSummary } from "../dist/commands/init.js";

const CLI_BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const MINIMAL_MCP = fileURLToPath(new URL("./fixtures/minimal-mcp.mjs", import.meta.url));

interface CapturedOutput<T> {
  result: T;
  stdout: string;
  stderr: string;
}

async function captureOutput<T>(fn: () => Promise<T>): Promise<CapturedOutput<T>> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => {
    out.push(args.join(" "));
  };
  console.error = (...args: unknown[]) => {
    err.push(args.join(" "));
  };
  try {
    const result = await fn();
    return { result, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

async function withIsolatedHome(
  fn: (home: string) => Promise<void>,
): Promise<void> {
  const tempHome = await mkdtemp(join(tmpdir(), "action-hub-init-"));
  const prevCwd = process.cwd();
  const saved: Record<string, string | undefined> = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    ACTION_HUB_CONFIG: process.env.ACTION_HUB_CONFIG,
    ACTION_HUB_SKILLS_DIR: process.env.ACTION_HUB_SKILLS_DIR,
  };
  process.env.HOME = tempHome;
  process.env.XDG_CONFIG_HOME = join(tempHome, ".config");
  delete process.env.ACTION_HUB_CONFIG;
  delete process.env.ACTION_HUB_SKILLS_DIR;
  process.chdir(tempHome);
  try {
    await fn(tempHome);
  } finally {
    process.chdir(prevCwd);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tempHome, { recursive: true, force: true });
  }
}

function runCli(args: string[], tempHome: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: tempHome,
    XDG_CONFIG_HOME: join(tempHome, ".config"),
  };
  delete env.ACTION_HUB_CONFIG;
  delete env.ACTION_HUB_SKILLS_DIR;
  return spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd: tempHome,
    env,
    encoding: "utf8",
  });
}

test("init --dry-run previews migration and harness without mutating any files on disk", async () => {
  await withIsolatedHome(async (home) => {
    // Seed a discoverable Cursor MCP server and an existing Claude Code config
    const cursorDir = join(home, ".cursor");
    await mkdir(cursorDir, { recursive: true });
    await writeFile(
      join(cursorDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          demo: { command: process.execPath, args: [MINIMAL_MCP] },
        },
      }),
      "utf8",
    );

    const claudePath = HARNESS_DEFS["claude-code"].configPath(home);
    const originalClaudeContent = JSON.stringify({ mcpServers: { existing: { command: "keep" } } });
    await writeFile(claudePath, originalClaudeContent, "utf8");

    const serversJsonPath = join(home, ".config", "action-hub", "servers.json");

    const { result, stdout } = await captureOutput(() =>
      initCommand({
        harness: "claude-code",
        dryRun: true,
        skipDoctor: true,
      }),
    );

    assert.equal(result, 0);
    assert.ok(!existsSync(serversJsonPath), "servers.json must not be created during --dry-run");
    assert.equal(
      await readFile(claudePath, "utf8"),
      originalClaudeContent,
      "harness config must remain untouched during --dry-run",
    );
    const homeFiles = await readdir(home);
    assert.ok(
      !homeFiles.some((f) => f.includes(".bak-")),
      "no backup files should be written during --dry-run",
    );
    assert.match(stdout, /dry run/i);
    assert.match(stdout, /Re-run without --dry-run/);
  });
});

test("init --harness claude-code migrates servers, writes harness config with backup, and prints summary", async () => {
  await withIsolatedHome(async (home) => {
    // Seed a working minimal MCP server in Cursor config so doctor can index it too
    const cursorDir = join(home, ".cursor");
    await mkdir(cursorDir, { recursive: true });
    await writeFile(
      join(cursorDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          pinger: { command: process.execPath, args: [MINIMAL_MCP] },
        },
      }),
      "utf8",
    );

    // Seed an existing ~/.claude.json so backup + entry preservation are exercised
    const claudePath = HARNESS_DEFS["claude-code"].configPath(home);
    await writeFile(
      claudePath,
      JSON.stringify({ mcpServers: { other: { command: "keep" } } }),
      "utf8",
    );

    const { result, stdout } = await captureOutput(() =>
      initCommand({
        harness: "claude-code",
      }),
    );

    assert.equal(result, 0);

    // 1. Verify Action Hub servers.json was written with migrated server
    const serversJsonPath = join(home, ".config", "action-hub", "servers.json");
    assert.ok(existsSync(serversJsonPath), "servers.json written");
    const savedConfig = JSON.parse(await readFile(serversJsonPath, "utf8")) as {
      servers?: Array<{ id: string }>;
    };
    assert.ok(
      savedConfig.servers?.some((s) => s.id === "pinger"),
      "migrated pinger server saved to servers.json",
    );

    // 2. Verify ~/.claude.json was updated in place with backup and preserved other entries
    const claudeDoc = JSON.parse(await readFile(claudePath, "utf8")) as {
      mcpServers: Record<string, { command: string; args?: string[] }>;
    };
    assert.equal(claudeDoc.mcpServers["other"]?.command, "keep", "existing harness entry preserved");
    assert.equal(
      claudeDoc.mcpServers["action-hub"]?.args?.at(-1),
      "start",
      "action-hub installed in stdio mode",
    );

    const homeFiles = await readdir(home);
    assert.ok(
      homeFiles.some((f) => f.startsWith(".claude.json.bak-")),
      "timestamped backup created for ~/.claude.json",
    );

    // 3. Verify crisp summary block printed with indexed tools and harness info
    assert.match(stdout, /Summary:/);
    assert.match(stdout, /1 tool\(s\) indexed/);
    assert.match(stdout, /Claude Code/);
    assert.match(stdout, /stdio mode/);
    assert.match(stdout, /Next steps:/);
  });
});

test("init --harness codex --daemon writes connect into Codex TOML and prints daemon hint", async () => {
  await withIsolatedHome(async (home) => {
    const res = runCli(["init", "--harness", "codex", "--daemon", "--skip-doctor"], home);
    assert.equal(res.status, 0, `CLI exited ${res.status}: ${res.stderr}`);

    const codexPath = join(home, ".codex", "config.toml");
    assert.ok(existsSync(codexPath), "Codex config.toml written");
    const codexDoc = tomlParse(await readFile(codexPath, "utf8")) as {
      mcp_servers?: Record<string, { command: string; args: string[] }>;
    };
    const entry = codexDoc.mcp_servers?.["action-hub"];
    assert.ok(entry, "action-hub entry written to Codex config.toml");
    assert.equal(entry.args.at(-1), "connect", "daemon mode writes connect subcommand");
    assert.match(res.stdout, /daemon mode/);
    assert.match(res.stdout, /action-hub daemon start/);
    assert.match(res.stderr, /action-hub daemon start/);
  });
});

test("init --json prints valid structured JSON on stdout with real indexed metrics", async () => {
  await withIsolatedHome(async (home) => {
    const cursorDir = join(home, ".cursor");
    await mkdir(cursorDir, { recursive: true });
    await writeFile(
      join(cursorDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          pinger: { command: process.execPath, args: [MINIMAL_MCP] },
        },
      }),
      "utf8",
    );

    const res = runCli(["init", "--harness", "cursor", "--daemon", "--json"], home);
    assert.equal(res.status, 0, `CLI exited ${res.status}: ${res.stderr}`);

    const parsed = JSON.parse(res.stdout) as InitSummary;
    assert.equal(parsed.dryRun, false);
    assert.equal(parsed.migrate.skipped, false);
    assert.equal(parsed.migrate.written, true);
    assert.equal(parsed.migrate.discovered.servers, 1);
    assert.equal(parsed.migrate.added.servers, 1);
    assert.equal(parsed.harness.configured, true);
    assert.equal(parsed.harness.target, "cursor");
    assert.equal(parsed.harness.mode, "daemon");
    assert.equal(parsed.harness.written, true);
    assert.equal(parsed.doctor.skipped, false);
    assert.equal(parsed.doctor.healthy, true);
    assert.equal(parsed.doctor.toolsIndexed, 1);
    assert.ok(parsed.doctor.contextSavings, "contextSavings populated");
    assert.equal(parsed.totals.servers, 1);
    assert.equal(parsed.totals.toolsIndexed, 1);
    assert.ok(
      parsed.nextSteps.some((step) => step.includes("action-hub daemon start")),
      "nextSteps includes daemon start hint",
    );

    // Cursor config should have connect written
    const cursorDoc = JSON.parse(await readFile(join(cursorDir, "mcp.json"), "utf8")) as {
      mcpServers: Record<string, { args: string[] }>;
    };
    assert.equal(cursorDoc.mcpServers["action-hub"]?.args.at(-1), "connect");

    // Re-running init must remain idempotent and never import `action-hub` itself
    const rerun = runCli(["init", "--harness", "cursor", "--daemon", "--json"], home);
    assert.equal(rerun.status, 0, `rerun exited ${rerun.status}: ${rerun.stderr}`);
    const rerunParsed = JSON.parse(rerun.stdout) as InitSummary;
    assert.equal(rerunParsed.migrate.added.servers, 0, "no duplicate servers added on rerun");
    assert.equal(rerunParsed.totals.servers, 1, "action-hub itself is never imported as a downstream server");
    assert.equal(rerunParsed.doctor.healthy, true, "doctor stays healthy on rerun");
  });
});

test("init rejects invalid or missing --harness target with exit code 1 before any disk mutation", async () => {
  await withIsolatedHome(async (home) => {
    const serversJsonPath = join(home, ".config", "action-hub", "servers.json");

    // Direct invocation with unknown harness
    const direct = await captureOutput(() =>
      initCommand({ harness: "not-a-harness" }),
    );
    assert.equal(direct.result, 1);
    assert.match(direct.stderr, /unknown harness "not-a-harness"/);
    assert.match(direct.stderr, /claude-code/);
    assert.ok(!existsSync(serversJsonPath), "invalid harness must fail before migrating config");

    // CLI invocation with unknown harness
    const badCli = runCli(["init", "--harness", "bogus", "--json"], home);
    assert.equal(badCli.status, 1);
    assert.match(badCli.stderr, /unknown harness "bogus"/);
    assert.match(badCli.stderr, /supported harnesses:/);
    assert.equal(badCli.stdout.trim(), "", "no JSON emitted on error");
    assert.ok(!existsSync(serversJsonPath), "config untouched on CLI error");

    // CLI invocation with valueless --harness
    const missingVal = runCli(["init", "--harness", "--daemon"], home);
    assert.equal(missingVal.status, 1);
    assert.match(missingVal.stderr, /Missing value for --harness/);
    assert.ok(!existsSync(serversJsonPath), "config untouched when --harness has no value");
  });
});

test("init supports --skip-migrate, --skip-doctor, and --help", async () => {
  await withIsolatedHome(async (home) => {
    const helpRes = runCli(["init", "--help"], home);
    assert.equal(helpRes.status, 0);
    assert.match(helpRes.stdout, /action-hub init/);
    assert.match(helpRes.stdout, /--harness/);
    assert.match(helpRes.stdout, /--daemon/);

    const skipRes = runCli(["init", "--skip-migrate", "--skip-doctor", "--json"], home);
    assert.equal(skipRes.status, 0, `stderr: ${skipRes.stderr}`);
    const parsed = JSON.parse(skipRes.stdout) as InitSummary;
    assert.equal(parsed.migrate.skipped, true);
    assert.equal(parsed.migrate.written, false);
    assert.equal(parsed.doctor.skipped, true);
    assert.equal(parsed.harness.configured, false);
    assert.ok(
      parsed.nextSteps.some((s) => s.includes("action-hub harness")),
      "suggests connecting a harness when --harness omitted",
    );
    assert.ok(
      parsed.nextSteps.some((s) => s.includes("action-hub doctor")),
      "suggests running doctor when --skip-doctor passed",
    );
  });
});
