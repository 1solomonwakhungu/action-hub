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

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const candidates = this.#catalog.filter(options);
    const terms = tokenize(query);

    if (candidates.length === 0) return [];

    // An empty query is a browse request, not an error: return a stable
    // alphabetical slice so callers can enumerate the catalog.
    if (terms.length === 0) {
      return candidates
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((record) => toHit(record, 0));
    }

    const stats = buildStats(candidates);
    const lexical = candidates.map((record) => ({
      record,
      score: bm25(record, terms, stats),
    }));

    let ranked = lexical;
    if (this.#semanticScorer) {
      const semantic = await this.#semanticScorer(query, candidates);
      ranked = lexical.map((entry, i) => ({
        record: entry.record,
        score: blend(entry.score, semantic[i] ?? 0),
      }));
    }

    return ranked
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
      .slice(0, limit)
      .map((entry) => toHit(entry.record, entry.score));
  }
}

/** Returns a normalized [0,1] relevance score per candidate, index-aligned. */
export type SemanticScorer = (
  query: string,
  candidates: readonly ActionRecord[],
) => Promise<number[]>;

const SEMANTIC_WEIGHT = 0.4;

function blend(lexicalScore: number, semanticScore: number): number {
  // Lexical scores are unbounded, so squash before blending to keep the two
  // signals on comparable scales.
  const squashed = lexicalScore / (1 + lexicalScore);
  return (1 - SEMANTIC_WEIGHT) * squashed + SEMANTIC_WEIGHT * semanticScore;
}

function toHit(record: ActionRecord, score: number): SearchHit {
  return {
    id: record.id,
    kind: record.kind,
    serverId: record.serverId,
    name: record.name,
    summary: record.summary,
    score: Number(score.toFixed(6)),
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

function buildStats(records: readonly ActionRecord[]): CorpusStats {
  const docFreq = new Map<string, number>();
  const termFreq = new Map<string, Map<string, number>>();
  const lengths = new Map<string, number>();
  let totalLength = 0;

  for (const record of records) {
    const tokens = documentTokens(record);
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
  ];
}

/** Splits on non-alphanumerics and camelCase boundaries, then lowercases. */
export function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase());
}
