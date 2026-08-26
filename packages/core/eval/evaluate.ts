import { Catalog } from "../dist/catalog/catalog.js";
import { SearchEngine } from "../dist/search/search.js";
import { EVAL_CORPUS } from "./corpus.ts";
import { EVAL_QUERIES } from "./queries.ts";
import type { EvalCase, EvalDifficulty } from "./queries.ts";

/**
 * The retrieval-quality harness.
 *
 * Metrics are deliberately the boring ones. recall@1 is what actually matters
 * in production — the model usually takes the first hit — while recall@5 and
 * MRR describe how gracefully the ranker fails when it misses. A change that
 * holds recall@1 but collapses recall@5 has made the system brittle, and the
 * report should make that visible.
 */

/** How deep results are fetched; recall@5 is measured within this window. */
export const EVAL_LIMIT = 5;

export interface CaseOutcome {
  query: string;
  expected: string;
  difficulty: EvalDifficulty;
  note?: string;
  /** 1-based position of the expected id, or 0 when it was not retrieved. */
  rank: number;
  /** Ids actually returned, best first. */
  returned: string[];
}

export interface Metrics {
  count: number;
  recallAt1: number;
  recallAt5: number;
  mrr: number;
}

export interface EvalReport {
  corpusSize: number;
  serverCount: number;
  overall: Metrics;
  byDifficulty: Record<EvalDifficulty, Metrics>;
  outcomes: CaseOutcome[];
  failures: CaseOutcome[];
}

export function buildEvalCatalog(): Catalog {
  const catalog = new Catalog();
  catalog.addAll(EVAL_CORPUS);
  return catalog;
}

export async function runEval(
  cases: readonly EvalCase[] = EVAL_QUERIES,
  limit: number = EVAL_LIMIT,
): Promise<EvalReport> {
  const catalog = buildEvalCatalog();
  const engine = new SearchEngine(catalog);

  assertLabelsResolve(catalog, cases);

  const outcomes: CaseOutcome[] = [];
  for (const testCase of cases) {
    const hits = await engine.search(testCase.query, { limit });
    const returned = hits.map((hit) => hit.id);
    const outcome: CaseOutcome = {
      query: testCase.query,
      expected: testCase.expected,
      difficulty: testCase.difficulty,
      rank: returned.indexOf(testCase.expected) + 1,
      returned,
    };
    if (testCase.note) outcome.note = testCase.note;
    outcomes.push(outcome);
  }

  const difficulties: EvalDifficulty[] = ["exact", "paraphrase", "ambiguous"];
  const byDifficulty = {} as Record<EvalDifficulty, Metrics>;
  for (const difficulty of difficulties) {
    byDifficulty[difficulty] = metricsFor(outcomes.filter((o) => o.difficulty === difficulty));
  }

  return {
    corpusSize: EVAL_CORPUS.length,
    serverCount: new Set(EVAL_CORPUS.map((record) => record.serverId)).size,
    overall: metricsFor(outcomes),
    byDifficulty,
    outcomes,
    failures: outcomes.filter((outcome) => outcome.rank !== 1),
  };
}

export function metricsFor(outcomes: readonly CaseOutcome[]): Metrics {
  if (outcomes.length === 0) {
    return { count: 0, recallAt1: 0, recallAt5: 0, mrr: 0 };
  }
  let hitsAt1 = 0;
  let hitsAt5 = 0;
  let reciprocalSum = 0;
  for (const outcome of outcomes) {
    if (outcome.rank === 1) hitsAt1 += 1;
    if (outcome.rank >= 1 && outcome.rank <= 5) hitsAt5 += 1;
    if (outcome.rank >= 1) reciprocalSum += 1 / outcome.rank;
  }
  return {
    count: outcomes.length,
    recallAt1: hitsAt1 / outcomes.length,
    recallAt5: hitsAt5 / outcomes.length,
    mrr: reciprocalSum / outcomes.length,
  };
}

/**
 * A typo in an expected id would silently depress every metric and look like a
 * retrieval regression, so labels are validated against the corpus up front.
 */
function assertLabelsResolve(catalog: Catalog, cases: readonly EvalCase[]): void {
  const missing = cases.filter((testCase) => !catalog.has(testCase.expected));
  if (missing.length > 0) {
    const ids = missing.map((testCase) => testCase.expected).join(", ");
    throw new Error(`Eval labels reference action ids that are not in the corpus: ${ids}`);
  }
}

export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  const rule = "─".repeat(72);

  lines.push("");
  lines.push("Action Hub — search evaluation");
  lines.push(rule);
  lines.push(
    `corpus: ${report.corpusSize} actions across ${report.serverCount} servers` +
      `   queries: ${report.overall.count}   depth: @${EVAL_LIMIT}`,
  );
  lines.push("");
  lines.push(`  recall@1   ${pct(report.overall.recallAt1)}`);
  lines.push(`  recall@5   ${pct(report.overall.recallAt5)}`);
  lines.push(`  MRR        ${report.overall.mrr.toFixed(3)}`);
  lines.push("");
  lines.push("By difficulty");
  lines.push(rule);
  lines.push(pad("band", 12) + pad("n", 5) + pad("recall@1", 11) + pad("recall@5", 11) + "MRR");
  for (const band of ["exact", "paraphrase", "ambiguous"] as const) {
    const metrics = report.byDifficulty[band];
    lines.push(
      pad(band, 12) +
        pad(String(metrics.count), 5) +
        pad(pct(metrics.recallAt1), 11) +
        pad(pct(metrics.recallAt5), 11) +
        metrics.mrr.toFixed(3),
    );
  }

  lines.push("");
  lines.push(`Misses at rank 1 (${report.failures.length})`);
  lines.push(rule);
  if (report.failures.length === 0) {
    lines.push("  none");
  } else {
    for (const failure of report.failures) {
      const position = failure.rank === 0 ? `not in top ${EVAL_LIMIT}` : `rank ${failure.rank}`;
      lines.push(`  [${failure.difficulty}] "${failure.query}"  → ${position}`);
      lines.push(`      expected: ${failure.expected}`);
      lines.push(`      returned: ${failure.returned.join(", ") || "(nothing)"}`);
      if (failure.note) lines.push(`      note:     ${failure.note}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? `${text} ` : text + " ".repeat(width - text.length);
}
