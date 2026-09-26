import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as tomlParse } from "smol-toml";
import { harnessCommand, HARNESS_DEFS } from "../dist/commands/harness.js";

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

/** Capture console.log/console.error output produced by harnessCommand. */
async function captureLogs(fn: () => Promise<unknown>): Promise<string> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  console.error = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origError;
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
    assert.equal(doc.mcpServers?.["other"], undefined, "export emits only the action-hub fragment");
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

test("harness export never echoes existing config secrets", async () => {
  await withTempHome(async (home) => {
    const cfg = join(home, ".cursor", "mcp.json");
    await mkdir(join(home, ".cursor"), { recursive: true });
    await writeFile(
      cfg,
      JSON.stringify({
        mcpServers: { private: { command: "x" } },
        SENTINEL_API_KEY: "sk-secret-do-not-print",
      }),
    );
    for (const json of [true, false]) {
      const out = await captureLogs(() =>
        harnessCommand("cursor", { mode: "export", json }),
      );
      assert.ok(!out.includes("SENTINEL_API_KEY"), `--json=${json}: key not echoed`);
      assert.ok(!out.includes("sk-secret-do-not-print"), `--json=${json}: value not echoed`);
    }
  });
});

test("harness --json is rejected for TOML targets", async () => {
  await withTempHome(async () => {
    assert.equal(await harnessCommand("codex", { mode: "export", json: true }), 1);
  });
});

test("win32 targets resolve under APPDATA", async () => {
  const home = "/home/fake";
  const appData = "C:\\Users\\fake\\AppData\\Roaming";
  const savedPlatform = process.platform;
  const savedAppData = process.env.APPDATA;
  Object.defineProperty(process, "platform", { value: "win32" });
  process.env.APPDATA = appData;
  try {
    assert.equal(
      HARNESS_DEFS["claude-desktop"].configPath(home),
      join(appData, "Claude", "claude_desktop_config.json"),
    );
    assert.equal(
      HARNESS_DEFS["vscode"].configPath(home),
      join(appData, "Code", "User", "mcp.json"),
    );
  } finally {
    Object.defineProperty(process, "platform", { value: savedPlatform });
    if (savedAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = savedAppData;
  }
});

test("snippet under node uses bare node, never an absolute node path", async () => {
  await withTempHome(async () => {
    const out = await captureLogs(() =>
      harnessCommand("cursor", { mode: "export", json: true }),
    );
    const doc = JSON.parse(out) as {
      mcpServers?: Record<string, { command: string; args: string[] }>;
    };
    const entry = doc.mcpServers?.["action-hub"];
    assert.ok(entry, "action-hub entry present");
    assert.equal(entry.command, "node", "command is bare node, resolved on PATH");
    assert.equal(entry.args.at(-1), "start");
  });
});

test("harness --node overrides the node command in the snippet", async () => {
  await withTempHome(async () => {
    const out = await captureLogs(() =>
      harnessCommand("cursor", {
        mode: "export",
        json: true,
        node: "/opt/nvm/versions/node/v22/bin/node",
      }),
    );
    const doc = JSON.parse(out) as {
      mcpServers?: Record<string, { command: string }>;
    };
    assert.equal(
      doc.mcpServers?.["action-hub"]?.command,
      "/opt/nvm/versions/node/v22/bin/node",
      "--node path replaces bare node",
    );
  });
});

test("pi install honors PI_CODING_AGENT_DIR and writes mcp.json there", async () => {
  await withTempHome(async (_home, tempDir) => {
    const agentDir = join(tempDir, "agent");
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await captureLogs(() => harnessCommand("pi", { mode: "install", write: true }));
      const doc = JSON.parse(await readFile(join(agentDir, "mcp.json"), "utf8")) as {
        mcpServers?: Record<string, { command: string; args: string[] }>;
      };
      const entry = doc.mcpServers?.["action-hub"];
      assert.ok(entry, "action-hub entry written to $PI_CODING_AGENT_DIR/mcp.json");
      assert.equal(entry.command, "node");
      assert.equal(entry.args.at(-1), "start");
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
    }
  });
});

test("pi default config path is ~/.pi/agent/mcp.json when env is unset", async () => {
  await withTempHome(async (home) => {
    const prev = process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
    try {
      assert.equal(
        HARNESS_DEFS.pi.configPath(home),
        join(home, ".pi", "agent", "mcp.json"),
      );
    } finally {
      if (prev !== undefined) process.env.PI_CODING_AGENT_DIR = prev;
    }
  });
});
