# Vendored model provenance

This directory ships the embedding model used by `EmbeddingSemanticIndex`
(`packages/core/src/search/embeddings.ts`), fully offline — nothing here is
fetched at runtime.

## Model

- **Model:** sentence-transformers/all-MiniLM-L6-v2, ONNX export published by
  the `Xenova/all-MiniLM-L6-v2` Hugging Face repository (384-dim MiniLM-L6).
- **License:** Apache-2.0 (model weights; see https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2
  and the upstream sentence-transformers repository for the full notice).
- **Artifact used at runtime:** `Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx`
  (int8/q8), plus tokenizer/config files.
- **Pinned artifact SHA-256:**
  `afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1`
  (`sha256 onnx/model_quantized.onnx`; matches the upstream LFS object).
- **Runtime:** direct `onnxruntime-web` WASM session over the vendored
  subset (see below) + the project's own BERT WordPiece tokenizer
  (`src/search/tokenizer.ts`), pinned by the vector-parity fixture
  (`test/fixtures/embedding-vectors.json`, captured from
  transformers-native q8 on the same model; median cosine 0.993, worst
  0.986 over 200 texts — int8 GEMM kernels differ between runtimes).
  `ACTION_HUB_EMBEDDINGS_MODEL` overrides the model root for bundled-binary
  hosts that extract these files at startup.

## Files

| file | purpose |
|---|---|
| `Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx` | int8 ONNX weights (pinned above) |
| `Xenova/all-MiniLM-L6-v2/tokenizer.json` | sentencepiece/wordpiece tokenizer data |
| `Xenova/all-MiniLM-L6-v2/tokenizer_config.json` | tokenizer metadata |
| `Xenova/all-MiniLM-L6-v2/config.json` | model architecture metadata |

## Update procedure

1. Download a new upstream revision of `Xenova/all-MiniLM-L6-v2` (q8 dtype).
2. Record the new SHA-256 in this file BEFORE committing; never ship a model
   whose provenance row is missing.
3. Re-run `packages/core` tests: vector determinism, persistence round-trip
   (persisted entries are keyed by model id + backend + dims, so a model
   change invalidates old caches cleanly), and the quality eval
   (`stress/split-eval.mjs --semantic embeddings`).

## Onnxruntime-web runtime (vendored)

`packages/core/vendor/ort/` ships an unmodified subset of **onnxruntime-web**
1.23.2 (npm tarball `onnxruntime-web-1.23.2.tgz`), selected by file:

| file | upstream source | SHA-256 |
|---|---|---|
| `ort.wasm.mjs` | onnxruntime-web 1.23.2 `dist/ort.wasm.mjs` | `721ff16fbab457ed31bd70ed14c74a609b661fc31d720d0d9b67c93ae3a852b7` |
| `ort-wasm-simd-threaded.wasm` | onnxruntime-web 1.23.2 `dist/ort-wasm-simd-threaded.wasm` | `45eaee27761ad883742a8d4b8fce1538d60ce43b51adf1726fafccc59b8c1a15` |
| `ort-wasm-simd-threaded.mjs` | onnxruntime-web 1.23.2 `dist/ort-wasm-simd-threaded.mjs` | `90a557d15c02bac4504d95b67f431d8594635ed2a0a62a7f2cd83d090ff91d3e` |

- **License:** MIT (onnxruntime-web; https://github.com/microsoft/onnxruntime,
  copyright Microsoft Corporation). The files above are unmodified copies of
  the published npm tarball — no internals were hand-edited.
- **Runtime behavior:** the WASM execution provider only, single-threaded
  (`ort.env.wasm.numThreads = 1`, wasm binary injected via
  `ort.env.wasm.wasmBinary` because `fetch()` cannot read `file://` URLs in
  Node). No native addons are loaded anywhere in the dependency tree.

## Update procedure (ORT)

1. Pick a new `onnxruntime-web` npm version; extract `dist/ort.wasm.mjs`,
   `dist/ort-wasm-simd-threaded.{mjs,wasm}` unmodified.
2. Compute and record SHA-256 for each file in the table above BEFORE
   committing; verify no other runtime file is referenced.
3. Re-run the embeddings parity test (fixture vs vendored runtime) and the
   quality eval.

## Shipped license texts

Redistribution requires the upstream license terms to accompany the
artifacts, so the texts are vendored here and packed with the package:

| file | covers |
|---|---|
| `licenses/Apache-2.0.txt` | the MiniLM model weights (Apache-2.0, canonical text from apache.org) |
| `licenses/onnxruntime-LICENSE.txt` | the vendored onnxruntime-web subset (MIT, Microsoft Corporation, verbatim from the upstream repository) |

Upstream NOTICE check (recorded): neither the onnxruntime repository nor the
Hugging Face model repositories ship a NOTICE file (verified 2026-09-27:
`onnxruntime` NOTICE request -> 404; `Xenova/all-MiniLM-L6-v2` and
`sentence-transformers/all-MiniLM-L6-v2` raw LICENSE -> not found). Nothing
further to redistribute.
