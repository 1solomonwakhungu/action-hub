import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionHub } from "../dist/action-hub.js";
import { BundleRegistry } from "../dist/bundles/bundles.js";
import { Catalog } from "../dist/catalog/catalog.js";
import type { Bundle, ServerConfig } from "../dist/types.js";
import { FakeClient, makeFactory } from "./fakes.ts";

const sampleBundles: Bundle[] = [
  {
    id: "github:review-pr",
    displayName: "PR Review Workflow",
    description: "Tools for reviewing GitHub pull requests",
    serverIds: ["github"],
    tags: ["review", "code", "github"],
  },
  {
    id: "ops:notify",
    displayName: "Incident Notification",
    description: "Post notifications to Slack and create GitHub issues",
    actionIds: ["github:create_issue", "slack:post_message"],
    tags: ["slack", "alerts", "ops"],
  },
];

const servers: ServerConfig[] = [
  { id: "github", transport: { type: "stdio", command: "gh-mcp" }, trust: "trusted" },
  { id: "slack", transport: { type: "stdio", command: "slack-mcp" }, trust: "untrusted" },
];

function buildClients() {
  return {
    github: new FakeClient([
      {
        name: "create_pull_request",
        description: "Open a new pull request",
        inputSchema: { type: "object", properties: { title: { type: "string" } } },
      },
      {
        name: "create_issue",
        description: "Create an issue",
        inputSchema: { type: "object", properties: { title: { type: "string" } } },
      },
    ]),
    slack: new FakeClient([
      {
        name: "post_message",
        description: "Post a Slack message",
        inputSchema: { type: "object", properties: { channel: { type: "string" } } },
      },
    ]),
  };
}

test("BundleRegistry stores, lists, and searches bundles", () => {
  const registry = new BundleRegistry(sampleBundles);
  assert.equal(registry.list().length, 2);
  assert.equal(registry.get("github:review-pr")?.displayName, "PR Review Workflow");

  const hits = registry.search("slack");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.id, "ops:notify");
});

test("BundleRegistry resolves actions across serverIds and actionIds", () => {
  const registry = new BundleRegistry(sampleBundles);
  const catalog = new Catalog();
  catalog.add({
    id: "github:create_pull_request",
    kind: "tool",
    serverId: "github",
    name: "create_pull_request",
    summary: "PR",
    trust: "trusted",
  });
  catalog.add({
    id: "github:create_issue",
    kind: "tool",
    serverId: "github",
    name: "create_issue",
    summary: "Issue",
    trust: "trusted",
  });
  catalog.add({
    id: "slack:post_message",
    kind: "tool",
    serverId: "slack",
    name: "post_message",
    summary: "Slack",
    trust: "untrusted",
  });

  const reviewActions = registry.resolveActions("github:review-pr", catalog);
  assert.equal(reviewActions.length, 2);

  const notifyActions = registry.resolveActions("ops:notify", catalog);
  assert.equal(notifyActions.length, 2);
  assert.ok(notifyActions.some((a) => a.id === "github:create_issue"));
  assert.ok(notifyActions.some((a) => a.id === "slack:post_message"));
});

test("ActionHub loads bundle and calculates token savings", async () => {
  const clients = buildClients();
  const { factory } = makeFactory(clients);
  const hub = new ActionHub({
    servers,
    bundles: sampleBundles,
    clientFactory: factory,
  });

  await hub.indexAll();

  const loaded = hub.loadBundle("ops:notify");
  assert.equal(loaded.id, "ops:notify");
  assert.equal(loaded.actions.length, 2);
  assert.ok(loaded.totalEagerTokens > 0);
  assert.ok(loaded.tokensSaved >= 0);

  const searchResults = hub.searchBundles("review");
  assert.equal(searchResults.length, 1);
  assert.equal(searchResults[0]?.id, "github:review-pr");
});
