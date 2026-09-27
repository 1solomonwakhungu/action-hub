/**
 * Real local embeddings for semantic search (SQ4; WASM-only per SQ4-R2).
 *
 * Pipeline: own faithful BERT WordPiece tokenizer (search/tokenizer.ts,
 * pinned by vector-parity fixtures) -> direct onnxruntime-web WASM session
 * (vendored: vendor/ort/{ort.wasm.mjs,ort-wasm-simd-threaded.{mjs,wasm}})
 * over the vendored int8 all-MiniLM-L6-v2 -> mean-pooled L2-normalized
 * vectors. NO native addons anywhere in the tree (the @huggingface/
 * transformers runtime was dropped with its onnxruntime-node/sharp
 * requirements); nothing is fetched at runtime.
 *
 * Cost model (WASM, reference box):
 *  - one-time corpus embedding at 15K docs: minutes (measured honestly below
 *    in the PR), cooperative (chunked with event-loop yields);
 *  - vectors persisted in the catalog cache keyed by (modelId, backend,
 *    dims), int8-quantized (~390 B/doc => ~6 MB for 15K); a warm start
 *    hydrates from disk and re-embeds only changed documents;
 *  - query embedding: tens of ms; cosine over cached fp32 is negligible.
 *
 * Failure policy: if the model or ORT cannot load (corrupt/missing), load()
 * reports failure and the hub degrades to the previous hashed scorer with a
 * warning — search must never break because an embedding model is missing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ActionRecord } from "../types.js";
import type { SemanticScorer } from "./search.js";
import { fingerprintOf } from "./semantic.js";
import { encode, loadTokenizer, type TokenizerData } from "./tokenizer.js";

/** Model shipped in packages/core/vendor/models. Apache-2.0 (see vendor/VENDOR.md). */
export const EMBEDDING_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIMS = 384;
/** ORT build + wasm binary are vendored alongside the model (MIT; see VENDOR.md). */
const ORT_MODULE = "ort.wasm.mjs";
/** ORT module segment under vendor/ort (module or wasm binary). */
const ORT_WASM = "ort-wasm-simd-threaded.wasm";

/**
 * SEA asset keys (build-binary.mjs embeds the vendor tree verbatim):
 * extracted to a temp dir at first embeddings load inside a bundled binary,
 * because import.meta.url is unusable there (esbuild emits import_meta = {}).
 */
const SEA_ASSETS = [
  "vendor/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx",
  "vendor/models/Xenova/all-MiniLM-L6-v2/tokenizer.json",
  "vendor/models/Xenova/all-MiniLM-L6-v2/tokenizer_config.json",
  "vendor/models/Xenova/all-MiniLM-L6-v2/config.json",
  `vendor/ort/${ORT_MODULE}`,
  "vendor/ort/ort-wasm-simd-threaded.mjs",
  `vendor/ort/${ORT_WASM}`,
];
/** Provenance + third-party license texts, written NEXT TO the extraction
 * tree so a downloaded standalone binary still carries the upstream terms. */
const SEA_LICENSE_ASSETS = [
  "vendor/VENDOR.md",
  "vendor/licenses/Apache-2.0.txt",
  "vendor/licenses/onnxruntime-LICENSE.txt",
];
let seaVendor: { modelRoot: string; ortDir: string } | null | undefined;

export interface EmbeddingIndexOptions {
  /** Vendored model root (contains <modelId> subdirectories). */
  modelPath?: string;
  modelId?: string;
  /** Called with warnings (stderr by default, MCP-safe). */
  onWarning?: (message: string) => void;
}

/** WASM-only by construction; the persisted key pins it for cache safety. */
export const EMBEDDING_BACKEND = "wasm";

export interface PersistedEmbeddings {
  modelId: string;
  /** Backend the vectors were produced with — "wasm" (the only one). */
  backend: string;
  dims: number;
  /** Per-action quantized vectors, keyed by action id. */
  vectors: Record<string, { h: string; q: string; s: number }>;
}

function warnDefault(message: string): void {
  process.stderr.write(`action-hub: ${message}\n`);
}

