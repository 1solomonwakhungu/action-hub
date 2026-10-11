import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionHub, CatalogCache } from "@action-hub/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../dist/index.js";
import type { HubRuntime } from "../dist/index.js";

/**
 * Cache-stable design (README "Cache-stable by design", r/mcp follow-up 6).
 *
 * Pins the three properties a prompt-caching host relies on:
 *   1. the server exposes exactly ONE tool whose definition (name,
 *      description, input schema) is byte-identical across the session;
 *   2. a search -> load -> execute cycle never emits
 *      notifications/tools/list_changed, so the host's cached tool prefix is
 *      never invalidated by using the hub;
 *   3. argument schemas arrive as TOOL RESULTS of `load` (and of search with
 *      include_schema), never through tools/list.
 */

const FAKE_CLIENT = {
  listTools: async () => [
    {
      name: "lookup_thing",
      description: "Idempotent read used by the cache-stable regression.",
      inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
      annotations: { readOnlyHint: true },
    },
  ],
  callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
  close: async () => {},
};

function buildRuntime(): HubRuntime {
  const hub = new ActionHub({
    clientFactory: async () => FAKE_CLIENT,
    servers: [{ id: "readmod", transport: { type: "stdio", command: "fake" }, trust: "trusted" }],
    // The tool surface is independent of the semantic channel; keep the
    // unit-test hub on the dependency-free scorer (no model load).
    embeddings: null,
  });
  return {
    hub,
    cache: new CatalogCache(),
    configHash: "test",
    configPath: "/tmp/nonexistent-action-hub-config.json",
    refreshed: Promise.resolve([]),
    searchAbstention: { enabled: false, threshold: 0.8 },
    startRefresh: () => Promise.resolve([]),
    snapshotDebouncer: { markDirty() {}, async flush() {} },
    close: async () => {},
  };
}

function payloadOf(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  assert.equal(content.length, 1, "one text block per tool result");
  assert.equal(content[0]!.type, "text");
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

test("cache-stable: one fixed tool, no list_changed across search -> load -> execute, schemas as tool results", async () => {
  const runtime = buildRuntime();
  await runtime.hub.indexAll();
  const server = createMcpServer(runtime);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "cache-stable-test", version: "0.0.0" });
  let listChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    listChanged += 1;
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    // 1. Exactly one tool, and the SDK's standard tools capability. The
    //    capability flag is the SDK default; what matters for caching is
    //    that the notification below is never sent.
    const capabilities = client.getServerCapabilities();
    assert.ok(capabilities?.tools, "server advertises the tools capability");
    const first = await client.listTools();
    assert.equal(first.tools.length, 1, "the hub exposes exactly one tool");
    assert.equal(first.tools[0]!.name, "action_hub");
    assert.equal(first.nextCursor, undefined, "no pagination: the list is one fixed page");
    const definition = JSON.stringify(first.tools[0]);
    assert.ok(definition.length > 0);

    // 2. A full cycle through the catalog.
    const search = payloadOf(await client.callTool({ name: "action_hub", arguments: { operation: "search", query: "lookup thing" } }));
    assert.equal(search["ok"], true);
    const results = search["results"] as Array<Record<string, unknown>>;
    assert.ok(results.some((r) => r["action_id"] === "readmod:lookup_thing"));
    assert.ok(results.every((r) => !("input_schema" in r)), "search without include_schema returns no schemas");

    const load = payloadOf(await client.callTool({ name: "action_hub", arguments: { operation: "load", action_id: "readmod:lookup_thing" } }));
    assert.equal(load["ok"], true);
    // 3. The schema is a tool RESULT: it lives in the conversation, not in
    //    the tool list the host caches.
    const schema = load["input_schema"] as Record<string, unknown>;
    assert.equal(schema["type"], "object");
    assert.deepEqual(Object.keys(schema["properties"] as object), ["key"]);

    const fast = payloadOf(await client.callTool({ name: "action_hub", arguments: { operation: "search", query: "lookup thing", limit: 1, include_schema: true } }));
    const fastHit = (fast["results"] as Array<Record<string, unknown>>)[0]!;
    assert.deepEqual(fastHit["input_schema"], schema, "include_schema returns the same schema inline, still as a tool result");

    const execute = payloadOf(await client.callTool({ name: "action_hub", arguments: { operation: "execute", action_id: "readmod:lookup_thing", arguments: { key: "k" } } }));
    assert.equal(execute["ok"], true);

    // The tool list is byte-identical after the cycle and no list_changed
    // notification was ever delivered.
    const second = await client.listTools();
    assert.equal(second.tools.length, 1);
    assert.equal(JSON.stringify(second.tools[0]), definition, "tool definition is byte-identical across the session");
    // Give any in-flight notification a turn of the loop to arrive.
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(listChanged, 0, "tools/list_changed is never emitted");
  } finally {
    await client.close();
    await server.close();
    await runtime.hub.close();
  }
});
