import assert from "node:assert/strict";
import { test } from "node:test";
import { Catalog } from "../dist/catalog/catalog.js";
import { DEFAULT_SEMANTIC_WEIGHT, SearchEngine } from "../dist/search/search.js";
import { LocalSemanticIndex, createLocalSemanticScorer } from "../dist/search/semantic.js";
import type { ActionRecord } from "../dist/types.js";

function record(
  id: string,
  name: string,
  summary: string,
  description?: string,
  tags?: string[],
): ActionRecord {
  const serverId = id.split(":")[0] ?? "server";
  return {
    id,
    kind: "tool",
    serverId,
    name,
    summary,
    description,
    tags,
    trust: "trusted",
  } as ActionRecord;
}

/**
 * A catalog with several same-server actions, so a win has to come from
 * ranking rather than from there being only one plausible answer.
 */
function corpus(): ActionRecord[] {
  return [
    record(
      "github:create_pull_request",
      "create_pull_request",
      "Open a pull request from a head branch into a base branch.",
      "Creates a pull request so teammates can review proposed changes before they merge.",
      ["git", "review"],
    ),
    record(
      "github:merge_pull_request",
      "merge_pull_request",
      "Merge an open pull request once review has completed.",
      "Squashes or rebases the pull request branch into the base branch after approval.",
      ["git"],
    ),
    record(
      "github:list_issues",
      "list_issues",
      "List issues in a repository filtered by label and state.",
      "Returns open or closed issues for the given repository.",
      ["issues"],
    ),
    record(
      "linear:list_my_issues",
      "list_my_issues",
      "List issues assigned to the current user.",
      "Returns the tasks assigned to you that are still in progress.",
      ["issues", "tasks"],
    ),
    record(
      "slack:post_message",
      "post_message",
      "Post a message to a Slack channel.",
      "Sends a chat message to a channel or a direct conversation.",
      ["chat"],
    ),
    record(
      "pagerduty:trigger_incident",
      "trigger_incident",
      "Trigger an incident and page the on-call responder.",
      "Alerts the on-call engineer that production is degraded.",
      ["alerting"],
    ),
    record(
      "ec2:stop_instance",
      "stop_instance",
      "Stop a running EC2 instance.",
      "Halts the instance while preserving its attached volumes.",
      ["compute"],
    ),
    record(
      "ec2:start_instance",
      "start_instance",
      "Start a stopped EC2 instance.",
      "Boots the instance and waits until it passes health checks.",
      ["compute"],
    ),
    record(
      "s3:put_object",
      "put_object",
      "Upload an object into a storage bucket.",
      "Stores a file in the configured bucket at the given key.",
      ["storage"],
    ),
    record(
      "s3:delete_object",
      "delete_object",
      "Delete an object from a storage bucket.",
      "Removes the file stored at the given key.",
      ["storage"],
    ),
  ];
}

function engines(): { lexical: SearchEngine; blended: SearchEngine } {
  const records = corpus();
  const catalog = new Catalog();
  catalog.addAll(records);
  const lexical = new SearchEngine(catalog);
  const blended = new SearchEngine(catalog);
  blended.setSemanticScorer(createLocalSemanticScorer(records));
  return { lexical, blended };
}

async function topId(engine: SearchEngine, query: string): Promise<string | undefined> {
  const hits = await engine.search(query);
  return hits[0]?.id;
}

// Each of these is a query whose wording shares no useful term with the target
// action, so BM25 has nothing to match on.
const PARAPHRASES: [string, string][] = [
  ["turn off a virtual machine", "ec2:stop_instance"],
  ["boot up a server", "ec2:start_instance"],
  ["what am i supposed to be working on", "linear:list_my_issues"],
];

for (const [query, expected] of PARAPHRASES) {
  test(`semantic scoring resolves the paraphrase ${JSON.stringify(query)}`, async () => {
    const { lexical, blended } = engines();

    assert.notEqual(
      await topId(lexical, query),
      expected,
      "expected pure BM25 to miss this paraphrase; if it now succeeds the case no longer tests anything",
    );
    assert.equal(await topId(blended, query), expected);
  });
}

// Morphology: BM25 treats "messaging" and "message" as unrelated tokens.
const MORPHOLOGY: [string, string][] = [
  ["messaging", "slack:post_message"],
  ["uploading", "s3:put_object"],
  ["deletion", "s3:delete_object"],
  ["merging", "github:merge_pull_request"],
];

for (const [query, expected] of MORPHOLOGY) {
  test(`semantic scoring matches the morphological variant ${JSON.stringify(query)}`, async () => {
    const { lexical, blended } = engines();

    assert.notEqual(await topId(lexical, query), expected);
    assert.equal(await topId(blended, query), expected);
  });
}

test("semantic scoring does not regress exact name matches", async () => {
  const { blended } = engines();
  const exact: [string, string][] = [
    ["create pull request", "github:create_pull_request"],
    ["merge pull request", "github:merge_pull_request"],
    ["stop instance", "ec2:stop_instance"],
    ["start instance", "ec2:start_instance"],
    ["delete object", "s3:delete_object"],
  ];

  for (const [query, expected] of exact) {
    assert.equal(await topId(blended, query), expected, `query: ${query}`);
  }
});

