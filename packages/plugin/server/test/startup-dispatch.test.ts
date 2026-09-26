import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionHub, CatalogCache } from "@action-hub/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHubRuntime, createMcpServer } from "../dist/index.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("F23 rework: refresh starts on handled initialize and exactly once across transports", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "hub-refresh-"));
  const configPath = join(tmp, "config.json");
  const cachePath = join(tmp, "cache.json");
  await writeFile(configPath, JSON.stringify({ autoDiscover: false }), "utf8");
  const prevConfig = process.env["ACTION_HUB_CONFIG"];
  const prevCache = process.env["ACTION_HUB_CACHE"];
  process.env["ACTION_HUB_CONFIG"] = configPath;
  process.env["ACTION_HUB_CACHE"] = cachePath;
  try {
    // Run 1 (cold): seeds the catalog cache, then closes.
    const cold = await createHubRuntime();
    await cold.startRefresh();
    await cold.close();

    // Run 2 (warm): the deferred refresh must start on the handled initialize
    // and run exactly once despite repeated transports.
    const runtime = await createHubRuntime();
    const hub = runtime.hub;
    let indexes = 0;
    const realIndexAll = hub.indexAll.bind(hub);
    (hub as unknown as { indexAll: () => Promise<unknown> }).indexAll = async () => {
      indexes += 1;
      return realIndexAll();
    };
    const server = createMcpServer(runtime);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await runtime.startRefresh();
    assert.equal(indexes, 1, "handled initialize starts the refresh");
    const server2 = createMcpServer(runtime);
    const [st2, ct2] = InMemoryTransport.createLinkedPair();
    const client2 = new Client({ name: "test2", version: "0.0.0" });
    await server2.connect(st2);
    await client2.connect(ct2);
    await client2.callTool({ name: "action_hub", arguments: { operation: "search", query: "x" } });
    assert.equal(indexes, 1, "memoised: no duplicate index");
    await client2.close();
    await server2.close();
    await client.close();
    await server.close();
    await runtime.close();
  } finally {
    if (prevConfig === undefined) delete process.env["ACTION_HUB_CONFIG"];
    else process.env["ACTION_HUB_CONFIG"] = prevConfig;
    if (prevCache === undefined) delete process.env["ACTION_HUB_CACHE"];
    else process.env["ACTION_HUB_CACHE"] = prevCache;
  }
});

test("F23 rework: no initialize handshake -> no refresh", async () => {
  let started = 0;
  const { runtime } = await buildRuntime();
  runtime.startRefresh = () => {
    started += 1;
    return Promise.resolve([]);
  };
  const server = createMcpServer(runtime);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  // A transport that connects but never handshakes must not start the refresh.
  assert.equal(started, 0);
  await clientTransport.close();
  await server.close();
  assert.equal(started, 0);
});

test("F18 rework: markDirty during an in-flight dispose flush is still persisted", async () => {
  let writes = 0;
  let releaseFirst: (() => void) | undefined;
  const debouncer = new SnapshotDebouncer(async () => {
    writes += 1;
    if (writes === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
  }, 5000);

  debouncer.markDirty();
  const disposing = debouncer.dispose();
  // Write #1 is in flight and blocked. A concurrent execute marks dirty again.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(releaseFirst);
  debouncer.markDirty();
  releaseFirst?.(); // release write #1
  await disposing; // dispose must drain the SECOND dirty state too
  assert.equal(writes, 2, "the mark accepted during dispose must be written");
  await debouncer.flush();
  assert.equal(writes, 2, "nothing further to write after the drain");
});

test("F23 rework: HTTP stateless requests start the refresh once, after the first handled request", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "hub-http-"));
  const configPath = join(tmp, "config.json");
  await writeFile(configPath, JSON.stringify({ autoDiscover: false }), "utf8");
  const prevConfig = process.env["ACTION_HUB_CONFIG"];
  process.env["ACTION_HUB_CONFIG"] = configPath;
  try {
    const { startHttpServer } = await import("../dist/http-server.js");
    // Seed run (cold): the cold path indexes inside bootstrapCatalog, so the
    // refresh trigger is only observable on a warm runtime.
    const seed = await startHttpServer({ port: 0, token: "test-token-123" });
    await seed.close();
    const handle = await startHttpServer({ port: 0, token: "test-token-123" });
    const hub = handle.runtime.hub;
    let indexes = 0;
    const realIndexAll = hub.indexAll.bind(hub);
    (hub as unknown as { indexAll: () => Promise<unknown> }).indexAll = async () => {
      indexes += 1;
      return realIndexAll();
    };
    const post = async (body: unknown) => {
      const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer test-token-123", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      await res.arrayBuffer().catch(() => undefined);
      return res.status;
    };
    await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    assert.equal(indexes, 1, "first handled HTTP request starts the refresh");
    for (let i = 0; i < 3; i++) {
      await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    }
    await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.equal(indexes, 1, "no duplicate refresh across stateless requests");
    await handle.close();
  } finally {
    if (prevConfig === undefined) delete process.env["ACTION_HUB_CONFIG"];
    else process.env["ACTION_HUB_CONFIG"] = prevConfig;
  }
});
