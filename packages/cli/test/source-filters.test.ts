import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IMPORT_SOURCE_FILTERS } from "../dist/commands/import.js";
import { MIGRATE_SOURCE_FILTERS } from "../dist/commands/migrate.js";

const CLI = join(import.meta.dirname ?? ".", "..", "dist", "index.js");

/** Spawns the built CLI with an isolated temp HOME; never touches the real HOME. */
function runCli(args: string[], tempHome: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: tempHome,
    env: { ...process.env, HOME: tempHome },
    encoding: "utf8",
  });
}

test("source filter unions include the multi-harness sources", () => {
  for (const source of ["codex", "windsurf", "cline", "roo-code"] as const) {
    assert.ok(IMPORT_SOURCE_FILTERS.includes(source));
    assert.ok(MIGRATE_SOURCE_FILTERS.includes(source));
  }
});

test("import and migrate reject unknown --source before running (exit 1, config untouched)", async () => {
  const home = await mkdtemp(join(tmpdir(), "ah-source-bad-"));
  const configFile = join(home, ".config", "action-hub", "servers.json");
  try {
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(
      join(home, ".codex", "config.toml"),
      `[mcp_servers.docs]\ncommand = "npx"\nargs = ["-y", "mcp-server-docs"]\n`,
      "utf8",
    );

    const badImport = runCli(["import", "--source", "bogus"], home);
    assert.equal(badImport.status, 1);
    assert.match(badImport.stderr, /Unknown --source value "bogus"/);
    assert.ok(!existsSync(configFile), "import must not run for unknown source");

    const badMigrate = runCli(["migrate", "--source", "bogus", "--write", "--json"], home);
    assert.equal(badMigrate.status, 1);
    assert.match(badMigrate.stderr, /Unknown --source value "bogus"/);
    assert.ok(!existsSync(configFile), "migrate must not write config for unknown source");

    // --source present but without a value: must not run unfiltered either.
    const missingImport = runCli(["import", "--source"], home);
    assert.equal(missingImport.status, 1);
    assert.match(missingImport.stderr, /Missing value for --source/);
    assert.ok(!existsSync(configFile), "import must not run for missing --source value");

    const missingMigrate = runCli(["migrate", "--source", "--write", "--json"], home);
    assert.equal(missingMigrate.status, 1);
    assert.match(missingMigrate.stderr, /Missing value for --source/);
    assert.ok(!existsSync(configFile), "migrate must not write config for missing --source value");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("import and migrate accept --source all (exit 0)", async () => {
  const home = await mkdtemp(join(tmpdir(), "ah-source-all-"));
  try {
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(
      join(home, ".codex", "config.toml"),
      `[mcp_servers.docs]\ncommand = "npx"\nargs = ["-y", "mcp-server-docs"]\n`,
      "utf8",
    );

    const importAll = runCli(["import", "--source", "all"], home);
    assert.equal(importAll.status, 0);
    assert.match(importAll.stdout, /\[docs\]/);
    assert.match(importAll.stdout, /Source: codex/);

    const migrateAll = runCli(["migrate", "--source", "all", "--json"], home);
    assert.equal(migrateAll.status, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
