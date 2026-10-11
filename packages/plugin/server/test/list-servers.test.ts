import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionHub, CatalogCache } from "@action-hub/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../dist/index.js";
import type { HubRuntime } from "../dist/index.js";

/**
 * Compressed domain/server awareness (r/mcp follow-up 4).
 *
 * The model sees ONE fixed tool. For a vague, goal-only ask it needs to know
 * which integrations exist before it can search well, so the directory is
 * served as a tool RESULT (`list_servers`) and rides along, in compact form,
 * on the two "nothing confident" responses (abstention, empty hits). The
 * tool definition itself must stay static so hosts can cache it.
 */

const SECRET = "ghp_" + "A".repeat(40);

function clientFor(tools: Array<{ name: string; description: string }>) {
  return {
    listTools: async () => tools.map((tool) => ({ ...tool, inputSchema: { type: "object", properties: {} } })),
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    close: async () => {},
  };
}

function buildRuntime(searchAbstention = { enabled: false, threshold: 0.8 }): HubRuntime {
  const hub = new ActionHub({
    embeddings: null,
    clientFactory: async (config) =>
      config.id === "payroll"
        ? clientFor([
            { name: "run_payroll", description: "Run the monthly payroll for all employees." },
            { name: "list_payslips", description: "List payslips for an employee in a payroll period." },
          ])
        : clientFor([
            { name: "post_message", description: "Post a chat message to a channel or thread." },
            { name: "list_channels", description: `List chat channels in the workspace. token ${SECRET}` },
          ]),
    servers: [
      {
        id: "payroll",
        displayName: "Payroll (ADP)",
        description: `HR payroll runs for EU staff ${SECRET}`,
        transport: { type: "stdio", command: "fake" },
        trust: "trusted",
      },
      { id: "chat", transport: { type: "stdio", command: "fake" }, trust: "trusted" },
    ],
  });
  return {
    hub,
    cache: new CatalogCache(),
    configHash: "test",
    configPath: "/tmp/nonexistent-action-hub-config.json",
    refreshed: Promise.resolve([]),
    searchAbstention,
    startRefresh: () => Promise.resolve([]),
    snapshotDebouncer: { markDirty() {}, async flush() {} },
    close: async () => {},
  };
}

async function withClient<T>(runtime: HubRuntime, fn: (client: Client) => Promise<T>): Promise<T> {
  const server = createMcpServer(runtime);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function call(client: Client, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name: "action_hub", arguments: args });
  return JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as Record<string, unknown>;
}

type DirectoryRow = {
  server: string;
  display_name?: string;
  description?: string;
  actions: number;
  kinds: string[];
  keywords: string[];
};

test("list_servers returns one compact, hardened row per indexed server", async () => {
  const runtime = buildRuntime();
  await runtime.hub.indexAll();
  await withClient(runtime, async (client) => {
    const payload = await call(client, { operation: "list_servers" });
    assert.equal(payload["ok"], true);
    assert.equal(payload["count"], 2);
    const rows = payload["servers"] as DirectoryRow[];
    assert.deepEqual(rows.map((row) => row.server), ["chat", "payroll"]);

    const payroll = rows.find((row) => row.server === "payroll")!;
    assert.equal(payroll.display_name, "Payroll (ADP)");
    assert.ok(payroll.description!.startsWith("HR payroll runs for EU staff"));
    assert.ok(!payroll.description!.includes(SECRET), "config description is redacted like every other echoed field");
    assert.equal(payroll.actions, 2);
    assert.deepEqual(payroll.kinds, ["tool"]);
    assert.ok(payroll.keywords.includes("payroll") || payroll.keywords.includes("payslips"), `keywords: ${payroll.keywords}`);

    const chat = rows.find((row) => row.server === "chat")!;
    assert.equal("display_name" in chat, false, "no config metadata means no key");
    assert.ok(chat.keywords.includes("channel") || chat.keywords.includes("channels") || chat.keywords.includes("chat"));
    for (const row of rows) {
      for (const keyword of row.keywords) assert.ok(!keyword.includes(SECRET.slice(0, 8)), "secret-shaped tokens never leak as keywords");
    }
    assert.match(String(payload["next"]), /server_id/);
  });
});

test("the tool definition stays fixed: one tool, static description that teaches list_servers", async () => {
  const runtime = buildRuntime();
  await runtime.hub.indexAll();
  await withClient(runtime, async (client) => {
    const before = await client.listTools();
    assert.equal(before.tools.length, 1, "exactly one tool, always");
    const tool = before.tools[0]!;
    assert.equal(tool.name, "action_hub");
    assert.match(tool.description ?? "", /list_servers/);
    // Nothing catalog-specific may leak into the definition, or it would
    // change between catalogs and defeat host-side caching.
    assert.ok(!(tool.description ?? "").includes("payroll"));
    const schema = JSON.stringify(tool.inputSchema);
    assert.match(schema, /list_servers/);
    assert.ok(!schema.includes("payroll"));

    // Re-indexing (a catalog change) must not alter the definition.
    await runtime.hub.indexAll();
    const after = await client.listTools();
    assert.deepEqual(after.tools, before.tools);
  });
});

test("an abstention response carries the compact directory", async () => {
  const runtime = buildRuntime({ enabled: true, threshold: 0.8 });
  await runtime.hub.indexAll();
  await runtime.hub.semanticReady();
  await withClient(runtime, async (client) => {
    const payload = await call(client, { operation: "search", query: "zzqx jabberwocky flimflam gibberish" });
    assert.equal(payload["abstained"], true);
    const servers = payload["servers"] as Array<{ server: string; keywords: string[] }>;
    assert.deepEqual(servers.map((row) => row.server), ["chat", "payroll"]);
    for (const row of servers) {
      assert.ok(row.keywords.length >= 1 && row.keywords.length <= 4, `compact rows carry at most 4 keywords: ${row.keywords}`);
      assert.equal("description" in row, false, "compact rows omit metadata; list_servers has it");
    }
    assert.match(String(payload["hint"]), /servers/);
  });
});

test("a confident search carries no directory; the field only appears when there is nothing to show", async () => {
  const runtime = buildRuntime();
  await runtime.hub.indexAll();
  await runtime.hub.semanticReady();
  await withClient(runtime, async (client) => {
    const confident = await call(client, { operation: "search", query: "run payroll" });
    assert.ok((confident["count"] as number) > 0);
    assert.equal("servers" in confident, false, "a search with hits is unchanged");

    // A server_id filter that matches nothing is a guaranteed empty page.
    const empty = await call(client, { operation: "search", query: "run payroll", server_id: "no-such-server" });
    assert.equal(empty["count"], 0);
    const servers = empty["servers"] as Array<{ server: string }>;
    assert.deepEqual(servers.map((row) => row.server), ["chat", "payroll"]);
  });
});
