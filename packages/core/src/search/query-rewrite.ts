/**
 * Raw-query-preserving goal-query rewrite (r/mcp thread 1x2u6sb experiment).
 *
 * Question under test: does rewriting a goal-style ask ("pull the incident
 * back open") into a tool-ish verb form ("reopen incident") help retrieval?
 *
 * The rewriter is deterministic and adds NO new lexicon. Its only inputs are:
 * - the catalog's own verb vocabulary: the first name token of every tool
 *   record (`reopen` from `reopen_incident_beta`), and
 * - the existing SQ2 verb tables in synonyms.ts (VERB_PHRASES and
 *   VERB_SYNONYMS). synonyms.ts documents them as chosen on the tune split,
 *   but most entries are exercised by no tune query, so that cannot be
 *   confirmed; see the leakage note in stress/README.md ("Goal-query rewrite
 *   experiment") before reading any held-out gain as clean.
 *
 * It differs from SQ2 expansion in two ways, which is exactly what the
 * experiment measures: the emitted verbs are restricted to verbs the catalog
 * actually uses, and they take part at full weight (and reach the semantic
 * channel) instead of as down-weighted BM25-only terms.
 *
 * The raw query is never replaced. SearchEngine uses the rewrite in one of
 * two opt-in modes (SearchOptions.queryRewrite, off by default):
 * - "append": one pass over `raw + " " + addedVerbs`.
 * - "fuse":   two passes (raw, then the tool-ish rewrite), fused by
 *             reciprocal rank with the raw ranking weighted higher.
 */

/** Modes accepted by SearchOptions.queryRewrite. */
export type QueryRewriteMode = "append" | "fuse";

/**
 * Cap on emitted verbs. A goal ask maps to one intended action; three leaves
 * room for a phrase's alternatives ("turn off" -> disable, deactivate)
 * without letting a long query flood the rewrite with every synonym.
 */
export const MAX_REWRITE_VERBS = 3;

/**
 * Weight of the rewrite ranking relative to the raw ranking (raw = 1) in
 * "fuse" mode. Fixed a priori, not swept. Raw is weighted higher, but under
 * RRF (k = 60) that does NOT keep the raw top hit on top: a hit at raw rank r
 * and rewrite rank 1 scores 1/(60+r) + 0.5/61, which beats a raw rank-1 hit
 * absent from the rewrite list (1/61) for every r up to 61, i.e. anywhere in
 * the depth-50 raw window. Changing it needs a tune-split-only sweep.
 */
export const REWRITE_FUSION_WEIGHT = 0.5;

/** Depth of each pass in "fuse" mode before fusion (at least the caller's limit). */
export const REWRITE_FUSION_DEPTH = 50;

export interface GoalQueryRewrite {
  /** Catalog verbs implied by the query that the raw query does not already contain. */
  addedVerbs: string[];
  /** Object tokens kept from the query (stopwords, verbs, and verb-phrase tokens removed). */
  objectTerms: string[];
  /** Tool-ish form used by "fuse" mode: verbs then objects. */
  toolQuery: string;
  /** Raw query with the added verbs appended, used by "append" mode. */
  appendedQuery: string;
  /**
   * Which table entries fired, for leakage audits: `phrase:<key>` (VERB_PHRASES),
   * `synonym:<key>` (VERB_SYNONYMS), or `literal:<verb>` (a query token that
   * already is a catalog verb).
   */
  sources: string[];
}

/** Verb vocabulary of a catalog: the first name token of each tool record. */
export function catalogVerbs(
  records: readonly { kind: string; name: string }[],
  tokenize: (text: string) => string[],
): Set<string> {
  const verbs = new Set<string>();
  for (const record of records) {
    if (record.kind !== "tool") continue;
    const first = tokenize(record.name)[0];
    if (first) verbs.add(first);
  }
  return verbs;
}

/**
 * Rewrites a goal-style query into catalog verbs plus its object terms.
 * Returns null when the rewrite would add nothing: no catalog verb is implied,
 * or every implied verb is already a literal query token. A null rewrite means
 * the caller runs the raw query unchanged.
 */
export function rewriteGoalQuery(
  query: string,
  verbs: ReadonlySet<string>,
  tables: {
    tokenize: (text: string) => string[];
    stopwords: ReadonlySet<string>;
    phrases: Readonly<Record<string, readonly string[]>>;
    synonyms: Readonly<Record<string, readonly string[]>>;
  },
): GoalQueryRewrite | null {
  const { tokenize, stopwords, phrases, synonyms } = tables;
  const literal = tokenize(query).filter((term) => !stopwords.has(term));
  if (literal.length === 0 || verbs.size === 0) return null;

  const implied: string[] = [];
  const add = (verb: string): void => {
    if (verbs.has(verb) && !implied.includes(verb)) implied.push(verb);
  };
  const consumed = new Set<number>();
  const sources: string[] = [];

  // 1. Multi-word phrases first: they are the most specific signal ("pull
  //    back open" says reopen more precisely than "pull" says anything).
  //    Matched as token subsequences under the same tokenizer and stopword
  //    filter as the query, mirroring expandQuery.
  for (const [phrase, mapped] of Object.entries(phrases)) {
    const phraseTokens = tokenize(phrase).filter((term) => !stopwords.has(term));
    if (phraseTokens.length === 0) continue;
    outer: for (let i = 0; i + phraseTokens.length <= literal.length; i += 1) {
      for (let j = 0; j < phraseTokens.length; j += 1) {
        if (literal[i + j] !== phraseTokens[j]) continue outer;
      }
      for (const verb of mapped) add(verb);
      for (let j = 0; j < phraseTokens.length; j += 1) consumed.add(i + j);
      sources.push(`phrase:${phrase}`);
      break;
    }
  }

  // 2. Literal tokens that already are catalog verbs, then single-token
  //    synonyms of the remaining tokens.
  literal.forEach((term, i) => {
    if (consumed.has(i)) return;
    if (verbs.has(term)) {
      add(term);
      consumed.add(i);
      sources.push(`literal:${term}`);
    }
  });
  literal.forEach((term, i) => {
    if (consumed.has(i)) return;
    const mapped = synonyms[term];
    if (!mapped) return;
    for (const verb of mapped) add(verb);
    if (mapped.some((verb) => verbs.has(verb))) {
      consumed.add(i);
      sources.push(`synonym:${term}`);
    }
  });

  const addedVerbs = implied.filter((verb) => !literal.includes(verb)).slice(0, MAX_REWRITE_VERBS);
  if (addedVerbs.length === 0) return null;

  const objectTerms = literal.filter((_, i) => !consumed.has(i));
  const keptVerbs = implied.slice(0, MAX_REWRITE_VERBS);
  return {
    addedVerbs,
    objectTerms,
    toolQuery: [...keptVerbs, ...objectTerms].join(" "),
    appendedQuery: `${query} ${addedVerbs.join(" ")}`,
    sources,
  };
}