/** Structural shape of the vendored ORT module we rely on. */
interface OrtLike {
  Tensor: new (type: string, data: BigInt64Array | Float32Array, dims: number[]) => { data: Float32Array | BigInt64Array; dims: number[] };
  InferenceSession: {
    create(model: Uint8Array, options: { executionProviders: string[] }): Promise<{
      inputNames: readonly string[];
      outputNames: readonly string[];
      run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: number[] }>>;
    }>;
  };
  env: { wasm: { numThreads?: number; wasmBinary?: Uint8Array } };
}

export class EmbeddingSemanticIndex {
  readonly #options: Required<Pick<EmbeddingIndexOptions, "modelId">> & EmbeddingIndexOptions;
  readonly #onWarning: (message: string) => void;
  #vectors = new Map<string, StoredVector>();
  #tokenizer?: TokenizerData;
  #session?: Awaited<ReturnType<OrtLike["InferenceSession"]["create"]>>;
  #ortTensor?: OrtLike["Tensor"];
  #loadFailed = false;

  constructor(options: EmbeddingIndexOptions = {}) {
    this.#options = {
      // Resolution deferred to load() — see defaultVendorPath — so a bundled
      // (SEA) context without a resolvable module anchor can still supply the
      // model path via ACTION_HUB_EMBEDDINGS_MODEL.
      modelPath: options.modelPath ?? "",
      modelId: options.modelId ?? EMBEDDING_MODEL_ID,
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

  get backend(): string {
    return EMBEDDING_BACKEND;
  }

  /** Whether the model loaded and scoring is active. */
  get ready(): boolean {
    return this.#session !== undefined;
  }

  get embeddedDocs(): number {
    return this.#vectors.size;
  }

  /**
   * Loads the vendored tokenizer + WASM session. Idempotent. Returns false
   * when anything is unavailable — the caller must then fall back to the
   * hashed scorer.
   */
  async load(): Promise<boolean> {
    if (this.#session) return true;
    if (this.#loadFailed) return false;
    try {
      // Precedence (review-1 round 4): an EXPLICIT caller/modelPath or env
      // override wins over the embedded SEA assets — a caller pointing at a
      // different (or deliberately invalid) model must get exactly what they
      // asked for, and no 35MB extraction happens needlessly. The embedded
      // extraction is used only when nothing else is configured.
      const explicitModel = this.#options.modelPath || process.env["ACTION_HUB_EMBEDDINGS_MODEL"] || "";
      // ORT is ALWAYS needed (even with a caller-supplied model, the bundled
      // binary has no resolvable vendor/ort — review-1 round 5 HIGH 2); the
      // embedded MODEL is extracted only when nothing else is configured.
      const sea = await seaVendorRoot(!explicitModel);
      const modelRoot = explicitModel || sea?.modelRoot || defaultVendorPath();
      if (!modelRoot) {
        throw new Error(
          "no model path: set ACTION_HUB_EMBEDDINGS_MODEL (bundled binary hosts extract the vendored model and point this at it)",
        );
      }
      const modelDir = `${modelRoot}/${this.#options.modelId}`;
      this.#tokenizer = loadTokenizer(`${modelDir}/tokenizer.json`);
      const ortDir = process.env["ACTION_HUB_EMBEDDINGS_ORT_DIR"] || sea?.ortDir || "";
      const ortUrl = ortDir
        ? pathToFileURL(`${ortDir}/${ORT_MODULE}`)
        : new URL(`../../vendor/ort/${ORT_MODULE}`, import.meta.url);
      const ort = (await import(ortUrl.href)) as unknown as OrtLike;
      ort.env.wasm.numThreads = 1;
      // Feed ORT the wasm binary directly: the web build resolves wasmPaths
      // with fetch(), which cannot read file:// URLs in Node.
      const wasmPath = ortDir
        ? `${ortDir}/${ORT_WASM}`
        : fileURLToPath(new URL(`../../vendor/ort/${ORT_WASM}`, import.meta.url));
      ort.env.wasm.wasmBinary = readFileSync(wasmPath);
      const modelBytes = readFileSync(`${modelDir}/onnx/model_quantized.onnx`);
      this.#ortTensor = ort.Tensor;
      this.#session = await ort.InferenceSession.create(new Uint8Array(modelBytes), {
        executionProviders: ["wasm"],
      });
      return true;
    } catch (cause) {
      this.#loadFailed = true;
      this.#onWarning(`embedding model unavailable, falling back to the built-in semantic scorer (${String(cause).slice(0, 200)})`);
      return false;
    }
  }

  /** Document text fed to the model: name first, then the full text. */
  #documentText(record: ActionRecord): string {
    return `${record.name.replace(/_/g, " ")}. ${record.summary} ${record.description ?? ""}`.slice(0, 256);
  }

