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
import { authCommand } from "../dist/commands/auth.js";

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

test("import command executes without errors", async (t) => {
  // Isolated empty HOME: the discovery path must never read real owner configs.
  const tempHome = resolve(tmpdir(), `action-hub-cli-import-${Date.now()}`);
  await mkdir(tempHome, { recursive: true });
  const originalHome = process.env["HOME"];
  process.env["HOME"] = tempHome;
  try {
    const code = await importCommand({ write: false });
    assert.equal(code, 0);
  } finally {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("import and migrate redact every secret sentinel from discovery output", async (t) => {
  const sentinels = {
    BASIC: "SENTINEL_BASIC_35",
    ENV: "SENTINEL_ENV_35",
    FLAG: "SENTINEL_FLAG_35",
    HEADER: "SENTINEL_HEADER_35",
    USERINFO: "SENTINEL_USERINFO_35",
    INVALID_URL: "SENTINEL_INVALID_URL_35",
    PWD: "SENTINEL_PWD_35",
    ATTACHED_HEADER: "SENTINEL_SHORT_HEADER_35",
    RAW_SECRET: "rawsecret12345678901234567890abcd",
  };
  const tempHome = resolve(tmpdir(), `action-hub-import-redact-${Date.now()}`);
  const cursorDir = join(tempHome, ".cursor");
  await mkdir(cursorDir, { recursive: true });
  await writeFile(
    join(cursorDir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        basic: {
          command: "node",
          args: ["server.js", "--token", sentinels.BASIC],
          env: { API_TOKEN: sentinels.ENV },
        },
        "custom-token-flag": {
          command: "node",
          args: ["server.js", "--github-token", sentinels.FLAG],
        },
        "inline-header": {
          command: "node",
          args: ["server.js", `--header=X-API-Key: ${sentinels.HEADER}`],
        },
        "url-userinfo": {
          url: `https://user:${sentinels.USERINFO}@example.com/mcp`,
        },
        "invalid-url": {
          url: `not-a-valid-url?token=${sentinels.INVALID_URL}`,
        },
        "pwd-flag": {
          command: "node",
          args: ["server.js", "--pwd", sentinels.PWD],
        },
        "attached-header": {
          command: "node",
          args: ["server.js", `-HX-API-Key:${sentinels.ATTACHED_HEADER}`],
        },
        "raw-secret": {
          command: "node",
          args: ["server.js", "--serve-data", sentinels.RAW_SECRET],
        },
      },
    }),
    "utf8",
  );

  const originalHome = process.env["HOME"];
  process.env["HOME"] = tempHome;
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };

  try {
    const importCode = await importCommand({ write: false });
    assert.equal(importCode, 0);
    const importOutput = logs.join("\n");
    assert.match(importOutput, /basic/);

    const migrateCode = await migrateCommand({ write: false, type: "mcps" });
    assert.equal(migrateCode, 0);
    const output = logs.join("\n");

    for (const [name, sentinel] of Object.entries(sentinels)) {
      assert.ok(
        !output.includes(sentinel),
        `${name} sentinel must never appear in import/migrate output`,
      );
    }
  } finally {
    console.log = originalLog;
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  }
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

    // Hermetic: listCommand probes ACTION_HUB_SKILLS_DIR (default
    // ~/.action-hub/skills); point HOME at the temp dir.
    const savedHome = process.env["HOME"];
    const savedSkillsDir = process.env["ACTION_HUB_SKILLS_DIR"];
    process.env["HOME"] = tempDir;
    delete process.env["ACTION_HUB_SKILLS_DIR"];
    try {
      const listCode = await listCommand({ configPath: cfgPath });
      assert.equal(listCode, 0);

      const searchCode = await testSearchCommand("pull request", { configPath: cfgPath });
      assert.equal(searchCode, 0);
    } finally {
      if (savedHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = savedHome;
      if (savedSkillsDir === undefined) delete process.env["ACTION_HUB_SKILLS_DIR"];
      else process.env["ACTION_HUB_SKILLS_DIR"] = savedSkillsDir;
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("auth command reports status, refuses unknown servers, and clears credentials", async () => {
  const tempDir = resolve(tmpdir(), `action-hub-cli-auth-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });
  const cfgPath = resolve(tempDir, "servers.json");
  const credentialsPath = resolve(tempDir, "credentials.json");
  const previousCredentials = process.env["ACTION_HUB_CREDENTIALS"];
  process.env["ACTION_HUB_CREDENTIALS"] = credentialsPath;

  const logged: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => void logged.push(args.join(" "));
  console.error = (...args: unknown[]) => void logged.push(args.join(" "));

  try {
    const testConfig = {
      servers: [
        { id: "plain-http", transport: { type: "http", url: "https://example.test/mcp" } },
        {
          id: "oauth-srv",
          transport: {
            type: "http",
            url: "https://example.test/mcp",
            auth: {
              type: "oauth2",
              authorizationUrl: "https://example.test/authorize",
              tokenUrl: "https://example.test/token",
              clientId: "client-abc",
              scopes: ["read"],
            },
          },
        },
      ],
      bundles: [],
      autoDiscover: false,
    };
    await writeFile(cfgPath, JSON.stringify(testConfig), "utf8");

    assert.equal(await authCommand("status", undefined, { configPath: cfgPath }), 0);
    const status = logged.join("\n");
    assert.ok(status.includes("oauth-srv"), "an OAuth server is listed");
    assert.ok(status.includes("unauthenticated"), "with no credential it is unauthenticated");
    assert.ok(!status.includes("plain-http"), "a transport with no auth block is not listed");

    // Logging in requires a server; an unknown or non-OAuth one must fail loudly.
    assert.equal(await authCommand("login", undefined, { configPath: cfgPath }), 1);
    assert.equal(await authCommand("login", "nope", { configPath: cfgPath }), 1);
    assert.equal(await authCommand("login", "plain-http", { configPath: cfgPath }), 1);

    // Logout is idempotent: clearing an absent credential is not an error.
    assert.equal(await authCommand("logout", "oauth-srv", { configPath: cfgPath }), 0);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    if (previousCredentials === undefined) delete process.env["ACTION_HUB_CREDENTIALS"];
    else process.env["ACTION_HUB_CREDENTIALS"] = previousCredentials;
    await rm(tempDir, { recursive: true, force: true });
  }
});
