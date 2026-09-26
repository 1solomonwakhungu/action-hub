import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as tomlParse } from "smol-toml";
import { harnessCommand } from "../dist/commands/harness.js";

async function withTempHome(
  fn: (home: string, tempDir: string) => Promise<void>,
): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "action-hub-harness-"));
  const prevHome = process.env.HOME;
  process.env.HOME = tempDir;
  try {
    await fn(tempDir, tempDir);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(tempDir, { recursive: true, force: true });
  }
}

/** Capture console.log output produced by harnessCommand. */
async function captureLogs(fn: () => Promise<unknown>): Promise<string> {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = origLog;
  }
  return logs.join("\n");
}

test("harness export prints valid JSON with an action-hub entry", async () => {
  await withTempHome(async (home) => {
    const cfg = join(home, ".cursor", "mcp.json");
    await mkdir(join(home, ".cursor"), { recursive: true });
    await writeFile(cfg, JSON.stringify({ mcpServers: { other: { command: "foo" } } }));

    const out = await captureLogs(() =>
      harnessCommand("cursor", { mode: "export", json: true }),
    );
    const doc = JSON.parse(out) as {
      mcpServers?: Record<string, { command: string; args: string[] }>;
    };
    const entry = doc.mcpServers?.["action-hub"];
    assert.ok(entry, "action-hub entry present");
    assert.equal(entry.args.at(-1), "start", "entry runs the CLI start subcommand");
    assert.ok(doc.mcpServers?.["other"], "existing entry preserved");
  });
});

test("harness opencode entry uses the documented local schema", async () => {
  await withTempHome(async () => {
    const out = await captureLogs(() =>
      harnessCommand("opencode", { mode: "export", json: true }),
    );
    const doc = JSON.parse(out) as {
      mcp?: Record<string, { type?: string; command?: unknown; environment?: Record<string, string> }>;
    };
    const entry = doc.mcp?.["action-hub"];
    assert.ok(entry, "action-hub entry present under mcp");
    assert.equal(entry.type, "local");
    assert.ok(Array.isArray(entry.command), "command is a single array");
  });
});

test("harness export is cwd-independent", async () => {
  await withTempHome(async (_home, tempDir) => {
    const prevCwd = process.cwd();
    process.chdir(tempDir); // unrelated cwd with no action-hub checkout
    try {
      const out = await captureLogs(() =>
        harnessCommand("cursor", { mode: "export", json: true }),
      );
      const doc = JSON.parse(out) as { mcpServers?: Record<string, { args: string[] }> };
      const args = doc.mcpServers?.["action-hub"]?.args ?? [];
      assert.ok(args.at(-1) === "start", "entry resolves regardless of cwd");
      assert.ok(
        !args.some((a) => a.includes("<action-hub>")),
        "no placeholder emitted",
      );
    } finally {
      process.chdir(prevCwd);
    }
  });
});

test("harness install updates the action-hub entry in place and writes a .bak", async () => {
  await withTempHome(async (home) => {
    const cfg = join(home, ".cursor", "mcp.json");
    await mkdir(join(home, ".cursor"), { recursive: true });
    await writeFile(
      cfg,
      JSON.stringify({
        mcpServers: {
          "action-hub": { command: "old", args: ["old.js"] },
          other: { command: "keep" },
        },
      }),
    );
    await captureLogs(() => harnessCommand("cursor", { mode: "install", write: true }));

    const doc = JSON.parse(await readFile(cfg, "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    const entry = doc.mcpServers["action-hub"];
    assert.ok(entry, "action-hub entry still present");
    assert.notEqual(entry.command, "old", "entry was updated");
    assert.equal(entry.args.at(-1), "start");
    assert.equal(doc.mcpServers["other"].command, "keep", "other entry preserved");

    const files = await readdir(join(home, ".cursor"));
    assert.ok(
      files.some((f) => f.startsWith("mcp.json.bak-")),
      "timestamped .bak written",
    );
  });
});

test("harness install fails closed on unreadable config (no mutation, exit 1)", async () => {
  await withTempHome(async (home) => {
    const cfg = join(home, ".cursor", "mcp.json");
    await mkdir(join(home, ".cursor"), { recursive: true });
    await writeFile(cfg, JSON.stringify({ mcpServers: { other: { command: "keep" } } }));
    await chmod(cfg, 0o200); // owner-write-only: read fails with EACCES

    const exitCode = await harnessCommand("cursor", { mode: "install", write: true });
    await chmod(cfg, 0o600);
    assert.equal(exitCode, 1, "exit 1 on unreadable config");
    const raw = await readFile(cfg, "utf8");
    assert.deepEqual(
      JSON.parse(raw),
      { mcpServers: { other: { command: "keep" } } },
      "file unchanged",
    );
  });
});

test("harness install fails closed on malformed JSON config", async () => {
  await withTempHome(async (home) => {
    const cfg = join(home, ".cursor", "mcp.json");
    await mkdir(join(home, ".cursor"), { recursive: true });
    await writeFile(cfg, "{ this is not json");
    const exitCode = await harnessCommand("cursor", { mode: "install", write: true });
    assert.equal(exitCode, 1, "exit 1 on malformed JSON");
    const raw = await readFile(cfg, "utf8");
    assert.equal(raw, "{ this is not json", "malformed config left untouched");
  });
});

test("harness install fails closed on malformed TOML config", async () => {
  await withTempHome(async (home) => {
    const cfg = join(home, ".codex", "config.toml");
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(cfg, 'model = "underterminated\n');
    const exitCode = await harnessCommand("codex", { mode: "install", write: true });
    assert.equal(exitCode, 1, "exit 1 on malformed TOML");
    const raw = await readFile(cfg, "utf8");
    assert.equal(raw, 'model = "underterminated\n', "malformed TOML left untouched");
  });
});

test("codex install emits TOML that parses, with a proper env table", async () => {
  await withTempHome(async (home) => {
    const customConfig = join(home, "custom-servers.json");
    await writeFile(customConfig, "{}\n");
    await captureLogs(() =>
      harnessCommand("codex", {
        mode: "install",
        write: true,
        configPath: customConfig,
      }),
    );
    const cfg = join(home, ".codex", "config.toml");
    const doc = tomlParse(await readFile(cfg, "utf8")) as {
      mcp_servers?: Record<
        string,
        { command: string; args: string[]; env?: Record<string, string> }
      >;
    };
    const entry = doc.mcp_servers?.["action-hub"];
    assert.ok(entry, "action-hub entry present");
    assert.ok(Array.isArray(entry.args), "args is a TOML array");
    assert.equal(entry.args.at(-1), "start");
    assert.equal(
      entry.env?.ACTION_HUB_CONFIG,
      customConfig,
      "env is a TOML table with ACTION_HUB_CONFIG",
    );
  });
});

test("harness returns 1 for unknown targets and ungated installs (no process.exit)", async () => {
  await withTempHome(async () => {
    assert.equal(await harnessCommand("nosuch", {}), 1);
    assert.equal(await harnessCommand("cursor", { mode: "install" }), 1);
    assert.equal(await harnessCommand("help", {}), 0);
  });
});
