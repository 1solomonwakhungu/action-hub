import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionHub } from "../dist/action-hub.js";
import type { ServerConfig } from "../dist/types.js";
import { FakeClient, makeFactory } from "./fakes.ts";

const servers: ServerConfig[] = [
  { id: "github", transport: { type: "stdio", command: "gh-mcp" }, trust: "trusted" },
  { id: "slack", transport: { type: "stdio", command: "slack-mcp" }, trust: "untrusted" },
];

function buildClients() {
  return {
    github: new FakeClient([
      {
        name: "create_pull_request",
        description: "Open a new pull request.\nSupports draft mode.",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" }, draft: { type: "boolean" } },
          required: ["title"],
        },
      },
      { name: "list_issues", description: "List repository issues", inputSchema: { type: "object" } },
    ]),
    slack: new FakeClient([
      { name: "post_message", description: "Post a Slack message", inputSchema: { type: "object" } },
    ]),
  };
}

function buildHub(overrides: Partial<ConstructorParameters<typeof ActionHub>[0]> = {}) {
  const clients = buildClients();
  const { factory, activations } = makeFactory(clients);
  const hub = new ActionHub({ servers, clientFactory: factory, ...overrides });
  return { hub, clients, activations };
}

test("indexes every enabled server", async () => {
  const { hub } = buildHub();
  const results = await hub.indexAll();
  assert.equal(results.every((result) => !result.error), true);
  assert.equal(hub.catalog.size, 3);
});

test("search returns summaries but load returns the full schema", async () => {
  const { hub } = buildHub();
  await hub.indexAll();

  const hits = await hub.search("pull request");
  const top = hits[0];
  assert.ok(top);
  assert.equal(top.id, "github:create_pull_request");
  assert.equal("inputSchema" in top, false);
  // The multi-line description collapses to a single summary line.
  assert.equal(top?.summary, "Open a new pull request.");

  const loaded = hub.load("github:create_pull_request");
  assert.deepEqual(loaded.inputSchema["required"], ["title"]);
  assert.match(loaded.description ?? "", /draft mode/);
});

test("load rejects an unknown action", async () => {
  const { hub } = buildHub();
  await hub.indexAll();
  assert.throws(() => hub.load("github:nope"), /Unknown action/);
});

test("execute validates arguments before dispatching", async () => {
  const { hub, clients } = buildHub();
  await hub.indexAll();

  const bad = await hub.execute("github:create_pull_request", { draft: true });
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? "", /required property is missing/);
  // The downstream server must never see an invalid call.
  assert.equal(clients.github.calls.length, 0);

  const good = await hub.execute("github:create_pull_request", { title: "Add feature" });
  assert.equal(good.ok, true);
  assert.equal(good.content, "ok:create_pull_request");
  assert.equal(clients.github.calls.length, 1);
});

test("gated servers are refused when approval is denied", async () => {
  const { hub, clients } = buildHub({ denyOnApprovalRequired: true });
  await hub.indexAll();

  const result = await hub.execute("slack:post_message", {});
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Approval required/);
  assert.equal(clients.slack.calls.length, 0);
});

test("a disabled server is neither indexed nor executable", async () => {
  const clients = buildClients();
  const { factory } = makeFactory(clients);
  const hub = new ActionHub({
    servers: [servers[0]!, { ...servers[1]!, enabled: false }],
    clientFactory: factory,
  });

  await hub.indexAll();
  assert.equal(hub.catalog.countByServer("slack"), 0);
  assert.equal(clients.slack.closed, false);
  assert.equal(clients.slack.calls.length, 0);
});

test("denied tools are excluded from the index", async () => {
  const clients = buildClients();
  const { factory } = makeFactory(clients);
  const hub = new ActionHub({
    servers: [{ ...servers[0]!, denyTools: ["create_pull_request"] }],
    clientFactory: factory,
  });

  await hub.indexAll();
  assert.equal(hub.catalog.has("github:create_pull_request"), false);
  assert.equal(hub.catalog.has("github:list_issues"), true);
});

test("a failing server does not break the rest of the catalog", async () => {
  const clients = buildClients();
  const factory = async (config: ServerConfig) => {
    if (config.id === "slack") throw new Error("auth expired");
    return clients.github;
  };

  const hub = new ActionHub({ servers, clientFactory: factory });
  const results = await hub.indexAll();

  const slack = results.find((result) => result.serverId === "slack");
  assert.match(slack?.error ?? "", /auth expired/);
  assert.equal(hub.catalog.countByServer("github"), 2);
  assert.equal(hub.serverStates().find((state) => state.id === "slack")?.status, "error");
});

test("a server is connected only once across repeated executions", async () => {
  const { hub, activations } = buildHub();
  await hub.indexAll();
  await hub.execute("github:list_issues", {});
  await hub.execute("github:list_issues", {});
  assert.equal(activations.filter((id) => id === "github").length, 1);
});

test("skills are searchable but not executable", async () => {
  const { hub } = buildHub();
  await hub.indexAll();
  hub.registerSkills([
    {
      id: "local:deploy-runbook",
      serverId: "local",
      name: "deploy-runbook",
      summary: "Steps for a production deploy",
      trust: "trusted",
    },
  ]);

  const hits = await hub.search("deploy runbook");
  assert.equal(hits[0]?.id, "local:deploy-runbook");

  const result = await hub.execute("local:deploy-runbook", {});
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /must be loaded, not executed/);
});

test("history records both successes and failures", async () => {
  const { hub } = buildHub();
  await hub.indexAll();
  await hub.execute("github:list_issues", {});
  await hub.execute("github:create_pull_request", {});

  const history = hub.history();
  assert.equal(history.length, 2);
  assert.equal(history[0]?.ok, true);
  assert.equal(history[1]?.ok, false);
});

test("context stats show the hub costs less than eager schemas", async () => {
  const { hub } = buildHub();
  await hub.indexAll();
  const stats = hub.contextStats();
  assert.equal(stats.actions, 3);
  assert.ok(stats.eagerTokensEstimate > 0);
  assert.ok(stats.hubTokensEstimate > 0);
});

test("close shuts down active clients", async () => {
  const { hub, clients } = buildHub();
  await hub.indexAll();
  await hub.close();
  assert.equal(clients.github.closed, true);
});

test("execute enforces timeout when downstream server hangs", async () => {
  const slowClient: any = {
    async listTools() {
      return [{ name: "slow_action", description: "Slow action" }];
    },
    async callTool() {
      // Hang indefinitely or longer than timeout
      await new Promise((resolve) => setTimeout(resolve, 200));
      return "done";
    },
    async close() {},
  };

  const hub = new ActionHub({
    servers: [
      {
        id: "slow",
        transport: { type: "stdio", command: "slow-mcp" },
        trust: "trusted",
        timeoutMs: 50,
      },
    ],
    clientFactory: async () => slowClient,
  });

  await hub.indexAll();
  const result = await hub.execute("slow:slow_action", {});
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /timed out after 50ms/);
});
