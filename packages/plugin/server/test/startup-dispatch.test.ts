import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionHub, CatalogCache } from "@action-hub/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../dist/index.js";
import { SnapshotDebouncer } from "../dist/snapshot.js";
import type { SnapshotDebouncer as SnapshotDebouncerType } from "../dist/snapshot.js";
import type { HubRuntime } from "../dist/index.js";

/**
 * Regression harness for FX12-FIX:
 *   - F24: the execute dispatch return must carry the core cache flag.
 *   - F18 part 2: the debouncer collapses burst snapshot writes and the
 *     execute path must mark dirty instead of rewriting per call.
 *
 * The runtime wires a counting debouncer, so nothing is written to disk.
 */
async function buildRuntime() {
  let marked = 0;
  let flushed = 0;
  const debouncer: Pick<SnapshotDebouncerType, "markDirty" | "flush"> = {
    markDirty() {
      marked += 1;
    },
    async flush() {
      flushed += 1;
    },
  };
  const hub = new ActionHub({
    clientFactory: async () => ({
      listTools: async () => [
        {
          name: "lookup_thing",
          description: "Idempotent read used by the cache-flag regression.",
          inputSchema: { type: "object", properties: { key: { type: "string" } } },
          annotations: { readOnlyHint: true },
        },
      ],
      callTool: async () => ({ content: [{ type: "text", text: "stable-result" }] }),
      close: async () => {},
    }),
    servers: [{ id: "readmod", transport: { type: "stdio", command: "fake" }, trust: "trusted" }],
    bundles: [],
  });
  await hub.indexAll();
  const runtime: HubRuntime = {
    hub,
    cache: new CatalogCache(),
    configHash: "test",
    configPath: "/tmp/nonexistent-action-hub-config.json",
    refreshed: Promise.resolve([]),
    startRefresh: () => Promise.resolve([]),
    snapshotDebouncer: debouncer,
    close: async () => {},
  };
  return { runtime, debouncer, marks: () => marked, flushes: () => flushed };
}

async function callOperation(runtime: HubRuntime, args: Record<string, unknown>) {
  const server = createMcpServer(runtime);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.callTool({ name: "action_hub", arguments: args });
  await client.close();
  await server.close();
  assert.ok(!result.isError, JSON.stringify(result).slice(0, 400));
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text);
}

test("F24: the second execute of a cacheable read reports cached:true", async () => {
  const { runtime } = await buildRuntime();
  const first = (await callOperation(runtime, {
    operation: "execute",
    action_id: "readmod:lookup_thing",
    arguments: { key: "k" },
  })) as { ok: boolean; cached?: boolean };
  assert.equal(first.ok, true);
  assert.equal(first.cached, false, "first call is not cached");

  const second = (await callOperation(runtime, {
    operation: "execute",
    action_id: "readmod:lookup_thing",
    arguments: { key: "k" },
  })) as { ok: boolean; cached?: boolean };
  assert.equal(second.ok, true);
  assert.equal(second.cached, true, "second identical read must carry cached:true");
});

test("F18 part 2: every execute marks the snapshot dirty instead of writing", async () => {
  const { runtime, marks } = await buildRuntime();
  for (let i = 0; i < 5; i++) {
    await callOperation(runtime, {
      operation: "execute",
      action_id: "readmod:lookup_thing",
      arguments: { key: `k${i}` },
    });
  }
  assert.equal(marks(), 5, "each execute marks dirty");
});

test("SnapshotDebouncer collapses a burst into one write and flushes on dispose", async () => {
  let writes = 0;
  const debouncer = new SnapshotDebouncer(async () => {
    writes += 1;
  }, 40);

  for (let i = 0; i < 10; i++) debouncer.markDirty();
  assert.equal(writes, 0, "no write before the interval elapses");
  await debouncer.dispose();
  assert.equal(writes, 1, "the burst collapsed into a single flushed write");

  // After dispose, further marks are ignored (runtime is closing).
  debouncer.markDirty();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(writes, 1);
});

test("SnapshotDebouncer writes at most once per interval across bursts", async () => {
  let writes = 0;
  const debouncer = new SnapshotDebouncer(async () => {
    writes += 1;
  }, 40);

  debouncer.markDirty();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(writes, 1, "first window wrote once");

  for (let i = 0; i < 8; i++) debouncer.markDirty();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(writes, 2, "second burst collapsed into one more write");
  await debouncer.dispose();
});
