import assert from "node:assert/strict";
import { test } from "node:test";
import { executeMigration, planMigration } from "../dist/migration/index.js";
import type { DiscoveredPlugin, DiscoveredServer, DiscoveredSkill, ServerConfig } from "../dist/types.js";

test("planMigration plans addition of new MCP servers, skills, and plugins without conflicts", () => {
  const existingServers: ServerConfig[] = [
    {
      id: "linear",
      transport: { type: "stdio", command: "linear-mcp" },
      trust: "trusted",
    },
  ];

  const discoveredServers: DiscoveredServer[] = [
    {
      id: "slack",
      transport: { type: "stdio", command: "slack-mcp" },
      trust: "untrusted",
      sourcePath: "/path/to/slack",
      sourceClient: "cursor",
    },
  ];

  const discoveredSkills: DiscoveredSkill[] = [
    {
      id: "skill:code-review",
      name: "code-review",
      summary: "Performs deep code reviews",
      description: "Review prompt...",
      tags: ["review"],
      trust: "trusted",
      sourcePath: "/path/to/skill",
      sourceClient: "copilot",
    },
  ];

  const discoveredPlugins: DiscoveredPlugin[] = [
    {
      id: "github-toolkit",
      name: "GitHub Toolkit",
      description: "Tools for GitHub automation",
      manifestPath: "/path/to/plugin.json",
      servers: [
        {
          id: "github",
          transport: { type: "stdio", command: "gh", args: ["mcp"] },
        },
      ],
      skills: [
        {
          id: "skill:gh-pr",
          name: "gh-pr",
          summary: "GitHub PR helper",
          description: "PR helper prompt...",
          trust: "trusted",
        },
      ],
    },
  ];

  const plan = planMigration({
    existingServers,
    discovered: {
      servers: discoveredServers,
      skills: discoveredSkills,
      plugins: discoveredPlugins,
    },
  });

  assert.equal(plan.serversToAdd.length, 2); // slack + github from plugin
  assert.ok(plan.serversToAdd.some((s) => s.id === "slack"));
  assert.ok(plan.serversToAdd.some((s) => s.id === "github"));

  assert.equal(plan.skillsToAdd.length, 2); // code-review + gh-pr from plugin
  assert.ok(plan.skillsToAdd.some((s) => s.id === "skill:code-review"));
  assert.ok(plan.skillsToAdd.some((s) => s.id === "skill:gh-pr"));

  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.summary.mcpsDiscovered, 1);
  assert.equal(plan.summary.skillsDiscovered, 1);
  assert.equal(plan.summary.pluginsDiscovered, 1);
});

test("planMigration flags conflicts when server already exists unless overwrite is true", () => {
  const existingServers: ServerConfig[] = [
    {
      id: "slack",
      displayName: "Existing Slack",
      transport: { type: "stdio", command: "old-slack-mcp" },
      trust: "trusted",
    },
  ];

  const discoveredServers: DiscoveredServer[] = [
    {
      id: "slack",
      displayName: "New Slack",
      transport: { type: "stdio", command: "new-slack-mcp" },
      sourcePath: "/path",
      sourceClient: "claude-desktop",
    },
  ];

  // Without overwrite: records conflict
  const planNoOverwrite = planMigration({
    existingServers,
    discovered: {
      servers: discoveredServers,
      skills: [],
      plugins: [],
    },
    options: { overwrite: false },
  });

  assert.equal(planNoOverwrite.serversToAdd.length, 0);
  assert.equal(planNoOverwrite.serversToUpdate.length, 0);
  assert.equal(planNoOverwrite.conflicts.length, 1);
  assert.equal(planNoOverwrite.conflicts[0]?.id, "slack");

  // With overwrite: records update
  const planWithOverwrite = planMigration({
    existingServers,
    discovered: {
      servers: discoveredServers,
      skills: [],
      plugins: [],
    },
    options: { overwrite: true },
  });

  assert.equal(planWithOverwrite.serversToAdd.length, 0);
  assert.equal(planWithOverwrite.serversToUpdate.length, 1);
  assert.equal(planWithOverwrite.conflicts.length, 0);
  assert.equal(planWithOverwrite.serversToUpdate[0]?.displayName, "New Slack");
});

test("executeMigration merges discovered capabilities cleanly", () => {
  const existingServers: ServerConfig[] = [
    {
      id: "linear",
      transport: { type: "stdio", command: "linear-mcp" },
      trust: "trusted",
    },
  ];

  const result = executeMigration({
    existingServers,
    discovered: {
      servers: [
        {
          id: "slack",
          transport: { type: "stdio", command: "slack-mcp" },
          sourcePath: "/path",
          sourceClient: "cursor",
        },
      ],
      skills: [
        {
          id: "skill:deploy",
          name: "Deploy",
          summary: "Deploy application",
          description: "Deploy instructions",
          sourcePath: "/path/skill",
          sourceClient: "copilot",
        },
      ],
      plugins: [],
    },
  });

  assert.equal(result.mergedServers.length, 2);
  assert.equal(result.mergedSkills.length, 1);
  assert.equal(result.mergedSkills[0]?.id, "skill:deploy");
});
