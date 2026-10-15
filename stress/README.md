# Action Hub stress & bench (S4)

Load/performance bench and orchestration for the stress fleet. Contract:
`/tmp/action-hub-stress/CONTRACT.md` (binding; intake-owned).

## Files (one owner per file)

| Path | Owner | What |
|---|---|---|
| `stress/bench-load.mjs` | builder-5 | load & perf bench (this packet) |
| `bench-load.mjs` | builder-5 | load & perf bench (in-process/stdio/daemon/cache) |
| `stress/README.md` | builder-5 | this file |
| `stress/gen-skills.mjs` | builder-1 | 5,000 skills + queries |
| `stress/gen-tools.mjs` | builder-4 | 10,000 tools across 44 servers + queries |
| `stress/fake-mcp-server.mjs`, `stress/make-config.mjs` | builder-2 | fake MCP fleet + config writer |
| `stress/eval-retrieval.mjs`, `stress/eval-retrieval.test.mjs` | builder-6 | search quality at scale: retrieval rank, abstention replay (`--abstention-threshold=<0..1>`, default 0.8) and execution success as three separate metrics; `--warm-embeddings` awaits the embedding index before the gate runs; `node --test stress/eval-retrieval.test.mjs` for the fixture and metric unit tests |
| `stress/goal-only-gate.mjs` | search-quality | goal-only recall gate (30 realistic rows, own floors) |
| `stress/chaos.mjs` | builder-8 | crash/hang/slow-start scenarios |
| `stress/harness-e2e.mjs` | builder-9 | pi harness entrypoint e2e |
| `stress/cli-scale.mjs` | builder-3 | CLI surface scale |
| `stress/abstention-threshold.mjs`, `stress/abstention-threshold.test.mjs`, `stress/fixtures/no-match-queries.json` | abstention-docs | held-out calibration of the search abstention gate (both semantic channels); negative fixture; unit tests for the pure parts |
| `stress/goal-query-rewrite.mjs`, `stress/goal-query-rewrite.test.mjs` | query-rewrite | before/after eval of the opt-in goal-query rewrite (`SearchOptions.queryRewrite`); eval-retrieval takes the same switch as `--query-rewrite=<append\|fuse>` |

Generated data lives in `stress/.generated/` (gitignored). Only scripts and
this README are committed.

## Run

```bash
npm run build                     # CLI must be built; bench drives dist/index.js
node stress/bench-load.mjs --scale small   # small fallback fixtures
```

Abstention calibration (needs the generated corpus; the first embeddings run
embeds 15K documents in WASM and takes minutes, later runs hydrate the
persisted vectors from `stress/.generated/abstention-vectors.json`):

```bash
node stress/gen-tools.mjs && node stress/gen-skills.mjs
node stress/abstention-threshold.mjs --semantic both   # or embeddings | hashed (own artifact name per channel)
node --test stress/abstention-threshold.test.mjs       # pure parts + fixture
```

`bench-load.mjs` measures, per scale:

- **cold start** — time until the `action_hub` tool answers `search` with the
  full fleet indexed (`bootToReadyMs`), plus first-search round-trip.
- **warm start** — same, from a populated catalog cache (`XDG_CACHE_HOME`).
- **search latency** p50/p95/p99 at concurrency 1/10/50/100, over the HTTP
  serve transport (`action-hub serve`, bearer-authenticated `/mcp`) and stdio
  (`action-hub start`).
- **load latency** p50/p95/p99 at c=10.
- **execute throughput** through the fake servers: successful calls / elapsed
  (failures reported separately, never folded into throughput; read-only,
  errorRate-0 tools with schema-valid arguments).
- **cache behaviour**: repeated identical read-only calls vs distinct-args
  calls of the same zero-latency tool (median repeat vs median distinct, plus
  speedup). Indirect by necessity: the dispatch layer drops
  `ExecuteResult.cached` (flagged finding), so the flag cannot be read.
