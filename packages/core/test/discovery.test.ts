import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  discoverAll,
  discoverMcpServers,
  discoverPlugins,
  discoverSkills,
} from "../dist/discovery/auto-discovery.js";

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
      skipDefaults: true,
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
      skipDefaults: true,
    });

    assert.equal(discovered.length, 1);
    assert.equal(discovered[0]?.id, "github");
    assert.equal(discovered[0]?.transport.type, "stdio");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discovers skills from SKILL.md files and cursor rules", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ah-skill-discovery-"));
  try {
    const skillDir = join(dir, "skills", "pr-reviewer");
    await mkdir(skillDir, { recursive: true });

    const skillContent = `---
name: pr-reviewer
description: Automated review of GitHub pull requests for security and quality
tags:
  - git
  - review
---

# PR Reviewer
You are a senior code reviewer. Check diffs for correctness and security vulnerabilities.`;

    await writeFile(join(skillDir, "SKILL.md"), skillContent, "utf8");

    const cursorRuleDir = join(dir, ".cursor", "rules");
    await mkdir(cursorRuleDir, { recursive: true });
    await writeFile(
      join(cursorRuleDir, "typescript.mdc"),
      `# TypeScript Standards\nAlways use strict types and prefer interfaces.`,
      "utf8",
    );

    const discovered = await discoverSkills({
      cwd: dir,
      home: dir,
      customPaths: [join(dir, "skills"), cursorRuleDir],
      skipDefaults: true,
    });

    assert.equal(discovered.length, 2);
    const prReviewer = discovered.find((s) => s.name === "pr-reviewer");
    assert.ok(prReviewer);
    assert.equal(prReviewer.id, "skill:pr-reviewer");
    assert.equal(
      prReviewer.summary,
      "Automated review of GitHub pull requests for security and quality",
    );
    assert.deepEqual(prReviewer.tags, ["git", "review"]);
    assert.ok(prReviewer.description.includes("senior code reviewer"));

    const tsRule = discovered.find((s) => s.name === "TypeScript Standards");
    assert.ok(tsRule);
    assert.equal(tsRule.id, "skill:typescript-standards");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discovers plugins with MCP servers and skills", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ah-plugin-discovery-"));
  try {
    const pluginDir = join(dir, "my-plugin");
    const skillDir = join(pluginDir, "skills", "deploy");
    await mkdir(skillDir, { recursive: true });

    await writeFile(
      join(skillDir, "SKILL.md"),
      `---\nname: deploy-helper\ndescription: Deployment orchestration\n---\n# Deploy\nDeploy safely.`,
      "utf8",
    );

    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: "deploy-toolkit",
        name: "Deployment Toolkit",
        description: "Everything needed for cloud deployment",
        version: "1.2.0",
        mcpServers: {
          aws: {
            command: "aws-mcp",
            args: ["--region", "us-east-1"],
          },
        },
        skills: ["./skills/deploy"],
      }),
      "utf8",
    );

    const plugins = await discoverPlugins({
      customPaths: [manifestPath],
      skipDefaults: true,
    });

    assert.equal(plugins.length, 1);
    const plugin = plugins[0]!;
    assert.equal(plugin.id, "deploy-toolkit");
    assert.equal(plugin.name, "Deployment Toolkit");
    assert.equal(plugin.servers.length, 1);
    assert.equal(plugin.servers[0]?.id, "aws");
    assert.equal(plugin.skills.length, 1);
    assert.equal(plugin.skills[0]?.name, "deploy-helper");

    const all = await discoverAll({
      customPaths: [manifestPath],
      skipDefaults: true,
    });
    assert.equal(all.plugins.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discovers plugins with directory-string skills and file-referenced mcpServers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ah-plugin-str-"));
  try {
    const pluginDir = join(dir, "repo-plugin");
    const skillDir = join(pluginDir, "skills", "action-hub");
    await mkdir(skillDir, { recursive: true });

    await writeFile(
      join(skillDir, "SKILL.md"),
      `---
name: action-hub
description: Action Hub helper
---
# Action Hub
Use the tool.`,
      "utf8",
    );

    await writeFile(
      join(pluginDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          hub: {
            command: "node",
            args: ["index.js"],
          },
        },
      }),
      "utf8",
    );

    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        name: "action-hub",
        skills: "skills/",
        mcpServers: ".mcp.json",
      }),
      "utf8",
    );

    const plugins = await discoverPlugins({
      customPaths: [manifestPath],
      skipDefaults: true,
    });

    assert.equal(plugins.length, 1);
    const plugin = plugins[0]!;
    assert.equal(plugin.servers.length, 1);
    assert.equal(plugin.servers[0]?.id, "hub");
    assert.equal(plugin.skills.length, 1);
    assert.equal(plugin.skills[0]?.name, "action-hub");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
