import assert from "node:assert/strict";
import { test } from "node:test";
import { EVAL_CORPUS } from "../eval/corpus.ts";
import { EVAL_QUERIES } from "../eval/queries.ts";
import {
  BASELINE,
  BAND_BASELINE,
  SEMANTIC_BASELINE,
  SEMANTIC_BAND_BASELINE,
} from "../eval/baseline.ts";
import { formatReport, metricsFor, runEval, runSemanticEval } from "../eval/evaluate.ts";

/**
 * The retrieval regression gate.
 *
 * Search quality is the product, so it is guarded like any other invariant.
 * These assertions fail when ranking gets worse, which is the entire point:
 * a regression should be caught by `npm test`, not discovered in use.
 */

const report = await runEval();
const semanticReport = await runSemanticEval();

test("the eval corpus is large and varied enough to be discriminating", () => {
  assert.ok(EVAL_CORPUS.length >= 60, `corpus has only ${EVAL_CORPUS.length} actions`);
  const servers = new Set(EVAL_CORPUS.map((record) => record.serverId));
  assert.ok(servers.size >= 10, `corpus spans only ${servers.size} servers`);

  const ids = new Set(EVAL_CORPUS.map((record) => record.id));
  assert.equal(ids.size, EVAL_CORPUS.length, "corpus contains duplicate action ids");

  // Name collisions across servers are what make the eval hard; without them
  // the corpus would flatter any ranker.
  const names = EVAL_CORPUS.map((record) => record.name);
  const collisions = names.filter((name, i) => names.indexOf(name) !== i);
  assert.ok(collisions.length > 0, "corpus has no cross-server name collisions");
});

test("every labeled query points at a real action", () => {
  const ids = new Set(EVAL_CORPUS.map((record) => record.id));
  for (const testCase of EVAL_QUERIES) {
    assert.ok(ids.has(testCase.expected), `unknown expected id: ${testCase.expected}`);
  }
});

test("the labeled set is large enough and covers every difficulty band", () => {
  assert.ok(EVAL_QUERIES.length >= 30, `only ${EVAL_QUERIES.length} labeled queries`);
  for (const band of ["exact", "paraphrase", "ambiguous"] as const) {
    const count = EVAL_QUERIES.filter((testCase) => testCase.difficulty === band).length;
    assert.ok(count >= 5, `band ${band} has only ${count} queries`);
  }
  const queries = EVAL_QUERIES.map((testCase) => testCase.query);
  assert.equal(new Set(queries).size, queries.length, "duplicate queries in the labeled set");
});

test("recall@1 has not regressed below the committed baseline", () => {
  assert.ok(
    report.overall.recallAt1 >= BASELINE.recallAt1,
    `recall@1 ${report.overall.recallAt1.toFixed(3)} is below the baseline ${BASELINE.recallAt1.toFixed(3)}\n` +
      formatReport(report),
  );
});

test("recall@5 has not regressed below the committed baseline", () => {
  assert.ok(
    report.overall.recallAt5 >= BASELINE.recallAt5,
    `recall@5 ${report.overall.recallAt5.toFixed(3)} is below the baseline ${BASELINE.recallAt5.toFixed(3)}\n` +
      formatReport(report),
  );
});

test("MRR has not regressed below the committed baseline", () => {
  assert.ok(
    report.overall.mrr >= BASELINE.mrr,
    `MRR ${report.overall.mrr.toFixed(3)} is below the baseline ${BASELINE.mrr.toFixed(3)}\n` +
      formatReport(report),
  );
});

test("no single difficulty band has collapsed", () => {
  for (const band of ["exact", "paraphrase", "ambiguous"] as const) {
    const measured = report.byDifficulty[band].recallAt1;
    assert.ok(
      measured >= BAND_BASELINE[band],
      `${band} recall@1 ${measured.toFixed(3)} is below its baseline ${BAND_BASELINE[band].toFixed(3)}\n` +
        formatReport(report),
    );
  }
});

test("the default semantic scorer materially improves retrieval", () => {
  assert.ok(semanticReport.overall.recallAt1 >= SEMANTIC_BASELINE.recallAt1, formatReport(semanticReport));
  assert.ok(semanticReport.overall.recallAt5 >= SEMANTIC_BASELINE.recallAt5, formatReport(semanticReport));
  assert.ok(semanticReport.overall.mrr >= SEMANTIC_BASELINE.mrr, formatReport(semanticReport));
  for (const band of ["exact", "paraphrase", "ambiguous"] as const) {
    assert.ok(
      semanticReport.byDifficulty[band].recallAt1 >= SEMANTIC_BAND_BASELINE[band],
      `${band} semantic recall@1 regressed\n${formatReport(semanticReport)}`,
    );
  }
  assert.ok(
    semanticReport.overall.recallAt1 > report.overall.recallAt1,
    `semantic recall@1 no longer improves BM25\n${formatReport(semanticReport)}`,
  );
});

test("exact-name queries resolve to the named action first", async () => {
  // A miss here is a tokenizer or name-weighting bug rather than a ranking
  // trade-off, so it is called out separately from the aggregate gate.
  const exact = report.outcomes.filter((outcome) => outcome.difficulty === "exact");
  const missed = exact.filter((outcome) => outcome.rank !== 1);
  assert.ok(
    missed.length <= 1,
    `exact-name queries missed rank 1: ${missed.map((o) => `"${o.query}"`).join(", ")}`,
  );
});

test("every labeled answer is retrieved somewhere in the top 5 or is a known miss", () => {
  const unretrieved = report.outcomes.filter((outcome) => outcome.rank === 0);
  assert.ok(
    unretrieved.length <= 4,
    `${unretrieved.length} queries retrieved nothing relevant:\n` +
      unretrieved.map((o) => `  "${o.query}" -> ${o.expected}`).join("\n"),
  );
});

test("metrics are computed correctly from ranks", () => {
  const outcomes = [
    { query: "a", expected: "x", difficulty: "exact" as const, rank: 1, returned: [] },
    { query: "b", expected: "y", difficulty: "exact" as const, rank: 4, returned: [] },
    { query: "c", expected: "z", difficulty: "exact" as const, rank: 0, returned: [] },
  ];
  const metrics = metricsFor(outcomes);
  assert.equal(metrics.count, 3);
  assert.equal(metrics.recallAt1, 1 / 3);
  assert.equal(metrics.recallAt5, 2 / 3);
  assert.equal(metrics.recallAtK, 2 / 3);
  assert.ok(Math.abs(metrics.mrr - (1 + 0.25) / 3) < 1e-9);

  const metricsAt3 = metricsFor(outcomes, 3);
  assert.equal(metricsAt3.recallAt1, 1 / 3);
  assert.equal(metricsAt3.recallAt5, 2 / 3);
  assert.equal(metricsAt3.recallAtK, 1 / 3);
});

test("an empty outcome set yields zeroed metrics rather than NaN", () => {
  assert.deepEqual(metricsFor([]), { count: 0, recallAt1: 0, recallAt5: 0, recallAtK: 0, mrr: 0 });
});

test("runEval with custom limit parameterizes recallAtK", async () => {
  const reportAt3 = await runEval(EVAL_QUERIES, 3);
  assert.equal(reportAt3.overall.recallAt1, report.overall.recallAt1);
  assert.ok(reportAt3.overall.recallAtK <= report.overall.recallAt5);
});

test("the report renders the headline numbers", () => {
  const text = formatReport(report);
  assert.match(text, /recall@1/);
  assert.match(text, /recall@5/);
  assert.match(text, /MRR/);
  assert.match(text, /corpus: \d+ actions across \d+ servers/);
});
