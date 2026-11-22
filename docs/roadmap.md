# Roadmap

Current shipped release: [`v0.1.0`](https://github.com/1solomonwakhungu/action-hub/releases/tag/v0.1.0). See [`STATUS.md`](../STATUS.md) for the detailed shipped PR ledger and test verification counts.

## Implemented

**Layer 1 — `packages/core`**

- **`Catalog`** — unified index of MCP tools and `SKILL.md` skills keyed by `serverId:name`, with provenance, collision-safe skill IDs, first-wins duplicate tool handling, and trust ranking
- **Hybrid Search (`SearchEngine` + `EmbeddingSemanticIndex` + `LocalSemanticIndex`)** — BM25 with name weighting, unicode-aware tokenization, query-side stopwords, curated verb-synonym expansion, and vendored offline int8 `all-MiniLM-L6-v2` ONNX/WASM embeddings fused via RRF (with non-throwing hashed n-gram fallback), memoized corpus statistics per catalog version, and opt-in "no confident match" abstention calibrated to `0.36` on the MiniLM channel
- **`list_servers` compressed directory** — IDF-keyword server summary giving models domain awareness for vague or goal-only requests without changing the host tool surface
- **`ConnectionManager`** — lazy downstream activation, shared in-flight connection promises, per-server activation deadlines (`timeoutMs`), closed/open/half-open circuit breakers (3 transport failures → 10 s cooldown → half-open probe; tool errors never trip the breaker), heartbeat probes, bounded exponential restart backoff with jitter, Node heap caps via `--max-old-space-size`, and anchored reuse-safe process-group teardown
- **`PermissionPolicy` & `ApprovalRegistry`** — trust tiers (`blocked`, `untrusted`, `trusted`), per-server `allowTools` / `denyTools` (deny beats allow), and single-use, expiring, SHA-256 canonical-argument-bound approval tokens
- **`validateArguments`** — JSON Schema subset validator preserving verbatim upstream schemas
- **`BundleRegistry`** — named multi-tool capability sets exposed to the model via `search_bundles` / `load_bundle` and exportable via CLI
- **Result caching for idempotent reads** — read-only tool result caching reported with `cached: true`, plus upstream tool-annotation propagation
- **`CatalogCache` & warm startup** — versioned on-disk catalog keyed by config fingerprint with hydrated embedding vectors, served immediately on startup with deferred background refresh, debounced snapshots, and cooperative chunked re-indexing
- **OAuth 2.0 for remote HTTP MCP servers** — PKCE and `client_credentials` flows, proactive 60 s pre-expiry refresh, deduplicated concurrent refreshes, and RFC 6749 refresh-token rotation stored `0600`
- **OpenTelemetry tracing** — zero-lock-in instrumentation via `@opentelemetry/api`, strict low-cardinality attributes including `action_hub.approval.args_sha256` (zero leaked arguments, schemas, or secrets), and W3C `traceparent`/`tracestate` propagation on HTTP transports
- **Auto-discovery & universal migration engine** — discovers and merges MCP servers, skills, and plugins across 9 client harnesses with credential redaction and atomic `0600` config writes
- **Evaluation & stress suites (`stress/` + `eval/`)** — 44-server / 10,000-tool / 5,000-skill corpus generators, isolated k6 load and chaos harnesses, 120/121 hand-written realistic retrieval evaluation, separate 30-query goal-only recall gate, and fixture-backed point-in-time (`as-of`) execution evaluation

**Layer 2 — `packages/plugin` + `packages/cli`**

- **Cache-stable `action_hub` meta-MCP server** — pinned by `cache-stable.test.ts` (one fixed tool, zero `tools/list_changed` emissions, schemas returned as tool results) over:
  - foreground stdio (`action-hub start`)
  - loopback Streamable HTTP with bearer-token authentication (`action-hub serve`)
  - authenticated shared multi-harness daemon over a user-only `0600` Unix domain socket (or ephemeral `127.0.0.1` loopback port on Windows) with a 256-bit constant-time token (`action-hub daemon` + `action-hub connect`)
- **Plugin bundle** — `plugin.json`, `.mcp.json`, and `skills/action-hub/SKILL.md` teaching the `search` → `load` → `execute` loop and approval handshake
- **Standalone Node SEA binaries** — zero-dependency single executables across 5 OS/arch targets (macOS `arm64`/`x64`, Linux `x64`/`arm64`, Windows `x64`) bundling the runtime, CLI, MCP server, and vendored MiniLM assets, published with `SHA256SUMS.txt`, Homebrew formula, winget manifests, and `THIRD_PARTY_LICENSES.txt`
- **Full developer CLI** — `init`, `migrate`, `import`, `harness` (with `--daemon` and timestamped `.bak` backups across 7 targets), `doctor`, `test-search`, `list`, `bundle`, `auth`, `daemon`, `start`, `serve`, `connect`, and `licenses`
- **Explainer microsite (`site/`)** — interactive architecture walkthrough and grounded design notes published to GitHub Pages

## Next / Planned

- **npm (`@action-hub/cli`) & Official MCP Registry (`server.json`) publishing activation** — enable one-command `npx` usage and automated Official MCP Registry updates once the `@action-hub` npm scope and `NPM_TOKEN` are active (packaging and release automation are prepped in-repo; see [`docs/releasing.md`](releasing.md))
- **Richer host & editor integrations ([#20](https://github.com/1solomonwakhungu/action-hub/issues/20))** — first-class extensions for VS Code, Cursor, and JetBrains with daemon status, capability browsing, permission controls, and surfacing per-server OAuth/auth state directly to hosts
- **Deterministic total-session token-budget benchmark** — reproducible end-to-end benchmark measuring full multi-turn session token cost (baseline + `list_servers` + `search` + `load` + false-positive search retries) against real MCP server schemas
- **Expanding held-out abstention & goal-only evaluation sets** — grow the held-out negative and goal-only corpora to validate default abstention behavior across broader domains and tune vague-query retrieval without regressing precision

## Explicitly out of scope

- **Forking or reimplementing a host app.** Hosts are products of their
  vendors; we integrate through supported extension paths rather than cloning
  them.
- **Reinterpreting upstream schemas.** Action Hub routes and validates. A
  downstream server's schema is passed through verbatim.
- **Becoming a conformant JSON Schema validator.** The validator exists to
  catch the model's mistakes before a network call, not to be spec-complete.
