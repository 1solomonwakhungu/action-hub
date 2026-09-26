import assert from "node:assert/strict";
import test from "node:test";
import { renderPage } from "./render.mjs";
import { operations, TRUST_TIERS } from "./controls.mjs";

test("renderPage produces complete HTML with dashboard tabs, health indicators, presets, and token analytics", () => {
  const token = "test-token-12345";
  const html = renderPage(token);

  assert.ok(html.includes("<!doctype html>"));
  assert.ok(html.includes("Capability Manager"));
  assert.ok(html.includes(token));
  // Tabs
  assert.ok(html.includes("data-tab=\"servers\""));
  assert.ok(html.includes("data-tab=\"search\""));
  assert.ok(html.includes("data-tab=\"explorer\""));
  assert.ok(html.includes("data-tab=\"analytics\""));
  assert.ok(html.includes("data-tab=\"presets\""));
  assert.ok(html.includes("data-tab=\"history\""));
  // Harnesses & Skills tab
  assert.ok(html.includes("data-tab=\"harnesses\""));
  assert.ok(html.includes("id=\"tab-harnesses\""));
  assert.ok(html.includes("claude_desktop_config.json"));
  assert.ok(html.includes(".cursor/mcp.json"));
  assert.ok(html.includes("config.toml"));
  assert.ok(html.includes("mcp.json"));
  // The placeholder is entity-escaped in the HTML source (&lt;…&gt;) so the
  // browser does not parse it as an unknown tag; textContent/clipboard get the
  // literal <ABSOLUTE_PATH_TO_ACTION_HUB> form.
  assert.ok(html.includes('&lt;ABSOLUTE_PATH_TO_ACTION_HUB&gt;/packages/copilot-plugin/server/dist/index.js'));
  assert.ok(!html.includes('"packages/copilot-plugin/server/dist/index.js"'));
  assert.ok(!html.includes('@action-hub/cli'));
  assert.ok(html.includes("id=\"skills-list\""));
  assert.ok(html.includes("data-copy-snippet"));
  // Server Health & Reconnect
  assert.ok(html.includes("btn-check-health"));
  assert.ok(html.includes("data-reconnect"));
  // Presets
  assert.ok(html.includes("data-preset=\"github\""));
  assert.ok(html.includes("data-preset=\"linear\""));
  assert.ok(html.includes("data-preset=\"slack\""));
  assert.ok(html.includes("data-preset=\"sqlite\""));
  // Config Importer
  assert.ok(html.includes("btn-import"));
  assert.ok(html.includes("import-json"));
});

test("controls validation tests", async () => {
  assert.deepEqual(TRUST_TIERS, ["blocked", "untrusted", "trusted"]);

  // Test set_server_enabled validation
  const res1 = await operations.set_server_enabled({});
  assert.equal(res1.ok, false);
  assert.ok(res1.error.includes("serverId"));

  const res2 = await operations.set_server_enabled({ serverId: "gh", enabled: "not-bool" });
  assert.equal(res2.ok, false);
  assert.ok(res2.error.includes("enabled"));

  // Test set_server_trust validation
  const res3 = await operations.set_server_trust({ serverId: "gh", trust: "invalid" });
  assert.equal(res3.ok, false);
  assert.ok(res3.error.includes("trust"));

  // Test test_search validation
  const res4 = await operations.test_search({});
  assert.equal(res4.ok, false);
  assert.ok(res4.error.includes("query"));

  // Test reconnect_server validation
  const res5 = await operations.reconnect_server({});
  assert.equal(res5.ok, false);
  assert.ok(res5.error.includes("serverId"));

  // Test import_config validation
  const res6 = await operations.import_config({});
  assert.equal(res6.ok, false);
  assert.ok(res6.error.includes("config"));

  // Test load_action validation
  const res7 = await operations.load_action({});
  assert.equal(res7.ok, false);
  assert.ok(res7.error.includes("actionId"));

  // Test load_bundle validation
  const res8 = await operations.load_bundle({});
  assert.equal(res8.ok, false);
  assert.ok(res8.error.includes("bundleId"));
});
