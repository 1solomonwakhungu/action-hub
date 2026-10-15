import assert from "node:assert/strict";
import { test } from "node:test";
import { Catalog } from "../dist/catalog/catalog.js";
import { QUERY_STOPWORDS, SearchEngine, tokenize } from "../dist/search/search.js";
import { VERB_PHRASES, VERB_SYNONYMS } from "../dist/search/synonyms.js";
import { catalogVerbs, MAX_REWRITE_VERBS, rewriteGoalQuery } from "../dist/search/query-rewrite.js";
import type { ActionRecord } from "../dist/types.js";

function record(id: string, description: string, kind: "tool" | "skill" = "tool"): ActionRecord {
  const [serverId, name] = id.split(":");
  return {
    id,
    kind,
    serverId,
    name,
    summary: description.slice(0, 160),
    description,
    trust: "trusted",
  } as ActionRecord;
}

const TABLES = { tokenize, stopwords: QUERY_STOPWORDS, phrases: VERB_PHRASES, synonyms: VERB_SYNONYMS };

function onboardingCatalog(): Catalog {
  const catalog = new Catalog();
  catalog.addAll([
    record("crm:reject_onboarding", "Rejects the onboarding request."),
    record("crm:get_onboarding", "Gets the onboarding request with its request history."),
    record("crm:list_onboarding", "Lists onboarding requests in the request queue."),
    record("crm:approve_onboarding", "Approves the onboarding request."),
    record("crm:disable_account", "Disables the account."),
    record("crm:freeze_sku", "Freezes the sku."),
    record("crm:delete_sku", "Deletes the sku."),
  ]);
  return catalog;
}

test("catalogVerbs: first name token of tool records only", () => {
  const verbs = catalogVerbs(
    [
      record("a:reject_onboarding", "x"),
      record("a:getUser", "x"),
      record("skills:deploy-guide", "x", "skill"),
    ],
    tokenize,
  );
  assert.deepEqual([...verbs].sort(), ["get", "reject"]);
});

test("rewriteGoalQuery: phrase maps to catalog verbs only, objects keep the rest", () => {
  const rewrite = rewriteGoalQuery("turn down that onboarding request", new Set(["reject", "get"]), TABLES);
  assert.ok(rewrite);
  // VERB_PHRASES["turn down"] = reject, decline; "decline" is not a catalog verb.
  assert.deepEqual(rewrite.addedVerbs, ["reject"]);
  assert.deepEqual(rewrite.objectTerms, ["onboarding", "request"]);
  assert.equal(rewrite.toolQuery, "reject onboarding request");
  assert.equal(rewrite.appendedQuery, "turn down that onboarding request reject");
  assert.deepEqual(rewrite.sources, ["phrase:turn down"]);
});

test("rewriteGoalQuery: raw query is a prefix of the appended form (never replaced)", () => {
  const query = "hold the mislabeled sku";
  const rewrite = rewriteGoalQuery(query, new Set(["freeze", "pause"]), TABLES);
  assert.ok(rewrite);
  assert.ok(rewrite.appendedQuery.startsWith(`${query} `));
  assert.deepEqual(rewrite.sources, ["synonym:hold"]);
});

test("rewriteGoalQuery: null when nothing new is implied", () => {
  const verbs = new Set(["reject", "freeze"]);
  // No table entry and no catalog verb.
  assert.equal(rewriteGoalQuery("take back the leaked secret", verbs, TABLES), null);
  // The only implied verb is already literal.
  assert.equal(rewriteGoalQuery("reject the onboarding request", verbs, TABLES), null);
  // Empty after stopwords, and an empty verb vocabulary.
  assert.equal(rewriteGoalQuery("the", verbs, TABLES), null);
  assert.equal(rewriteGoalQuery("turn down the request", new Set(), TABLES), null);
});

test("rewriteGoalQuery: caps the emitted verbs", () => {
  const verbs = new Set(["delete", "remove", "purge", "erase", "wipe"]);
  const rewrite = rewriteGoalQuery("get rid of the stale cache", verbs, TABLES);
  assert.ok(rewrite);
  assert.ok(rewrite.addedVerbs.length <= MAX_REWRITE_VERBS);
  assert.deepEqual(rewrite.objectTerms, ["stale", "cache"]);
});

test("SearchEngine: no queryRewrite option is the unchanged default path", async () => {
  const engine = new SearchEngine(onboardingCatalog());
  for (const query of ["turn down that onboarding request", "hold the mislabeled sku", "reject onboarding", ""]) {
    assert.deepEqual(
      await engine.search(query, { limit: 10 }),
      await engine.search(query, { limit: 10, queryRewrite: undefined }),
    );
  }
});

test("SearchEngine append: the implied catalog verb scores at full weight, other hits untouched", async () => {
  const engine = new SearchEngine(onboardingCatalog());
  const query = "turn down that onboarding request";
  const off = new Map((await engine.search(query, { limit: 5 })).map((hit) => [hit.id, hit.score]));
  const append = await engine.search(query, { limit: 5, queryRewrite: "append" });
  assert.equal(append[0]?.id, "crm:reject_onboarding");
  // Off already reaches "reject" through SQ2 expansion at half weight; append
  // makes it a literal term, so only the verb's own record gains score.
  assert.ok(append[0]!.score > off.get("crm:reject_onboarding")!);
  for (const hit of append.slice(1)) assert.equal(hit.score, off.get(hit.id), `${hit.id} must not move`);
});

test("SearchEngine fuse: every raw hit survives fusion and the raw query still ranks", async () => {
  const engine = new SearchEngine(onboardingCatalog());
  const query = "turn down that onboarding request";
  const raw = await engine.search(query, { limit: 50 });
  const fused = await engine.search(query, { limit: 50, queryRewrite: "fuse" });
  const fusedIds = new Set(fused.map((hit) => hit.id));
  for (const hit of raw) assert.ok(fusedIds.has(hit.id), `raw hit ${hit.id} dropped by fusion`);
  assert.equal(fused[0]?.id, "crm:reject_onboarding");
  for (let i = 1; i < fused.length; i += 1) assert.ok(fused[i - 1]!.score >= fused[i]!.score);
  assert.ok(fused.every((hit) => hit.score > 0 && hit.score <= 1));
});

test("SearchEngine rewrite: exact-name and no-rewrite queries take the single raw pass", async () => {
  const engine = new SearchEngine(onboardingCatalog());
  for (const mode of ["append", "fuse"] as const) {
    for (const query of ["delete sku", "take back the leaked secret"]) {
      assert.deepEqual(
        await engine.search(query, { limit: 10, queryRewrite: mode }),
        await engine.search(query, { limit: 10 }),
        `${mode} must not change "${query}"`,
      );
    }
  }
});

test("SearchEngine rewrite: honors limit and filters", async () => {
  const engine = new SearchEngine(onboardingCatalog());
  for (const mode of ["append", "fuse"] as const) {
    const hits = await engine.search("turn down that onboarding request", { limit: 2, queryRewrite: mode });
    assert.equal(hits.length, 2);
    const filtered = await engine.search("hold the mislabeled sku", { kind: "skill", queryRewrite: mode });
    assert.deepEqual(filtered, []);
  }
});
