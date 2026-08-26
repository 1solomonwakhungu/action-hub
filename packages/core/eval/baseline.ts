/**
 * Committed retrieval baseline.
 *
 * These are floors, not targets. Measured on the current BM25 ranker
 * (2026-08-26, 40 labeled queries over 91 actions):
 *
 *     recall@1  0.700    recall@5  0.950    MRR  0.804
 *     exact       1.000  paraphrase  0.438  ambiguous  0.750   (recall@1)
 *
 * Each floor sits roughly two queries below the measured value — one query is
 * 2.5% of the set — so a harmless reshuffle between near-tied results passes
 * and a real ranking regression fails. Tightening them to the measured numbers
 * would make the gate flap on ties; loosening them further would let a genuine
 * regression through.
 *
 * When retrieval genuinely improves — semantic scoring is the next planned
 * change — raise these in the same commit that improves it and record the new
 * numbers in the pull request. A baseline that is never raised stops
 * protecting anything.
 */
export const BASELINE = Object.freeze({
  recallAt1: 0.65,
  recallAt5: 0.9,
  mrr: 0.76,
});

/**
 * Per-band recall@1 floors, so a collapse in one difficulty band cannot hide
 * inside a healthy-looking average. `exact` is held near-perfect deliberately:
 * a miss there is a tokenizer or name-weighting bug, not a ranking trade-off.
 */
export const BAND_BASELINE = Object.freeze({
  exact: 0.9,
  paraphrase: 0.37,
  ambiguous: 0.66,
});
