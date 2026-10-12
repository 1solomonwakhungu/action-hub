# Changelog

All notable changes to Action Hub are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

No version has been tagged yet. Everything below is on `main`, which GitHub
records as 96 merged pull requests as of 2026-10-11. The checkout this file was
first written from was shallow and starts at `a5310ba` (#55, 2026-09-26); the
entries below group the pull requests visible from there and the earlier ones
the README cites by number. PR numbers link to this repository.

## [Unreleased]

### Added

- **Search quality.** Query-side stopwords, unicode-aware tokenization, a
  document token cap, and an optional `minScoreRatio` cutoff (#52). Curated
  verb-synonym query expansion, down-weighted and skipped on exact-name
  lookups (#83). Local MiniLM embeddings (vendored int8 model, onnxruntime-web
  WASM) as the default semantic channel, fused with BM25 by reciprocal-rank
  fusion, with the hashed index kept as the automatic fallback (#92). An
  off-by-default "no confident match" abstention flag for search (#82), with
  a held-out recalibration showing the shipped 0.8 threshold must be lowered
  before enabling it (#105).
- **Server directory.** The `list_servers` operation returns a compressed
  per-server directory (id, display name, description, action count, domain
  keywords); the compact form rides along on empty and abstained search
  responses (#104).
- **Resilience.** Per-server activation deadline covering spawn + initialize
  (#65). Servers with repeated execute timeouts are isolated through the
  circuit breaker (#73). Execute-time transport failures trip the breaker
  (#59, cited in the README).
- **Server runtime.** Deferred startup refresh so a warm catalog answers
  `initialize` immediately on stdio, HTTP, and daemon transports; `cached:
  true` on execute responses; debounced snapshot writes (#68). Cooperative
  index embedding so the daemon keeps serving during a reindex, plus
  `indexing` / `indexingSettledAt` in `daemon.json` (#63).
- **CLI.** Progress-aware daemon start with a 120 s cap and 15 s no-progress
  window (#70). Deterministic `doctor` under flapping servers (#61). Anchored,
  reuse-safe process-group teardown for spawned servers (#77). Pipe-safe
  stdout flushing so large output is never truncated (#53, cited in the
  README).
- **Stress and evaluation suite.** External stress station with k6, fuzzing,
  spec and conformance suites (#47, #95). CLI scale benchmarks (#57). Load and
  performance bench plus orchestrator (#58). Harness end-to-end runs (#62).
  Shared harness library with isolation, process-group runner, interrupt-safe
  `main()`, and group API (#64, #75, #94). Retrieval-quality evaluation with
  execution success and abstention as separate metrics (#66, #103).
  Hand-written realistic query fixture, ambiguity validator, quality lint gate,
  and verb-consistent generated descriptions (#72, #76, #78). Strict eval
  validators (#85). Corpus-faithful probe arguments and scale-aware gates
  (#101). Goal-only recall gate with committed per-engine floors (#104).
- **Docs and site.** Scale and reliability section in the README (#80).
  Cache-stable design notes and guidance for loaded schemas after context
  compaction (#105). Explainer microsite deployed to GitHub Pages (#106).
- **Community files.** `CONTRIBUTING.md`, `SECURITY.md`, this changelog, a
  pull request template, and bug-report / feature-request issue forms.
- **Supply chain.** Dependabot (weekly npm and GitHub Actions updates, minor
  and patch bumps grouped) and a CodeQL workflow for JavaScript/TypeScript.

### Changed

- `@modelcontextprotocol/sdk` raised to `^1.32.1` in the CLI and server
  workspaces. 1.30.x was flagged by GHSA-6qxp-vccf-f47h (OAuth client could
  send credentials to an attacker-chosen authorization server) and was the
  only path to every other production advisory (`proxy-addr`, `qs`,
  `ip-address`, `fast-uri`, `hono`); `npm audit --omit=dev` is clean.
- Harness-neutral naming: `packages/plugin` and `@action-hub/mcp-server`
  replace the Copilot-specific names; the capability-manager canvas was
  removed (#55).
- Stateless HTTP POSTs are answered with plain JSON instead of a per-request
  SSE stream (#88).
- Empty search queries and unknown `tools/list` cursors return JSON-RPC
  `-32602` (#81).
- Unit-test hubs disable embeddings by default; execute-timeout handling
  hardened; embedding vector writes follow a defined lifecycle (#102).
- README status, roadmap, architecture, and telemetry docs rewritten to match
  the code: OAuth, model-visible bundles, and the idempotent-read cache moved
  from "later" to "implemented"; the semantic weight and fusion mode, the
  telemetry attribute names and trust tiers, and the stress cache-measurement
  note corrected; known gaps listed with file paths.

### Fixed

- The server runtime's config loader now carries an HTTP transport's OAuth
  `auth` block through, so `action-hub start`, `serve`, and the daemon bind
  tokens the same way the CLI commands already did. A malformed block is
  rejected instead of silently connecting unauthenticated.
- Config loading fails closed on malformed shapes: a non-object JSON root, or
  a present-but-malformed `args`, `env`, `headers`, `allowTools`,
  `denyTools`, `tags`, `serverIds`, or `actionIds`, is an error naming the
  field instead of a partially loaded config (a string `denyTools` used to
  disable the deny list). `${VAR}` now expands inside `~/`-prefixed paths.
- Argument validation: `additionalProperties: false` applies when
  `properties` is absent and respects `patternProperties`; `Object.prototype`
  names (`constructor`, `__proto__`, `toString`) are neither supplied nor
  declared properties; type unions such as `["string", "null"]` are enforced;
  string lengths count code points; `pattern` compiles in unicode mode with a
  legacy fallback.
- Connection manager: a client factory that throws synchronously no longer
  parks its rejection as the in-flight activation forever; a heartbeat probe
  that settles after `reconnect()` is ignored instead of being charged to the
  new connection and doubling the heartbeat chain.
- Tokenizer keeps combining marks and NFC-normalizes, so accented and
  Devanagari text no longer matches on consonant fragments. Eval baseline
  unchanged.
- Loopback HTTP server routes on the request path only; a malformed `Host`
  header no longer yields a 500 before authentication.
- CLI rejects a valueless `--config` and a non-numeric or non-positive
  `--limit` with exit 1 instead of ignoring them.
- `harness install` writes host configs atomically (sibling temp file plus
  rename, mode preserved, symlinked dotfiles written through).
- Tests that simulate unreadable or unwritable paths with `chmod` skip with a
  reason under a root runner and gain root-proof companion fixtures, so the
  suite is green in containers; the HTTP circuit-breaker test no longer dials
  port 0 on a half-written port file.
- Malformed stdio JSON-RPC frames are answered (`-32600` / `-32700`) instead
  of dropped (#89).
- Deterministic winner-path identity check and exit-event grace in the CLI
  process anchor (#96, #97); the unused server pid relay was removed (#100).
- Smoke test spawns are isolated from the owner's real state (#69); stress
  `main()` refuses an owner-state results path (#99).
- Conformance evaluator false negative on healthy cleanup (#98); results
  directory created before seeding stale artifacts in the eval self-test
  (#93); `gen-skills` removes partial output on a post-write failure (#79).
- Flaky wall-clock search microbench replaced by a deterministic memo
  assertion (#90); contention-tolerant activation-deadline tests (#87); test
  hygiene passes (#71, #91).

### Removed

- `STATUS.md`. Its status content moved to the README "Status" section and
  `docs/roadmap.md`; its development notes moved to `CONTRIBUTING.md`.

