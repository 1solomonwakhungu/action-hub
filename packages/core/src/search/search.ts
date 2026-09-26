import type { ActionRecord, SearchHit, SearchOptions } from "../types.js";
import type { Catalog } from "../catalog/catalog.js";

const DEFAULT_LIMIT = 10;

/**
 * Lexical BM25-style retrieval over the catalog.
 *
 * This is the lexical half of the eventual hybrid ranker. It is deliberately
 * dependency-free and synchronous so that search stays fast and testable; a
 * semantic scorer can be blended in later via `SearchEngine#setSemanticScorer`
 * without changing any caller.
 */
export class SearchEngine {
  readonly #catalog: Catalog;
  #semanticScorer?: SemanticScorer;
  #semanticWeight = DEFAULT_SEMANTIC_WEIGHT;

  // Memoized corpus work, keyed by the catalog generation. The dominant F18
  // cost was re-tokenizing the entire corpus on every query; this cache makes
  // tokenization O(1) per record after the first pass and lets a full-corpus
  // query (the server's default path) reuse whole stats wholesale.
  #tokensCache = new Map<string, { generation: number; tokens: string[] }>();
  #fullStats?: { generation: number; stats: CorpusStats };
  #tokensGeneration = -1;

  constructor(catalog: Catalog) {
    this.#catalog = catalog;
  }

  /**
   * Registers an optional semantic scorer. Scores must be normalized to
   * [0, 1]; they are blended with the lexical score rather than replacing it,
   * so a weak embedding model degrades results gracefully instead of
   * destroying them.
   */
  setSemanticScorer(scorer: SemanticScorer | undefined): void {
    this.#semanticScorer = scorer;
  }

  /**
   * Sets the blend weight applied to the semantic signal. Clamped to [0, 1];
   * an out-of-range or non-finite value falls back to the default rather than
   * silently disabling one of the two signals.
   */
  setSemanticWeight(weight: number): void {
    this.#semanticWeight = Number.isFinite(weight)
      ? Math.min(1, Math.max(0, weight))
      : DEFAULT_SEMANTIC_WEIGHT;
  }

  get semanticWeight(): number {
    return this.#semanticWeight;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    // Invalidate the memoized corpus work BEFORE any early return: otherwise
    // a generation change followed by an empty-candidate or empty-query
    // search would retain the stale memo indefinitely (37 MiB at 15k docs).
    this.#invalidateIfChanged();
    const limit = options.limit ?? DEFAULT_LIMIT;
    const candidates = this.#catalog.filter(options);
    // Query-side stopword filtering: common function words carry no retrieval
    // signal for BM25 and only dilute the query. Document tokens are NOT
    // filtered — a record whose summary legitimately contains one of these
    // words should still match the content words around it.
    const terms = tokenize(query).filter((term) => !QUERY_STOPWORDS.has(term));

    if (candidates.length === 0) return [];

    // An empty query is a browse request, not an error: return a stable
    // alphabetical slice so callers can enumerate the catalog.
    if (terms.length === 0) {
      return candidates
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((record) => toHit(record, 0, options.includeSchema ?? false));
    }

    const stats = this.#statsFor(candidates);
    const lexical = candidates.map((record) => ({
      record,
      score: bm25(record, terms, stats),
    }));

    let ranked = lexical;
    const semantic = await this.#semanticScores(query, candidates);
    if (semantic) {
      ranked = lexical.map((entry, i) => ({
        record: entry.record,
        score: blend(entry.score, semantic[i] ?? 0, this.#semanticWeight),
      }));
    }

    const sorted = ranked
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id));

    // Optional relative cutoff: drop hits far below the best score so a weak
    // partial match cannot pad the result page. Off by default; ships only if
    // the S5 retrieval eval shows fewer no-match false positives with no
    // recall regression.
    const ratio = options.minScoreRatio;
    const cutoff =
      typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0 && ratio <= 1
        ? (sorted[0]?.score ?? 0) * ratio
        : 0;

