# Roadmap

## Implemented

**Layer 1 — `packages/core`**

- `Catalog` — action records keyed by `serverId:name`, with trust ranking
- `SearchEngine` — BM25 with name weighting, camelCase tokenization, blended
  semantic scoring with a tunable weight, empty-query browse
- `LocalSemanticIndex` — dependency-free local embeddings (subword n-gram
  hashing plus a concept lexicon), precomputed at index time, blended at
  `w = 0.2`, with a non-throwing fallback to pure BM25
- `ConnectionManager` — lazy activation, shared in-flight connection promises,
  per-server state tracking, ordered shutdown, closed/open/half-open circuit
  breakers, heartbeat probes, bounded restart backoff with jitter, and Node
  heap caps via `--max-old-space-size`
- `PermissionPolicy` — trust tiers, auto-approve floor, allow/deny lists
- `ApprovalRegistry` — single-use, argument-bound, expiring approval tokens
  backing the two-step execute flow for gated actions
- `validateArguments` — JSON Schema subset validator
- `BundleRegistry` — named capability scopes
- `CatalogCache` / `bootstrapCatalog` — versioned on-disk catalog keyed by a
  config fingerprint, served on startup and refreshed in the background
- `ActionHub` — the `search` / `load` / `execute` façade, invocation history,
  context savings estimate
- Tests covering ranking and semantic quality gates, scorer fallback, the schema
  split, validation, policy gating, approval tokens, per-server failure
  isolation, activation counts, and cache invalidation/corruption handling

**Layer 2 — `packages/plugin`**

- `plugin.json` and `.mcp.json` in the standard plugin bundle format
- `skills/action-hub/SKILL.md` teaching the search → load → execute loop and
  the approval handshake for gated actions
- Meta-MCP server exposing the single `action_hub` tool over stdio
- Config loader with `~` and `${ENV_VAR}` expansion
- `@modelcontextprotocol/sdk` client adapter for stdio and HTTP transports
- `action-hub` CLI for server management — import, doctor, auth, list,
  and live search testing against the real index

## Next

All five near-term roadmap items are implemented. The next priorities should be
chosen from production usage and the committed search evaluation results.

## Later

- Authentication state per server, with OAuth refresh surfaced to the host
- Bundles exposed to the model, so a task can scope itself to a subset
- Result caching for idempotent reads
- Support for hosts that need richer integration than the single MCP tool
  (e.g. native tool listings, per-host skill formats)

## Explicitly out of scope

- **Forking or reimplementing a host app.** Hosts are products of their
  vendors; we integrate through supported extension paths rather than cloning
  them.
- **Reinterpreting upstream schemas.** Action Hub routes and validates. A
  downstream server's schema is passed through verbatim.
- **Becoming a conformant JSON Schema validator.** The validator exists to
  catch the model's mistakes before a network call, not to be spec-complete.
