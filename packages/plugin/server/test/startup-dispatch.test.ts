import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
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
test("F23 rework: the initialize response arrives before the deferred refresh starts", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "hub-order-"));
  const configPath = join(tmp, "config.json");
  await writeFile(configPath, JSON.stringify({ autoDiscover: false }), "utf8");
  const prevConfig = process.env["ACTION_HUB_CONFIG"];
  process.env["ACTION_HUB_CONFIG"] = configPath;
  try {
    const runtime = await createHubRuntime();
    const order: string[] = [];
    // Deliberately blocking refresh: if the trigger ever fires before the
    // initialize response, awaiting it would stall the handshake.
    runtime.startRefresh = () => {
      order.push("refresh-start");
      return new Promise(() => {}); // never resolves
    };
    const server = createMcpServer(runtime);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    // Intercept SERVER->client sends (the client overwrites its own inbound
    // handler on connect, so the response must be recorded server-side).
    const realSend = serverTransport.send.bind(serverTransport);
    (serverTransport as unknown as { send: (msg: unknown) => Promise<void> }).send = async (msg: unknown) => {
      const m = msg as { id?: unknown; result?: unknown };
      if (m.id !== undefined && m.result !== undefined) order.push("initialize-response");
      await realSend(msg as Parameters<typeof realSend>[0]);
    };
    const client = new Client({ name: "test", version: "0.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.ok(order.includes("initialize-response"), "initialize response sent");
    assert.ok(order.includes("refresh-start"), "refresh trigger fired");
    assert.equal(
      order.indexOf("initialize-response") < order.indexOf("refresh-start"),
      true,
      `initialize response must precede the refresh trigger: ${order.join(",")}`,
    );
    await client.close();
    await server.close();
    await runtime.close();
  } finally {
    if (prevConfig === undefined) delete process.env["ACTION_HUB_CONFIG"];
    else process.env["ACTION_HUB_CONFIG"] = prevConfig;
  }
});

test("F23 rework 2: synchronous refresh work cannot extend client-observed initialize latency (HTTP)", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "hub-http-lat-"));
  const configPath = join(tmp, "config.json");
  await writeFile(configPath, JSON.stringify({ autoDiscover: false }), "utf8");
  const prevConfig = process.env["ACTION_HUB_CONFIG"];
  process.env["ACTION_HUB_CONFIG"] = configPath;
  try {
    const { startHttpServer } = await import("../dist/http-server.js");
    // Seed run (cold) so the test runtime is warm.
    const seed = await startHttpServer({ port: 0, token: "tok" });
    await seed.close();
    const handle = await startHttpServer({ port: 0, token: "tok" });
    const SYNC_COST_MS = 300;
    let refreshRan = 0;
    handle.runtime.startRefresh = () => {
      // Deliberately synchronous index-shaped work: if this ran on the
      // response-critical path, an independent client would observe the full
      // cost added to its initialize latency.
      const start = Date.now();
      while (Date.now() - start < SYNC_COST_MS) { /* busy */ }
      refreshRan += 1;
      return Promise.resolve([]);
    };
    // The measuring client runs in a CHILD PROCESS so its event loop is
    // independent of this process (an in-process fetch would be delayed by
    // the busy loop regardless of server-side ordering).
    const child = spawn(process.execPath, [
      "-e",
      `const { performance } = require("node:perf_hooks");
       const t = performance.now();
       fetch("http://127.0.0.1:${handle.port}/mcp", {
         method: "POST",
         headers: { authorization: "Bearer tok", "content-type": "application/json" },
         body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } })
       }).then(async (r) => { await r.arrayBuffer(); console.log(JSON.stringify({ ms: Math.round(performance.now() - t) })); })
        .catch((e) => console.log(JSON.stringify({ ms: -1, error: String(e) })));`,
    ]);
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => { stdout += String(c); });
    const latency = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("child client timed out")), 15000);
      child.on("exit", () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(stdout.trim().split("\n").pop() ?? "{}").ms as number); }
        catch (cause) { reject(cause as Error); }
      });
    });
    assert.ok(latency > 0, `child client failed: ${stdout.slice(0, 200)}`);
    assert.ok(
      latency < SYNC_COST_MS,
      `client-observed initialize latency (${latency}ms) must stay below the synchronous refresh cost (${SYNC_COST_MS}ms)`,
    );
    // The refresh still ran (after the flushed response, off-turn).
    await new Promise((resolve) => setTimeout(resolve, SYNC_COST_MS + 100));
    assert.equal(refreshRan, 1, "refresh triggered exactly once, after the response");
    await handle.close();
  } finally {
    if (prevConfig === undefined) delete process.env["ACTION_HUB_CONFIG"];
    else process.env["ACTION_HUB_CONFIG"] = prevConfig;
  }
});


