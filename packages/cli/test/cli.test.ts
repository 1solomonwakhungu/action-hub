import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadCliConfig } from "../dist/config-loader.js";
import { importCommand } from "../dist/commands/import.js";
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
