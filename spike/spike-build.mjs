// SQ4-P spike: build + verify a Node SEA with offline local embeddings on any
// of macOS/Linux/Windows. Downloads the vendored int8 MiniLM-L6 assets from
// Hugging Face (network is allowed at BUILD time only), bundles + injects a
// SEA binary, then runs ONE query and asserts: ok:true, dim 384, zero https
// fetches at runtime (offline proof).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, copyFileSync, rmSync, chmodSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const spike = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(spike, "..");
const results = { steps: [] };
const step = (name, ok, detail) => { results.steps.push({ name, ok, detail }); if (!ok) { console.error(`STEP FAILED: ${name}: ${detail}`); } return ok; };

// 1. Download model files (build-time network; runtime is verified offline).
const base = "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/";
const modelDir = join(spike, "models", "Xenova", "all-MiniLM-L6-v2");
const files = ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json"];
try {
  for (const f of files) {
    mkdirSync(modelDir, { recursive: true });
    const res = await fetch(base + f);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${f}`);
    writeFileSync(join(modelDir, f), Buffer.from(await res.arrayBuffer()));
  }
  mkdirSync(join(modelDir, "onnx"), { recursive: true });
  const res = await fetch(base + "onnx/model_quantized.onnx");
  if (!res.ok) throw new Error(`HTTP ${res.status} for model`);
  writeFileSync(join(modelDir, "onnx", "model_quantized.onnx"), Buffer.from(await res.arrayBuffer()));
  step("download-model", true, `${(await (await import("node:fs/promises")).stat(join(modelDir, "onnx", "model_quantized.onnx"))).size} bytes`);
} catch (err) {
  step("download-model", false, String(err && err.message));
  console.log(JSON.stringify(results)); process.exit(1);
}

// 2. Bundle with esbuild (CJS, stub natives, define import.meta.url).
try {
  const { build } = await import("esbuild");
  await build({
    entryPoints: [join(spike, "sea-entry.mjs")],
    bundle: true, platform: "node", format: "cjs", target: "node20",
    outfile: join(spike, "sea.cjs"), logLevel: "error",
    define: { "import.meta.url": JSON.stringify("file:///sq4/spike/sea.cjs") },
    plugins: [{
      name: "stub-natives",
      setup(b2) {
        b2.onResolve({ filter: /^(onnxruntime-node|sharp)$/ }, () => ({ path: "stub", namespace: "stub" }));
        b2.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "module.exports = {}; module.exports.default = module.exports;", loader: "js" }));
      },
    }],
  });
  step("bundle", true, "sea.cjs written");
} catch (err) { step("bundle", false, String(err && err.message)); console.log(JSON.stringify(results)); process.exit(1); }

// 3. sea-config: assets = model + wasm, keyed by relative paths.
const wasmDist = join(spike, "node_modules", "onnxruntime-web", "dist");
const seaConfig = {
  main: "sea.cjs",
  output: "sea-prep.blob",
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets: {
    "model_quantized.onnx": "models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx",
    "config.json": "models/Xenova/all-MiniLM-L6-v2/config.json",
    "tokenizer.json": "models/Xenova/all-MiniLM-L6-v2/tokenizer.json",
    "tokenizer_config.json": "models/Xenova/all-MiniLM-L6-v2/tokenizer_config.json",
    "special_tokens_map.json": "models/Xenova/all-MiniLM-L6-v2/special_tokens_map.json",
    "ort-wasm-simd-threaded.wasm": join(wasmDist, "ort-wasm-simd-threaded.wasm"),
    "ort-wasm-simd-threaded.mjs": join(wasmDist, "ort-wasm-simd-threaded.mjs"),
  },
};
writeFileSync(join(spike, "sea-config.json"), JSON.stringify(seaConfig, null, 2));

// 4. Blob (same Node version as the binary copy — hard requirement).
const blobRun = spawnSync(process.execPath, ["--experimental-sea-config", join(spike, "sea-config.json")], { encoding: "utf8" });
if (!step("sea-blob", blobRun.status === 0, (blobRun.stderr || "").slice(0, 300))) { console.log(JSON.stringify(results)); process.exit(1); }

// 5. Copy the exact runtime binary.
const bin = join(spike, process.platform === "win32" ? "sea-bin.exe" : "sea-bin");
copyFileSync(process.execPath, bin);
if (process.platform !== "win32") chmodSync(bin, 0o755);

// 6. Inject (macOS needs the segment name + remove/re-sign dance).
const postject = (await import("postject")).default ?? "postject-bin-path-unresolved";
function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: process.platform === "win32" });
  return { ok: r.status === 0, out: ((r.stdout || "") + (r.stderr || "")).slice(0, 400) };
}
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
if (process.platform === "darwin") {
  run("codesign", ["--remove-signature", bin]);
}
const inject = run(npx, ["postject", bin, "NODE_SEA_BLOB", join(spike, "sea-prep.blob"),
  "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : []),
  "--overwrite"]);
if (!step("inject", inject.ok, inject.out)) { console.log(JSON.stringify(results)); process.exit(1); }
if (process.platform === "darwin") {
  run("codesign", ["--remove-signature", bin]);
  const sign = run("codesign", ["--sign", "-", bin]);
  if (!step("codesign", sign.ok, sign.out)) { console.log(JSON.stringify(results)); process.exit(1); }
}

// 7. Run ONE query offline; assert ok / dim / zero network.
const out = spawnSync(bin, [], { encoding: "utf8", timeout: 120000, env: { ...process.env, CI_SPIKE: "1" } });
let verdict = null; let parsed = null;
try {
  parsed = JSON.parse((out.stdout || "").trim().split("\n").filter(Boolean).pop());
  verdict = parsed.ok === true && parsed.dim === 384 && parsed.fetchCalls === 0;
} catch { /* fallthrough */ }
step("run-embed", verdict === true, JSON.stringify(parsed ?? { exit: out.status, stderr: (out.stderr || "").slice(0, 300) }));
results.platform = process.platform;
results.node = process.version;
results.assert = { ok: parsed?.ok, dim: parsed?.dim, fetchCalls: parsed?.fetchCalls, totalMs: parsed?.totalMs };
console.log(JSON.stringify(results));
process.exit(verdict ? 0 : 1);
