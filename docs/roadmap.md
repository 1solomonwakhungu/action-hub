# Roadmap

## Implemented

**Layer 1 — `packages/core`**

- `Catalog` — action records keyed by `serverId:name`, with trust ranking
- `SearchEngine` — BM25 with name weighting, camelCase tokenization, optional
  blended semantic scoring, empty-query browse
- `ConnectionManager` — lazy activation, shared in-flight connection promises,
  per-server state tracking, ordered shutdown
- `PermissionPolicy` — trust tiers, auto-approve floor, allow/deny lists
- `validateArguments` — JSON Schema subset validator
- `BundleRegistry` — named capability scopes
- `CatalogCache` / `bootstrapCatalog` — versioned on-disk catalog keyed by a
  config fingerprint, served on startup and refreshed in the background
- `ActionHub` — the `search` / `load` / `execute` façade, invocation history,
  context savings estimate
- 60 tests covering ranking, the schema split, validation, policy gating,
  per-server failure isolation, activation counts, and cache
  invalidation/corruption handling

**Layer 2 — `packages/copilot-plugin`**

- `plugin.json` and `.mcp.json` in the Copilot plugin format
- `skills/action-hub/SKILL.md` teaching the search → load → execute loop
- Meta-MCP server exposing the single `action_hub` tool over stdio
- Config loader with `~` and `${ENV_VAR}` expansion
- `@modelcontextprotocol/sdk` client adapter for stdio and HTTP transports
- Capability Manager canvas — server table, health, trust, indexed counts,
  invocation history, context savings

## Next

**Semantic scoring by default.** The `SemanticScorer` hook exists but nothing
implements it. Ship a small local embedding model so retrieval stops being
purely lexical. Gate it on the eval suite below.

**Evaluation suite.** Search quality is the product. A corpus of (query →
expected action) pairs with recall@1/@5 reported on every change, so retrieval
regressions fail CI instead of being discovered in use.

**Interactive canvas controls.** The canvas is read-only today. Add enable and
disable toggles, trust changes, live search testing, and add-a-server — writing
back through the hub rather than editing the config file directly.

**Approval flow.** `requiresApproval` is computed and returned but no host
surfaces it. Wire it to a Copilot confirmation prompt so untrusted servers are
genuinely gated rather than merely flagged.

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
