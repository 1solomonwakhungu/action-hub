import type { ActionRecord } from "../types.js";
import { tokenize, type SemanticScorer } from "./search.js";

/**
 * A dependency-free semantic scorer.
 *
 * The design constraint is that Action Hub must install and start without
 * downloading model weights, so this is a *self-contained* vector space model
 * built from the catalog itself. Two signals are combined:
 *
 * 1. **Subword hashing.** Every term is projected onto a fixed-width vector by
 *    hashing the term plus its character n-grams into sparse ternary index
 *    vectors. This makes morphological variants ("repo" / "repository",
 *    "notify" / "notification", "merge" / "merging") close in the space, which
 *    is a class of query BM25 cannot match at all — a term either occurs or it
 *    does not.
 *
 * 2. **A concept lexicon.** Subword similarity is purely orthographic, so it
 *    can never bridge a true paraphrase: "virtual machine" and "instance"
 *    share no substring. Terms belonging to a known concept therefore also
 *    receive that concept's anchor vector, pulling synonyms together. The
 *    built-in lexicon covers the operational vocabulary MCP catalogs use, and
 *    callers can extend or replace it via {@link LocalSemanticOptions.concepts}.
 *
 * An earlier revision instead derived term relatedness from catalog
 * co-occurrence (random indexing). Measured against a labeled query set it was
 * actively harmful: pulling every term toward its document's centroid destroyed
 * the discrimination between actions from the same server, which is exactly
 * where ranking is hardest. It was removed rather than left switched off.
 *
 * Both parts are deterministic — the same catalog always produces the same
 * vectors — so retrieval is reproducible and the evaluation suite can assert
 * on exact rankings.
 *
 * Everything expensive happens in {@link LocalSemanticIndex.index}, which the
 * hub calls once per (re)index. A query only has to embed a handful of query
 * terms and take dot products against precomputed unit vectors.
 */
export interface LocalSemanticOptions {
  /** Embedding width. Larger reduces hash collisions at linear memory cost. */
  dimensions?: number;
  /** Non-zero entries per hashed feature. */
  sparsity?: number;
  /** Shortest character n-gram used for subword matching. */
  minNgram?: number;
  /** Longest character n-gram used for subword matching. */
  maxNgram?: number;
  /** Weight of the subword signal relative to the whole-term signal. */
  subwordWeight?: number;
  /** Weight of the concept anchor relative to the term's own vector. */
  conceptWeight?: number;
  /**
   * Extra concept groups, merged over the built-in lexicon. Each key is a
   * concept name and each value lists the terms that evoke it; every term in a
   * group is pulled toward a shared anchor, so they match one another even
   * with no characters in common.
   */
  concepts?: Readonly<Record<string, readonly string[]>>;
  /** Replaces the built-in lexicon entirely instead of extending it. */
  replaceConcepts?: boolean;
  /**
   * Lower bound on the divisor used to normalize cosine similarities into
   * [0, 1]. Scores are divided by `max(bestCosine, scaleFloor)`, so a query
   * the catalog genuinely covers saturates near 1 while a query nothing
   * resembles stays small instead of being stretched to look confident.
   */
  scaleFloor?: number;
}

export interface SemanticIndexStats {
  documents: number;
  terms: number;
  dimensions: number;
}

const DEFAULTS = {
  dimensions: 256,
  sparsity: 8,
  minNgram: 3,
  maxNgram: 4,
  subwordWeight: 1,
  conceptWeight: 1.1,
  scaleFloor: 0.35,
} as const;

/**
 * Synonym groups for the vocabulary MCP catalogs actually use. This is
 * deliberately small and operational rather than an attempt at a general
 * thesaurus: it only has to cover the concepts action catalogs express, and
 * anything it misses degrades to subword and lexical matching.
 */
