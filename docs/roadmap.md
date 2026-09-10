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

**Layer 2 — `packages/copilot-plugin`**

- `plugin.json` and `.mcp.json` in the Copilot plugin format
- `skills/action-hub/SKILL.md` teaching the search → load → execute loop and
  the approval handshake for gated actions
- Meta-MCP server exposing the single `action_hub` tool over stdio
- Config loader with `~` and `${ENV_VAR}` expansion
- `@modelcontextprotocol/sdk` client adapter for stdio and HTTP transports
- Capability Manager canvas — server table, health, trust, indexed counts,
  invocation history, context savings
- Interactive canvas controls — enable/disable toggles, trust tier changes,
  live search testing, and add-a-server, all writing back through a
  localhost-only control endpoint on the running hub rather than editing the
  config file directly; degrades to the read-only view when no hub is running

## Next

All five near-term roadmap items are implemented. The next priorities should be
chosen from production usage and the committed search evaluation results.

## Later

- Authentication state per server, with OAuth refresh surfaced in the canvas
- Bundles exposed to the model, so a task can scope itself to a subset
- Result caching for idempotent reads
- Additional hosts: Claude Code, VS Code, any MCP-compatible runtime — Layer 2
  is the only part that needs rewriting

## Explicitly out of scope

- **Forking or reimplementing the Copilot app.** `github/app` is a release and
  issue home, not source, and is all-rights-reserved. The plugin path is
  supported, legal, and distributable.
- **Reinterpreting upstream schemas.** Action Hub routes and validates. A
  downstream server's schema is passed through verbatim.
- **Becoming a conformant JSON Schema validator.** The validator exists to
  catch the model's mistakes before a network call, not to be spec-complete.
