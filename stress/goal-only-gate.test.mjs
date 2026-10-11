/**
 * stress/goal-only-gate.test.mjs: unit tests for the goal-only gate's pure
 * parts (row selection, metrics, floors). No corpus or dist build needed.
 * Run: node --test stress/goal-only-gate.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { __test } from "./goal-only-gate.mjs";

const { selectGoalOnlyRows, rankOf, scoreRanks, checkFloors, parseEngines, GOAL_ONLY_FLOORS, GOAL_ONLY_ROWS } = __test;
const here = fileURLToPath(new URL(".", import.meta.url));

function goalRows(n = GOAL_ONLY_ROWS) {
  return Array.from({ length: n }, (_, i) => ({
    query: `goal query ${i}`,
    expected: `srv:tool_${i}`,
    subtype: "goal-only",
    difficulty: "hard",
  }));
}

test("the committed fixture carries exactly the gated goal-only band, all well-formed", () => {
  const fixture = JSON.parse(readFileSync(join(here, "fixtures", "realistic-queries.json"), "utf8"));
  const rows = selectGoalOnlyRows(fixture);
  assert.equal(rows.length, GOAL_ONLY_ROWS);
  for (const row of rows) assert.equal(row.difficulty, "hard");
});

test("row selection ignores other subtypes and fails closed on count, shape, and missing golds", () => {
  const extra = [{ query: "paraphrase row", expected: "srv:x", subtype: "paraphrase", difficulty: "paraphrase" }];
  assert.equal(selectGoalOnlyRows([...goalRows(), ...extra]).length, GOAL_ONLY_ROWS);
  assert.throws(() => selectGoalOnlyRows(goalRows(GOAL_ONLY_ROWS - 1)), /expected exactly 30/);
  assert.throws(() => selectGoalOnlyRows(goalRows(GOAL_ONLY_ROWS + 1)), /expected exactly 30/);
  assert.throws(() => selectGoalOnlyRows("nope"), /not a JSON array/);

  const wrongDifficulty = goalRows();
  wrongDifficulty[3].difficulty = "paraphrase";
  assert.throws(() => selectGoalOnlyRows(wrongDifficulty), /difficulty "hard"/);

  const multiGold = goalRows();
  multiGold[0].expectedAll = ["a", "b"];
  assert.throws(() => selectGoalOnlyRows(multiGold), /no expectedAll/);

  const nullGold = goalRows();
  nullGold[0].expected = null;
  assert.throws(() => selectGoalOnlyRows(nullGold), /non-empty gold/);

  const duplicate = goalRows();
  duplicate[1].query = duplicate[0].query;
  assert.throws(() => selectGoalOnlyRows(duplicate), /duplicate goal-only query/);

  const ids = new Set(goalRows().map((row) => row.expected));
  assert.equal(selectGoalOnlyRows(goalRows(), ids).length, GOAL_ONLY_ROWS);
  ids.delete("srv:tool_7");
  assert.throws(() => selectGoalOnlyRows(goalRows(), ids), /absent from the corpus: srv:tool_7/);
});

test("rankOf is 1-based and null when the gold is not retrieved", () => {
  assert.equal(rankOf(["a", "b", "c"], "a"), 1);
  assert.equal(rankOf(["a", "b", "c"], "c"), 3);
  assert.equal(rankOf(["a", "b", "c"], "z"), null);
  assert.equal(rankOf([], "a"), null);
});

test("scoreRanks computes recall@1/5/10 and MRR@10 from ranks", () => {
  const metrics = scoreRanks([{ rank: 1 }, { rank: 4 }, { rank: 10 }, { rank: 11 }, { rank: null }]);
  assert.equal(metrics.n, 5);
  assert.equal(metrics.recallAt1, 0.2);
  assert.equal(metrics.recallAt5, 0.4);
  assert.equal(metrics.recallAt10, 0.6);
  // (1 + 1/4 + 1/10 + 0 + 0) / 5; rank 11 is outside the @10 window.
  assert.equal(metrics.mrrAt10, Number(((1 + 0.25 + 0.1) / 5).toFixed(4)));
  assert.deepEqual(scoreRanks([]), { n: 0, recallAt1: 0, recallAt5: 0, recallAt10: 0, mrrAt10: 0 });
});

test("checkFloors passes only when every committed floor holds", () => {
  const good = { recallAt5: 0.5, recallAt10: 0.6, mrrAt10: 0.4 };
  assert.equal(checkFloors("keyword", good).pass, true);
  const low = { ...good, mrrAt10: GOAL_ONLY_FLOORS.keyword.mrrAt10 - 0.01 };
  const verdict = checkFloors("keyword", low);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.checks.mrrAt10.pass, false);
  assert.equal(verdict.checks.recallAt5.pass, true);
  assert.equal(checkFloors("keyword", { recallAt5: 0.5, recallAt10: 0.6 }).pass, false, "a missing metric fails closed");
  assert.throws(() => checkFloors("bogus", good), /no committed floors/);
});

test("floors exist for every engine and sit at or below one query of slack from a perfect score", () => {
  for (const engine of ["keyword", "hashed", "embeddings"]) {
    const floor = GOAL_ONLY_FLOORS[engine];
    assert.ok(floor, `floors for ${engine}`);
    for (const value of Object.values(floor)) assert.ok(value > 0 && value < 1, `${engine} floor ${value} is a proportion`);
    assert.ok(floor.recallAt10 >= floor.recallAt5, `${engine}: recall@10 floor cannot be below recall@5`);
  }
});

test("parseEngines defaults to the fast engines, dedups, and rejects unknown names", () => {
  assert.deepEqual(parseEngines(undefined), ["keyword", "hashed"]);
  assert.deepEqual(parseEngines("hashed,keyword,hashed"), ["hashed", "keyword"]);
  assert.deepEqual(parseEngines("embeddings"), ["embeddings"]);
  assert.throws(() => parseEngines("bm25"), /unknown engine/);
  assert.throws(() => parseEngines(" , "), /at least one engine/);
});
