import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionHub, CatalogCache } from "@action-hub/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../dist/index.js";
import { loadConfig } from "../dist/config.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HubRuntime } from "../dist/index.js";

/**
 * SQ3 (F49 part 2): flagged "no confident match" abstention.
 *
 * The flag is config-driven and DEFAULT OFF. When on, a search whose top
 * hit scores below the calibrated threshold returns an additive,
 * backward-compatible response: empty results + abstained/reason/threshold/
 * closestMatch instead of presenting low-confidence hits as facts.
 * Calibration (SQ1 2d, disjoint rows, 15K self-mode corpus): threshold 0.8
 * refused 0/51 real matches and abstained 5/7 no-match queries; caveat: only
 * 12 negative rows — a thin calibration base, hence the flag defaulting off.
 */

const FAKE_CLIENT = {
  listTools: async () => [
    {
      name: "lookup_thing",
      description: "Idempotent read used by the abstention regression.",
      inputSchema: { type: "object", properties: { key: { type: "string" } } },
      annotations: { readOnlyHint: true },
    },
    {
      name: "deploy_service",
      description: "Deploy a service to the staging environment.",
      inputSchema: { type: "object", properties: { app: { type: "string" } } },
      annotations: { destructiveHint: true },
    },
  ],
  callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
  close: async () => {},
};

function buildRuntime(searchAbstention: { enabled: boolean; threshold: number }): HubRuntime {
  const hub = new ActionHub({
    clientFactory: async () => FAKE_CLIENT,
    servers: [{ id: "readmod", transport: { type: "stdio", command: "fake" }, trust: "trusted" }],
    bundles: [],
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

async function callSearch(runtime: HubRuntime, query: string): Promise<Record<string, unknown>> {
  const server = createMcpServer(runtime);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.callTool({
    name: "action_hub",
    arguments: { operation: "search", query },
  });
  const payload = JSON.parse(
    (result.content as Array<{ type: string; text: string }>)[0]!.text,
  ) as Record<string, unknown>;
  await client.close();
  await server.close();
  return payload;
}

test("SQ3: the flag is OFF by default — search behaves exactly as before", async () => {
  const runtime = buildRuntime({ enabled: false, threshold: 0.8 });
  await runtime.hub.indexAll();
  const payload = await callSearch(runtime, "zzqx jabberwocky flimflam gibberish");
  assert.equal(payload["abstained"], undefined, "no abstention key when the flag is off");
  assert.ok((payload["count"] as number) > 0, "low-confidence hits are still returned as before");
});

test("SQ3: flag ON — a below-threshold search abstains with an additive response", async () => {
  const runtime = buildRuntime({ enabled: true, threshold: 0.8 });
  await runtime.hub.indexAll();
  const payload = await callSearch(runtime, "zzqx jabberwocky flimflam gibberish");
  assert.equal(payload["abstained"], true);
  assert.equal(payload["reason"], "no_confident_match");
  assert.equal(payload["count"], 0);
  assert.deepEqual(payload["results"], []);
  assert.equal(payload["threshold"], 0.8);
  const closest = payload["closestMatch"] as { id?: string; score?: number } | null;
  assert.ok(closest && typeof closest.id === "string" && typeof closest.score === "number",
    "closestMatch preserves the near miss");
});

test("SQ3: flag ON — a confident match still returns results, no abstention key", async () => {
  // 0.7, not 0.8: blend scores scale with corpus size/IDF and this 2-tool
  // fixture gives the exact-name match ~0.748 — the calibration caveat in
  // miniature. The threshold must be recalibrated per catalog, which is why
  // the flag ships default-off.
  const runtime = buildRuntime({ enabled: true, threshold: 0.7 });
  await runtime.hub.indexAll();
  const payload = await callSearch(runtime, "lookup_thing");
  assert.equal(payload["abstained"], undefined, "a real match must never be refused");
  assert.ok((payload["count"] as number) > 0);
  const results = payload["results"] as Array<{ action_id?: string }>;
  assert.ok(results.some((r) => r.action_id === "readmod:lookup_thing"));
});

test("SQ3: config parsing — enabled flag, threshold clamped into [0,1], defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hub-abstain-"));
  const path = join(dir, "servers.json");
  await writeFile(path, JSON.stringify({
    servers: [],
    search: { abstention: { enabled: true, threshold: 7 } },
  }), "utf8");
  const config = await loadConfig(path);
  assert.deepEqual(config.searchAbstention, { enabled: true, threshold: 1 }, "threshold clamped to 1");
  await writeFile(path, JSON.stringify({ servers: [], search: { abstention: { enabled: true } } }), "utf8");
  const defaulted = await loadConfig(path);
  assert.deepEqual(defaulted.searchAbstention, { enabled: true, threshold: 0.8 }, "calibrated default threshold");
  await writeFile(path, JSON.stringify({ servers: [] }), "utf8");
  const off = await loadConfig(path);
  assert.deepEqual(off.searchAbstention, { enabled: false, threshold: 0.8 }, "default OFF");
});
