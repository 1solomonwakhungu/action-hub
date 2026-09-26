import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { importCommand } from "../dist/commands/import.js";

// Regression for PR (P11): `import --write` must merge discovered servers
// into the RAW config document — skills and any custom top-level keys must
// survive — and the file must be written atomically with owner-only (0o600)
// permissions because configs can contain credentials.
test("import --write preserves skills and custom keys; writes with mode 600", async () => {
  const tempHome = await mkdtemp(resolve(tmpdir(), "action-hub-import-"));
  const originalHome = process.env["HOME"];
  process.env["HOME"] = tempHome;

  const configPath = join(tempHome, "config", "servers.json");
  const existingConfig = {
    servers: [
      {
        id: "existing-server",
        transport: { type: "stdio", command: "echo", args: ["keep-me"] },
        trust: "trusted",
        enabled: true,
      },
    ],
    skills: [{ id: "my-skill", name: "My Skill", instructions: "keep me" }],
    approvalTtlSeconds: 123,
    customTopLevel: { nested: "must survive" },
  };

  try {
    await mkdir(join(tempHome, "config"), { recursive: true });
    // Deliberately lax pre-existing permissions; the writer must tighten to 600.
    await writeFile(configPath, JSON.stringify(existingConfig, null, 2), { mode: 0o644 });

    // Discovery fixture: a claude-desktop config under the temp HOME so
    // discoverMcpServers() finds a server to merge in.
    const claudeDir = join(tempHome, "Library", "Application Support", "Claude");
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, "claude_desktop_config.json"),
      JSON.stringify({
        mcpServers: {
          "fixture-weather": {
            command: "npx",
            args: ["-y", "weather-mcp"],
            env: { API_KEY: "sk-fixture" },
          },
        },
      }),
    );

    const code = await importCommand({ configPath, write: true });
    assert.equal(code, 0);

    const written = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;

    // Existing config untouched beyond the servers merge.
    assert.deepEqual(written["skills"], existingConfig.skills);
    assert.deepEqual(written["approvalTtlSeconds"], 123);
    assert.deepEqual(written["customTopLevel"], { nested: "must survive" });

    // Existing server entry wins; discovered fixture added alongside it.
    const servers = written["servers"] as Record<string, unknown>[];
    const existingEntry = servers.find((s) => s["id"] === "existing-server");
    assert.deepEqual(existingEntry, existingConfig.servers[0]);
    assert.ok(servers.some((s) => s["id"] === "fixture-weather"));

    // Owner-only permissions on the written file.
    const mode = (await stat(configPath)).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0o600, got 0o${mode.toString(8)}`);
  } finally {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  }
});

/**
 * Regression for the reviewer-2 HIGH finding: a malformed config must fail
 * closed — exit code 1 (the command rejects) and byte-for-byte unchanged.
 * Covers the zero-discovery early-return path too: validation runs before it.
 */
for (const scenario of [
  {
    name: "import --write fails closed on invalid JSON",
    content: "{servers: [broken",
    withDiscoveryFixture: false,
  },
  {
    name: "import --write fails closed on malformed servers (zero discovery)",
    content: JSON.stringify({ servers: ["KEEP_SENTINEL"], skills: [], custom: "keep" }),
    withDiscoveryFixture: false,
  },
  {
    name: "import --write fails closed on duplicate server ids with a discovery fixture",
    content: JSON.stringify({
      servers: [{ id: "dup" }, { id: "dup" }],
      skills: [{ id: "my-skill" }],
      custom: "keep",
    }),
    withDiscoveryFixture: true,
  },
] as const) {
  test(scenario.name, async () => {
    const tempHome = await mkdtemp(resolve(tmpdir(), "action-hub-import-bad-"));
    const originalHome = process.env["HOME"];
    process.env["HOME"] = tempHome;
    const configPath = join(tempHome, "config", "servers.json");
    try {
      await mkdir(join(tempHome, "config"), { recursive: true });
      const originalBytes = scenario.content;
      await writeFile(configPath, originalBytes);

      if (scenario.withDiscoveryFixture) {
        const claudeDir = join(tempHome, "Library", "Application Support", "Claude");
        await mkdir(claudeDir, { recursive: true });
        await writeFile(
          join(claudeDir, "claude_desktop_config.json"),
          JSON.stringify({ mcpServers: { "fixture-weather": { command: "npx" } } }),
        );
      }

      await assert.rejects(
        () => importCommand({ configPath, write: true }),
        /Malformed config|Failed to parse config/,
      );
      assert.equal(await readFile(configPath, "utf8"), originalBytes, "config bytes changed");
    } finally {
      if (originalHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = originalHome;
      await rm(tempHome, { recursive: true, force: true });
    }
  });
}

// Regression for reviewer-2 HIGH: migrate --write must also fail closed on a
// malformed servers array. This is a real CLI spawn (node dist/index.js), not
// an in-process call, so the actual exit code is asserted.
test("migrate --write via CLI spawn fails closed on malformed servers", async () => {
  const tempHome = await mkdtemp(resolve(tmpdir(), "action-hub-migrate-bad-"));
  const originalHome = process.env["HOME"];
  process.env["HOME"] = tempHome;
  const configPath = join(tempHome, "config", "servers.json");
  try {
    await mkdir(join(tempHome, "config"), { recursive: true });
    const originalBytes = JSON.stringify({
      servers: ["KEEP_SENTINEL"],
      skills: [{ id: "keep-skill" }],
      custom: "keep",
    });
    await writeFile(configPath, originalBytes);

    const cliPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
    const child = spawn(process.execPath, [
      cliPath,
      "migrate",
      "--type",
      "mcps",
      "--write",
      "--json",
      "--config",
      configPath,
    ], { env: { ...process.env, HOME: tempHome }, cwd: tempHome });

    const code = await new Promise<number | null>((resolveExit, rejectSpawn) => {
      child.on("error", rejectSpawn);
      child.on("exit", (exitCode) => resolveExit(exitCode));
    });

    assert.equal(code, 1, `expected exit 1, got ${code}`);
    assert.equal(await readFile(configPath, "utf8"), originalBytes, "config bytes changed");
  } finally {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  }
});
