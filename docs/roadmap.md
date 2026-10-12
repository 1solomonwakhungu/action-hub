# Roadmap

Status of the project as of 2026-10-11. Every item under **Implemented** is
backed by code on `main` and by tests; file paths point at the implementation
so the claim can be checked. Nothing has been tagged or released yet (see
[Known gaps](#known-gaps)).

## Implemented

**Layer 1 — `packages/core`**

- `Catalog` — action records keyed by `serverId:name`, with trust ranking
  (`src/catalog/catalog.ts`)
- `SearchEngine` — BM25 with name weighting, camelCase and unicode-aware
  tokenization, query-side stopwords and a token cap, curated verb-synonym
  expansion (down-weighted; skipped on exact-name lookups), an exact-name
  first-place invariant, optional `minScoreRatio` cutoff, empty-query browse
  (`src/search/search.ts`, `tokenizer.ts`, `synonyms.ts`)
- `EmbeddingSemanticIndex` — the default semantic channel: a vendored int8
  all-MiniLM-L6-v2 model run by onnxruntime-web (WASM, no native addons,
  nothing fetched at runtime), fused with BM25 by reciprocal-rank fusion,
  built cooperatively so the event loop keeps serving during a reindex
  (`src/search/embeddings.ts`, `vendor/`)
- `LocalSemanticIndex` — the dependency-free hashed fallback (subword n-grams
  plus a concept lexicon), blended at weight 0.2, used automatically when the
  embedding model cannot load (`src/search/semantic.ts`)
- Compressed server directory for the `list_servers` operation: per-server
  domain keywords by coverage times server-level IDF, memoized per catalog
  generation (`src/search/server-directory.ts`)
- `ConnectionManager` — lazy activation, shared in-flight connection
  promises, per-server activation deadline (spawn + initialize), ordered
  shutdown, closed/open/half-open circuit breakers fed by execute-time
  transport failures and by repeated execute timeouts, heartbeat probes,
  bounded restart backoff with jitter, Node heap caps via
  `--max-old-space-size` (`src/servers/`)
- `PermissionPolicy` — trust tiers, auto-approve floor, allow/deny lists
  (`src/permissions/policy.ts`)
- `ApprovalRegistry` — single-use, argument-bound, expiring approval tokens
  backing the two-step execute flow for gated actions
  (`src/permissions/approvals.ts`)
- `validateArguments` — JSON Schema subset validator (`src/router/validate.ts`)
- `BundleRegistry` — named capability scopes, searchable and loadable as a
  unit (`src/bundles/bundles.ts`)
- `CatalogCache` / `bootstrapCatalog` — versioned on-disk catalog keyed by a
  config fingerprint, served on startup and refreshed in the background;
  atomic, serialised, `0600` writes (`src/catalog/persistence.ts`,
  `bootstrap.ts`)
- OAuth 2.0 for remote HTTP servers — authorization-code with PKCE and
  client-credentials grants, proactive refresh, refresh-token rotation,
  deduplicated concurrent refreshes, one replayed 401, explicit
  `authorization_required` failure, host-injected `TokenStore` with a `0600`
  `FileTokenStore` default (`src/auth/`)
- Idempotent-read result cache — results of actions marked `readOnlyHint`
  (or whose name carries a conventional read prefix) are cached per argument
  fingerprint, 60 s TTL and 500 entries by default, surfaced as
  `cached: true` on `ExecuteResult` and on the `action_hub` execute response
  (`src/action-hub.ts`)
- Redaction of secrets from snapshots, errors, and echoed config
  (`src/redact.ts`)
- OpenTelemetry instrumentation of `search`, `load`, `loadBundle`, and
  `execute` through `@opentelemetry/api` only, with W3C trace propagation on
  HTTP transports ([telemetry.md](telemetry.md), `src/telemetry/`)
- Harness discovery and migration — MCP servers, skills, and plugins from
  Claude Desktop, Cursor, VS Code, Copilot, Codex, Windsurf, Cline, and Roo
  Code (`src/discovery/`, `src/migration/`)
- `ActionHub` — the `search` / `load` / `loadBundle` / `execute` façade,
  server directory, invocation history, context savings estimate
- Retrieval evaluation harness with committed floors, run by `npm run eval`
  (`eval/`)

**Layer 2 — `packages/plugin`**

- `plugin.json` and `.mcp.json` in the standard plugin bundle format
- `skills/action-hub/SKILL.md` teaching the search → load → execute loop, the
  `list_servers` directory, bundles, and the approval handshake
- Meta-MCP server exposing the single `action_hub` tool with the operations
  `search`, `load`, `execute`, `list_servers`, `search_bundles`, and
  `load_bundle`, over stdio, streamable HTTP (loopback, bearer token), and a
  shared per-user daemon with an authenticated local socket
  (`server/src/index.ts`, `http-server.ts`, `daemon.ts`)
- Cache-stable tool surface: one fixed tool definition, a single `tools/list`
  page, no `tools/list_changed` notification, schemas returned only as tool
  results (`server/test/cache-stable.test.ts`)
- Deferred startup refresh: a warm catalog answers `initialize` immediately
  and re-indexes afterwards; snapshot writes are debounced
- Output hardening: byte caps on every echoed field, schema size limits
  (`server/src/output-hardening.ts`)
- Optional, off-by-default "no confident match" abstention for search
  (`search.abstention` in the config; see the calibration in
  [harness-guides.md](harness-guides.md#no-confident-match-abstention-search))
- Config loader with `~` and `${ENV_VAR}` expansion, skills directory
  scanning (`~/.action-hub/skills` or `ACTION_HUB_SKILLS_DIR`)

**Developer CLI — `packages/cli`**

- `doctor`, `licenses`, `auth <login|status|logout>`, `migrate`, `import`,
  `test-search`, `list`, `bundle`, `start`, `harness`, `serve`, `connect`,
  `daemon <start|status|stop>` (`src/index.ts`)
- `harness` targets: `claude-code`, `claude-desktop`, `cursor`, `codex`,
  `opencode`, `pi`, `vscode`, with timestamped backups on `install --write`
- Progress-aware daemon start (120 s cap, 15 s no-progress window),
  anchored process-group teardown, deterministic `doctor` under flapping
  servers, pipe-safe stdout flushing

**Distribution and verification**

- Standalone Node SEA binaries for macOS arm64/x64, Linux x64/arm64, and
  Windows x64, built and smoke-tested by `.github/workflows/release.yml`,
  with generated Homebrew and winget manifests ([releasing.md](releasing.md))
- Stress and scale suite at 44 servers / 10,000 tools / 5,000 skills:
  load bench, chaos, CLI scale, harness e2e, retrieval evaluation, goal-only
  recall gate, abstention calibration, external k6/fuzz/conformance station
  ([../stress/README.md](../stress/README.md))
- Test isolation preload (`test-isolation.mjs`) so no test or spawned child
  can touch the real user's config, cache, or harness state
- Explainer microsite published to GitHub Pages from `site/`

## Known gaps

Things the code does not do yet, or does only partly. These are the honest
caveats to the list above.

- **No release has been tagged.** The release workflow, Homebrew formula, and
  winget manifests exist and are exercised in CI, but as of 2026-10-11 the
  repository has no `v*` tag and no GitHub release, so the install commands
  in the README do not resolve yet.
- **Search abstention is off by default and its shipped threshold is not
  calibrated for the default channel.** At 0.8 on the embeddings channel it
  refuses every real match; the measured operating point is near 0.36. See
  the calibration tables in harness-guides.md before enabling it.
- **Goal-only queries are the weakest retrieval band**: recall@5 0.533 under
  the default embeddings engine, 0.433 keyword-only (measured 2026-10-11,
  `stress/goal-only-gate.mjs`). Misses are verb and entity paraphrases the
  synonym table does not bridge.
- **Embedding a 15K-record catalog cold takes minutes** in WASM on a cloud
  runner. Searches during the cold embed get zero semantic weight; hosts that
  need warm vectors await `semanticReady()`.

## Next

Chosen from production usage and the committed evaluation results rather than
a fixed list. Candidates, in no committed order:

- Cut `v0.1.0`, so the binary channel is real.
- Raise goal-only recall without trading away exact-name or paraphrase
  recall; raise the committed floors in the same change.
- Recalibrate and possibly enable search abstention once the no-match fixture
  is larger than 87 rows.

## Later

- Support for hosts that need richer integration than the single MCP tool
  (e.g. native tool listings, per-host skill formats)
- A keychain-backed `TokenStore` for desktop hosts (the interface exists; only
  the file store ships)

## Explicitly out of scope

- **Forking or reimplementing a host app.** Hosts are products of their
  vendors; we integrate through supported extension paths rather than cloning
  them.
- **Reinterpreting upstream schemas.** Action Hub routes and validates. A
  downstream server's schema is passed through verbatim.
- **Becoming a conformant JSON Schema validator.** The validator exists to
  catch the model's mistakes before a network call, not to be spec-complete.
