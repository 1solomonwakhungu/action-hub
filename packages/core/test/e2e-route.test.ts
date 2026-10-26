import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActionHubOptions } from "../dist/action-hub.js";
import type { ServerConfig } from "../dist/types.js";
import { FakeClient, makeFactory } from "./fakes.ts";
import { testActionHub } from "./test-hub.ts";

/**
 * Offline end-to-end regression for the model-facing route:
 * search -> load schema -> execute, against in-process fake MCP clients.
 *
 * Covers three cross-component failure shapes the unit suites exercise only
 * in isolation:
 * 1. the happy route, including argument validation against the loaded schema;
 * 2. denial of an unauthorized action (untrusted server, fail-closed host);
 * 3. an upstream server dying between index and execute, with the rest of
 *    the catalog untouched;
 * 4. the schema hand-off contract: the object returned by load()/search
 *    must not alias the catalog record, or a host-side mutation silently
 *    disables execute-time validation.
 */

const servers: ServerConfig[] = [
  {
    id: "github",
    transport: { type: "stdio", command: "gh-mcp" },
    trust: "trusted",
  },
  {
    id: "slack",
    transport: { type: "stdio", command: "slack-mcp" },
    trust: "untrusted",
  },
];

function buildClients() {
  return {
    github: new FakeClient(
      [
        {
          name: "create_pull_request",
          description: "Open a new pull request.\nSupports draft mode.",
          inputSchema: {
            type: "object",
            properties: { title: { type: "string" }, draft: { type: "boolean" } },
            required: ["title"],
          },
        },
        {
          name: "list_issues",
          description: "List repository issues",
          inputSchema: { type: "object" },
        },
      ],
      (name, args) => `ran:${name}:${JSON.stringify(args)}`,
    ),
    slack: new FakeClient(
      [
        {
          name: "post_message",
          description: "Post a Slack message",
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
        },
      ],
      (name) => `ran:${name}`,
    ),
  };
}

function buildHub(overrides: Partial<ActionHubOptions> = {}) {
  const clients = buildClients();
  const { factory, activations } = makeFactory(clients);
  const hub = testActionHub({ servers, clientFactory: factory, ...overrides });
  return { hub, clients, activations };
}

test("search -> load -> execute runs the full route against the fake MCP server", async () => {
  const { hub, clients } = buildHub();
  await hub.indexAll();

  const hits = await hub.search("pull request");
  const top = hits[0];
  assert.ok(top, "search must surface the pull-request action");
  assert.equal(top.id, "github:create_pull_request");
  assert.equal("inputSchema" in top, false, "search stays schema-free");

  const loaded = hub.load(top.id);
  assert.equal(loaded.serverId, "github");
  assert.deepEqual(loaded.inputSchema["required"], ["title"]);

  const result = await hub.execute(top.id, { title: "Add feature" });
  assert.equal(result.ok, true);
  assert.deepEqual(clients.github.calls, [
    { name: "create_pull_request", args: { title: "Add feature" }, options: { headers: {} } },
  ]);

  // Invalid arguments are rejected against the loaded schema and never
  // reach the downstream server.
  const bad = await hub.execute(top.id, { draft: true });
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? "", /required property is missing/);
  assert.equal(clients.github.calls.length, 1);
});

test("an unauthorized action is denied through the same route without reaching the server", async () => {
  const { hub, clients } = buildHub({ denyOnApprovalRequired: true });
  await hub.indexAll();

  // The untrusted action is still discoverable and loadable...
  const hits = await hub.search("slack message");
  assert.ok(hits.some((hit) => hit.id === "slack:post_message"));
  const loaded = hub.load("slack:post_message");
  assert.equal(loaded.serverId, "slack");

  // ...but the fail-closed host refuses it and the server is never called.
  const denied = await hub.execute("slack:post_message", { text: "hi" });
  assert.equal(denied.ok, false);
  assert.match(denied.error ?? "", /Approval required/);
  assert.equal(clients.slack.calls.length, 0);

  // The denial must not poison the healthy route.
  const ok = await hub.execute("github:list_issues", {});
  assert.equal(ok.ok, true);
});

test("an upstream server dying between index and execute fails the call and leaves the rest of the catalog intact", async () => {
  const clients = buildClients();
  let slackUp = true;
  // The child process dies mid-flight: the live transport throws a
  // positively-marked transport error on the next call.
  const slackRaw = clients.slack.callTool.bind(clients.slack);
  (clients.slack as unknown as { callTool: (...a: unknown[]) => Promise<unknown> }).callTool = async (
    ...a: unknown[]
  ) => {
    if (!slackUp) {
      const e = new Error("slack-mcp exited: not connected") as Error & { errno?: string };
      e.errno = "EPIPE";
      throw e;
    }
    return slackRaw(...(a as [string, Record<string, unknown>, unknown]));
  };
  const factory = async (config: ServerConfig) => {
    if (config.id === "slack") {
      return slackUp ? clients.slack : Promise.reject(new Error("spawn failed: slack-mcp exited"));
    }
    return clients.github;
  };
  const hub = testActionHub({
    servers: [servers[0]!, { ...servers[1]!, trust: "trusted" }],
    clientFactory: factory,
  });
  await hub.indexAll();

  const ok = await hub.execute("slack:post_message", { text: "hi" });
  assert.equal(ok.ok, true);
  slackUp = false;

  // Search and load still surface the action (the catalog is the last known
  // good index), but execute fails with the upstream error, not a crash.
  const hits = await hub.search("slack message");
  assert.ok(hits.some((hit) => hit.id === "slack:post_message"));
  const failed = await hub.execute("slack:post_message", { text: "hi" });
  assert.equal(failed.ok, false);
  assert.match(failed.error ?? "", /slack-mcp exited|Connection failed|No fake client|Unknown|error/);

  // The failure is recorded and isolated: the healthy server keeps working.
  const last = hub.history()[hub.history().length - 1];
  assert.equal(last?.ok, false);
  assert.equal(last?.serverId, "slack");
  const healthy = await hub.execute("github:create_pull_request", { title: "Still works" });
  assert.equal(healthy.ok, true);
});

test("the schema handed out by load is a copy: mutating it cannot disable execute-time validation", async () => {
  const { hub, clients } = buildHub();
  await hub.indexAll();

  const loaded = hub.load("github:create_pull_request");
  // A host that (accidentally or maliciously) strips the requirements from
  // the schema it was handed must not weaken the hub's own validation.
  const schema = loaded.inputSchema as Record<string, unknown>;
  delete schema["required"];

  const result = await hub.execute("github:create_pull_request", { draft: true });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /required property is missing/);
  assert.equal(clients.github.calls.length, 0, "invalid args must never reach the server");

  // The catalog record is unchanged: a fresh load still carries the schema.
  const fresh = hub.load("github:create_pull_request");
  assert.deepEqual(fresh.inputSchema["required"], ["title"]);
});

test("search with includeSchema also hands out a copy", async () => {
  const { hub, clients } = buildHub();
  await hub.indexAll();

  const hits = await hub.search("pull request", { includeSchema: true });
  const hit = hits.find((entry) => entry.id === "github:create_pull_request");
  assert.ok(hit);
  const schema = hit.inputSchema as Record<string, unknown>;
  delete schema["required"];

  const result = await hub.execute("github:create_pull_request", { draft: true });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /required property is missing/);
  assert.equal(clients.github.calls.length, 0);
});
