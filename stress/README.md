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
| `stress/eval-retrieval.mjs` | builder-6 | search quality at scale |
| `stress/chaos.mjs` | builder-8 | crash/hang/slow-start scenarios |
| `stress/harness-e2e.mjs` | builder-9 | pi harness entrypoint e2e |
| `stress/cli-scale.mjs` | builder-3 | CLI surface scale |

Generated data lives in `stress/.generated/` (gitignored). Only scripts and
this README are committed.

## Run

```bash
npm run build                     # CLI must be built; bench drives dist/index.js
node stress/bench-load.mjs --scale small   # small fallback fixtures
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
   Small scale: repeats ~1.2-2.2× faster than distinct. Full scale: HTTP
   ~1.37×, stdio noisy (0.73-1.27× — a repeat can measure slower than a
   distinct call at scale); treat small-scale numbers as the clean signal.
4. **Daemon `start` does not become ready at fleet scale**: its 15s
   readiness window (`START_TIMEOUT_MS` in packages/cli/src/commands/daemon.ts)
   is smaller than a 44-server boot (6-19s observed, more under load), and
   `daemon.log` contains only child stderr with no hub progress markers.
   Concurrent-connect behavior is packet D1 (builder-1). (PR 58 rerun:
   the daemon contract passes at full scale — 20/20 clients connect and
   complete searches, 0 errors.)
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