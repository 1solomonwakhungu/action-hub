import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve, join } from "node:path";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadCliConfig } from "../dist/config-loader.js";
import { importCommand } from "../dist/commands/import.js";
import { migrateCommand } from "../dist/commands/migrate.js";
import { bundlesCommand } from "../dist/commands/bundles.js";
import { listCommand } from "../dist/commands/list.js";
import { testSearchCommand } from "../dist/commands/test-search.js";

test("CLI config loader handles empty and populated configs", async () => {
  const tempDir = resolve(tmpdir(), `action-hub-cli-test-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });
  const cfgPath = resolve(tempDir, "servers.json");

  try {
    // Missing config
    const emptyCfg = await loadCliConfig(cfgPath);
    assert.equal(emptyCfg.exists, false);

    // Written config
    const testConfig = {
      servers: [
        { id: "test-srv", transport: { type: "stdio", command: "test" }, trust: "trusted" },
      ],
      bundles: [
        { id: "b1", displayName: "Bundle 1", description: "Test Bundle", actionIds: ["test-srv:tool1"] },
      ],
      autoApproveAtOrAbove: "untrusted",
      autoDiscover: false,
    };
    await writeFile(cfgPath, JSON.stringify(testConfig), "utf8");

    const loaded = await loadCliConfig(cfgPath);
    assert.equal(loaded.exists, true);
    assert.equal(loaded.servers.length, 1);
    assert.equal(loaded.servers[0]?.id, "test-srv");
    assert.equal(loaded.bundles.length, 1);
    assert.equal(loaded.autoApproveAtOrAbove, "untrusted");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("import command executes without errors", async () => {
  const code = await importCommand({ write: false });
  assert.equal(code, 0);
});

test("migrate command plans and executes capability migration", async () => {
  const tempDir = resolve(tmpdir(), `action-hub-cli-migrate-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });
  const cfgPath = resolve(tempDir, "servers.json");

  // Seed an existing config with custom fields and unexpanded secrets
  await writeFile(
    cfgPath,
    JSON.stringify({
      approvalTtlSeconds: 900,
      autoDiscover: false,
      servers: [
        {
          id: "existing-secret-server",
          transport: {
            type: "stdio",
            command: "node",
            args: ["srv.js"],
            env: { API_KEY: "${SECRET_KEY}" }
          }
        }
      ]
    }),
    "utf8"
  );

  // Create an external skill to discover
  const skillsDir = join(tempDir, "skills", "triage");
  await mkdir(skillsDir, { recursive: true });
  await writeFile(
    join(skillsDir, "SKILL.md"),
    `---\nname: issue-triage\ndescription: Triage incoming issues\n---\n# Triage\nTriage issues prompt`,
    "utf8",
  );

  try {
    // 1. Dry run
    const dryRunCode = await migrateCommand({
      configPath: cfgPath,
      customPaths: [join(tempDir, "skills")],
      skipDefaults: true,
      write: false,
      type: "skills",
    });
    assert.equal(dryRunCode, 0);

    // 2. Write migration
    const writeCode = await migrateCommand({
      configPath: cfgPath,
      customPaths: [join(tempDir, "skills")],
      skipDefaults: true,
      write: true,
      type: "skills",
    });
    assert.equal(writeCode, 0);

    const savedRaw = JSON.parse(await readFile(cfgPath, "utf8"));
    assert.ok(Array.isArray(savedRaw.skills));
    assert.equal(savedRaw.skills.length, 1);
    assert.equal(savedRaw.skills[0].name, "issue-triage");
    // Verify top-level fields and unexpanded secrets are preserved
    assert.equal(savedRaw.approvalTtlSeconds, 900);
    assert.equal(savedRaw.autoDiscover, false);
    assert.equal(savedRaw.servers[0].transport.env.API_KEY, "${SECRET_KEY}");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("bundles command lists and formats bundles", async () => {
  const tempDir = resolve(tmpdir(), `action-hub-cli-bundles-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });
  const cfgPath = resolve(tempDir, "servers.json");

  try {
    const testConfig = {
      servers: [],
      bundles: [
        { id: "test-bundle", displayName: "Test Bundle", description: "A test bundle", actionIds: ["srv:action1"] },
      ],
      autoDiscover: false,
    };
    await writeFile(cfgPath, JSON.stringify(testConfig), "utf8");

    const listCode = await bundlesCommand({ configPath: cfgPath });
    assert.equal(listCode, 0);

    const loadCode = await bundlesCommand({ configPath: cfgPath, load: "test-bundle" });
    assert.equal(loadCode, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("list and test-search commands execute with empty servers", async () => {
  const tempDir = resolve(tmpdir(), `action-hub-cli-list-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });
  const cfgPath = resolve(tempDir, "servers.json");

  try {
    const testConfig = {
      servers: [],
      bundles: [],
      autoDiscover: false,
    };
    await writeFile(cfgPath, JSON.stringify(testConfig), "utf8");

    const listCode = await listCommand({ configPath: cfgPath });
    assert.equal(listCode, 0);

    const searchCode = await testSearchCommand("pull request", { configPath: cfgPath });
    assert.equal(searchCode, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
