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

test("duplicate tool names within one server keep the first occurrence and warn on stderr", async () => {
  const stderr: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const client = new FakeClient([
      { name: "dup_tool", description: "the real tool", inputSchema: { type: "object" } },
      { name: "unique_tool", description: "unaffected", inputSchema: { type: "object" } },
      { name: "dup_tool", description: "hostile shadow copy", inputSchema: { type: "object" } },
    ]);
    const hub = new ActionHub({
      servers: [{ id: "dup", transport: { type: "stdio", command: "dup-mcp" }, trust: "trusted" }],
      clientFactory: async () => client,
    });
    const results = await hub.indexAll();

    // First occurrence wins; the shadow copy is skipped, not the real tool.
    assert.equal(results[0]?.indexed, 2);
    const kept = hub.load("dup:dup_tool");
    assert.match(kept.description ?? "", /the real tool/);
    assert.ok(!JSON.stringify(hub.catalog.all()).includes("shadow copy"));
    // Exactly one stderr warning, naming the duplicated tool; nothing on stdout.
    const dupWarnings = stderr.filter((line) => line.includes('server "dup" listed duplicate tool names'));
    assert.equal(dupWarnings.length, 1);
    assert.match(dupWarnings[0] ?? "", /dup_tool/);
  } finally {
    process.stderr.write = originalWrite;
  }
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

test("caches idempotent reads and serves repeat calls from the cache", async () => {
  const { hub, clients } = buildHub();
  await hub.indexAll();

  const first = await hub.execute("github:list_issues", {});
  assert.equal(first.ok, true);
  assert.notEqual(first.cached, true);
  assert.equal(clients.github.calls.length, 1);

  const second = await hub.execute("github:list_issues", {});
  assert.equal(second.ok, true);
  assert.equal(second.cached, true);
  assert.deepEqual(second.content, first.content);
  // The downstream client must see exactly one call for both executions.
  assert.equal(clients.github.calls.length, 1);

  hub.clearResultCache();
  const third = await hub.execute("github:list_issues", {});
  assert.equal(third.cached, undefined);
  assert.equal(clients.github.calls.length, 2);
});

test("readOnlyHint annotation makes non-prefixed tools cacheable and cache hits are recorded", async () => {
  let downstreamCalls = 0;
  const client = {
    listTools: async () => [
      {
        name: "create_report",
        description: "Generates a report",
        annotations: { readOnlyHint: true },
      },
    ],
    callTool: async () => {
      downstreamCalls += 1;
      return "ok:create_report";
    },
    close: async () => {},
  };
  const hub = new ActionHub({
    clientFactory: async () => client,
    servers: [{ id: "rep", transport: { type: "stdio", command: "rep-mcp" }, trust: "trusted" }],
  });
  await hub.indexAll();

  const first = await hub.execute("rep:create_report", {});
  assert.equal(first.ok, true);
  assert.notEqual(first.cached, true);
  assert.equal(downstreamCalls, 1);

  const second = await hub.execute("rep:create_report", {});
  assert.equal(second.cached, true);
  // No read prefix, so caching only happened because of readOnlyHint.
  assert.equal(downstreamCalls, 1);

  const lastEntry = hub.history()[hub.history().length - 1];
  assert.ok(lastEntry);
  assert.equal(lastEntry?.cached, true);
  assert.equal(lastEntry?.ok, true);
});

test("a typed annotations object from a client marks the action readOnly", async () => {
  // Tool objects flowing through the shared McpClient.listTools type (not an
  // untyped inline client) carry annotations, so the hub must honor
  // readOnlyHint without any local casts.
  let downstreamCalls = 0;
  const hub = new ActionHub({
    clientFactory: makeFactory({
      rep: new FakeClient(
        [
          {
            name: "create_report",
            description: "Generates a report",
            annotations: { readOnlyHint: true },
          },
        ],
        () => {
          downstreamCalls += 1;
          return "ok:create_report";
        },
      ),
    }).factory,
    servers: [{ id: "rep", transport: { type: "stdio", command: "rep-mcp" }, trust: "trusted" }],
  });
  await hub.indexAll();

  const first = await hub.execute("rep:create_report", {});
  assert.equal(first.ok, true);
  assert.notEqual(first.cached, true);
  assert.equal(downstreamCalls, 1);

  // Cached purely because the typed annotations marked the action readOnly.
  const second = await hub.execute("rep:create_report", {});
  assert.equal(second.cached, true);
  assert.equal(downstreamCalls, 1);
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
