import assert from "node:assert/strict";
import { test } from "node:test";
import { Catalog } from "../dist/catalog/catalog.js";
import { SearchEngine, tokenize } from "../dist/search/search.js";
import type { ActionRecord } from "../dist/types.js";

function record(partial: Partial<ActionRecord> & { id: string; name: string }): ActionRecord {
  return {
    kind: "tool",
    serverId: partial.serverId ?? "github",
    summary: partial.summary ?? "",
    trust: partial.trust ?? "trusted",
    ...partial,
  } as ActionRecord;
}

function seeded(): Catalog {
  const catalog = new Catalog();
  catalog.addAll([
    record({
      id: "github:create_pull_request",
      name: "create_pull_request",
      summary: "Open a new pull request against a branch",
    }),
    record({
      id: "github:list_issues",
      name: "list_issues",
      summary: "List issues in a repository",
    }),
    record({
      id: "linear:create_issue",
      name: "create_issue",
      serverId: "linear",
      summary: "Create a Linear issue in a team",
    }),
    record({
      id: "slack:post_message",
      name: "post_message",
      serverId: "slack",
      summary: "Send a message to a Slack channel",
      trust: "untrusted",
    }),
  ]);
  return catalog;
}

test("tokenize splits camelCase and punctuation", () => {
  assert.deepEqual(tokenize("createPullRequest"), ["create", "pull", "request"]);
  assert.deepEqual(tokenize("list_issues"), ["list", "issues"]);
});

test("ranks an exact name match above a description match", async () => {
  const engine = new SearchEngine(seeded());
  const hits = await engine.search("create pull request");
  assert.equal(hits[0]?.id, "github:create_pull_request");
});

test("search results never expose input schemas", async () => {
  const catalog = seeded();
  catalog.add(
    record({
      id: "github:with_schema",
      name: "with_schema",
      summary: "Has a schema",
      inputSchema: { type: "object", properties: { secret: { type: "string" } } },
    }),
  );
  const engine = new SearchEngine(catalog);
  const hits = await engine.search("schema");
  assert.ok(hits.length > 0);
  for (const hit of hits) {
    assert.equal("inputSchema" in hit, false);
    assert.equal("description" in hit, false);
  }
});

test("scopes results by server", async () => {
  const engine = new SearchEngine(seeded());
  const hits = await engine.search("issue", { serverIds: ["linear"] });
  assert.ok(hits.length > 0);
  assert.ok(hits.every((hit) => hit.serverId === "linear"));
});

test("filters below the minimum trust tier", async () => {
  const engine = new SearchEngine(seeded());
  const hits = await engine.search("message", { minTrust: "trusted" });
  assert.equal(hits.find((hit) => hit.serverId === "slack"), undefined);
});

test("respects the result limit", async () => {
  const engine = new SearchEngine(seeded());
  const hits = await engine.search("issue create list message", { limit: 2 });
  assert.equal(hits.length, 2);
});

test("an empty query browses the catalog instead of failing", async () => {
  const engine = new SearchEngine(seeded());
  const hits = await engine.search("", { limit: 3 });
  assert.equal(hits.length, 3);
});

test("an unmatched query returns no hits", async () => {
  const engine = new SearchEngine(seeded());
  assert.deepEqual(await engine.search("kubernetes helm chart"), []);
});

test("a semantic scorer reorders lexically weaker matches", async () => {
  const engine = new SearchEngine(seeded());
  const boosted = "linear:create_issue";
  engine.setSemanticScorer(async (_query, candidates) =>
    candidates.map((candidate) => (candidate.id === boosted ? 1 : 0)),
  );
  const hits = await engine.search("issue");
  assert.equal(hits[0]?.id, boosted);
});
