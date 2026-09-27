/**
 * Real local embeddings for semantic search (SQ4 / F49 part 3).
 *
 * Replaces/augments the hashed subword scorer with a real sentence-embedding
 * model (int8 all-MiniLM-L6-v2 via @huggingface/transformers, ONNX WASM
 * backend — no native addon, SEA-binary friendly). The model is VENDORED in
 * the repo (`packages/core/vendor/models`) and loaded with remote downloads
 * disabled: no network is touched, ever.
 *
 * Cost model, measured on the reference box (M-series Mac):
 *  - one-time corpus embedding at 15K docs: ~56 s batched, cooperative
 *    (chunked with yields so the event loop stays responsive);
 *  - vectors persisted in the catalog cache keyed by (modelId, text hash),
 *    int8-quantized per vector (~390 B/doc => ~6 MB for 15K), so a warm
 *    start hydrates from disk and re-embeds only changed documents;
 *  - query embedding: ~10-15 ms; cosine over pre-fetched candidates is
 *    negligible.
 *
 * Failure policy: if the model cannot load (corrupt/missing files), load()
 * reports failure and the hub degrades to the previous hashed scorer with a
 * warning — search must never break because an embedding model is missing.
 */
import type { ActionRecord } from "../types.js";
import type { SemanticScorer } from "./search.js";
import { fingerprintOf } from "./semantic.js";

/** Model shipped in packages/core/vendor/models. MIT/Apache-2.0 licensed. */
export const EMBEDDING_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIMS = 384;

export interface EmbeddingIndexOptions {
  /** Vendored model root (contains <modelId> subdirectories). */
  modelPath?: string;
  modelId?: string;
  /** Quantization of the ONNX file ("q8" matches the vendored artifact). */
  dtype?: "q8" | "fp32";
  /** Called with warnings (stderr by default, MCP-safe). */
  onWarning?: (message: string) => void;
}

/** Structural type for the transformers.js feature-extraction pipeline. */
type FeatureExtractionPipeline = (
  texts: string | string[],
  options?: Record<string, unknown>,
) => Promise<{ data: Float32Array; dims: number[] }>;
/** A single document vector, int8-quantized for persistence. */
interface StoredVector {
  /** Fingerprint of the text that produced the vector (invalidation key). */
  fingerprint: string;
  /** int8 quantized values, length = EMBEDDING_DIMS. */
  q: Int8Array;
  /** absmax scale used at quantization time. */
  scale: number;
}

export interface PersistedEmbeddings {
  modelId: string;
  dims: number;
  /** Per-action quantized vectors, keyed by action id. */
  vectors: Record<string, { h: string; q: string; s: number }>;
}

function warnDefault(message: string): void {
  process.stderr.write(`action-hub: ${message}\n`);
}

export class EmbeddingSemanticIndex {
  readonly #options: Required<Pick<EmbeddingIndexOptions, "modelPath" | "modelId" | "dtype">> & EmbeddingIndexOptions;
  readonly #onWarning: (message: string) => void;
  #vectors = new Map<string, StoredVector>();
  #pipe?: FeatureExtractionPipeline;
  #loadFailed = false;

