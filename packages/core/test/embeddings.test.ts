/**
 * SQ4: real local embeddings — offline loading, determinism, persistence,
 * warm-start reuse, and graceful degradation when the model is unavailable.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionHub } from "../dist/action-hub.js";
import { Catalog } from "../dist/catalog/catalog.js";
import { SearchEngine } from "../dist/search/search.js";
import { EmbeddingSemanticIndex } from "../dist/search/embeddings.js";
import type { ActionRecord } from "../dist/types.js";
import { FakeClient, makeFactory } from "./fakes.ts";

const servers = [
  { id: "acme", transport: { type: "stdio", command: "acme-mcp" }, trust: "trusted" },
] as const;

class EmbeddingFakeClient extends FakeClient {}

function buildClients() {
  return {
    acme: new EmbeddingFakeClient([
      { name: "pause_project", description: "Pauses the project until further notice.", inputSchema: { type: "object" } },
      { name: "enable_project", description: "Enables the project for all users.", inputSchema: { type: "object" } },
      { name: "disable_user", description: "Disables the user account and revokes sessions.", inputSchema: { type: "object" } },
    ]),
  };
}

function record(id: string, description: string): ActionRecord {
  const [serverId, name] = id.split(":");
  return {
    id,
    kind: "tool",
    serverId,
    name,
    summary: description.slice(0, 160),
    description,
    tags: [],
    trust: "trusted",
  };
}

test("embedding index loads offline from the vendored model and is deterministic", async () => {
  const index = new EmbeddingSemanticIndex();
  assert.equal(await index.load(), true);
  const records = [record("acme:pause_project", "Pauses the project until further notice.")];
  const embedded = await index.index(records);
  assert.equal(embedded, 1);
  assert.equal(index.ready, true);

  const a = await index.embedQuery("hold the project");
  const b = await index.embedQuery("hold the project");
  assert.equal(a.length, 384);
  assert.deepEqual([...a], [...b]);

  // normalization + a sanity cosine: identical text vs unrelated text
  const unrelated = await index.embedQuery("kubernetes rollback canary cluster");
  let same = 0;
  let other = 0;
  for (let i = 0; i < a.length; i += 1) {
    same += a[i]! * b[i]!;
    other += a[i]! * unrelated[i]!;
  }
  assert.ok(Math.abs(same - 1) < 0.01, `self-cosine ${same}`);
  assert.ok(other < same, "unrelated text must not out-score identity");
});

test("persisted vectors round-trip and warm-start reuses them (no re-embed)", async () => {
  const index = new EmbeddingSemanticIndex();
  await index.load();
  const records = [
    record("acme:pause_project", "Pauses the project until further notice."),
    record("acme:disable_user", "Disables the user account and revokes sessions."),
  ];
  await index.index(records);
  const persisted = index.toPersisted();
  assert.equal(persisted.modelId, "Xenova/all-MiniLM-L6-v2");
  assert.equal(Object.keys(persisted.vectors).length, 2);

  const warm = new EmbeddingSemanticIndex();
  assert.equal(warm.hydrate(persisted), 2);
  // Nothing to re-embed for unchanged documents.
  const embedded = await warm.index(records);
  assert.equal(embedded, 0);

  // Changed text re-embeds only that document.
  const changed = [...records, record("acme:disable_user", "Completely different text now.")];
  const reembedded = await warm.index(changed);
  assert.equal(reembedded, 1);

  // Mismatched modelId is rejected on hydrate.
  assert.equal(warm.hydrate({ ...persisted, modelId: "other/model" }), 0);
});

test("scorer degrades to zeros for documents without vectors and stays in [0,1]", async () => {
  const index = new EmbeddingSemanticIndex();
  await index.load();
  await index.index([record("acme:pause_project", "Pauses the project.")]);
  const scorer = index.asScorer();
  const scores = await scorer("hold the project", [
    record("acme:pause_project", "Pauses the project."),
    record("acme:enable_project", "Enables the project."),
  ]);
  assert.equal(scores.length, 2);
  assert.ok(scores[0]! > 0);
  assert.equal(scores[1], 0);
});

test("hub with an unloadable model still searches (fallback) and warns", async () => {
  const warnings: string[] = [];
  const clients = buildClients();
  const { factory } = makeFactory(clients);
  const hub = new ActionHub({
    servers: [...servers],
    clientFactory: factory,
    embeddings: {
      modelPath: "/nonexistent/vendor/models",
      onWarning: (message) => warnings.push(message),
    },
  });
  const results = await hub.indexAll();
  await hub.semanticReady();
  assert.equal(results.every((result) => !result.error), true);
  // The fallback scorer path materializes the hashed index; search works.
  const hits = await hub.search("pause project");
  assert.ok(hits.length > 0, "search must still return hits after fallback");
  assert.ok(warnings.some((w) => w.includes("falling back")), `warning emitted: ${JSON.stringify(warnings)}`);
});

test("hub with embeddings finds the paraphrase and never demotes exact names", async () => {
  const clients = buildClients();
  const { factory } = makeFactory(clients);
  const hub = new ActionHub({
    servers: [...servers],
    clientFactory: factory,
    embeddings: {},
  });
  const results = await hub.indexAll();
  await hub.semanticReady();
  assert.equal(results.every((result) => !result.error), true);
  const hits = await hub.search("hold the project until we hear back");
  assert.equal(hits[0].id, "acme:pause_project");

  // Exact-name lookup: the literal name must stay rank 1.
  const exact = await hub.search("disable_user");
  assert.equal(exact[0].id, "acme:disable_user");
});