test("a scorer that throws falls back to pure BM25 instead of failing the search", async () => {
  const records = corpus();
  const catalog = new Catalog();
  catalog.addAll(records);

  const engine = new SearchEngine(catalog);
  const baseline = await new SearchEngine(catalog).search("create pull request");

  engine.setSemanticScorer(async () => {
    throw new Error("embedding backend unavailable");
  });

  const hits = await engine.search("create pull request");
  assert.deepEqual(
    hits.map((hit) => hit.id),
    baseline.map((hit) => hit.id),
  );
  assert.deepEqual(
    hits.map((hit) => hit.score),
    baseline.map((hit) => hit.score),
  );
});

test("a scorer that rejects asynchronously also falls back", async () => {
  const catalog = new Catalog();
  catalog.addAll(corpus());
  const engine = new SearchEngine(catalog);
  engine.setSemanticScorer(() => Promise.reject(new Error("timeout")));

  const hits = await engine.search("stop instance");
  assert.equal(hits[0]?.id, "ec2:stop_instance");
});

test("malformed scorer output is ignored rather than corrupting ranking", async () => {
  const catalog = new Catalog();
  catalog.addAll(corpus());

  const shapes: unknown[] = [
    undefined,
    null,
    "not an array",
    [Number.NaN, Number.NaN],
    [Number.POSITIVE_INFINITY],
    [],
  ];

  for (const shape of shapes) {
    const engine = new SearchEngine(catalog);
    engine.setSemanticScorer((async () => shape) as never);
    const hits = await engine.search("delete object");
    assert.equal(hits[0]?.id, "s3:delete_object", `shape: ${JSON.stringify(shape)}`);
    for (const hit of hits) assert.ok(Number.isFinite(hit.score));
  }
});

test("out-of-range semantic scores are clamped into [0, 1]", async () => {
  const catalog = new Catalog();
  catalog.addAll(corpus());
  const engine = new SearchEngine(catalog);
  engine.setSemanticScorer(async (_query, candidates) => candidates.map(() => 1000));

  const hits = await engine.search("stop instance");
  for (const hit of hits) assert.ok(hit.score >= 0 && hit.score <= 1, `score: ${hit.score}`);
});

test("scores are normalized into [0, 1] and index-aligned with candidates", () => {
  const records = corpus();
  const index = new LocalSemanticIndex();
  index.index(records);

  const scores = index.score("turn off a virtual machine", records);
  assert.equal(scores.length, records.length);
  for (const score of scores) {
    assert.ok(Number.isFinite(score));
    assert.ok(score >= 0 && score <= 1, `score out of range: ${score}`);
  }

  const stopIndex = records.findIndex((r) => r.id === "ec2:stop_instance");
  const bestIndex = scores.indexOf(Math.max(...scores));
  assert.equal(bestIndex, stopIndex);
});

test("indexing is deterministic across separate instances", () => {
  const records = corpus();
  const first = new LocalSemanticIndex();
  const second = new LocalSemanticIndex();
  first.index(records);
  second.index(records);

  assert.deepEqual(
    first.score("boot up a server", records),
    second.score("boot up a server", records),
  );
});

test("an empty query and an empty catalog are safe", () => {
  const index = new LocalSemanticIndex();
  index.index([]);
  assert.deepEqual(index.score("anything", []), []);
  assert.equal(index.stats().documents, 0);

  const records = corpus();
  index.index(records);
  assert.deepEqual(
    index.score("", records),
    records.map(() => 0),
  );
});

test("a record added after indexing is embedded on demand rather than scored zero", () => {
  const records = corpus();
  const index = new LocalSemanticIndex();
  index.index(records);

  const added = record(
    "ec2:reboot_instance",
    "reboot_instance",
    "Reboot a running EC2 instance.",
    "Restarts the instance in place.",
    ["compute"],
  );

  const scores = index.score("restart the machine", [...records, added]);
  assert.ok((scores.at(-1) ?? 0) > 0);
});

test("a zero blend weight disables the semantic signal entirely", async () => {
  const records = corpus();
  const catalog = new Catalog();
  catalog.addAll(records);

  const engine = new SearchEngine(catalog);
  engine.setSemanticScorer(createLocalSemanticScorer(records));
  engine.setSemanticWeight(0);

  const baseline = await new SearchEngine(catalog).search("messaging");
  const hits = await engine.search("messaging");
  assert.deepEqual(
    hits.map((hit) => hit.id),
    baseline.map((hit) => hit.id),
  );
});

test("the blend weight is clamped and rejects non-finite values", () => {
  const catalog = new Catalog();
  const engine = new SearchEngine(catalog);

  engine.setSemanticWeight(5);
  assert.equal(engine.semanticWeight, 1);
  engine.setSemanticWeight(-2);
  assert.equal(engine.semanticWeight, 0);
  engine.setSemanticWeight(Number.NaN);
  assert.equal(engine.semanticWeight, DEFAULT_SEMANTIC_WEIGHT);
});

test("custom concepts extend the built-in lexicon", () => {
  const records = [
    record("infra:cordon_node", "cordon_node", "Cordon a Kubernetes node.", "Marks it unschedulable."),
    record("slack:post_message", "post_message", "Post a message to a Slack channel."),
  ];

  const plain = new LocalSemanticIndex();
  plain.index(records);

  const extended = new LocalSemanticIndex({ concepts: { drain: ["cordon", "quarantine", "evict"] } });
  extended.index(records);

  // "evict" shares no substring with "cordon", so only the concept link can
  // connect them; the built-in lexicon has no such entry.
  const before = plain.score("evict", records)[0] ?? 0;
  const after = extended.score("evict", records)[0] ?? 0;
  assert.ok(after > before * 2, `expected concept to help: ${before} -> ${after}`);
});
