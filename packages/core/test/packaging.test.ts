/** Packed-artifact regression (packaging review R1-2): the distributed core
 * package must include the vendored model, or a packed install silently
 * falls back to the hashed scorer. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("npm pack of @action-hub/core includes the vendored model", () => {
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: join(repoRoot, "packages", "core"),
    encoding: "utf8",
  });
  const parsed = JSON.parse(out) as { filename: string; files: { path: string }[] }[];
  const paths = parsed[0]?.files?.map((f) => f.path) ?? [];
  assert.ok(
    paths.includes("vendor/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx"),
    `model missing from the packed artifact (files: ${paths.length})`,
  );
  assert.ok(paths.includes("vendor/VENDOR.md"), "provenance notice missing from the packed artifact");
});
