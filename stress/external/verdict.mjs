/**
 * Verdict aggregation for external stress runners (builder-10).
 *
 * Rules (from the stress evidence rule): a run row passes only when
 *   - it exited 0 (or did not run, i.e. exitCode undefined), AND
 *   - if the child produces a summary, that summary was successfully parsed
 *     AND reports ok:true.
 * A missing or unparsable summary is a FAILURE, never a pass.
 */
export function aggregateRuns(runs) {
  const failures = [];
  for (const run of runs) {
    if (run.exitCode !== 0 && run.exitCode !== undefined) {
      failures.push(`${run.label}: exitCode ${run.exitCode}`);
    }
    if (Array.isArray(run.cleanupFailures) && run.cleanupFailures.length > 0) {
      // MIG2-R1: cleanup evidence is load-bearing at the aggregate too —
      // a green workload with a failed teardown can never aggregate green.
      failures.push(`${run.label}: cleanup: ${run.cleanupFailures.map((f) => f.problems.join("; ")).join(" | ").slice(0, 300)}`);
      continue;
    }
    if (run.requiresSummary) {
      if (run.summary === undefined || run.summary === null) {
        failures.push(`${run.label}: missing or unparsable summary`);
      } else if (run.summary?.ok !== true) {
        failures.push(`${run.label}: summary ok=${run.summary?.ok}`);
      }
    }
  }
  return { ok: failures.length === 0, failures };
}
