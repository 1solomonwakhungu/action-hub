/**
 * Strict evidence parsers for external stress reports (builder-10).
 *
 * Four-bar rule: a runner may only be green when it has POSITIVE parsed
 * evidence. Unrecognized shapes, zero scenarios, zero verified cases, or
 * unknown tool counts are failures, not passes.
 */

/** mcp-fuzzer run_summary.json — requires a positive numeric tool count. */
export function fuzzEvidence(summary) {
  if (!summary || typeof summary !== "object") {
    return { ok: false, reason: "run_summary.json missing or not an object" };
  }
  const blockedReason = summary.blocked_reason ?? (summary.status === "blocked" ? "blocked" : null);
  const toolCount = summary.tool_discovery?.tool_count ?? summary.tools?.total ?? null;
  if (typeof toolCount !== "number" || !Number.isFinite(toolCount) || toolCount <= 0) {
    return { ok: false, reason: `no positive discovered-tool count (toolCount=${JSON.stringify(toolCount)})` };
  }
  const findings = summary.findings ?? {};
  const total = findings.total
    ?? (findings.by_category ? Object.values(findings.by_category).reduce((a, b) => a + (b ?? 0), 0) : 0);
  return {
    ok: !blockedReason && toolCount > 0,
    reason: blockedReason ? `run blocked: ${blockedReason}` : null,
    toolCount,
    findingTotal: total,
    byCategory: findings.by_category ?? {},
  };
}

/** @hasmcp/mcp-spec-test report — requires executed AND passed > 0, failed = 0. */
export function specEvidence(report) {
  if (!report || typeof report !== "object") {
    return { ok: false, reason: "spec-test report missing or not an object" };
  }
  // Primary shape: counts.{passed, failed, notVerified, ...}
  const counts = report?.counts;
  if (counts && typeof counts === "object") {
    const passed = Number(counts.passed ?? 0);
    const failed = Number(counts.failed ?? 0);
    const notVerified = Number(counts.notVerified ?? 0);
    if (!Number.isFinite(passed) || !Number.isFinite(failed)) {
      return { ok: false, reason: "spec-test counts are not numeric" };
    }
    if (passed + failed + notVerified === 0) {
      return { ok: false, reason: "zero executed spec cases parsed from report" };
    }
    if (passed === 0) {
      return { ok: false, reason: `zero passed cases (${passed + failed + notVerified} executed)` };
    }
    return {
      ok: failed === 0,
      reason: failed > 0 ? `${failed} failed spec cases` : null,
      executed: passed + failed + notVerified,
      passed,
      failed,
      notVerified,
    };
  }
  // Alternate nested shape: [{suites:[{items:[{status}]}]}].
  const arr = Array.isArray(report) ? report : [report];
  let executed = 0;
  let passed = 0;
  let failed = 0;
  let verified = 0;
  let notVerified = 0;
  for (const entry of arr) {
    for (const suite of entry?.suites ?? []) {
      for (const item of suite?.items ?? []) {
        executed += 1;
        if (item?.status === "pass" || item?.status === "success") {
          passed += 1;
          verified += 1;
        } else if (item?.status === "fail" || item?.status === "failure" || item?.status === "error") {
          failed += 1;
        } else {
          notVerified += 1;
        }
      }
    }
    // Flat shapes seen in the wild.
    if (typeof entry?.passed === "number") {
      executed = Math.max(executed, entry.passed + (entry.failed ?? 0) + (entry.notVerified ?? 0));
      passed += entry.passed;
      failed += entry.failed ?? 0;
    }
  }
  if (executed === 0) {
    return { ok: false, reason: "no executed spec cases parsed from report" };
  }
  if (passed === 0) {
    return { ok: false, reason: `zero passed cases (${executed} executed)` };
  }
  return { ok: failed === 0, reason: failed > 0 ? `${failed} failed spec cases` : null, executed, passed, failed, notVerified };
}

/** Official MCP conformance per-scenario checks.json results. */
export function conformanceEvidence(scenarios) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    return { ok: false, reason: "no conformance scenarios parsed" };
  }
  let success = 0;
  let failure = 0;
  let warning = 0;
  const details = [];
  for (const scenario of scenarios) {
    const name = scenario?.scenario ?? scenario?.name ?? "unknown";
    const statuses = (scenario?.checks ?? [])
      .map((check) => check?.status)
      .filter((status) => typeof status === "string");
    if (statuses.length === 0) {
      failure += 1;
      details.push({ name, reason: "no checks parsed" });
      continue;
    }
    const fails = statuses.filter((s) => s !== "SUCCESS" && s !== "WARNING").length;
    const warns = statuses.filter((s) => s === "WARNING").length;
    const oks = statuses.filter((s) => s === "SUCCESS").length;
    success += oks > 0 && fails === 0 ? 1 : 0;
    failure += fails > 0 ? 1 : 0;
    warning += warns > 0 && fails === 0 ? 1 : 0;
    if (fails > 0) details.push({ name, reason: `${fails} failed checks` });
  }
  return {
    ok: success > 0 && failure === 0,
    reason: failure > 0 ? `${failure} failing scenarios` : success === 0 ? "zero successful scenarios" : null,
    success,
    failure,
    warning,
    details,
  };
}