  /** Embeds a batch of texts: tokenize, pad, run, mean-pool, normalize. */
  async #embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
    if (!this.#session || !this.#tokenizer || !this.#ortTensor) throw new Error("embedding index not loaded");
    const encoded = texts.map((text) => encode(text, this.#tokenizer!));
    const maxLen = Math.max(...encoded.map((ids) => ids.length));
    const batch = encoded.length;
    const inputIds = new BigInt64Array(batch * maxLen);
    const attentionMask = new BigInt64Array(batch * maxLen);
    const tokenTypeIds = new BigInt64Array(batch * maxLen);
    for (let b = 0; b < batch; b += 1) {
      const ids = encoded[b] ?? [];
      for (let t = 0; t < maxLen; t += 1) {
        const inRange = t < ids.length;
        inputIds[b * maxLen + t] = BigInt(inRange ? ids[t]! : 0);
        attentionMask[b * maxLen + t] = inRange ? 1n : 0n;
      }
    }
    const dims = [batch, maxLen];
    const makeTensor = (data: BigInt64Array): unknown =>
      new (this.#ortTensor as unknown as { new (type: string, data: BigInt64Array, dims: number[]): unknown })(
        "int64",
        data,
        dims,
      );
    const feeds: Record<string, unknown> = {
      input_ids: makeTensor(inputIds),
      attention_mask: makeTensor(attentionMask),
      token_type_ids: makeTensor(tokenTypeIds),
    };
    const output = await this.#session.run(feeds);
    const hiddenKey = Object.keys(output)[0]!;
    const hidden = output[hiddenKey]!;
    const seqLen = hidden.dims[1] ?? 0;
    const featureDim = hidden.dims[2] ?? EMBEDDING_DIMS;
    const data = hidden.data as Float32Array;
    const out: Float32Array[] = [];
    for (let b = 0; b < batch; b += 1) {
      const vec = new Float32Array(featureDim);
      let used = 0;
      const lenB = encoded[b]?.length ?? 0;
      for (let t = 0; t < Math.min(maxLen, lenB); t += 1) {
        // Mean pool over ALL non-pad tokens (attention mask), matching the
        // sentence-transformers pooling the reference vectors were built
        // with — special tokens INCLUDED.
        const base = (b * seqLen + t) * featureDim;
        for (let f = 0; f < featureDim; f += 1) vec[f] = vec[f]! + data[base + f]!;
        used += 1;
      }
      if (used > 0) for (let f = 0; f < featureDim; f += 1) vec[f] = vec[f]! / used;
      // L2 normalize (guarded against all-zero rows).
      let norm = 0;
      for (let f = 0; f < featureDim; f += 1) norm += vec[f]! * vec[f]!;
      norm = Math.sqrt(norm);
      if (norm > 0) for (let f = 0; f < featureDim; f += 1) vec[f] = vec[f]! / norm;
      out.push(vec);
    }
    return out;
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
    if (!this.#session && !(await this.load())) return 0;
    // Normalize: non-finite/non-positive/fractional chunk sizes would
    // otherwise stall the loop (0) or throw (NaN).
    const effectiveChunk = Number.isFinite(chunkSize) && chunkSize >= 1 ? Math.floor(chunkSize) : 64;
    const todo = records.filter((record) => {
      const fingerprint = fingerprintOf(record);
      const cached = this.#vectors.get(record.id);
      return !cached || cached.fingerprint !== fingerprint;
    });
    let embedded = 0;
    for (let i = 0; i < todo.length; i += effectiveChunk) {
      const batch = todo.slice(i, i + effectiveChunk);
      const vectors = await this.#embedBatch(batch.map((r) => this.#documentText(r)));
      for (let j = 0; j < batch.length; j += 1) {
        const record = batch[j]!;
        this.#vectors.set(record.id, quantize(vectors[j]!, fingerprintOf(record)));
      }
      embedded += batch.length;
      await yieldFn();
    }
    return embedded;
  }

  /** Discards ALL in-memory vectors (rebuild-failure cleanup: a partially
   * embedded map must never serve as a semantic channel — the fallback then
   * covers the whole corpus uniformly). Persisted vectors are untouched;
   * hydration can restore them on the next successful run. */
  discardVectors(): void {
    this.#vectors = new Map();
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
    const [vec] = await this.#embedBatch([query]);
    return vec!;
  }

  /**
   * Score [0,1]-normalized cosine per candidate, index-aligned with
   * candidates. Documents without a (current) vector score 0 — lexical
   * ranking still covers them, and the fusion layer tolerates the zeros.
   *
   * The QUERY text is enriched with the verb-synonym expansions (same
   * curated table, down-weighted order preserved) BEFORE embedding: a real
   * sentence encoder turns "hold the project" and "pause the project" into
   * nearby vectors anyway, and the explicit synonyms measurably improve
   * paraphrase recall (tune split). This is an embeddings-scorer-local
   * decision — the hashed scorer keeps its literal-only contract (SQ2
   * review finding 3).
   */
  asScorer(): SemanticScorer {
    return async (query, candidates) => {
      if (!this.#session) return new Array(candidates.length).fill(0);
      // Synonym-enriched query text (see method doc): literal tokens first,
      // then the down-weighted expansions from the same curated table.
      let text = query;
      try {
        const { expandQuery } = await import("./synonyms.js");
        const { QUERY_STOPWORDS, tokenize } = await import("./search.js");
        const { terms } = expandQuery(query, tokenize, 0.5, QUERY_STOPWORDS);
        text = terms.map((t) => t.term).join(" ");
      } catch {
        /* fall back to the raw query */
      }
      const q = await this.embedQuery(text);
      return candidates.map((record) => {
        const cached = this.#vectors.get(record.id);
        if (!cached) return 0;
        cached.fp32 ??= dequantize(cached);
        const vec = cached.fp32;
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
    return { modelId: this.#options.modelId, backend: EMBEDDING_BACKEND, dims: EMBEDDING_DIMS, vectors };
  }

  /** Hydrates vectors persisted by a previous run (same model only). */
  hydrate(persisted: PersistedEmbeddings | undefined): number {
    if (!persisted || persisted.modelId !== this.#options.modelId || persisted.dims !== EMBEDDING_DIMS) return 0;
    if (persisted.backend !== EMBEDDING_BACKEND) return 0;
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

interface StoredVector {
  /** Fingerprint of the text that produced the vector (invalidation key). */
  fingerprint: string;
  /** int8 quantized values, length = EMBEDDING_DIMS. */
  q: Int8Array;
  /** absmax scale used at quantization time. */
  scale: number;
  /** Lazily dequantized fp32 copy (query-time hot path; ~1.5 KiB/doc). */
  fp32?: Float32Array;
}

function defaultYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Inside a bundled SEA binary the vendor tree is embedded as assets (see
 * build-binary.mjs): extract them once to a per-process temp dir and serve
 * both the model root and the ORT module from there. Returns null outside
 * SEA, when node:sea is unavailable, or when extraction fails (callers then
 * fall back to the normal resolution paths and, ultimately, the hashed
 * scorer). Failure is cached — load() must not retry a broken extraction on
 * every scorer call.
 */
async function seaVendorRoot(wantModel: boolean): Promise<{ modelRoot: string; ortDir: string } | null> {
  if (seaVendor !== undefined) return seaVendor;
  seaVendor = null;
  try {
    const sea = (await import("node:sea")) as {
      isSea?: () => boolean;
      getRawAsset?: (key: string) => ArrayBuffer;
    };
    if (!sea.isSea?.() || !sea.getRawAsset) return null;
    const { createHash } = await import("node:crypto");
    const { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join, dirname } = await import("node:path");

    // Content-addressed cache (review-2/round 4): extract ONCE under a
    // stable per-content key and REUSE across processes. A fresh temp dir per
    // invocation leaked ~35MB per embedding-enabled process; a shared,
    // content-addressed tree is bounded (one tree per shipped asset set)
    // and survives repeated invocations. The key hashes the FULL embedded
    // asset set (review-1 round 5 hardening: model/wasm-only keys could
    // reuse stale tokenizer/config/ORT-JS/license files across releases).
    const wanted = wantModel ? SEA_ASSETS : SEA_ASSETS.filter((key) => !key.startsWith("vendor/models/"));
    const assetKeys = [...wanted, ...SEA_LICENSE_ASSETS];
    const hash = createHash("sha256");
    for (const assetKey of assetKeys) {
      hash.update(assetKey);
      hash.update(Buffer.from(sea.getRawAsset(assetKey) ?? new ArrayBuffer(0)));
    }
    // Private per-user cache root (review-2 round 5, MUST-FIX 1 — cache
    // tampering): a shared world-writable tmp tree that only trusts
    // existsSync let another user pre-create/plant the directory, and
    // load() IMPORTS the cached ORT JS — planted code would execute.
    // The cache therefore lives under a 0700 per-uid directory we create and
    // verify (owner + mode + no symlinks), and every extracted asset is
    // authenticated against the SHA-256 of the bytes embedded in the binary
    // before ANY reuse/import.
    const uid = typeof process.getuid === "function" ? String(process.getuid()) : "unknown";
    const cacheBase = join(tmpdir(), `action-hub-cache-${uid}`);
    const { statSync, lstatSync, mkdtempSync } = await import("node:fs");
    // A pre-existing base that is foreign-owned or loose-mode is NEVER reused
    // or chmod'ed (intake round 5): fall back to a fresh private mkdtemp
    // (0700) so the run still works; the shared cache is simply skipped.
    // Candidate bases, in order (intake round 5): the per-uid tmp cache dir;
    // the user cache dir (XDG_CACHE_HOME / %LOCALAPPDATA% / ~/.cache) when
    // tmpdir itself is unusable (e.g. a TMPDIR pointing at a nonexistent
    // tree); a fresh private mkdtemp as the final filesystem resort. A base
    // that is foreign-owned or loose-mode is never reused or chmod'ed.
    const usable = (dir: string): boolean => {
      try {
        const st = statSync(dir);
        return (
          st.isDirectory() &&
          !(st.mode & 0o077) &&
          (typeof process.getuid !== "function" || st.uid === process.getuid())
        );
      } catch {
        return false;
      }
    };
    const userCache = join(
      process.env["XDG_CACHE_HOME"] || process.env["LOCALAPPDATA"] || join(process.env["HOME"] ?? tmpdir(), ".cache"),
      "action-hub",
    );
    const privateFallback = (): string => {
      try {
        return mkdtempSync(join(userCache, "cache-"));
      } catch {
        return mkdtempSync(join(tmpdir(), "action-hub-cache-"));
      }
    };
    let base = cacheBase;
    if (!usable(base)) {
      try {
        mkdirSync(cacheBase, { recursive: true, mode: 0o700 });
      } catch {
        /* fall through to the user cache dir */
      }
      if (!usable(base)) {
        try {
          mkdirSync(userCache, { recursive: true, mode: 0o700 });
        } catch {
          /* final fallback below */
        }
        base = usable(cacheBase) ? cacheBase : usable(userCache) ? userCache : privateFallback();
      }
    }
    const root = join(base, `vendor-${hash.digest("hex").slice(0, 16)}`);
    const readFileF = (await import("node:fs/promises")).readFile;
    const sha256Bytes = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
    // Expected hashes are computed from the bytes EMBEDDED IN THE BINARY
    // (getRawAsset) — a compile-time source of truth an on-disk attacker
    // cannot rewrite. No disk manifest is trusted for authentication.
    const expected = new Map<string, string>();
    for (const assetKey of assetKeys) {
      expected.set(assetKey, sha256Bytes(Buffer.from(sea.getRawAsset(assetKey) ?? new ArrayBuffer(0))));
    }
    const verifyTree = async (): Promise<boolean> => {
      // No symlinks anywhere in the tree; every needed file must be a regular
      // file whose bytes hash to the EMBEDDED asset's SHA-256.
      try {
        for (const assetKey of assetKeys) {
          const st = lstatSync(join(root, assetKey));
          if (!st.isFile()) return false;
          if (sha256Bytes(await readFileF(join(root, assetKey))) !== expected.get(assetKey)) return false;
        }
        return true;
      } catch {
        return false;
      }
    };
    if (!(await verifyTree())) {
      // Missing/corrupt/stale/foreign tree: extract fresh. If the existing
      // tree cannot be replaced (not ours), extraction fails -> fail closed.
      const staging = `${root}.staging-${process.pid}`;
      rmSync(staging, { recursive: true, force: true });
      try {
        for (const assetKey of assetKeys) {
          const bytes = sea.getRawAsset(assetKey);
          if (!bytes) throw new Error(`SEA asset missing: ${assetKey}`);
          const target = join(staging, assetKey);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, Buffer.from(bytes), { mode: 0o600 });
        }
        mkdirSync(base, { recursive: true, mode: 0o700 });
        try {
          rmSync(root, { recursive: true, force: true });
        } catch {
          /* a tree we do not own — rename below will fail and fail closed */
        }
        renameSync(staging, root);
      } catch (cause) {
        // Partial-failure cleanup: never leave a half-written cache tree.
        rmSync(staging, { recursive: true, force: true });
        throw cause;
      }
    }

    // Process-global handoff (NOT module state): a bundled binary can contain
    // more than one copy of this module (package entry + deep imports), and
    // each copy has its own cache. Writing the env vars once (first copy
    // wins) makes the extraction visible to every copy. The MODEL env is
    // only set when the embedded model was actually extracted — a caller's
    // explicit ACTION_HUB_EMBEDDINGS_MODEL must never be overwritten.
    // The extraction created intermediate dirs with the default mode; the
    // private tree must be 0700 end to end (we own it — chmod is safe).
    try {
      const { chmodSync } = await import("node:fs");
      chmodSync(root, 0o700);
      chmodSync(join(root, "vendor"), 0o700);
    } catch {
      /* gated below */
    }
    // Import gate (intake round 5): the tree must be owned + 0700 AT THIS
    // MOMENT (closes the swap-after-verify window as far as stat allows);
    // every file load() imports was hashed in verifyTree against the bytes
    // embedded in this binary.
    const rootSt = statSync(root);
    if (!rootSt.isDirectory() || rootSt.mode & 0o077 || (typeof process.getuid === "function" && rootSt.uid !== process.getuid())) {
      throw new Error(`embeddings cache tree not private: ${root}`);
    }
    const ortDir = join(root, "vendor/ort");
    process.env["ACTION_HUB_EMBEDDINGS_ORT_DIR"] ??= ortDir;
    const modelRoot = wantModel ? join(root, "vendor/models") : undefined;
    if (modelRoot) process.env["ACTION_HUB_EMBEDDINGS_MODEL"] ??= modelRoot;
    seaVendor = { modelRoot: modelRoot ?? "", ortDir };
  } catch {
    /* fall back to normal resolution */
  }
  return seaVendor;
}

/**
 * Default vendored model root, resolved relative to this module.
 *
 * Precedence: the ACTION_HUB_EMBEDDINGS_MODEL env var wins (bundled-binary
 * hosts extract the vendored model into a temp dir and point this at it —
 * SEA bundles define import.meta.url to a non-file anchor, so the URL
 * resolution below must never throw there).
 */
function defaultVendorPath(): string {
  const fromEnv = process.env["ACTION_HUB_EMBEDDINGS_MODEL"];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  try {
    // dist/search/embeddings.js -> ../../vendor/models
    return fileURLToPath(new URL("../../vendor/models", import.meta.url));
  } catch {
    return "";
  }
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