- **token cost** of search(10) and load responses (~4 chars/token estimate).
- **memory**: RSS sampled over the hub's recursive child tree every 250ms.
  Headline is `peakSimultaneousTreeRssKb` (sum across the tree within a single
  tick — peaks that really co-occurred). `upperBoundSumOfIndependentPeaksKb`
  is also reported, explicitly labelled as an upper bound (each process's own
  peak, summed; peaks may never have co-occurred).
- **daemon mode**: 20 concurrent `action-hub connect` clients, connect time +
  concurrent search latency.

Every script prints a machine-readable JSON summary as its last stdout line
and writes it to `stress/.generated/results/<script-name>.json`;
`bench-load.mjs` writes its results into
`stress/.generated/results/summary.md`.

### Goal-only recall gate

```bash
node stress/gen-tools.mjs && node stress/gen-skills.mjs   # binding corpus (fail closed otherwise)
node stress/goal-only-gate.mjs                            # keyword + hashed, ~10 s
node stress/goal-only-gate.mjs --engines keyword,hashed,embeddings --fails   # production wiring, ~10 min
node --test stress/goal-only-gate.test.mjs                # pure-function unit tests
```

`goal-only-gate.mjs` scores the 30 `goal-only` rows of
`stress/fixtures/realistic-queries.json` (intent stated without the gold tool's
verb; the lowest-scoring subtype) against the binding generated corpus, per
engine and independently of `eval-retrieval.mjs`, which folds them into
"hard". Each engine gets recall@1/5/10, MRR@10, per-row ranks with their
tune/held split membership, the held-out subset's own metrics, and a pass/fail
against committed floors (`GOAL_ONLY_FLOORS`, one query below the measured
value). Measured 2026-10-11 at the commit that added the gate:

| engine | recall@1 | recall@5 | recall@10 | MRR@10 | held-out recall@5 |
|---|---:|---:|---:|---:|---:|
| keyword (BM25 + synonyms) | 0.267 | 0.433 | 0.533 | 0.349 | 0.462 |
| hashed (LocalSemanticIndex blend) | 0.133 | 0.267 | 0.333 | 0.181 | 0.462 |
| embeddings (MiniLM + RRF, production default) | 0.400 | 0.533 | 0.567 | 0.454 | 0.538 |

The held-out column is the 13 rows of `split-held.json`. The embeddings
engine built its 15K-record index in about 10 minutes on the cloud runner,
which is why it is opt-in.

Two readings worth keeping: the hashed blend is BELOW pure BM25 on this band
at 15K records (the semantic channel pulls toward entity-sharing distractors),
and the production embeddings engine is the only one above 50% recall@5. The
misses are verb paraphrases the synonym table does not bridge ("take back" for
revoke, "fire it off again" for resend, "let ... through" for unlock) and
entity paraphrases ("spending plan" for budget), not server confusion: 29 of
the 30 golds live on one server. Raise the floors in the same commit that
improves them.


### Goal-query rewrite experiment (opt-in, off by default)

```bash
node stress/goal-query-rewrite.mjs                                   # keyword + hashed, ~15 s
node stress/goal-query-rewrite.mjs --engines keyword,hashed,embeddings   # ~13 min (embedding index build)
node stress/eval-retrieval.mjs --query-rewrite=append                # full eval with the rewrite on
node --test stress/goal-query-rewrite.test.mjs
```

