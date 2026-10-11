import type { ActionKind, ActionRecord } from "../types.js";
import { QUERY_STOPWORDS, tokenize } from "./search.js";

/**
 * Compressed domain/server awareness (r/mcp follow-up 4).
 *
 * A vague, goal-only ask ("straighten out that messy contact record") gives
 * the ranker almost nothing to match on, and the model issuing it does not
 * know which integrations exist, so it cannot narrow the search or decide
 * whether searching is worthwhile at all. The directory answers the cheaper
 * question first: WHICH servers are connected and what domain words each one
 * covers. It is deliberately tiny (one line per server) so it can be loaded
 * as a tool RESULT, which keeps the single fixed `action_hub` tool and its
 * description cache-stable (no `list_changed`, nothing dynamic in the tool
 * definition).
 *
 * Keywords are chosen by server-level TF-IDF: a term scores by how many of
 * the server's actions mention it, discounted by how many OTHER servers also
 * mention it. Terms every server shares (generic verbs like "list", "create")
 * sink; domain vocabulary ("funnel", "cohort", "payroll") rises. The server
 * id's own tokens are excluded because the id is already in the entry.
 */
export interface ServerDirectoryEntry {
  serverId: string;
  /** Human-readable name from the server config, when one is set. */
  displayName?: string;
  /** Operator-written description from the server config, when one is set. */
  description?: string;
  /** Number of indexed actions on this server. */
  actionCount: number;
  /** Which kinds of actions the server contributes (tools, skills, or both). */
  kinds: ActionKind[];
  /** Most distinctive domain words for this server, best first. */
  keywords: string[];
}

export interface ServerDirectoryMetadata {
  displayName?: string;
  description?: string;
}

export interface ServerDirectoryOptions {
  /** Keywords per server. Default {@link DEFAULT_DIRECTORY_KEYWORDS}; clamped to [0, 32]. */
  keywordsPerServer?: number;
  /** Optional per-server metadata (from the server config) merged into entries. */
  metadata?: ReadonlyMap<string, ServerDirectoryMetadata>;
}

/**
 * Eight words per server keeps a 44-server directory at about 6.5 KB of
 * compact JSON (roughly 1.6K tokens; a pretty-printed tool result is about
 * twice that) while still naming the main sub-domains of most servers
 * (measured on the 10,000-tool / 5,000-skill stress corpus; see
 * stress/goal-only-gate.mjs notes).
 */
export const DEFAULT_DIRECTORY_KEYWORDS = 8;
export const MAX_DIRECTORY_KEYWORDS = 32;
/** Shorter tokens are almost always noise (ids, units, articles). */
const MIN_KEYWORD_LENGTH = 3;

/**
 * Builds the directory from a set of action records. Pure and deterministic:
 * servers are sorted by id and keyword ties break alphabetically, so the same
 * catalog always yields byte-identical output (cache-friendly for hosts that
 * compare tool results).
 */
export function buildServerDirectory(
  records: readonly ActionRecord[],
  options: ServerDirectoryOptions = {},
): ServerDirectoryEntry[] {
  const perServer = clampKeywords(options.keywordsPerServer);

  // Per-server record frequency of each term, plus the set of servers that
  // mention the term at all (server-level document frequency).
  const byServer = new Map<string, { count: number; kinds: Set<ActionKind>; termRecords: Map<string, number> }>();
  const serversWithTerm = new Map<string, number>();
  for (const record of records) {
    let entry = byServer.get(record.serverId);
    if (!entry) {
      entry = { count: 0, kinds: new Set(), termRecords: new Map() };
      byServer.set(record.serverId, entry);
    }
    entry.count += 1;
    entry.kinds.add(record.kind);
    for (const term of recordTerms(record)) {
      const previous = entry.termRecords.get(term) ?? 0;
      if (previous === 0) serversWithTerm.set(term, (serversWithTerm.get(term) ?? 0) + 1);
      entry.termRecords.set(term, previous + 1);
    }
  }

  const serverCount = byServer.size;
  const entries: ServerDirectoryEntry[] = [];
  for (const serverId of [...byServer.keys()].sort()) {
    const entry = byServer.get(serverId)!;
    const own = new Set(tokenize(serverId));
    const scored: { term: string; score: number; coverage: number }[] = [];
    for (const [term, recordFrequency] of entry.termRecords) {
      if (own.has(term)) continue;
      const df = serversWithTerm.get(term) ?? serverCount;
      // A word that more than half the servers use ("supports", "workspace",
      // API boilerplate) cannot tell this server apart, so it is dropped
      // rather than padded in: rows may be shorter than the budget. The rule
      // keeps two-server catalogs informative (a word on one of two servers
      // stays) and excludes "list"/"create" on three or more. A single-server
      // catalog has no contrast to exploit and ranks by coverage alone.
      if (serverCount > 1 && df * 2 > serverCount) continue;
      const coverage = recordFrequency / entry.count;
      const idf = serverCount === 1 ? 1 : Math.log(serverCount / df);
      scored.push({ term, score: coverage * idf, coverage });
    }
    // Code-point order for the final tie-break: localeCompare depends on the
    // process locale (ICU), which would make the directory differ between
    // hosts for the same catalog.
    scored.sort((a, b) => b.score - a.score || b.coverage - a.coverage || compareCodePoints(a.term, b.term));
    const distinctive = scored.filter((item) => item.score > 0);
    const meta = options.metadata?.get(serverId);
    entries.push({
      serverId,
      ...(meta?.displayName ? { displayName: meta.displayName } : {}),
      ...(meta?.description ? { description: meta.description } : {}),
      actionCount: entry.count,
      kinds: [...entry.kinds].sort(),
      keywords: distinctive.slice(0, perServer).map((item) => item.term),
    });
  }
  return entries;
}

