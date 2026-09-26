import test from "node:test";
import assert from "node:assert/strict";
import { aggregateRuns } from "../verdict.mjs";

test("missing or unparsable summary is a failure", () => {
  const v = aggregateRuns([
    { label: "inspector-smoke", requiresSummary: true, exitCode: 0, summary: null },
  ]);
  assert.equal(v.ok, false);
  assert.match(v.failures[0], /unparsable summary/);
});

test("summary ok:false is a failure", () => {
  const v = aggregateRuns([
    { label: "mcp-fuzzer", requiresSummary: true, exitCode: 0, summary: { ok: false } },
  ]);
  assert.equal(v.ok, false);
});

test("nonzero exit is a failure regardless of summary", () => {
  const v = aggregateRuns([
    { label: "k6", requiresSummary: true, exitCode: 99, summary: { ok: false } },
  ]);
  assert.equal(v.ok, false);
});

test("rows without summaries pass on exit 0", () => {
  const v = aggregateRuns([{ label: "make-fixture", exitCode: 0, stdout: "{}" }]);
  assert.equal(v.ok, true);
});

test("all-good rows pass", () => {
  const v = aggregateRuns([
    { label: "inspector-smoke", requiresSummary: true, exitCode: 0, summary: { ok: true } },
    { label: "k6", requiresSummary: true, exitCode: 0, summary: { ok: true } },
  ]);
  assert.equal(v.ok, true);
});
