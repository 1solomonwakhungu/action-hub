import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverMcpServers } from "../dist/discovery/auto-discovery.js";

test("discovers MCP servers from Claude Desktop dictionary format", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ah-discovery-"));
  try {
    const claudeConfigPath = join(dir, "claude_desktop_config.json");
    await writeFile(
      claudeConfigPath,
      JSON.stringify({
        mcpServers: {
          linear: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-linear"],
            env: { LINEAR_API_KEY: "secret_123" },
          },
          weather: {
            url: "https://api.weather.com/mcp",
          },
        },
      }),
      "utf8",
    );

    const discovered = await discoverMcpServers({
      customPaths: [claudeConfigPath],
    });

    assert.equal(discovered.length, 2);
    const linear = discovered.find((s) => s.id === "linear");
    assert.ok(linear);
    assert.equal(linear.transport.type, "stdio");
    if (linear.transport.type === "stdio") {
      assert.equal(linear.transport.command, "npx");
      assert.deepEqual(linear.transport.args, ["-y", "@modelcontextprotocol/server-linear"]);
      assert.deepEqual(linear.transport.env, { LINEAR_API_KEY: "secret_123" });
    }

    const weather = discovered.find((s) => s.id === "weather");
    assert.ok(weather);
    assert.equal(weather.transport.type, "http");
    if (weather.transport.type === "http") {
      assert.equal(weather.transport.url, "https://api.weather.com/mcp");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discovers MCP servers from Cursor/Copilot array format", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ah-discovery-"));
  try {
    const mcpPath = join(dir, "mcp.json");
    await writeFile(
      mcpPath,
      JSON.stringify({
        servers: [
          {
            id: "github",
            command: "gh",
            args: ["mcp-server"],
          },
        ],
      }),
      "utf8",
    );

    const discovered = await discoverMcpServers({
      customPaths: [mcpPath],
    });

    assert.equal(discovered.length, 1);
    assert.equal(discovered[0]?.id, "github");
    assert.equal(discovered[0]?.transport.type, "stdio");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