/**
 * Distinct terms of one record: name, summary, tags, and description, with
 * query stopwords, short tokens, and pure numbers removed. Only PRESENCE is
 * counted (per-record set), so a verbose description cannot outvote the rest
 * of the server.
 */
function recordTerms(record: ActionRecord): Set<string> {
  const terms = new Set<string>();
  const sources = [record.name, record.description ?? "", ...(record.tags ?? [])];
  // Summaries are usually the description's first line cut at a byte budget
  // (see `summarize` in action-hub.ts), which can split the final word into a
  // fragment ("refere", "notificati"). Such a fragment occurs on no other
  // server, so IDF would promote it to a keyword. When the summary is a
  // truncation of the description, drop its last token; the full description
  // still contributes the whole word.
  let summaryTokens = tokenize(record.summary);
  const summaryCore = record.summary.replace(/…$/u, "").trimEnd();
  const description = record.description ?? "";
  if (description.length > record.summary.length && summaryCore.length > 0 && description.includes(summaryCore)) {
    summaryTokens = summaryTokens.slice(0, -1);
  }
  for (const source of [...sources, summaryTokens.join(" ")]) {
    for (const token of tokenize(source)) {
      if (token.length < MIN_KEYWORD_LENGTH) continue;
      if (QUERY_STOPWORDS.has(token) || DIRECTORY_STOPWORDS.has(token)) continue;
      if (/^\p{N}+$/u.test(token)) continue;
      terms.add(token);
    }
  }
  return terms;
}

/**
 * Function words and API boilerplate that say nothing about a DOMAIN. This
 * list is used only to pick directory keywords: it is deliberately broader
 * than QUERY_STOPWORDS (which keeps prepositions because they carry
 * targeting signal when ranking) and never touches search scoring.
 */
export const DIRECTORY_STOPWORDS: ReadonlySet<string> = new Set([
  // prepositions, determiners, pronouns, conjunctions
  "about", "above", "across", "after", "against", "along", "among", "around", "before", "behind",
  "below", "beneath", "beside", "between", "beyond", "during", "except", "for", "from", "inside",
  "into", "near", "onto", "outside", "over", "past", "since", "through", "toward", "towards",
  "under", "until", "upon", "via", "with", "within", "without", "all", "any", "both", "each",
  "either", "every", "few", "many", "more", "most", "much", "neither", "none", "one", "other",
  "others", "same", "several", "some", "such", "whatever", "whichever", "your", "yours", "our",
  "ours", "his", "her", "hers", "whose", "what", "where", "whether", "why", "how", "here", "there",
  "not", "nor", "yet", "than", "then", "thus", "also", "only", "own", "per", "via",
  // API and documentation boilerplate
  "supports", "support", "supported", "returns", "return", "returned", "optional", "optionally",
  "required", "requires", "default", "defaults", "specified", "specify", "given", "provided",
  "provide", "provides", "including", "include", "includes", "using", "use", "used", "uses",
  "allows", "allow", "allowed", "enables", "based", "according", "following", "example", "note",
  "see", "set", "sets", "new", "existing", "current", "available", "data", "information", "details",
  "fields", "field", "value", "values", "object", "objects", "item", "items", "entry", "entries",
  "result", "results", "request", "response", "parameter", "parameters", "operation", "operations",
  "tool", "tools", "server", "servers", "skill", "skills", "api", "call", "calls", "work",
]);

function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Normalizes a keyword budget the way {@link buildServerDirectory} does:
 * undefined or non-finite means the default, otherwise clamped to
 * [0, {@link MAX_DIRECTORY_KEYWORDS}]. Exported so a memoizing caller can
 * build once at the maximum budget and slice per request (keyword lists are
 * prefixes of each other because the ranking is total and budget-independent).
 */
export function clampDirectoryKeywords(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_DIRECTORY_KEYWORDS;
  return Math.min(MAX_DIRECTORY_KEYWORDS, Math.max(0, Math.floor(value)));
}
const clampKeywords = clampDirectoryKeywords;
