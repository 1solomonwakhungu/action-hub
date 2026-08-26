import { formatReport, runEval } from "./evaluate.ts";
import { BASELINE } from "./baseline.ts";

/**
 * CLI entry point: `npm run eval`.
 *
 * Prints the full report and exits non-zero if the committed baseline is
 * breached, so the same command works as a local diagnostic and as a CI gate.
 */
const report = await runEval();
process.stdout.write(formatReport(report));

const breaches: string[] = [];
if (report.overall.recallAt1 < BASELINE.recallAt1) {
  breaches.push(
    `recall@1 ${report.overall.recallAt1.toFixed(3)} < baseline ${BASELINE.recallAt1.toFixed(3)}`,
  );
}
if (report.overall.recallAt5 < BASELINE.recallAt5) {
  breaches.push(
    `recall@5 ${report.overall.recallAt5.toFixed(3)} < baseline ${BASELINE.recallAt5.toFixed(3)}`,
  );
}
if (report.overall.mrr < BASELINE.mrr) {
  breaches.push(`MRR ${report.overall.mrr.toFixed(3)} < baseline ${BASELINE.mrr.toFixed(3)}`);
}

if (breaches.length > 0) {
  process.stdout.write(`Baseline breached:\n${breaches.map((b) => `  ${b}`).join("\n")}\n\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Baseline held (recall@1 ≥ ${BASELINE.recallAt1.toFixed(3)}, ` +
      `recall@5 ≥ ${BASELINE.recallAt5.toFixed(3)}, MRR ≥ ${BASELINE.mrr.toFixed(3)}).\n\n`,
  );
}