test("F23 rework 3: closing cancels the queued refresh trigger (deterministic)", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "hub-http-close-"));
  const configPath = join(tmp, "config.json");
  await writeFile(configPath, JSON.stringify({ autoDiscover: false }), "utf8");
  const prevConfig = process.env["ACTION_HUB_CONFIG"];
  process.env["ACTION_HUB_CONFIG"] = configPath;
  const realSetImmediate = globalThis.setImmediate;
  try {
    const { startHttpServer } = await import("../dist/http-server.js");
    const seed = await startHttpServer({ port: 0, token: "tok" });
    await seed.close();
    const handle = await startHttpServer({ port: 0, token: "tok" });
    let refreshRan = 0;
    let refreshPromise: Promise<unknown> | undefined;
    handle.runtime.startRefresh = () => {
      refreshRan += 1;
      refreshPromise ??= Promise.resolve([]);
      return refreshPromise;
    };
    // Capture the queued trigger instead of letting it run: the real window
    // between res finish and the setImmediate firing is sub-millisecond, so
    // no external close can land inside it deterministically.
    const queued: Array<(...args: unknown[]) => void> = [];
    const handles: unknown[] = [];
    const realClearImmediate = globalThis.clearImmediate;
    (globalThis as { setImmediate: unknown }).setImmediate = ((fn: (...args: unknown[]) => void, ...args: unknown[]) => {
      queued.push(() => fn(...args));
      const handle = realSetImmediate(() => undefined, 0);
      handles.push(handle);
      return handle;
    }) as typeof setImmediate;
    const cleared: unknown[] = [];
    (globalThis as { clearImmediate: unknown }).clearImmediate = ((handle: unknown) => {
      cleared.push(handle);
    }) as typeof clearImmediate;
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    });
    await res.arrayBuffer().catch(() => undefined);
    (globalThis as { setImmediate: unknown }).setImmediate = realSetImmediate;
    assert.ok(queued.length >= 1, "the finish handler queued at least one deferred trigger");
    assert.equal(refreshRan, 0, "trigger has not run while queued");

    // Close must cancel the queued trigger (clearImmediate on our handle).
    await handle.close();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));
    (globalThis as { clearImmediate: unknown }).clearImmediate = realClearImmediate;
    const triggerHandles = handles.slice(-queued.length);
    assert.equal(
      triggerHandles.some((h) => cleared.includes(h)),
      true,
      "close cleared the queued trigger",
    );
    assert.equal(refreshRan, 0, "close cancelled the queued trigger");

    // Even if the trigger runs after close (the race the reviewer proved),
    // the closing guard must keep it from starting an index.
    for (const run of queued) run();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(refreshRan, 0, "a trigger firing after close must not start the refresh");
  } finally {
    (globalThis as { setImmediate: unknown }).setImmediate = realSetImmediate;
    if (prevConfig === undefined) delete process.env["ACTION_HUB_CONFIG"];
    else process.env["ACTION_HUB_CONFIG"] = prevConfig;
  }
});

test("FX19/F6: empty search query is a JSON-RPC -32602, not an unfiltered top-10", async () => {
  const { runtime } = await buildRuntime();
  const server = createMcpServer(runtime);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  await assert.rejects(
    client.callTool({ name: "action_hub", arguments: { operation: "search", query: "" } }),
    (cause: { code?: number }) => cause.code === -32602,
  );
  await assert.rejects(
    client.callTool({ name: "action_hub", arguments: { operation: "search" } }),
    (cause: { code?: number }) => cause.code === -32602,
  );
  await assert.rejects(
    client.callTool({ name: "action_hub", arguments: { operation: "load" } }),
    (cause: { code?: number; message?: string }) =>
      cause.code === -32602 && (cause.message ?? "").includes("action_id"),
  );
  // Valid calls keep working.
  const ok = await client.callTool({ name: "action_hub", arguments: { operation: "search", query: "lookup" } });
  assert.ok(!ok.isError);
  await client.close();
  await server.close();
});

test("FX19/F7: an unrecognized tools/list cursor is a JSON-RPC -32602", async () => {
  const { runtime } = await buildRuntime();
  const server = createMcpServer(runtime);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  await assert.rejects(
    client.listTools({ cursor: "bogus-cursor" }),
    (cause: { code?: number }) => cause.code === -32602,
  );
  // No cursor: the single action_hub tool is still listed.
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 1);
  assert.equal(listed.tools[0]!.name, "action_hub");
  await client.close();
  await server.close();
});

test("FX19: HTTP serve mode returns -32602 for the same violations", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "hub-conformance-"));
  const configPath = join(tmp, "config.json");
  await writeFile(configPath, JSON.stringify({ autoDiscover: false }), "utf8");
  const prevConfig = process.env["ACTION_HUB_CONFIG"];
  process.env["ACTION_HUB_CONFIG"] = configPath;
  try {
    const { startHttpServer } = await import("../dist/http-server.js");
    const handle = await startHttpServer({ port: 0, token: "tok" });
    const post = async (body: unknown) => {
      const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer tok", "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify(body),
      });
      const raw = await res.text();
      // The streamable-HTTP transport may answer JSON or an SSE frame
      // ("event: message\ndata: {...}"); normalise both to the payload.
      const payload = raw.startsWith("event:")
        ? (JSON.parse(raw.split("data: ")[1]!.split("\n")[0]!) as Record<string, unknown>)
        : (JSON.parse(raw) as Record<string, unknown>);
      return { status: res.status, body: payload };
    };
    await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    const badSearch = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "action_hub", arguments: { operation: "search" } } });
    assert.equal(badSearch.status, 200);
    assert.equal((badSearch.body?.error as { code?: number } | undefined)?.code, -32602, "empty search query -> JSON-RPC -32602");
    const badCursor = await post({ jsonrpc: "2.0", id: 3, method: "tools/list", params: { cursor: "bogus" } });
    assert.equal((badCursor.body?.error as { code?: number } | undefined)?.code, -32602, "unknown cursor -> JSON-RPC -32602");
    const goodList = await post({ jsonrpc: "2.0", id: 4, method: "tools/list" });
    assert.ok((goodList.body?.result as { tools?: unknown[] } | undefined)?.tools, "cursor-less tools/list still works");
    await handle.close();
  } finally {
    if (prevConfig === undefined) delete process.env["ACTION_HUB_CONFIG"];
    else process.env["ACTION_HUB_CONFIG"] = prevConfig;
  }
});
