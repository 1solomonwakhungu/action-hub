// SQ4 spike: @huggingface/transformers + int8 MiniLM-L6 inside a Node SEA, offline.
// Order matters: force the WASM ONNX backend via the globalThis symbol BEFORE
// transformers is imported (it otherwise requires onnxruntime-node, whose
// native .node addon cannot be loaded from inside a SEA blob).

async function main() {
const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const t0 = performance.now();

// Offline proof: count every fetch call (must stay 0).
let fetchCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  const url = String(args[0]);
  if (/^https?:\/\//.test(url)) {
    fetchCalls++;
    throw new Error(`NETWORK BLOCKED: fetch(${url.slice(0, 120)})`);
  }
  return realFetch(...args); // file:// etc. -> Node fetch errors natively
};

// Force onnxruntime-web (WASM) as the ONNX backend: transformers dynamically
// require()s onnxruntime-node at module load (its native .node addon cannot
// load from inside a SEA blob). We intercept that require and hand back the
// onnxruntime-web module in the same shape ({InferenceSession, Tensor, env}),
// so transformers takes its normal node path — supportedDevices populated,
// default device cpu — but every op runs on the WASM backend.
const ortWeb = await import("onnxruntime-web");
const ortWebShim = {
  InferenceSession: ortWeb.InferenceSession,
  Tensor: ortWeb.Tensor,
  env: ortWeb.env,
};
ortWebShim.default = ortWebShim;
const Module = await import("node:module");
const mod = Module.default;
const origLoad = mod._load;
mod._load = function (request, ...rest) {
  if (request === "onnxruntime-node") return ortWebShim;
  if (request === "sharp") return {};
  return origLoad.apply(this, [request, ...rest]);
};
const { pipeline, env } = await import("@huggingface/transformers");

// Import transformers AFTER the backend override.

// Extract SEA assets to a private temp dir and lay them out as transformers
// expects (models/Xenova/all-MiniLM-L6-v2/...) + wasm dir.
let scratch = null;
const ASSET_LAYOUT = [
  ["model_quantized.onnx", "models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx"],
  ["config.json", "models/Xenova/all-MiniLM-L6-v2/config.json"],
  ["tokenizer.json", "models/Xenova/all-MiniLM-L6-v2/tokenizer.json"],
  ["tokenizer_config.json", "models/Xenova/all-MiniLM-L6-v2/tokenizer_config.json"],
  ["special_tokens_map.json", "models/Xenova/all-MiniLM-L6-v2/special_tokens_map.json"],
  ["ort-wasm-simd-threaded.wasm", "wasm/ort-wasm-simd-threaded.wasm"],
  ["ort-wasm-simd-threaded.mjs", "wasm/ort-wasm-simd-threaded.mjs"],
];
if (await existsSyncAssetSupport()) {
  scratch = mkdtempSync(join(tmpdir(), "sq4-sea-"));
  const { mkdirSync } = await import("node:fs");
  for (const [key, dest] of ASSET_LAYOUT) {
    const data = Buffer.from(getSeaAsset(key));
    mkdirSync(join(scratch, dest, ".."), { recursive: true });
    writeFileSync(join(scratch, dest), data);
  }
  const wasmDir = join(scratch, "wasm");
  env.backends.onnx.wasm.wasmPaths = {
    wasm: join(wasmDir, "ort-wasm-simd-threaded.wasm"),
    mjs: join(wasmDir, "ort-wasm-simd-threaded.mjs"),
  };
  env.backends.onnx.wasm.numThreads = 1; // keep it simple/portable in SEA
  env.allowLocalModels = true;
  env.localModelPath = join(scratch, "models");
  env.allowRemoteModels = false;
  env.useWasmCache = true;
} else {
  // Non-SEA sanity path: use the spike checkout's own local model + wasm.
  env.backends.onnx.wasm.wasmPaths = {
    wasm: join(process.cwd(), "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm"),
    mjs: join(process.cwd(), "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs"),
  };
  env.backends.onnx.wasm.numThreads = 1;
  env.allowLocalModels = true;
  env.localModelPath = join(process.cwd(), "models");
  env.allowRemoteModels = false;
  env.useWasmCache = true;
}

const tEnv = performance.now();
const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" });
const tLoad = performance.now();
const out = await extractor("hello world", { pooling: "mean", normalize: true });
const tEmbed = performance.now();
const v = Array.from(out.data);
const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));

if (scratch) {
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log(JSON.stringify({
  ok: fetchCalls === 0 && v.length === 384 && Math.abs(norm - 1) < 1e-3,
  fetchCalls,
  envExtractMs: +(tEnv - t0).toFixed(1),
  pipelineLoadMs: +(tLoad - tEnv).toFixed(1),
  embedMs: +(tEmbed - tLoad).toFixed(1),
  totalMs: +(tEmbed - t0).toFixed(1),
  dim: v.length,
  norm: +norm.toFixed(4),
  first4: v.slice(0, 4).map((x) => +x.toFixed(4)),
}));

async function existsSyncAssetSupport() {
  try {
    // node:sea exposes isSea() — true only inside a Single Executable App.
    const { isSea, getRawAsset } = await import("node:sea");
    if (!isSea()) return false;
    globalThis.__getSeaAsset = getRawAsset;
    return true;
  } catch {
    return false;
  }
}
function getSeaAsset(key) {
  return globalThis.__getSeaAsset(key);
}
}

main().catch((err) => { console.error('SEA spike failed:', err && (err.stack || err)); process.exit(1); });
