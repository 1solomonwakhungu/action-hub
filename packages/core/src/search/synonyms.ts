/**
 * Curated verb-synonym expansion (F49 part 1, SQ2).
 *
 * Search queries frequently name an intent in different words than the tool
 * name uses ("turn off the account" vs `disable_user`). BM25 cannot bridge
 * that gap — a term either occurs or it does not — and the hashed subword
 * semantic scorer only bridges morphology and already-cataloged concepts, not
 * true paraphrase. This table maps common action verbs to their
 * catalog-canonical equivalents.
 *
 * Construction discipline (SQ2): entries are plain, standard English verb
 * equivalence classes (the same classes intake's packet lists as examples),
 * checked against the deterministic TUNE split (60%) of the realistic-query
 * fixture. The held-out 40% was never used to choose entries. Every entry is
 * a single-token verb equivalence — values must survive `tokenize` unchanged,
 * because BM25 matches whole tokens; multi-word phrases live in VERB_PHRASES
 * and are matched against the raw query text instead. No row-specific hacks.
 *
 * Expanded terms are DOWN-WEIGHTED relative to the literal query terms (see
 * SYNONYM_TERM_WEIGHT in search.ts) so an exact-name match always outranks a
 * synonym-only match. An exact-name short-circuit in SearchEngine skips
 * expansion entirely when the query's tokens spell an existing action name.
 */

/** Single-token verb equivalences. Keys and values are single lowercase tokens. */
export const VERB_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  // stopping / resuming
  hold: ["pause", "suspend", "freeze"],
  suspend: ["pause", "hold", "freeze"],
  freeze: ["pause", "suspend", "hold"],
  pause: ["hold", "suspend", "freeze"],
  thaw: ["unfreeze", "resume"],
  unfreeze: ["thaw", "resume"],
  resume: ["unfreeze", "continue"],
  unpause: ["resume", "unfreeze"],
  // enabling / disabling
  disable: ["deactivate"],
  deactivate: ["disable"],
  enable: ["activate"],
  activate: ["enable"],
  reject: ["decline", "deny"],
  decline: ["reject", "deny"],
  // creation / destruction
  create: ["make", "provision"],
  provision: ["create"],
  wipe: ["purge", "delete", "erase"],
  purge: ["wipe", "delete", "erase"],
  delete: ["remove", "erase", "purge"],
  remove: ["delete", "erase", "detach"],
  erase: ["delete", "wipe", "purge"],
  duplicate: ["clone", "copy", "replicate"],
  clone: ["duplicate", "copy", "replicate"],
  copy: ["duplicate", "clone"],
  // modification
  amend: ["change", "update", "edit", "modify"],
  adjust: ["change", "update", "amend", "edit"],
  modify: ["change", "update", "edit", "amend"],
  update: ["change", "edit", "amend", "modify", "refresh"],
  change: ["update", "amend", "modify", "edit"],
  shift: ["move", "change", "amend", "reschedule"],
  reschedule: ["change", "amend", "shift"],
  move: ["transfer", "relocate", "shift", "migrate"],
  rebuild: ["reconstruct", "regenerate", "redo"],
  tweak: ["adjust", "change", "edit"],
  // communication / transfer
  send: ["transmit", "dispatch", "ship"],
  resend: ["retransmit"],
  ship: ["send", "transmit"],
  share: ["transfer", "pass", "send"],
  transfer: ["move", "pass", "share"],
  assign: ["allocate", "delegate", "pass"],
  link: ["tie", "connect", "attach", "associate"],
  tie: ["link", "connect", "attach"],
  attach: ["link", "tie", "connect"],
  detach: ["unlink", "remove", "disconnect"],
  unlink: ["detach", "disconnect", "remove"],
  disconnect: ["unlink", "detach", "remove"],
  connect: ["link", "attach", "tie"],
  // resolution / cleanup
  resolve: ["fix", "settle"],
  fix: ["resolve", "repair"],
  repair: ["fix", "resolve"],
  cancel: ["abort", "stop"],
  reopen: ["reinstate", "unclose"],
  unlock: ["unblock"],
  prune: ["trim", "remove"],
  trim: ["prune", "cut", "remove"],
  // inspection / comparison
  compare: ["diff", "contrast"],
  diff: ["compare", "difference"],
  search: ["find", "hunt"],
  find: ["search", "locate"],
  inspect: ["review", "examine"],
  // approval / restoration
  approve: ["authorize", "accept"],
  authorize: ["approve", "allow"],
  restore: ["reinstate", "recover"],
  redact: ["hide", "mask", "censor"],
  hide: ["redact", "mask", "conceal"],
  mask: ["redact", "hide"],
  split: ["divide", "partition", "bisect"],
  divide: ["split", "partition"],
  escalate: ["raise", "elevate"],
  snapshot: ["capture", "checkpoint"],
  capture: ["snapshot", "record"],
  grab: ["capture", "get", "take"],
  confirm: ["acknowledge", "verify"],
  acknowledge: ["confirm", "verify"],
  rotate: ["cycle", "reshuffle"],
  rotation: ["rotate", "cycle"],
  reshuffle: ["rotate", "reorder"],
  shuffle: ["reshuffle", "rotate", "reorder"],
  merge: ["combine", "unify", "consolidate"],
  fold: ["merge", "combine", "unify"],
  combine: ["merge", "unify"],
  summarize: ["recap", "brief"],
  summary: ["summarize", "recap"],
  recap: ["summarize"],
  book: ["schedule", "reserve"],
  schedule: ["book", "reserve"],
  reserve: ["book", "schedule"],
  revoke: ["withdraw", "retract"],
  withdraw: ["revoke", "retract"],
  validate: ["check", "verify"],
  verify: ["validate", "check"],
  sync: ["reconcile", "synchronize"],
  reconcile: ["sync", "synchronize"],
  reconciled: ["sync", "reconcile"],
  look: ["peek", "inspect", "search"],
};

