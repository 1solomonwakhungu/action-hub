import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  discoverMcpServers,
  defaultDiscoveryLocations,
  parseTomlMcpServers,
} from "../dist/discovery/auto-discovery.js";

test("discovers MCP servers from Codex config.toml", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ah-codex-"));
  try {
    const codexPath = join(dir, ".codex", "config.toml");
    await mkdir(join(dir, ".codex"), { recursive: true });
    await writeFile(
      codexPath,
      `model = "gpt-5"

[mcp_servers.docs]
command = "npx"
args = ["-y", "mcp-server-docs"]
env = { DOCS_KEY = "abc" }

[mcp_servers.web]
url = "https://example.com/mcp"
`,
      "utf8",
    );

    const discovered = await discoverMcpServers({
      customPaths: [{ path: codexPath, client: "codex" }],
      skipDefaults: true,
    });

    assert.equal(discovered.length, 2);
    const docs = discovered.find((s) => s.id === "docs");
    assert.ok(docs);
    assert.equal(docs.sourceClient, "codex");
    assert.equal(docs.transport.type, "stdio");
    if (docs.transport.type === "stdio") {
      assert.equal(docs.transport.command, "npx");
      assert.deepEqual(docs.transport.args, ["-y", "mcp-server-docs"]);
      assert.deepEqual(docs.transport.env, { DOCS_KEY: "abc" });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parses Codex TOML nested tables, inline comments, and multiline arrays", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ah-codex-nested-"));
  try {
    const codexPath = join(dir, "config.toml");
    await writeFile(
      codexPath,
      `[mcp_servers.docs] # inline comment on section
command = "npx" # inline comment on value
args = [
  "-y", # comment inside array
  "mcp-server-docs",
]

[mcp_servers.docs.env]
DOCS_KEY = "abc" # secret key

[mcp_servers.docs.http_headers]
Authorization = "Bearer tok" # auth header

[mcp_servers.docs.headers]
X-Custom = "yes"

[other_section]
command = "ignored"
`,
      "utf8",
    );

    const discovered = await discoverMcpServers({
      customPaths: [{ path: codexPath, client: "codex" }],
      skipDefaults: true,
    });

    assert.equal(discovered.length, 1);
    const docs = discovered.find((s) => s.id === "docs");
    assert.ok(docs);
    assert.equal(docs.transport.type, "stdio");
    if (docs.transport.type === "stdio") {
      assert.equal(docs.transport.command, "npx");
      assert.deepEqual(docs.transport.args, ["-y", "mcp-server-docs"]);
      assert.deepEqual(docs.transport.env, { DOCS_KEY: "abc" });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseTomlMcpServers merges env, http_headers and headers subtables", () => {
  const parsed = parseTomlMcpServers(
    `[mcp_servers.docs]
command = "npx" # runner

[mcp_servers.docs.env]
KEY = "v" # value

[mcp_servers.docs.http_headers]
Authorization = "Bearer tok"

[mcp_servers.docs.headers]
X-Custom = "yes"
`,
  );
  const servers = parsed["mcpServers"] as Record<string, Record<string, unknown>>;
  const docs = servers["docs"];
  assert.equal(docs?.command, "npx");
  assert.deepEqual(docs?.env, { KEY: "v" });
  assert.deepEqual(docs?.headers, { Authorization: "Bearer tok", "X-Custom": "yes" });
});

test("preserves commas inside quoted array elements", () => {
  const parsed = parseTomlMcpServers(
    `[mcp_servers.search]
command = "grep"
args = ["--filter", "foo,bar", "--query", "a,b"]
`,
  );
  const servers = parsed["mcpServers"] as Record<string, Record<string, unknown>>;
  assert.deepEqual(servers["search"]?.args, ["--filter", "foo,bar", "--query", "a,b"]);
});

test("tags Windsurf config with windsurf harness", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ah-windsurf-"));
  try {
    const wsPath = join(dir, ".codeium", "windsurf", "mcp_config.json");
    await mkdir(join(dir, ".codeium", "windsurf"), { recursive: true });
    await writeFile(
      wsPath,
      JSON.stringify({
        mcpServers: {
          search: { command: "uvx", args: ["mcp-search"] },
        },
      }),
      "utf8",
    );

    const discovered = await discoverMcpServers({
      customPaths: [{ path: wsPath, client: "windsurf" }],
      skipDefaults: true,
    });

    assert.equal(discovered.length, 1);
    assert.equal(discovered[0]?.sourceClient, "windsurf");
    assert.equal(discovered[0]?.id, "search");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discovers Cline and Roo Code global storage configs with harness tags", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ah-cline-"));
  try {
    const gs = join(dir, "gs");
    const clinePath = join(
      gs,
      "saoudrizwan.claude-dev",
      "settings",
      "cline_mcp_settings.json",
    );
    await mkdir(join(gs, "saoudrizwan.claude-dev", "settings"), { recursive: true });
    await writeFile(
      clinePath,
      JSON.stringify({
        mcpServers: { fetch: { command: "uvx", args: ["mcp-fetch"] } },
      }),
      "utf8",
    );

    const rooPath = join(gs, "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json");
    await mkdir(join(gs, "rooveterinaryinc.roo-cline", "settings"), { recursive: true });
    await writeFile(
      rooPath,
      JSON.stringify({
        mcpServers: { db: { command: "npx", args: ["mcp-db"] } },
      }),
      "utf8",
    );

    const discovered = await discoverMcpServers({
      customPaths: [
        { path: clinePath, client: "cline" },
        { path: rooPath, client: "roo-code" },
      ],
      skipDefaults: true,
    });

    assert.equal(discovered.length, 2);
    assert.ok(discovered.find((s) => s.id === "fetch" && s.sourceClient === "cline"));
    assert.ok(discovered.find((s) => s.id === "db" && s.sourceClient === "roo-code"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("default locations include Codex, Windsurf, Cline and Roo paths for the platform", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ah-defaults-"));
  try {
    const locations = defaultDiscoveryLocations({ home: dir, cwd: dir, skipDefaults: false });
    const paths = locations.map((l) => l.path);

    assert.ok(paths.some((p) => p.includes(".codex") && p.endsWith("config.toml")));
    assert.ok(paths.some((p) => p.includes(".codeium") && p.endsWith("mcp_config.json")));
    assert.ok(paths.some((p) => p.includes("cline_mcp_settings.json")));
    assert.ok(paths.some((p) => p.includes("roo-cline") || p.includes(".roo")));

    const codex = locations.find((l) => l.path.endsWith("config.toml"));
    assert.ok(codex);
    assert.equal(codex.client, "codex");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
