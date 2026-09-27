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

1. **Search latency collapses under concurrency** (numbers from the
   pre-rework run; re-run numbers below once recorded). At c=1 the hub answers
   in ~0.2-0.8s; at c=10 the p50 is ~1.5-3.6s and at c=50/c=100 p50 reaches
   ~5-17s with p99 up to ~30s (both HTTP serve and stdio). Zero request
   errors — the hub never fails, it just does not scale: concurrent searches
   appear to serialize somewhere below the MCP layer. (Note: c50/c100 bands
   in that run used a fixed 20-request sample; the reworked harness runs the
   full fixed sample count per band at true concurrency.)
2. **Warm start is NOT faster than cold** (warm ~17s vs cold ~19s in the
   latest run; earlier runs 8.3s vs 5.5s the other way). The catalog cache
   restore path (`XDG_CACHE_HOME/action-hub/catalog.json`) is not paying for
   itself at 10K tools — flag for the catalog-cache owner.
3. **`action_hub` execute response drops `ExecuteResult.cached`** — the
   hub's result cache works (repeats return `duration_ms: 0`, measured hit
   ratio ~0.94-1.0) but the dispatch projection omits the `cached` field, so
   clients cannot detect cache hits. (Filed as a finding; bench counts hits
   via `duration_ms === 0`.)
4. **Daemon `start` does not become ready at fleet scale**: its 15s
   readiness window (`START_TIMEOUT_MS` in packages/cli/src/commands/daemon.ts)
   is smaller than a 44-server boot (6-19s observed, more under load), and
   `daemon.log` contains only child stderr with no hub progress markers.
   Concurrent-connect behavior is packet D1 (builder-1).
5. **Hub memory at full scale**: hub process peak RSS ~0.5-0.8GB (serve,
   HTTP) and up to ~1.7GB sampled for the stdio hub; children add ~30MB each
   × 44 fake servers. Not a hard bottleneck alone, but notable with 1.5GB
   soft limits configured for servers.
6. **Token cost of the search surface**: search(limit 10) returns ~3.4KB
   (~850 tokens); load returns ~0.5-0.7KB (~130-165 tokens). Fine for the
   tool contract, but a load-with-schema round trip across many actions adds
   up; include_schema on search multiplies it.

Bench hygiene built in after the early failures: per-call timeouts, per-stage
watchdogs, process-tree kill (spawns are detached, killed with -pid),
SIGTERM/SIGINT interrupt handling and verified group cleanup live in the
shared stress lib (spawnGroup/killGroupAndVerify + main() signals);
startup, hub stderr captured to `results/hub-*.log` for post-mortems, and
forced exit after the summary so no spawned child keeps the run alive.