Question (r/mcp thread 1x2u6sb): does rewriting a goal-style ask ("turn down
that onboarding request") into tool-ish verbs ("reject onboarding request")
help retrieval? `packages/core/src/search/query-rewrite.ts` answers it with a
deterministic rewriter that adds no new lexicon: it maps the query through the
existing SQ2 verb tables (`synonyms.ts`) and keeps only verbs the catalog's own
tool names use (72 verbs on the binding corpus). The raw query is never
replaced. `SearchOptions.queryRewrite` selects:

- `append`: one pass over the raw query plus the implied catalog verbs, so the
  verbs count at full weight and reach the semantic channel (SQ2 expansion
  alone adds them at half weight, BM25 only).
- `fuse`: a raw pass and a tool-ish rewrite pass (depth 50 each), rank-fused
  with the rewrite at weight 0.5. Weight and depth were fixed before measuring
  and never swept.

A query that implies no new catalog verb, or that spells an existing action
name, takes the unchanged single raw pass. The plugin server builds its
`SearchOptions` field by field, so agents cannot turn the rewrite on.

**Leakage control.** The SQ2 tables were built on the tune split, but 23 of 35
phrases and 67 of 95 single-verb entries occur in no tune-split query, so
nothing shows they were validated on tune. `append-tuneonly` reruns `append`
with only the 12 phrases and 28 verbs that some tune query exercises. Read its
held column as the leakage-safe number. (The baseline gate prints every row, so
the held query texts were visible while this was built. That is why the
rewriter has no hand-written entries of its own.) No LLM rewriter was measured:
no Anthropic API key was available in the environment, and nothing below
estimates one.

Goal-only rows (30; held = the 13 rows of `split-held.json`), measured
2026-10-15 on the binding corpus:

| engine | mode | recall@1 | recall@5 | recall@10 | MRR@10 | held recall@5 | held MRR@10 | improved / regressed |
|---|---|---:|---:|---:|---:|---:|---:|---|
| keyword | off | 0.267 | 0.433 | 0.533 | 0.349 | 0.462 | 0.396 | |
| keyword | append | 0.467 | 0.500 | 0.567 | 0.488 | 0.615 | 0.615 | 7 / 1 |
| keyword | fuse | 0.367 | 0.467 | 0.567 | 0.420 | 0.538 | 0.460 | 6 / 0 |
| keyword | append-tuneonly | 0.400 | 0.467 | 0.567 | 0.442 | 0.538 | 0.511 | 5 / 1 |
| hashed | off | 0.133 | 0.267 | 0.333 | 0.181 | 0.462 | 0.301 | |
| hashed | append | 0.400 | 0.467 | 0.533 | 0.435 | 0.538 | 0.551 | 14 / 0 |
| hashed | fuse | 0.200 | 0.400 | 0.467 | 0.298 | 0.462 | 0.434 | 11 / 0 |
| hashed | append-tuneonly | 0.300 | 0.433 | 0.467 | 0.351 | 0.462 | 0.359 | 10 / 0 |
| embeddings (default) | off | 0.400 | 0.533 | 0.567 | 0.454 | 0.538 | 0.470 | |
| embeddings (default) | append | 0.433 | 0.533 | 0.567 | 0.472 | 0.615 | 0.558 | 5 / 3 |
| embeddings (default) | fuse | 0.433 | 0.533 | 0.567 | 0.470 | 0.538 | 0.509 | 2 / 1 |
| embeddings (default) | append-tuneonly | 0.400 | 0.500 | 0.567 | 0.451 | 0.538 | 0.509 | 3 / 3 |

Per-row ranks for the production engine (embeddings), off to append:
improved "confirm the audience invite went through" 9 to 4, "trim the dead
nodes from the cluster map" miss to 47, "turn on the churn tracking" 2 to 1,
"turn down that onboarding request" 2 to 1, "hold the warehouse sync until
monday" 14 to 11; regressed "side-by-side the usage numbers for both months"
4 to 6, "the timesheet bounced, fire it off again" 32 to 44, "adjust the
contract wording" 1 to 2; 22 unchanged. The full per-row lists for every
engine and mode are in the JSON artifact.

Cost per goal-only query (30 rows, 23 of which rewrite to something):

| mode | search passes (30 rows) | added query tokens (30 rows) | median ms keyword / hashed / embeddings |
|---|---:|---:|---|
| off | 30 | 0 | 26.0 / 47.2 / 30.9 |
| append | 30 | 31 | 38.5 / 49.3 / 39.8 |
| fuse | 53 | 104 | 71.1 / 77.9 / 65.4 |

Wall times are from one run on a shared machine with other agents active, so
treat them as rough; the pass count is the deterministic cost. `fuse` roughly
doubles search work on every rewritten query.

Abstention side effect, on the 87 no-match negatives (15 realistic + 72 in
`no-match-queries.json`) and the goal-only golds in the top 10:

| engine | mode | negatives abstained @0.36 | @0.8 (shipped) | golds refused @0.36 | mean negative gate input |
|---|---|---:|---:|---:|---:|
| hashed | off | 3/87 | 77/87 | 0/10 | 0.642 |
| hashed | append | 0/87 | 75/87 | 0/16 | 0.663 |
| embeddings (default) | off | 83/87 | 87/87 | 1/17 | 0.146 |
| embeddings (default) | append | 83/87 | 87/87 | 1/17 | 0.149 |
| embeddings (default) | fuse | 83/87 | 87/87 | 1/17 | 0.146 |

`fuse` replaces each hit's `score` with the fused rank score (about 0.02), which
is what the abstention rule reads when no semantic channel is active. On a
keyword-only hub with abstention enabled, `fuse` would therefore refuse almost
every query (16 of 17 golds in the keyword run). That alone rules `fuse` out
as a default without further work.

Full eval-retrieval (generated 1,500 + realistic 121, default wiring, which
measures blend on a cold embedding index and so equals keyword there):

| metric | base 0146f5c | off | append | fuse |
|---|---:|---:|---:|---:|
| contract gates passing | 2/13 | 2/13 | 2/13 | 2/13 |
| headline recall@1 / @5 / MRR@10 | .208 / .386 / .286 | .208 / .386 / .286 | .248 / .412 / .325 | .228 / .398 / .305 |
| headline execution success | .225 | .225 | .262 | .245 |
| exact recall@5 | .897 | .897 | .897 | .897 |
| paraphrase recall@5 | .410 | .410 | .443 | .437 |
| hard recall@5 | .192 | .192 | .225 | .203 |
| sufficiency@10 | .247 | .247 | .333 | .247 |
| no-match FP (any hit) | .280 | .280 | .280 | .280 |
| realistic recall@5 / MRR@10 | .657 / .572 | .657 / .572 | .695 / .630 | .686 / .596 |
| realistic near-duplicate / multi recall@5 | .950 / .854 | .950 / .854 | .950 / .854 | .950 / .854 |

Base and off agree on every non-timing field (the one difference is warm p95,
32 vs 67 ms, both under the 100 ms gate). The 11 failing gates fail identically
at base; this experiment neither causes nor fixes them. The generated
paraphrase rows are built from gen-tools' own verb synonym list, which overlaps
the SQ2 tables, so treat the generated paraphrase gain as optimistic.

**Verdict.** Raw-preserving rewriting into catalog verbs clearly helps the
lexical and hashed engines on goal-only asks, and part of that gain survives
the leakage audit (keyword held recall@5 .462 to .538, hashed overall .267 to
.433). On the production embeddings engine it is a wash: recall@5 is unchanged,
MRR moves by one rank-1 flip, and the leakage-safe variant loses one row at
recall@5 while staying flat on the held rows. The misses the gate
section names stay misses: "take back" for revoke and "let ... through" for
unlock get no rewrite at all (no table entry covers them), and "spending
plan" for budget is an entity paraphrase that a verb rewrite cannot reach (that
row gains `approve` and still misses). The default stays off.
`append` is the mode worth revisiting for the hashed fallback channel, but the
next step is a lexicon grown on tune rows only. No more table entries should be
added on the strength of these 30 rows.

