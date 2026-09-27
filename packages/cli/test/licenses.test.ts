/** `action-hub licenses` must work OUTSIDE SEA (review-1 round 5 HIGH 1):
 * the Node CLI resolves the texts from the @action-hub/core package vendor
 * tree via createRequire — this regression pins the non-SEA path. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("node CLI 'licenses' prints the vendored provenance + both license texts", () => {
  const cliRoot = fileURLToPath(new URL("..", import.meta.url)); // packages/cli
  const entry = join(cliRoot, "dist", "index.js");
  const result = spawnSync(process.execPath, [entry, "licenses"], { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, `licenses exited ${result.status}: ${result.stderr?.slice(0, 300)}`);
  const out = result.stdout ?? "";
  for (const needle of [
    "Vendored third-party provenance",
    "Apache License",
    "MIT License",
    "onnxruntime",
  ]) {
    assert.ok(out.includes(needle), `licenses output missing "${needle}"`);
  }
});
