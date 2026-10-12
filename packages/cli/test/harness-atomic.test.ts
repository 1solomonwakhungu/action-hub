import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as tomlParse } from "smol-toml";
import { harnessCommand } from "../dist/commands/harness.js";

// `harness <target> install --write` used to rewrite the host config with a
// plain truncating writeFile: a crash between truncate and write left the
// harness with an empty, unparseable mcp.json / config.toml. The write must go
// through a sibling temp file + rename (the same contract as the server's
// config writer), keep the existing file's mode, and write THROUGH a
// symlinked config (dotfiles setups) rather than replacing the link.

async function withTempHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "action-hub-harness-atomic-"));
  const prevHome = process.env["HOME"];
  process.env["HOME"] = home;
  const origLog = console.log;
  const origError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await fn(home);
  } finally {
    console.log = origLog;
    console.error = origError;
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    await rm(home, { recursive: true, force: true });
  }
}

test("JSON install replaces the config by rename, keeping its mode and leaving no temp file", async () => {
  await withTempHome(async (home) => {
    const cfg = join(home, ".cursor", "mcp.json");
    await mkdir(join(home, ".cursor"), { recursive: true });
    await writeFile(cfg, JSON.stringify({ mcpServers: { other: { command: "keep" } } }));
    await chmod(cfg, 0o600);
    const before = await stat(cfg);

    assert.equal(await harnessCommand("cursor", { mode: "install", write: true }), 0);

    const after = await stat(cfg);
    // A truncate-and-write keeps the inode; an atomic replace is a new file.
    assert.notEqual(after.ino, before.ino, "config was replaced via rename, not rewritten in place");
    assert.equal(after.mode & 0o777, 0o600, "existing mode is preserved across the replace");
    const doc = JSON.parse(await readFile(cfg, "utf8")) as { mcpServers: Record<string, unknown> };
    assert.ok(doc.mcpServers["action-hub"], "entry written");
    assert.deepEqual(doc.mcpServers["other"], { command: "keep" }, "other entries preserved");
    const leftovers = (await readdir(join(home, ".cursor"))).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "no temp file left behind");
  });
});

test("install writes through a symlinked config instead of replacing the link", async () => {
  await withTempHome(async (home) => {
    const real = join(home, "dotfiles", "cursor-mcp.json");
    await mkdir(join(home, "dotfiles"), { recursive: true });
    await mkdir(join(home, ".cursor"), { recursive: true });
    await writeFile(real, JSON.stringify({ mcpServers: { other: { command: "keep" } } }));
    const link = join(home, ".cursor", "mcp.json");
    await symlink(real, link);

    assert.equal(await harnessCommand("cursor", { mode: "install", write: true }), 0);

    assert.ok((await lstat(link)).isSymbolicLink(), "the symlink is still a symlink");
    const doc = JSON.parse(await readFile(real, "utf8")) as { mcpServers: Record<string, unknown> };
    assert.ok(doc.mcpServers["action-hub"], "the link target received the entry");
    assert.deepEqual(doc.mcpServers["other"], { command: "keep" });
  });
});

test("TOML install is atomic too and still produces a parseable document", async () => {
  await withTempHome(async (home) => {
    const cfg = join(home, ".codex", "config.toml");
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(cfg, 'model = "gpt"\n\n[mcp_servers.other]\ncommand = "keep"\n');
    const before = await stat(cfg);

    assert.equal(await harnessCommand("codex", { mode: "install", write: true }), 0);

    assert.notEqual((await stat(cfg)).ino, before.ino, "replaced via rename");
    const doc = tomlParse(await readFile(cfg, "utf8")) as { model?: string; mcp_servers?: Record<string, { command: string }> };
    assert.equal(doc.model, "gpt", "unrelated top-level key preserved");
    assert.equal(doc.mcp_servers?.["other"]?.command, "keep");
    assert.ok(doc.mcp_servers?.["action-hub"], "entry written");
    const leftovers = (await readdir(join(home, ".codex"))).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "no temp file left behind");
  });
});