/**
 * Multi-word verb phrases, matched against the lowercased raw query with word
 * boundaries. Each match contributes its canonical verbs as extra
 * (down-weighted) query terms.
 */
export const VERB_PHRASES: Readonly<Record<string, readonly string[]>> = {
  "turn off": ["disable", "deactivate"],
  "switch off": ["disable", "deactivate"],
  "shut off": ["disable", "deactivate"],
  "turn on": ["enable", "activate"],
  "flip on": ["enable", "activate"],
  "turn down": ["reject", "decline"],
  "set up": ["create", "provision", "configure"],
  "spin up": ["create", "provision", "start"],
  "tear down": ["delete", "deprovision", "remove"],
  "call off": ["cancel", "abort"],
  "sort out": ["resolve", "fix"],
  "sorted out": ["resolve", "fix"],
  "straighten out": ["resolve", "fix"],
  "fix up": ["rebuild", "repair"],
  "side by side": ["compare", "diff"],
  "look for": ["search", "find"],
  "look up": ["search", "find"],
  "look into": ["inspect", "review", "investigate"],
  "check on": ["inspect", "review"],
  "fire off": ["send", "submit"],
  "hand off": ["assign", "transfer", "share"],
  "pass to": ["share", "transfer", "assign"],
  "hand to": ["assign", "transfer"],
  "open back up": ["reopen", "unlock"],
  "pull back open": ["reopen", "unlock"],
  "pull off": ["detach", "remove"],
  "get rid of": ["delete", "remove", "purge"],
  "put on hold": ["pause", "suspend", "freeze"],
  "on hold": ["pause", "suspend", "freeze"],
  "bring back": ["restore", "recover"],
  "green light": ["approve", "authorize"],
  "what changed": ["diff", "compare"],
  "give me": ["get", "show", "summarize"],
  "went through": ["acknowledge", "confirm"],
  "let through": ["approve", "unlock"],
};

/** Lowercases and dedups; order-preserving. */
function addUnique(target: string[], term: string): void {
  const t = term.toLowerCase();
  if (!target.includes(t)) target.push(t);
}

/** A query term with its BM25 contribution weight (literal = 1). */
export interface WeightedTerm {
  term: string;
  weight: number;
}

/**
 * Expands a tokenized query into weighted terms: literal terms at weight 1,
 * synonym/phrase expansions at `synonymWeight`. Single-token keys are matched
 * against the tokenized query; multi-word phrases are matched as TOKEN
 * SEQUENCES over the same tokenization (so punctuation and repeated
 * whitespace cannot break or split a match — “turn off, the user” and
 * “turn off the user” behave identically). A non-positive synonym weight
 * short-circuits expansion (used by the exact-name lookup path). Stopwords
 * are dropped from both literal terms and expansions.
 */
export function expandQuery(
  query: string,
  tokenize: (text: string) => string[],
  synonymWeight: number,
  stopwords: ReadonlySet<string> = new Set(),
): { terms: WeightedTerm[]; literalCount: number } {
  const literal = tokenize(query).filter((term) => !stopwords.has(term));
  if (synonymWeight <= 0) {
    return { terms: literal.map((term) => ({ term, weight: 1 })), literalCount: literal.length };
  }
  const expanded: string[] = [];
  const addSyn = (syn: string): void => {
    if (!stopwords.has(syn)) addUnique(expanded, syn);
  };

  // 1. Multi-word phrases, matched as token subsequences of the SAME
  //    tokenization AND the same stopword filter as the query (so a phrase
  //    containing "of" still matches a stopword-filtered query stream).
  //    Punctuation-safe by construction: tokenization has already stripped
  //    terminal/interior punctuation and normalized whitespace.
  const tokens = literal;
  for (const [phrase, syns] of Object.entries(VERB_PHRASES)) {
    const phraseTokens = tokenize(phrase).filter((term) => !stopwords.has(term));
    if (phraseTokens.length === 0) continue;
    outer: for (let i = 0; i + phraseTokens.length <= tokens.length; i += 1) {
      for (let j = 0; j < phraseTokens.length; j += 1) {
        if (tokens[i + j] !== phraseTokens[j]) continue outer;
      }
      for (const syn of syns) addSyn(syn);
      break;
    }
  }

  // 2. Single-token synonyms.
  for (const token of tokens) {
    const syns = VERB_SYNONYMS[token];
    if (!syns) continue;
    for (const syn of syns) addSyn(syn);
  }

  const terms = [
    ...literal.map((term) => ({ term, weight: 1 })),
    ...expanded
      .filter((term) => !literal.includes(term))
      .map((term) => ({ term, weight: synonymWeight })),
  ];
  return { terms, literalCount: literal.length };
}