    return sorted
      .filter((entry) => entry.score >= cutoff)
      .slice(0, limit)
      .map((entry) => toHit(entry.record, entry.score, options.includeSchema ?? false));
  }

  /**
   * Corpus stats for a candidate set, memoized across queries.
   *
   * Bit-identical to the uncached path: `buildStats` still runs over the same
   * records in the same order — the cache only removes repeated tokenization
   * and repeated whole-corpus accumulation when the catalog has not changed.
   */
  /** Drops the whole memo when the catalog generation has changed. */
  #invalidateIfChanged(): void {
    const generation = this.#catalog.generation;
    if (generation === this.#tokensGeneration) return;
    this.#tokensCache.clear();
    this.#fullStats = undefined;
    this.#tokensGeneration = generation;
  }

  /** Test-only observation point for the memo (never used in production paths). */
  get memoSizeForTest(): number {
    return this.#tokensCache.size;
  }

  /**
   * Corpus stats for a candidate set, memoized across queries.
   *
   * Bit-identical to the uncached path: `buildStats` still runs over the same
   * records in the same order — the cache only removes repeated tokenization
   * and repeated whole-corpus accumulation when the catalog has not changed.
   */
  #statsFor(candidates: readonly ActionRecord[]): CorpusStats {
    this.#invalidateIfChanged();
    const generation = this.#catalog.generation;
    // Fast path: the candidate set IS the whole catalog (the server's default
    // search path passes no filters). Reuse the stats wholesale.
    const full =
      candidates.length === this.#catalog.size && this.#catalog.size > 0;
    if (full) {
      if (this.#fullStats?.generation === generation) return this.#fullStats.stats;
      const stats = this.#buildStats(candidates, generation);
      this.#fullStats = { generation, stats };
      return stats;
    }
    return this.#buildStats(candidates, generation);
  }

  #buildStats(records: readonly ActionRecord[], generation: number): CorpusStats {
    const docFreq = new Map<string, number>();
    const termFreq = new Map<string, Map<string, number>>();
    const lengths = new Map<string, number>();
    let totalLength = 0;

    for (const record of records) {
      const tokens = this.#documentTokens(record, generation);
      const freq = new Map<string, number>();
      for (const token of tokens) {
        freq.set(token, (freq.get(token) ?? 0) + 1);
      }
      termFreq.set(record.id, freq);
      lengths.set(record.id, tokens.length);
      totalLength += tokens.length;
      for (const token of freq.keys()) {
        docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
      }
    }

    return {
      docFreq,
      docCount: records.length,
      avgLength: records.length > 0 ? totalLength / records.length : 0,
      termFreq,
      lengths,
    };
  }

  /** Tokenizes a record's document text once per catalog generation. */
  #documentTokens(record: ActionRecord, generation: number): string[] {
    const cached = this.#tokensCache.get(record.id);
    if (cached && cached.generation === generation) return cached.tokens;
    const tokens = documentTokens(record);
    this.#tokensCache.set(record.id, { generation, tokens });
    return tokens;
  }

  /**
   * Runs the semantic scorer defensively. Semantic scoring is an enhancement,
   * never a dependency: a scorer that throws, hangs on a rejected promise,
   * returns the wrong shape, or emits non-finite values must degrade search to
   * pure BM25 rather than fail the query.
   */
  async #semanticScores(
    query: string,
    candidates: readonly ActionRecord[],
  ): Promise<number[] | undefined> {
    const scorer = this.#semanticScorer;
    if (!scorer || this.#semanticWeight <= 0) return undefined;

    let scores: unknown;
    try {
      scores = await scorer(query, candidates);
    } catch {
      return undefined;
    }
    if (!Array.isArray(scores)) return undefined;

    return candidates.map((_, i) => {
      const value = scores[i];
      if (typeof value !== "number" || !Number.isFinite(value)) return 0;
      return Math.min(1, Math.max(0, value));
    });
  }
}

/** Returns a normalized [0,1] relevance score per candidate, index-aligned. */
export type SemanticScorer = (
  query: string,
  candidates: readonly ActionRecord[],
) => Promise<number[]>;

/**
 * Deliberately small so that a weak, misconfigured, or partially failing
 * embedding model shifts the ranking rather than dictating it.
 *
 * 0.2 was chosen by an independent weight sweep over the 40-query / 91-action
 * labelled set (see `packages/core/eval`). It is the setting that maximises
 * overall and paraphrase recall@1 while holding exact recall@1 at 100%; larger
 * weights let the semantic signal demote lexically-exact matches. Recorded
 * results at 0.2 vs. pure BM25: overall recall@1 70.0% → 77.5%, paraphrase
 * recall@1 43.8% → 50.0%, ambiguous recall@1 75.0% → 91.7%, MRR .804 → .863.
 */
export const DEFAULT_SEMANTIC_WEIGHT = 0.2;

function blend(lexicalScore: number, semanticScore: number, weight: number): number {
  // Lexical scores are unbounded, so squash before blending to keep the two
  // signals on comparable scales.
  const squashed = lexicalScore / (1 + lexicalScore);
  return (1 - weight) * squashed + weight * semanticScore;
}

