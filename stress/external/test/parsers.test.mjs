import assert from "node:assert/strict";
import { test } from "node:test";
import { fuzzEvidence, specEvidence, conformanceEvidence } from "../parsers.mjs";

test("fuzzEvidence requires a positive numeric tool count", () => {
  assert.equal(fuzzEvidence(null).ok, false);
  assert.equal(fuzzEvidence({}).ok, false); // no tool count at all
  assert.equal(fuzzEvidence({ tool_discovery: { tool_count: 0 } }).ok, false);
  assert.equal(fuzzEvidence({ tool_discovery: { tool_count: null } }).ok, false);
  assert.equal(fuzzEvidence({ tools: { total: "12" } }).ok, false); // non-numeric
  assert.equal(fuzzEvidence({ blocked_reason: "auth" }).ok, false);
  const good = fuzzEvidence({ tool_discovery: { tool_count: 4 }, findings: { total: 2 } });
  assert.equal(good.ok, true);
  assert.equal(good.toolCount, 4);
  assert.equal(good.findingTotal, 2);
});

test("specEvidence requires positive passed evidence and zero failures", () => {
  assert.equal(specEvidence(null).ok, false);
  assert.equal(specEvidence({ counts: { passed: 0, failed: 0, notVerified: 7 } }).ok, false); // zero passed
  assert.equal(specEvidence({ counts: {} }).ok, false); // zero executed
  const failed = specEvidence({ counts: { passed: 13, failed: 2, notVerified: 7 } });
  assert.equal(failed.ok, false);
  const good = specEvidence({ counts: { passed: 13, failed: 0, notVerified: 7 } });
  assert.equal(good.ok, true);
  assert.equal(good.executed, 20);
});

test("conformanceEvidence requires positive scenarios and zero failures", () => {
  assert.equal(conformanceEvidence(null).ok, false);
  assert.equal(conformanceEvidence([]).ok, false); // zero scenarios
  assert.equal(conformanceEvidence([{ name: "s", checks: [] }]).ok, false); // unreadable scenario
  const allFail = conformanceEvidence([
    { name: "s1", checks: [{ status: "FAILURE" }] },
  ]);
  assert.equal(allFail.ok, false);
  assert.equal(allFail.failure, 1);
  const zeroSuccess = conformanceEvidence([
    { name: "s1", checks: [{ status: "WARNING" }] },
  ]);
  assert.equal(zeroSuccess.ok, false); // positive evidence required
  const good = conformanceEvidence([
    { name: "s1", checks: [{ status: "SUCCESS" }, { status: "WARNING" }] },
    { name: "s2", checks: [{ status: "SUCCESS" }] },
  ]);
  assert.equal(good.ok, true);
  assert.equal(good.success, 2);
  assert.equal(good.failure, 0);
});
