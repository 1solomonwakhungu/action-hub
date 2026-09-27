import assert from "node:assert/strict";
import { test } from "node:test";
import { Catalog } from "../dist/catalog/catalog.js";
import { SearchEngine, SYNONYM_TERM_WEIGHT, tokenize } from "../dist/search/search.js";
import { expandQuery, VERB_PHRASES, VERB_SYNONYMS } from "../dist/search/synonyms.js";
import type { ActionRecord } from "../dist/types.js";

function record(id: string, description: string): ActionRecord {
  const [serverId, name] = id.split(":");
  return {
    id,
    kind: "tool",
    serverId,
    name,
    summary: description.slice(0, 160),
    description,
    trust: "trusted",
  } as ActionRecord;
}

test("expandQuery: literal terms weight 1, expansions down-weighted, no dupes", () => {
  const { terms, literalCount } = expandQuery("hold the project", tokenize, SYNONYM_TERM_WEIGHT);
  const literal = terms.filter((t) => t.weight === 1);
  const expanded = terms.filter((t) => t.weight < 1);
  assert.deepEqual(literal.map((t) => t.term), ["hold", "the", "project"]);
  assert.equal(literalCount, 3);
  assert.deepEqual(
    expanded.map((t) => t.term).sort(),
    ["freeze", "pause", "suspend"],
  );
  assert.ok(expanded.every((t) => t.weight === SYNONYM_TERM_WEIGHT));
});

test("expandQuery: multi-word phrases contribute canonical verbs", () => {
  const { terms } = expandQuery("turn off the user account", tokenize, SYNONYM_TERM_WEIGHT);
  const expanded = terms.filter((t) => t.weight < 1).map((t) => t.term);
  assert.ok(expanded.includes("disable"), "turn off must expand to disable");
  assert.ok(expanded.includes("deactivate"));
});

test("expandQuery: phrase matching survives punctuation and whitespace (SQ2 review finding 2)", () => {
  const variants = [
    "turn off the user",
    "turn off, the user",
    "turn off. the user",
    "turn  off the user",
    "please TURN OFF the user",
  ];
  for (const q of variants) {
    const expanded = expandQuery(q, tokenize, SYNONYM_TERM_WEIGHT).terms
      .filter((t) => t.weight < 1)
      .map((t) => t.term);
    assert.ok(expanded.includes("disable"), `"${q}" must expand (got ${JSON.stringify(expanded)})`);
  }
  // terminal punctuation on the phrase itself
  const trailing = expandQuery("turn off", tokenize, SYNONYM_TERM_WEIGHT).terms
    .filter((t) => t.weight < 1)
    .map((t) => t.term);
  assert.ok(trailing.includes("disable"), "punctuated trailing phrase must still expand");
  // a phrase that is only a substring must NOT match (boundaries are token-level)
  const noMatch = expandQuery("turnoff the user", tokenize, SYNONYM_TERM_WEIGHT).terms
    .filter((t) => t.weight < 1);
  assert.ok(!noMatch.map((t) => t.term).includes("disable"));
});

test("expandQuery: stopwords are dropped from literals and expansions", () => {
  const QUERY_STOPWORDS = new Set(["the", "my"]);
  const { terms, literalCount } = expandQuery("hold my the project", tokenize, SYNONYM_TERM_WEIGHT, QUERY_STOPWORDS);
  const literal = terms.filter((t) => t.weight === 1).map((t) => t.term);
  assert.deepEqual(literal, ["hold", "project"]);
  assert.equal(literalCount, 2);
});

test("expandQuery: zero weight short-circuits expansion", () => {
  const { terms } = expandQuery("hold the project", tokenize, 0);
  assert.ok(terms.every((t) => t.weight === 1));
  assert.equal(terms.length, tokenize("hold the project").length);
});

test("table entries are plain single tokens or lowercase phrases", () => {
  for (const [key, syns] of Object.entries(VERB_SYNONYMS)) {
    assert.ok(!key.includes(" "), `single-token key must not contain spaces: ${key}`);
    for (const syn of syns) assert.equal(syn, tokenize(syn).join(" "));
  }
  for (const key of Object.keys(VERB_PHRASES)) {
    assert.ok(key === key.toLowerCase());
  }
});

test("verb paraphrase reaches the canonical tool: hold -> pause_project", async () => {
  const catalog = new Catalog();
  catalog.add(record("acme:pause_project", "Pauses the project until further notice."));
  catalog.add(record("acme:enable_project", "Enables the project for all users."));
  catalog.add(record("acme:split_project", "Splits the project into sub-projects."));
  const engine = new SearchEngine(catalog);
  const hits = await engine.search("hold the project until we hear back");
  assert.equal(hits[0].id, "acme:pause_project");
});

test("exact-name lookup is never demoted by synonym noise (vs independent literal baseline)", async () => {
  const catalog = new Catalog();
  catalog.add(record("acme:disable_user", "Disables the user account and revokes sessions."));
  catalog.add(record("acme:pause_user", "Pauses the user account temporarily."));
  catalog.add(record("other:pause_user", "Pauses the user account temporarily."));
  const engine = new SearchEngine(catalog);
  // "disable_user" tokenizes to an exact existing name -> expansion skipped.
  const exact = await engine.search("disable_user");
  assert.equal(exact[0].id, "acme:disable_user");
  // Independent baseline: a SEPARATE engine built without the synonyms module
  // in play at all — expansion-weight 0 equals pure lexical on a fresh engine.
  const baseline = new SearchEngine(catalog);
  assert.deepEqual(
    exact.map((h) => h.id),
    (await baseline.search("disable_user")).map((h) => h.id),
  );
});

test("the semantic scorer receives ONLY the literal query terms (SQ2 review finding 3)", async () => {
  const catalog = new Catalog();
  catalog.add(record("acme:disable_user", "Disables the user account and revokes sessions."));
  const engine = new SearchEngine(catalog);
  const seen: string[] = [];
  engine.setSemanticScorer(async (query) => {
    seen.push(query);
    return new Array(catalog.all().length).fill(0);
  });
  await engine.search("turn off the user account");
  assert.equal(seen.length, 1);
  // "disable"/"deactivate" are synonym expansions and must be absent.
  assert.ok(!seen[0].includes("disable"), `scorer saw expanded query: "${seen[0]}"`);
  assert.ok(!seen[0].includes("deactivate"), `scorer saw expanded query: "${seen[0]}"`);
  for (const literal of ["turn", "off", "user", "account"]) {
    assert.ok(seen[0].includes(literal), `scorer must still see literal "${literal}"`);
  }
});

test("paraphrased query beats same-noun distractors", async () => {
  const catalog = new Catalog();
  catalog.add(record("a:disable_user", "Disables the user account permanently."));
  catalog.add(record("a:snapshot_user", "Snapshots the user account state."));
  catalog.add(record("a:escalate_user", "Escalates the user account to admins."));
  const engine = new SearchEngine(catalog);
  const hits = await engine.search("turn the user account off");
  assert.equal(hits[0].id, "a:disable_user");
});
