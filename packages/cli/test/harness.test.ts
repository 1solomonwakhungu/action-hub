import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessCommand } from "../dist/commands/harness.js";

async function withTempHome(fn: (home: string) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "action-hub-harness-"));
  const prevHome = process.env.HOME;
  process.env.HOME = tempDir;
  try {
    await fn(tempDir);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("harness export prints valid JSON with an action-hub entry", async () => {
  await withTempHome(async (home) => {
    const cfg = join(home, ".cursor", "mcp.json");
    await mkdir(join(home, ".cursor"), { recursive: true });
    await writeFile(cfg, JSON.stringify({ mcpServers: { other: { command: "foo" } } }));

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };
    try {
      await harnessCommand("cursor", { mode: "export", json: true });
    } finally {
      console.log = origLog;
    }
    const doc = JSON.parse(logs.join("\n")) as {
      mcpServers?: Record<string, unknown>;
    };
    assert.ok(doc.mcpServers, "mcpServers key present");
    assert.ok(doc.mcpServers["action-hub"], "action-hub entry present");
    assert.ok(doc.mcpServers["other"], "existing entry preserved");
  });
});

test("harness opencode entry uses the documented local schema", async () => {
  await withTempHome(async (home) => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };
    try {
      await harnessCommand("opencode", { mode: "export", json: true });
    } finally {
      console.log = origLog;
    }
    const doc = JSON.parse(logs.join("\n")) as {
      mcp?: Record<string, { type?: string; command?: unknown }>;
    };
    const entry = doc.mcp?.["action-hub"];
    assert.ok(entry, "action-hub entry present under mcp");
    assert.equal(entry.type, "local");
    assert.ok(Array.isArray(entry.command), "command is a single array");
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

    // A fake server build so install mode can locate the script.
    const fakeScript = join(home, "fake-server.js");
    await writeFile(fakeScript, "console.log('hi');\n");
    const cliDir = process.cwd();
    // installJson locates the script via findServerScript(cwd); emulate by
    // pointing ACTION_HUB_CONFIG-free options at a place it can find.
    // Instead of relying on repo layout, call with a cwd that has the script:
    const prevCwd = process.cwd();
    process.chdir(home);
    const fakePkgs = join(home, "packages", "copilot-plugin", "server", "dist");
    await mkdir(fakePkgs, { recursive: true });
    await writeFile(join(fakePkgs, "index.js"), "// fake\n");
    try {
      await harnessCommand("cursor", { mode: "install", write: true });
    } finally {
      process.chdir(prevCwd);
    }

    const doc = JSON.parse(await readFile(cfg, "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    const entry = doc.mcpServers["action-hub"];
    assert.ok(entry, "action-hub entry still present");
    assert.notEqual(entry.command, "old", "entry was updated");
    assert.equal(doc.mcpServers["other"].command, "keep", "other entry preserved");

    // .bak file exists
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(join(home, ".cursor"));
    assert.ok(
      files.some((f) => f.startsWith("mcp.json.bak-")),
      "timestamped .bak written",
    );
  });
});

test("harness install fails closed on malformed JSON config", async () => {
  await withTempHome(async (home) => {
    const cfg = join(home, ".cursor", "mcp.json");
    await mkdir(join(home, ".cursor"), { recursive: true });
    await writeFile(cfg, "{ this is not json");

    const fakePkgs = join(home, "packages", "copilot-plugin", "server", "dist");
    await mkdir(fakePkgs, { recursive: true });
    await writeFile(join(fakePkgs, "index.js"), "// fake\n");
    const prevCwd = process.cwd();
    process.chdir(home);
    try {
      await assert.rejects(
        () => harnessCommand("cursor", { mode: "install", write: true }),
        /Refusing to modify a config we cannot parse/,
      );
    } finally {
      process.chdir(prevCwd);
    }
    const raw = await readFile(cfg, "utf8");
    assert.equal(raw, "{ this is not json", "malformed config left untouched");
  });
});
