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
- **Runtime:** `@huggingface/transformers` 4.3.0, loaded with
  `allowRemoteModels=false` and `localModelPath` pointed at this directory
  (or at `ACTION_HUB_EMBEDDINGS_MODEL` for bundled-binary hosts that extract
  these files at startup).

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
