import assert from "node:assert/strict";
import { test } from "node:test";
import { Catalog } from "../dist/catalog/catalog.js";
import { SearchEngine, tokenize, QUERY_STOPWORDS, MAX_DOCUMENT_TOKENS } from "../dist/search/search.js";
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

test("tokenize is unicode-aware: emoji, accents, and RTL names survive", () => {
  // Emoji is kept as a token (Extended_Pictographic), not dropped.
  assert.deepEqual(tokenize("deploy_\u{1F680}_rocket"), ["deploy", "\u{1F680}", "rocket"]);
  // Accented letters are letters, not separators.
  assert.deepEqual(tokenize("créer un ticket"), ["créer", "un", "ticket"]);
  // RTL text tokenizes instead of vanishing.
  assert.deepEqual(tokenize("מרחב_tool"), ["מרחב", "tool"]);
  // Zero-width characters cannot glue tokens together.
  assert.deepEqual(tokenize("zero\u200Bwidth_name"), ["zero", "width", "name"]);
});

test("emoji-named tools are findable by the emoji", async () => {
  const catalog = new Catalog();
  catalog.addAll([
    record({ id: "rocket:deploy", name: "deploy_\u{1F680}_rocket", summary: "Ship the release" }),
    record({ id: "github:list_issues", name: "list_issues", summary: "List issues" }),
  ]);
  const engine = new SearchEngine(catalog);
  const hits = await engine.search("\u{1F680}");
  assert.equal(hits[0]?.id, "rocket:deploy");
});

test("query-side stopwords are filtered from the query, not from documents", async () => {
  const engine = new SearchEngine(seeded());
  // "the" adds no signal; the content words still rank the exact tool first.
  const hits = await engine.search("the create pull request");
  assert.equal(hits[0]?.id, "github:create_pull_request");
  // A pure-stopword query degrades to a browse request (stable slice), not an error.
  const browse = await engine.search("the of and");
  assert.equal(browse.length > 0, true);
});

test("QUERY_STOPWORDS never intersects the concept lexicon anchors", async () => {
  const { DEFAULT_CONCEPTS } = await import("../dist/search/semantic.js");
  const anchors = new Set(Object.values(DEFAULT_CONCEPTS).flat());
  for (const stopword of QUERY_STOPWORDS) {
    assert.equal(anchors.has(stopword), false, `stopword "${stopword}" is a concept anchor`);
  }
});

test("huge descriptions are capped per record and search stays responsive", async () => {
  const catalog = new Catalog();
  catalog.addAll([
    record({ id: "big:tool", name: "big_tool", summary: "A big tool" }),
    record({
      id: "big:flooded",
      name: "flooded_tool",
      summary: "Flooded tool",
      description: Array.from({ length: 20_000 }, (_, i) => `word${i}`).join(" "),
    }),
  ]);
  const engine = new SearchEngine(catalog);
  const hits = await engine.search("big tool");
  assert.equal(hits[0]?.id, "big:tool");
  assert.equal(MAX_DOCUMENT_TOKENS, 2048);
});

test("minScoreRatio trims weak hits relative to the best score", async () => {
  const engine = new SearchEngine(seeded());
  const all = await engine.search("create");
  const trimmed = await engine.search("create", { minScoreRatio: 0.9 });
  assert.ok(all.length >= trimmed.length);
  if (all.length > 1) {
    assert.ok(trimmed.length < all.length || trimmed[0]!.score >= all[0]!.score * 0.9);
  }
  assert.equal((await engine.search("create", { minScoreRatio: 0 })).length, all.length);
  // Out-of-range ratios are ignored (fall back to no cutoff).
  assert.equal((await engine.search("create", { minScoreRatio: 1.5 })).length, all.length);
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

test("intent-bearing quantifiers keep the exact name ranked above its near-duplicate (F5 rework)", async () => {
  // Reviewer-1 repros: filtering quantifiers (all/any/only/same) let a
  // keyword-collision near-duplicate outrank the EXACT name. The ranking
  // invariant is that an exact name wins its own query.
  const catalog = new Catalog();
  catalog.addAll(
    [
      ...["delete_all_users", "delete_users"],
      ...["show_only_active_users", "show_active_users"],
      ...["find_any_open_ticket", "find_open_ticket"],
      ...["compare_same_branch", "compare_branch"],
    ].map((name) => record({ id: `ops:${name}`, name, summary: "" })),
  );
  const engine = new SearchEngine(catalog);
  const cases: Array<[string, string]> = [
    ["delete all users", "delete_all_users"],
    ["show only active users", "show_only_active_users"],
    ["find any open ticket", "find_any_open_ticket"],
    ["compare same branch", "compare_same_branch"],
  ];
  for (const [query, exact] of cases) {
    const hits = await engine.search(query);
    assert.equal(hits[0]?.id, `ops:${exact}`, `query "${query}" must rank the exact name first`);
    const rival = hits.find((h) => h.id !== `ops:${exact}`);
    assert.ok(
      (hits[0]?.score ?? 0) > (rival?.score ?? 0),
      `exact "${exact}" must strictly outrank its near-duplicate for "${query}"`,
    );
  }
});