export const DEFAULT_CONCEPTS: Readonly<Record<string, readonly string[]>> = {
  machine: ["instance", "vm", "machine", "server", "host", "node", "droplet", "container", "ec2"],
  start: ["start", "boot", "launch", "power", "spin", "provision", "resume", "run", "up", "on"],
  stop: ["stop", "halt", "shutdown", "terminate", "kill", "destroy", "down", "off", "pause", "turn"],
  create: ["create", "add", "new", "open", "file", "make", "submit", "register", "insert", "cut"],
  delete: ["delete", "remove", "destroy", "purge", "drop", "erase", "clear"],
  update: ["update", "edit", "modify", "change", "patch", "set", "rename", "replace", "line"],
  read: ["get", "read", "fetch", "show", "describe", "view", "inspect", "retrieve"],
  list: ["list", "search", "find", "query", "browse", "enumerate", "index"],
  message: ["message", "chat", "post", "send", "notify", "announce", "tell", "dm", "speak"],
  comment: ["comment", "discussion", "reply", "note", "leave", "remark"],
  alert: ["alert", "page", "incident", "oncall", "escalate", "wake", "alarm", "outage"],
  refund: ["refund", "reimburse", "return", "money", "back", "credit", "reversal", "chargeback"],
  optimize: ["optimize", "optimization", "faster", "slow", "performance", "speed", "tuning", "tune", "accelerate"],
  error: ["error", "errors", "exception", "fault", "crash", "failure", "broken"],
  task: [
    "issue",
    "ticket",
    "task",
    "bug",
    "story",
    "todo",
    "backlog",
    "assignment",
    "work",
    "supposed",
  ],
  review: ["review", "approve", "pr", "pull", "request", "feedback", "critique"],
  merge: ["merge", "land", "integrate", "squash", "rebase", "ship"],
  repository: ["repo", "repository", "codebase", "project", "source"],
  file: ["file", "object", "blob", "document", "artifact", "attachment"],
  storage: ["storage", "bucket", "store", "upload", "download", "save", "persist", "s3"],
  metric: ["metric", "telemetry", "timeseries", "stat", "measurement", "gauge", "monitor"],
  log: ["log", "logs", "trace", "event", "audit", "history", "events", "cloudwatch"],
  deploy: ["deploy", "release", "rollout", "publish", "promote", "ship", "version"],
  user: [
    "user",
    "account",
    "member",
    "person",
    "assignee",
    "owner",
    "me",
    "my",
    "mine",
    "i",
    "you",
    "current",
  ],
  permission: ["permission", "access", "role", "grant", "policy", "scope", "auth"],
  schedule: ["schedule", "cron", "timer", "recurring", "interval", "calendar"],
  database: ["database", "db", "table", "sql", "record", "row", "schema"],
  branch: ["branch", "commit", "tag", "revision", "checkout"],
};

/** Field weights when flattening an action into a bag of terms. */
const NAME_WEIGHT = 2;
const SERVER_WEIGHT = 0.5;
const SUMMARY_WEIGHT = 1;
const DESCRIPTION_WEIGHT = 0.5;
const TAG_WEIGHT = 1;

/** Terms longer than this are hashed whole; n-gramming them is not useful. */
const MAX_SUBWORD_TERM = 32;

interface IndexedDocument {
  id: string;
  fingerprint: string;
  terms: Map<string, number>;
  weightSum: number;
}

interface CachedVector {
  fingerprint: string;
  vector: Float32Array;
}

export class LocalSemanticIndex {
  readonly #dimensions: number;
  readonly #sparsity: number;
  readonly #minNgram: number;
  readonly #maxNgram: number;
  readonly #subwordWeight: number;
  readonly #conceptWeight: number;
  readonly #scaleFloor: number;
  /** Term -> concept names. A term may evoke more than one concept. */
  readonly #conceptsByTerm: ReadonlyMap<string, readonly string[]>;

  /** Hash-derived term vectors; independent of the catalog, so never cleared. */
  readonly #features = new Map<string, Float32Array>();
  #documents = new Map<string, CachedVector>();
  #idf = new Map<string, number>();
  #documentCount = 0;