  constructor(options: EmbeddingIndexOptions = {}) {
    this.#options = {
      modelPath: options.modelPath ?? defaultVendorPath(),
      modelId: options.modelId ?? EMBEDDING_MODEL_ID,
      dtype: options.dtype ?? "q8",
      onWarning: options.onWarning,
    };
    this.#onWarning = options.onWarning ?? warnDefault;
  }

  get modelId(): string {
    return this.#options.modelId;
  }

  get dims(): number {
    return EMBEDDING_DIMS;
  }

  /** Whether the model loaded and scoring is active. */
  get ready(): boolean {
    return this.#pipe !== undefined;
  }

  get embeddedDocs(): number {
    return this.#vectors.size;
  }

  /**
   * Loads the vendored model. Idempotent. Returns false when the model is
   * unavailable — the caller must then fall back to the hashed scorer.
   */
  async load(): Promise<boolean> {
    if (this.#pipe) return true;
    if (this.#loadFailed) return false;
    try {
      const { pipeline, env } = await import("@huggingface/transformers");
      // Vendored, offline: never touch the network, never consult the cache.
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.localModelPath = this.#options.modelPath;
      this.#pipe = (await pipeline("feature-extraction", this.#options.modelId, {
        dtype: this.#options.dtype,
      })) as unknown as FeatureExtractionPipeline;
      return true;
    } catch (cause) {
      this.#loadFailed = true;
      this.#onWarning(`embedding model unavailable, falling back to the built-in semantic scorer (${String(cause).slice(0, 200)})`);
      return false;
    }
  }

  /** Document text fed to the model: name first, then the full text. */
  #documentText(record: ActionRecord): string {
    return `${record.name.replace(/_/g, " ")}. ${record.summary} ${record.description ?? ""}`.slice(0, 512);
  }

  /**
   * Embeds the given records cooperatively: yields to the event loop between
   * chunks and reports progress. Only documents whose text fingerprint is
   * missing or changed are embedded (incremental).
   * @returns the number of documents newly embedded.
   */
  async index(
    records: readonly ActionRecord[],
    { chunkSize = 64, yieldFn = defaultYield }: { chunkSize?: number; yieldFn?: () => Promise<void> } = {},
  ): Promise<number> {
    if (!this.#pipe && !(await this.load())) return 0;
    const todo = records.filter((record) => {
      const fingerprint = fingerprintOf(record);
      const cached = this.#vectors.get(record.id);
      return !cached || cached.fingerprint !== fingerprint;
    });
    let embedded = 0;
    for (let i = 0; i < todo.length; i += chunkSize) {
      const batch = todo.slice(i, i + chunkSize);
      const outputs = await this.#pipe!(batch.map((r) => this.#documentText(r)), {
        pooling: "mean",
        normalize: true,
      });
      for (let j = 0; j < batch.length; j += 1) {
        const record = batch[j]!;
        const vec = new Float32Array(outputs.data.slice(j * EMBEDDING_DIMS, (j + 1) * EMBEDDING_DIMS));
        this.#vectors.set(record.id, quantize(vec, fingerprintOf(record)));
      }
      embedded += batch.length;
      await yieldFn();
    }
    return embedded;
  }

  /** Drops vectors for ids not in the given set (post reindex cleanup). */
  prune(aliveIds: ReadonlySet<string>): number {
    let removed = 0;
    for (const id of this.#vectors.keys()) {
      if (!aliveIds.has(id)) {
        this.#vectors.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  /** Embeds a query string. Throws if the model is not loaded. */
  async embedQuery(query: string): Promise<Float32Array> {
    if (!this.#pipe) throw new Error("embedding index not loaded");
    // Same underscore normalization as #documentText so exact-name queries
    // ("disable_user") embed like their document text.
    const output = await this.#pipe(query.replace(/_/g, " "), { pooling: "mean", normalize: true });
    return new Float32Array(output.data.slice(0, EMBEDDING_DIMS));
  }

  /**
   * Score [0,1]-normalized cosine per candidate, index-aligned with
   * candidates. Documents without a (current) vector score 0 — lexical
   * ranking still covers them, and the fusion layer tolerates the zeros.
   */
  asScorer(): SemanticScorer {
    return async (query, candidates) => {
      if (!this.#pipe) return new Array(candidates.length).fill(0);
      const q = await this.embedQuery(query);
      return candidates.map((record) => {
        const cached = this.#vectors.get(record.id);
        if (!cached) return 0;
        const vec = dequantize(cached);
        let dot = 0;
        for (let i = 0; i < q.length; i += 1) dot += q[i]! * vec[i]!;
        // cosine of unit vectors is in [-1, 1]; clamp into [0, 1].
        return Math.min(1, Math.max(0, dot));
      });
    };
  }

  /** Serializes the vector map for the catalog cache (int8, base64). */
  toPersisted(): PersistedEmbeddings {
    const vectors: PersistedEmbeddings["vectors"] = {};
    for (const [id, stored] of this.#vectors) {
      vectors[id] = { h: stored.fingerprint, q: encodeInt8(stored.q), s: stored.scale };
    }
    return { modelId: this.#options.modelId, dims: EMBEDDING_DIMS, vectors };
  }

  /** Hydrates vectors persisted by a previous run (same model only). */
  hydrate(persisted: PersistedEmbeddings | undefined): number {
    if (!persisted || persisted.modelId !== this.#options.modelId || persisted.dims !== EMBEDDING_DIMS) return 0;
    let loaded = 0;
    for (const [id, entry] of Object.entries(persisted.vectors ?? {})) {
      try {
        this.#vectors.set(id, { fingerprint: entry.h, q: decodeInt8(entry.q), scale: entry.s });
        loaded += 1;
      } catch {
        /* corrupt entry -> will re-embed lazily */
      }
    }
    return loaded;
  }

  stats(): { docs: number; dims: number; modelId: string } {
    return { docs: this.#vectors.size, dims: EMBEDDING_DIMS, modelId: this.#options.modelId };
  }
}

function defaultYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Default vendored model root, resolved relative to this module. */
function defaultVendorPath(): string {
  // dist/search/embeddings.js -> ../../vendor/models
  return new URL("../../vendor/models", import.meta.url).pathname;
}

function quantize(vec: Float32Array, fingerprint: string): StoredVector {
  let absmax = 0;
  for (let i = 0; i < vec.length; i += 1) absmax = Math.max(absmax, Math.abs(vec[i]!));
  const scale = absmax > 0 ? absmax / 127 : 1;
  const q = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i += 1) q[i] = Math.round(vec[i]! / scale);
  return { fingerprint, q, scale };
}

function dequantize(stored: StoredVector): Float32Array {
  const out = new Float32Array(stored.q.length);
  for (let i = 0; i < stored.q.length; i += 1) out[i] = stored.q[i]! * stored.scale;
  return out;
}

function encodeInt8(q: Int8Array): string {
  return Buffer.from(q.buffer, q.byteOffset, q.byteLength).toString("base64");
}

function decodeInt8(text: string): Int8Array {
  const buf = Buffer.from(text, "base64");
  if (buf.length !== EMBEDDING_DIMS) throw new Error(`bad vector length ${buf.length}`);
  return new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