function toHit(record: ActionRecord, score: number, includeSchema = false): SearchHit {
  return {
    id: record.id,
    kind: record.kind,
    serverId: record.serverId,
    name: record.name,
    summary: record.summary,
    score: Number(score.toFixed(6)),
    ...(includeSchema && record.inputSchema ? { inputSchema: record.inputSchema } : {}),
  };
}

interface CorpusStats {
  /** Number of documents containing each term. */
  docFreq: Map<string, number>;
  docCount: number;
  avgLength: number;
  /** Term frequencies per action id. */
  termFreq: Map<string, Map<string, number>>;
  lengths: Map<string, number>;
}

/**
 * Function words filtered from QUERIES before lexical scoring.
 *
 * Deliberately excludes every term used as a DEFAULT_CONCEPTS anchor
 * (me, my, i, you, current, on, off, up, down, back, set, open, line, cut,
 * file, work, new, show, get, list, search, …) — those carry paraphrase
 * signal in the semantic scorer and must never be dropped.
 *
 * Also deliberately excludes PREPOSITIONS (to, from, into, with, by, at, in,
 * about, via, over, under, on, …): in action catalogs they carry targeting
 * signal ("send to channel", "merge into branch", "assigned to you"), and a
 * measured regression on the semantic paraphrase suite showed that stripping
 * "to" flips a true paraphrase match. Articles, copulas, auxiliaries,
 * demonstratives, pronouns, and pure conjunctions are the conservative core.
 * A unit test asserts the intersection with the concept lexicon stays empty.
 */
export const QUERY_STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "of", "that", "this", "these", "those",
  "it", "its", "is", "are", "was", "were", "be", "been", "being", "am",
  "has", "have", "had", "do", "does", "did", "but", "when", "while",
  "which", "who", "whom", "their", "them", "they", "all", "any", "can",
  "could", "should", "would", "will", "shall", "may", "might", "must",
  "if", "then", "than", "so", "too", "very", "just", "also", "some",
  "such", "only", "same",
]);

const K1 = 1.2;
const B = 0.75;

function bm25(record: ActionRecord, terms: readonly string[], stats: CorpusStats): number {
  const freq = stats.termFreq.get(record.id);
  if (!freq) return 0;
  const length = stats.lengths.get(record.id) ?? 0;
  const avg = stats.avgLength || 1;

  let score = 0;
  for (const term of terms) {
    const tf = freq.get(term);
    if (!tf) continue;
    const df = stats.docFreq.get(term) ?? 0;
    // Standard BM25 IDF with the +1 guard that keeps values positive even
    // when a term appears in every document.
    const idf = Math.log(1 + (stats.docCount - df + 0.5) / (df + 0.5));
    const denominator = tf + K1 * (1 - B + (B * length) / avg);
    score += idf * ((tf * (K1 + 1)) / denominator);
  }
  return score;
}

/**
 * The name is weighted by repetition because an exact name match is a much
 * stronger signal of intent than a description keyword collision.
 */
function documentTokens(record: ActionRecord): string[] {
  const nameTokens = tokenize(record.name);
  return [
    ...nameTokens,
    ...nameTokens,
    ...nameTokens,
    ...tokenize(record.serverId),
    ...tokenize(record.summary),
    ...tokenize(record.description ?? ""),
    ...(record.tags ?? []).flatMap((tag) => tokenize(tag)),
  ].slice(0, MAX_DOCUMENT_TOKENS);
}

/**
 * Per-record token cap. A hostile or accidentally huge description (the S10
 * adversarial fixtures carry 100 KB descriptions) must not dominate the
 * average-document-length term of BM25 or blow up indexing cost.
 */
export const MAX_DOCUMENT_TOKENS = 2048;

/**
 * Unicode-aware tokenizer: splits on camelCase boundaries and on everything
 * that is not a letter, a number, or an emoji, then lowercases.
 *
 * Format and control characters (zero-width spaces, bidi marks, NULs) are
 * stripped BEFORE splitting so they cannot glue tokens together or create
 * phantom tokens. Emoji (Extended_Pictographic, general category So) are kept
 * as tokens so an emoji-named tool like `deploy_🚀_rocket` is findable by the
 * emoji itself.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .replace(/[\p{Cf}\p{Cc}\p{Zs}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}\p{Extended_Pictographic}]+/u)
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase());
}
