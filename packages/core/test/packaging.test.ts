/** Packed-artifact regression (packaging review R1-2 + license round): the
 * distributed core package must include every runtime asset the embeddings
 * pipeline needs (model, tokenizer data, vendored ORT subset) AND the
 * third-party license texts, or a packed install silently falls back to the
 * hashed scorer and redistributes third-party code without its terms. */
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
  const required = [
    // runtime model + tokenizer data
    "vendor/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx",
    "vendor/models/Xenova/all-MiniLM-L6-v2/tokenizer.json",
    "vendor/models/Xenova/all-MiniLM-L6-v2/tokenizer_config.json",
    "vendor/models/Xenova/all-MiniLM-L6-v2/config.json",
    // vendored ORT subset (the WASM inference runtime)
    "vendor/ort/ort.wasm.mjs",
    "vendor/ort/ort-wasm-simd-threaded.mjs",
    "vendor/ort/ort-wasm-simd-threaded.wasm",
    // provenance + third-party license texts (redistribution requirement)
    "vendor/VENDOR.md",
    "vendor/licenses/Apache-2.0.txt",
    "vendor/licenses/onnxruntime-LICENSE.txt",
  ];
  const missing = required.filter((p) => !paths.includes(p));
  assert.deepEqual(
    missing,
    [],
    `required assets missing from the packed artifact (${paths.length} files packed): ${missing.join(", ")}`,
  );
});

test("vendored ORT bytes match the SHAs recorded in vendor/VENDOR.md", async () => {
  const { readFile } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const vendorDir = new URL("../vendor/", import.meta.url);
  const provenance = await readFile(new URL("VENDOR.md", vendorDir), "utf8");
  // The VENDOR.md ORT table pins "<upstream path> | <sha256>" per file.
  const rows = [
    ...provenance.matchAll(/\| `(ort\.[^`]+|ort-wasm[^`]+)` \| onnxruntime-web[^|]+\| `([0-9a-f]{64})` \|/g),
  ];
  assert.ok(rows.length >= 3, "VENDOR.md ORT provenance table must pin all vendored files");
  for (const [, file, sha] of rows) {
    const bytes = await readFile(new URL(`ort/${file}`, vendorDir));
    const actual = createHash("sha256").update(bytes).digest("hex");
    assert.equal(actual, sha, `vendor/ort/${file} does not match its recorded SHA-256 (provenance drift)`);
  }
});