## Isolation (contract hard rules)

Every spawned process gets: temp `HOME`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`,
`ACTION_HUB_CONFIG`, `ACTION_HUB_SKILLS_DIR`, `PI_CODING_AGENT_DIR`; stress
configs set `autoDiscover: false`. No network, no LLM calls, deterministic.

## Findings so far (full-scale: 44 servers, 10,000 tools, 5,000 skills)

Numbers from bench-load runs on the shared bench host are noisy (other
agents' builds run concurrently); treat absolute values as order-of-magnitude
and re-run before/after any optimization.

1. **Search latency scales cleanly post-rework** (PR 58 full-scale rerun,
   2026-09-27, 44 servers / 10,000 tools / 5,000 skills, exclusive window,
   zero request errors in every band). HTTP: c1 p50 ~40ms → c100 p50 ~3.4s,
   p99 ~3.9s; stdio: c1 p50 ~33ms → c100 p50 ~3.0s, p99 ~5.3s. The pre-rework
   serialization cliff (p99 up to ~30s) is gone from these runs; concurrent
   searches still queue under high concurrency but with bounded tails.
2. **Warm start IS faster than cold at full scale, but only modestly**:
   ~7.5s vs ~8.6s boot-to-ready (~13-19% across reruns; ratios 0.81-0.87).
   The 10K-tool manifest load dominates both boots, so the catalog-cache
   restore path pays less than at small scale (~50% there). The bench gate
   is scale-aware (small: warm must be ≥20% faster; full: ≥15%) and treats
   this band as advisory — a full-scale rerun can flag while staying green.
3. **`action_hub` execute response still drops `ExecuteResult.cached`** —
   the bench measures cache effect indirectly via repeat-vs-distinct latency.
   Corrected methodology (PR 101 rework): the distinct baseline now uses 100
   PROVABLY unique schema-valid arg sets (cardinality asserted and reported
   as `distinctArgSets` in the summary); the first rework iteration silently
   measured only 2 unique sets (a boolean-only schema) and its ratios were
   invalid. Corrected full-scale result: speedup http ~0.75, stdio ~1.6 —
   the cache's full-scale benefit is marginal and noisy in both directions;
   small scale (~1.2-2.2×) remains the cleaner signal. Do not cite the
   pre-PR-101 full-scale cache ratios.
4. **Daemon `start` passes at fleet scale** (PR 58 rerun: the daemon
   contract passes at full scale — 20/20 clients connect and complete
   searches, 0 errors). Current behavior: `daemon.ts` caps start at an
   overall 120s limit plus a 15s no-progress window (`START_TIMEOUT_MS` is
   the daemon-stop wait, not a start window). Historical: the original run
   failed with a fixed 15s start window smaller than a 44-server boot —
   superseded by the current cap-and-progress design; the old fixed-window
   failure is kept here only as history.
5. **Hub memory at full scale**: hub process peak RSS ~0.5GB (cold boot)
   and ~1.0GB steady-state under the HTTP or stdio scenarios; the 20-client
   daemon hub holds ~346MB. Children add ~30MB each × 44 fake servers.
6. **Token cost of the search surface** (full-scale manifests): search
   (limit 10) returns ~3.6KB (~900 tokens); load ~2.9KB (~730 tokens).
   Fine for the tool contract, but a load-with-schema round trip across many
   actions adds up; include_schema on search multiplies it.

Bench validity notes (PR 58 follow-up fixes, 2026-09-27): the probe arg
builders are now corpus-faithful — enum-constrained and min/max-bounded
properties get valid values (generic placeholders failed validation on ~40%
of full-scale execute calls), and the cache-probe distinct baseline varies an
existing schema property instead of injecting an unknown key (full-scale
tools pin `additionalProperties: false`). The search p99 gate is scale-aware
(2s small / 15s full); a healthy full-scale hub spans ~4-13s across runs.

F29 (endpoint-level ECONNRESET under cumulative load): did NOT reproduce in
four full-scale post-merge reruns (all bands 0 errors). Classification from
the instrumented repro: the failure was endpoint-level with the hub process
alive — a transient connection-level event, not hub death. Recommend keeping
the errBreakdown instrumentation in place and watching for recurrence rather
than blocking on it.

Bench hygiene built in after the early failures: per-call timeouts, per-stage
watchdogs, process-tree kill (spawns are detached, killed with -pid),
SIGTERM/SIGINT interrupt handling and verified group cleanup live in the
shared stress lib (spawnGroup/killGroupAndVerify + main() signals);
startup, hub stderr captured to `results/hub-*.log` for post-mortems, and
forced exit after the summary so no spawned child keeps the run alive.