  constructor(options: LocalSemanticOptions = {}) {
    this.#dimensions = Math.max(32, Math.floor(options.dimensions ?? DEFAULTS.dimensions));
    this.#sparsity = Math.max(2, Math.floor(options.sparsity ?? DEFAULTS.sparsity));
    this.#minNgram = Math.max(2, Math.floor(options.minNgram ?? DEFAULTS.minNgram));
    this.#maxNgram = Math.max(this.#minNgram, Math.floor(options.maxNgram ?? DEFAULTS.maxNgram));
    this.#subwordWeight = Math.max(0, options.subwordWeight ?? DEFAULTS.subwordWeight);
    this.#conceptWeight = Math.max(0, options.conceptWeight ?? DEFAULTS.conceptWeight);
    this.#scaleFloor = Math.min(1, Math.max(1e-6, options.scaleFloor ?? DEFAULTS.scaleFloor));
    this.#conceptsByTerm = invertConcepts(
      options.replaceConcepts
        ? (options.concepts ?? {})
        : { ...DEFAULT_CONCEPTS, ...(options.concepts ?? {}) },
    );
  }

  stats(): SemanticIndexStats {
    return {
      documents: this.#documents.size,
      terms: this.#idf.size,
      dimensions: this.#dimensions,
    };
  }

  /**
   * Rebuilds every document embedding. Called once per catalog change so that
   * query time stays proportional to the query, not to the catalog.
   */
  index(records: readonly ActionRecord[]): void {
    const documents = records.map((record) => describe(record));
    this.#documentCount = documents.length;
    this.#documents = new Map();
    this.#idf = new Map();

    if (documents.length === 0) return;

    const docFreq = new Map<string, number>();
    for (const document of documents) {
      for (const term of document.terms.keys()) {
        docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
      }
    }
    for (const [term, df] of docFreq) {
      this.#idf.set(term, Math.log(1 + documents.length / (df + 0.5)));
    }

    for (const document of documents) {
      const vector = this.#embed(document.terms);
      if (vector) this.#documents.set(document.id, { fingerprint: document.fingerprint, vector });
    }
  }

  /**
   * Returns a [0, 1] relevance score per candidate, index-aligned, as the
   * `SemanticScorer` contract requires.
   */
  score(query: string, candidates: readonly ActionRecord[]): number[] {
    const zeros = candidates.map(() => 0);
    const terms = tokenize(query);
    if (terms.length === 0 || candidates.length === 0) return zeros;

    const weights = new Map<string, number>();
    for (const term of terms) weights.set(term, (weights.get(term) ?? 0) + 1);
    const queryVector = this.#embed(weights);
    if (!queryVector) return zeros;

    let best = 0;
    const raw = candidates.map((candidate) => {
      const vector = this.#documentVector(candidate);
      if (!vector) return 0;
      const similarity = Math.max(0, dot(queryVector, vector));
      if (similarity > best) best = similarity;
      return similarity;
    });

    const scale = Math.max(best, this.#scaleFloor);
    return raw.map((value) => Math.min(1, value / scale));
  }

  /** Adapts this index to the `SearchEngine` hook. */
  asScorer(): SemanticScorer {
    return async (query, candidates) => this.score(query, candidates);
  }

  /**
   * Embeddings are precomputed, but a record the index has not seen (or one
   * whose text changed since the last rebuild) is embedded on demand rather
   * than silently scored as zero.
   */
  #documentVector(record: ActionRecord): Float32Array | undefined {
    const cached = this.#documents.get(record.id);
    const fingerprint = fingerprintOf(record);
    if (cached && cached.fingerprint === fingerprint) return cached.vector;

    const document = describe(record);
    const vector = this.#embed(document.terms);
    if (vector) this.#documents.set(record.id, { fingerprint, vector });
    return vector;
  }

  #embed(terms: ReadonlyMap<string, number>): Float32Array | undefined {
    const accumulator = new Float32Array(this.#dimensions);
    for (const [term, weight] of terms) {
      addScaled(accumulator, this.#feature(term), weight * this.#idfOf(term));
    }
    return normalized(accumulator);
  }

  /** Unseen terms are treated as maximally specific rather than ignored. */
  #idfOf(term: string): number {
    const known = this.#idf.get(term);
    if (known !== undefined) return known;
    return Math.log(1 + Math.max(1, this.#documentCount) / 0.5);
  }

  /**
   * Hash embedding of a single term: the whole term, its character n-grams,
   * and the anchors of any concepts it belongs to. The n-grams handle
   * morphology; the anchors handle synonymy.
   */
  #feature(term: string): Float32Array {
    const cached = this.#features.get(term);
    if (cached) return cached;

    const vector = new Float32Array(this.#dimensions);
    addScaled(vector, this.#hashVector(`w:${term}`), 1);

    if (this.#subwordWeight > 0 && term.length <= MAX_SUBWORD_TERM) {
      const grams = subwordGrams(term, this.#minNgram, this.#maxNgram);
      if (grams.length > 0) {
        const subword = new Float32Array(this.#dimensions);
        for (const gram of grams) addScaled(subword, this.#hashVector(`g:${gram}`), 1);
        const unit = normalized(subword);
        if (unit) addScaled(vector, unit, this.#subwordWeight);
      }
    }

    const concepts = this.#conceptsFor(term);
    if (concepts && this.#conceptWeight > 0) {
      // Split across concepts so an ambiguous term ("file" is both a verb and
      // a noun here) does not get more total pull than an unambiguous one.
      const share = this.#conceptWeight / concepts.length;
      for (const concept of concepts) {
        addScaled(vector, this.#hashVector(`c:${concept}`), share);
      }
    }

    const feature = normalized(vector) ?? vector;
    this.#features.set(term, feature);
    return feature;
  }

  /**
   * Concept lookup with a light morphological fallback, so an inflected query
   * word ("working", "deletion", "uploading") still reaches the concept its
   * base form belongs to. Stemming is confined to this lookup and never
   * touches the shared tokenizer, which BM25 also depends on.
   */
  #conceptsFor(term: string): readonly string[] | undefined {
    const exact = this.#conceptsByTerm.get(term);
    if (exact) return exact;
    for (const candidate of stemCandidates(term)) {
      const match = this.#conceptsByTerm.get(candidate);
      if (match) return match;
    }
    return undefined;
  }

  /** Deterministic sparse ternary index vector, seeded from the token itself. */
  #hashVector(token: string): Float32Array {
    const vector = new Float32Array(this.#dimensions);
    let state = fnv1a(token);
    for (let i = 0; i < this.#sparsity; i++) {
      state = nextState(state);
      const position = state % this.#dimensions;
      vector[position]! += state & 0x10000 ? 1 : -1;
    }
    return normalized(vector) ?? vector;
  }
}

/**
 * Convenience factory returning a scorer bound to an index, for callers that
 * want the hook without holding the index themselves.
 */
export function createLocalSemanticScorer(
  records: readonly ActionRecord[],
  options?: LocalSemanticOptions,
): SemanticScorer {
  const index = new LocalSemanticIndex(options);
  index.index(records);
  return index.asScorer();
}

/**
 * Builds the term -> concepts lookup. Concept terms are tokenized through the
 * same pipeline as documents so a multi-word entry like "virtual machine"
 * registers each of its tokens.
 */
function invertConcepts(
  concepts: Readonly<Record<string, readonly string[]>>,
): ReadonlyMap<string, readonly string[]> {
  const inverted = new Map<string, string[]>();
  for (const [concept, terms] of Object.entries(concepts)) {
    for (const raw of terms) {
      for (const term of tokenize(raw)) {
        const existing = inverted.get(term);
        if (existing) {
          if (!existing.includes(concept)) existing.push(concept);
        } else {
          inverted.set(term, [concept]);
        }
      }
    }
  }
  return inverted;
}

function describe(record: ActionRecord): IndexedDocument {
  const terms = new Map<string, number>();
  const add = (text: string | undefined, weight: number): void => {
    if (!text) return;
    for (const term of tokenize(text)) {
      terms.set(term, (terms.get(term) ?? 0) + weight);
    }
  };

  add(record.name, NAME_WEIGHT);
  add(record.serverId, SERVER_WEIGHT);
  add(record.summary, SUMMARY_WEIGHT);
  add(record.description, DESCRIPTION_WEIGHT);
  for (const tag of record.tags ?? []) add(tag, TAG_WEIGHT);

  let weightSum = 0;
  for (const weight of terms.values()) weightSum += weight;

  return { id: record.id, fingerprint: fingerprintOf(record), terms, weightSum };
}

function fingerprintOf(record: ActionRecord): string {
  return [
    record.name,
    record.serverId,
    record.summary,
    record.description ?? "",
    (record.tags ?? []).join(","),
  ].join("\u0000");
}

/** Common English suffixes, longest first so "ization" beats "ing". */
const SUFFIXES = ["ization", "ations", "ation", "ings", "ing", "ers", "er", "ies", "es", "s", "ed"];

/**
 * Cheap suffix stripping. This is not a real stemmer and does not need to be:
 * a wrong guess simply fails to find a concept, which costs nothing.
 */
function stemCandidates(term: string): string[] {
  if (term.length < 4) return [];
  const candidates: string[] = [];
  for (const suffix of SUFFIXES) {
    if (!term.endsWith(suffix)) continue;
    const stem = term.slice(0, -suffix.length);
    if (stem.length < 3) continue;
    candidates.push(stem);
    // "deletion" -> "delet" -> "delete"; "queries" -> "quer" -> "query".
    candidates.push(`${stem}e`);
    if (stem.endsWith("i")) candidates.push(`${stem.slice(0, -1)}y`);
    // "running" -> "runn" -> "run"
    const last = stem.at(-1);
    if (last && last === stem.at(-2)) candidates.push(stem.slice(0, -1));
  }
  return candidates;
}

function subwordGrams(term: string, min: number, max: number): string[] {
  const padded = `#${term}#`;
  const grams: string[] = [];
  for (let n = min; n <= max; n++) {
    if (padded.length < n) continue;
    for (let i = 0; i + n <= padded.length; i++) grams.push(padded.slice(i, i + n));
  }
  return grams;
}

function addScaled(target: Float32Array, source: Float32Array, scale: number): void {
  if (scale === 0) return;
  for (let i = 0; i < target.length; i++) target[i]! += source[i]! * scale;
}

function normalized(vector: Float32Array): Float32Array | undefined {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i]! * vector[i]!;
  if (sum <= 0) return undefined;
  const inverse = 1 / Math.sqrt(sum);
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i]! * inverse;
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) sum += a[i]! * b[i]!;
  return sum;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32 step — deterministic, cheap, and good enough for hashing. */
function nextState(state: number): number {
  let next = (state + 0x6d2b79f5) >>> 0;
  next = Math.imul(next ^ (next >>> 15), next | 1) >>> 0;
  next = (next ^ (next + Math.imul(next ^ (next >>> 7), next | 61))) >>> 0;
  return (next ^ (next >>> 14)) >>> 0;
}
