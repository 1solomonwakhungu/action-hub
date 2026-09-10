# Architecture

## The two layers

The split exists so the engine outlives its first host.

```
GitHub Copilot app
        │
        ▼
  Action Hub plugin          ← Layer 2, replaceable
        │
        ▼
  action_hub MCP tool
        │
        ▼
  ActionHub façade           ← Layer 1, the actual IP
        │
        ├── Catalog ──────────► CatalogCache (~/.cache/action-hub)
        ├── SearchEngine
        ├── ConnectionManager ──► GitHub MCP, Linear MCP, Slack MCP, …
        ├── PermissionPolicy
        └── validateArguments
```

Layer 1 has no dependency on Copilot, on the MCP SDK, or on any transport. It
talks to downstream servers only through the `McpClient` interface:

```ts
interface McpClient {
  listTools(): Promise<Array<{ name; description?; inputSchema? }>>;
  callTool(name, args): Promise<unknown>;
  close(): Promise<void>;
}
```

That interface is four lines long on purpose. It is the entire contract between
the engine and the outside world, which is why the test suite can drive the
whole system with in-memory fakes and no subprocesses.

Layer 2 supplies one implementation of that interface (`sdk-client.ts`, backed
by `@modelcontextprotocol/sdk`) and one presentation of the façade (the
`action_hub` tool). Porting to Claude Code, VS Code, or any other MCP host
means rewriting Layer 2 only.

## Why search must not return schemas

This is the load-bearing decision of the whole project.

A tool definition costs context on every single turn, whether or not it is
used. A moderate MCP setup — GitHub, Linear, Slack, a filesystem server, a
browser server — is 150+ tools and comfortably 50,000 tokens of permanently
resident schema. The model pays that on turn one and on turn four hundred.

Action Hub inverts it:

| | Eager | Action Hub |
| --- | --- | --- |
| Resident cost | every schema, every turn | one schema (~600 tokens) |
| Marginal cost of server #20 | +2,000 tokens forever | 0 |
| Ceiling | context window | disk |

`search` returns `id`, `name`, `serverId`, `kind`, and a one-line summary.
`load` is the only path that returns `inputSchema`. If search ever returned
schemas, the system would degrade into the eager model with extra steps —
which is why `packages/core/test/action-hub.test.ts` asserts that search
results contain no `inputSchema` key.

## Retrieval

`SearchEngine` is BM25 (`K1 = 1.2`, `B = 0.75`) over a document built per
action from its name, summary, and description.

Name tokens are inserted three times. An exact name match is a far stronger
intent signal than a keyword collision in a description, and triplication is a
cheap, explainable way to encode that without a separate scoring stage.

`tokenize()` splits on punctuation *and* camelCase boundaries, so
`createPullRequest`, `create_pull_request`, and "create a pull request" all
reduce to the same terms. Downstream servers are wildly inconsistent about
naming, and the index should not care.

A `SemanticScorer` is blended rather than substituted:

```
score = (1 - w) · (s / (1 + s)) + w · semantic     w = 0.4
```

The lexical score is squashed into `[0, 1)` before blending so the two signals
are commensurate, and the weight is deliberately below 0.5 so a weak or
misconfigured embedding model degrades results instead of destroying them.
Tune it with `setSemanticWeight()`; `0` disables the semantic signal entirely.

If the scorer throws, rejects, or returns anything other than a numeric array
of the right shape, the blend is skipped and the query falls back to pure BM25.
Retrieval never fails because of the semantic layer.

### The local semantic index

`LocalSemanticIndex` is the default scorer, wired up by `ActionHub` unless you
pass `semanticScorer: null`. It is deliberately dependency-free: no model
weights, no download at install time, no network at query time. Embeddings are
deterministic, so two processes indexing the same catalog agree exactly.

A document embedding is the IDF-weighted sum of two signals, hashed into a
fixed 256-dimensional space and L2-normalized; scoring is a cosine similarity.

1. **Subword character n-grams** (3-4 chars) over each term. This is what makes
   morphology work — "messaging" and "message" share most of their n-grams
   without either being a prefix of the other.
2. **A concept lexicon** (`DEFAULT_CONCEPTS`), a small hand-written thesaurus of
   operational vocabulary. Every term in a group anchors to a shared concept
   dimension, so "instance", "vm", and "virtual machine" land near each other.

The second signal exists because the first cannot possibly cover synonymy:
n-grams are purely orthographic, and "virtual machine" shares no substring with
"instance". Concept lookup applies cheap suffix stripping so "working" reaches
the `task` concept, which the shared `tokenize()` would not do on its own —
that stemming is confined to concept lookup precisely because BM25 depends on
`tokenize()` staying literal.

Embeddings are built once per catalog change in `index()`, not per query. A
record the index has not seen — or whose text changed since the last rebuild —
is embedded on demand rather than silently scored zero.

An earlier iteration derived term relatedness from catalog co-occurrence via
random indexing. It was removed after measurement, not left switched off: a
co-occurrence pass pulls every term toward its own document's centroid, which
destroys discrimination between actions on the *same* server, which is exactly
where ranking is hardest. Every configuration in the parameter sweep preferred
a weight of zero for it.

An empty query is treated as a browse request and returns a stable
alphabetical slice, not an error. "Show me what is available" is a legitimate
thing for a model to ask.

## Lazy activation

Indexing is the one moment a downstream server must be contacted eagerly — you
cannot index tools you have not listed. After that, `ConnectionManager` keeps
each server `inactive` until an action from it is actually executed.

Concurrent `activate()` calls for the same server share a single in-flight
promise, so a burst of parallel executions produces one connection rather than
a thundering herd.

`ConnectionManager` also owns recovery. Each server has its own closed / open /
half-open circuit: consecutive failures trip it, the cooldown fails fast, and
the first call after cooldown is a single half-open probe. Crashed or
unreachable stdio servers restart with bounded exponential backoff and jitter.
Manual `deactivate()`, `setEnabled(false)`, and `closeAll()` cancel timers and
never auto-restart. Heartbeats probe `listTools` on connected servers and move
status through `degraded` then `unreachable`. Node-based stdio servers can set
`maxOldSpaceSizeMb`; the client factory injects `--max-old-space-size` (or
`NODE_OPTIONS` for wrappers such as `npx`) without duplicating an existing flag
or touching non-Node commands.

Indexing failures are captured per server. One broken integration produces one
`IndexResult` with an `error` field; the rest of the catalog still builds. A
misconfigured Slack token must not take down GitHub.

## Catalog persistence

Indexing is the only eager cost in the system, and it is linear in the number
of configured servers. `bootstrapCatalog` removes it from the critical path:
the catalog is read from `$XDG_CACHE_HOME/action-hub/catalog.json` (falling
back to `~/.cache`), the hub becomes answerable immediately, and the real index
runs behind it and writes the refreshed catalog back.

An entry is reused only when both the schema `version` and a `configHash`
match. That hash covers command, args, cwd, transport type, URL, trust,
enabled, and the allow/deny lists. It deliberately covers env and header *keys*
but not their *values*: a rotated token must not discard a valid catalog, and a
secret must not end up in a digest that lives on disk. A value change that
actually alters the catalog is caught by the background re-index instead.
Servers are sorted before hashing, so reordering the config file is not a
cache-invalidating edit.

Every failure mode degrades to a full index rather than an error. A missing,
corrupt, truncated, or unreadable file is a miss; individual malformed action
records are dropped while the rest of the entry survives; an unwritable cache
directory produces a warning and a working hub. The background refresh catches
its own rejections, because an unhandled one would take down the process the
agent session depends on.

Restoring a catalog restores *only* the catalog. No server is activated, so
lazy activation is preserved — a warm start connects to nothing until an action
is executed. Actions belonging to servers that have since been removed from the
config are dropped, since they could never be dispatched.

The cache file and the Capability Manager snapshot are the same file. The
persisted entry is a superset of `HubSnapshot`, so one atomic write keeps the
canvas current and the cache warm without the two drifting apart. Each write
goes to a unique temp file (`<path>.<pid>.<uuid>.tmp`) and is renamed into
place, and every write on a `CatalogCache` instance is serialised onto a
promise chain. That combination is what makes the "atomic" claim hold under the
concurrency the host actually produces — an unawaited write after every
`execute` plus the background refresh — so two writes can never interleave their
bytes or race each other's rename, and a reader always sees a complete entry.
The cache directory is created `0700` and the file written `0600`.

## Remote authentication

A remote HTTP server that speaks OAuth 2.0 declares it in `transport.auth`.
Nothing else about the transport changes: an HTTP transport with no `auth`
block, including one carrying a hand-written `Authorization` header, behaves
exactly as it did before.

Providers are modelled as configuration, not code. GitHub, Slack, Jira and any
other standards-compliant authorization server are described by their endpoints
and scopes; there is no provider registry and no per-vendor branch. The two
escape hatches for the details providers disagree about are
`extraAuthorizationParams` and `extraTokenParams`.

### The core/host boundary

`packages/core` owns the protocol and nothing else. `OAuthClient` takes an
injected `fetch`, an injected clock, and an injected `TokenStore`; it never
opens a browser, reads `process.env`, or talks to a keychain. That is what
keeps it runtime-agnostic and what makes the lifecycle testable without a
socket.

The host supplies the parts that are inherently platform-specific:

| Concern | Contract | Default |
| --- | --- | --- |
| Credential persistence | `TokenStore` | `FileTokenStore` (mode `0600`) |
| Secret material | `clientSecretEnv` / `clientIdEnv` | resolved by the host from its environment |
| User consent | `createAuthorizationRequest` → `exchangeAuthorizationCode` | `action-hub auth login <id>` |

A desktop host that wants the system keychain implements `TokenStore` and
passes it in; core is unchanged.

### Token lifecycle

`createHttpAuthBinding` returns a `fetch` wrapper that the MCP SDK transport
uses in place of the global one, so authentication is invisible to the
connection manager. On each request it:

1. Refreshes **ahead** of expiry, using a 60 s leeway by default. Waiting for a
   401 costs a wasted round trip and, on some providers, a rate-limit penalty.
2. Deduplicates concurrent refreshes. Activating several tools at once produces
   a burst of requests against one expired token; all of them join a single
   in-flight refresh. Without this, a provider that rotates refresh tokens sees
   N concurrent uses of a one-time token and revokes the whole grant.
3. Rotates. A returned `refresh_token` always replaces the stored one; when the
   provider returns none, the previous one is carried forward per RFC 6749 §6.
4. Retries a 401 exactly once, after forcing a refresh, and only when the
   request body can actually be replayed. A stream body cannot, so it is not
   retried.
5. Fails explicitly. `invalid_grant` drops the dead credential and raises
   `authorization_required` rather than retrying something that cannot succeed.

Before replaying, the 401 is attributed to the specific token that failed. If a
concurrent refresh already replaced it, the invalidation is a no-op — otherwise
a slow request could discard a token that was just minted.

### Secrets

No token value reaches a log, an error message, the catalog cache, or the
Capability Manager snapshot.

Token-endpoint error bodies are reduced to the two RFC 6749 fields (`error`,
`error_description`) before being rendered, because a token endpoint is the one
place a raw body could carry a credential. Configured secrets are then scrubbed
from the resulting text as a second pass.

`hashServerConfigs` normalises the `auth` block with `clientSecret` excluded, so
rotating a secret does not invalidate an otherwise-valid catalog, while changing
what the connection *is* — token URL, scopes, grant type — correctly forces a
re-index.

## Permissions

Three tiers: `blocked` < `untrusted` < `trusted`.

`autoApproveAtOrAbove` sets the floor for silent execution. Anything below it
is *allowed but gated*: the decision carries `requiresApproval: true`.

Per-server `allowTools` / `denyTools` filter at both index time and execute
time. Deny always beats allow, so an explicitly denied tool cannot be reached
by any path.

## Approval

A gated `execute` does not run. It returns an `ApprovalRequest` describing what
was asked for — server, action, trust tier, argument summary — plus a
single-use `approvalToken`. Passing that token back on an identical `execute`
is what actually dispatches the call.

The token is bound to a SHA-256 fingerprint of the canonicalized arguments, not
to the action alone. Approving "post *this* message to *this* channel" must not
become authority to post anything else, so changing any value invalidates it.
Key order is normalized, so the binding tracks meaning rather than
serialization. Tokens are single-use and expire in five minutes by default
(`approvalTtlSeconds` in the host config, clamped to an hour): an approval is a
decision about *now*, not a standing grant.

Ordering inside `execute` is the security property:

1. **Deny is evaluated first, and unconditionally.** A disabled server, a
   `blocked` tier, or a deny-listed tool fails outright — and crucially, *no
   token is issued*. There is no denied-but-approvable state, so approval can
   never become a path around an explicit deny. A token minted elsewhere is
   worthless because the deny check runs before the token is read.
2. **Arguments are validated before the gate.** A user is never asked to
   approve a call that would fail locally anyway, and a malformed retry cannot
   burn a valid token.
3. **Only then is the gate applied.**

A host that cannot prompt the user at all should set
`denyOnApprovalRequired: true` and fail closed rather than issue tokens.

## Validation

`validateArguments` implements the JSON Schema subset that MCP tools actually
use: `required`, `type`, `enum`, numeric bounds, string length and `pattern`,
array `items` and length, nested `properties`, and `additionalProperties`.

Unrecognized keywords pass rather than reject. A partial validator that blocks
valid calls is worse than no validator; the goal is to catch the model's
mistakes locally — before a network round trip and before a side effect —
not to be a conformant JSON Schema implementation.

Schemas are stored and returned exactly as the upstream server provided them.
Action Hub routes and validates; it never reinterprets.

## Skills

Skills live in the same catalog as tools and are ranked by the same engine, so
one search covers both. Only their summaries are indexed — the whole point is
that skill bodies are never injected into context until requested.

`execute` on a skill fails by design, before the policy check, since a skill
has no downstream server to evaluate against. Skills are loaded and followed,
not dispatched.

## The control endpoint

The Capability Manager canvas runs in a separate process from the hub, which
is a stdio MCP subprocess. To let the canvas change state rather than merely
display it, the plugin server binds a control listener on `127.0.0.1:0` and
publishes its URL and a per-process random bearer token to
`~/.cache/action-hub/control.json`, written user-only. The canvas discovers the
endpoint by reading that file.

Every mutation the canvas offers — enable and disable, trust changes, adding a
server — is a `POST` to this endpoint. The canvas never writes to the config
file, and never writes to the catalog cache, which belongs to core. This is the
whole point of the design: validation, the in-memory hub update, and config
persistence all happen on the server side, where canvas-supplied values are
treated as untrusted input. A canvas that edited the files directly would
desynchronize the running hub and could corrupt core's cache.

Two consequences follow. Failing to bind the control listener is not fatal —
the MCP server still starts, and the canvas simply renders read-only. And the
token file is unlinked on shutdown, so a canvas that finds no file, or a stale
one pointing at a dead port, concludes the hub is not running and disables its
controls rather than failing.

## Observability & Telemetry

Action Hub core instruments `search`, `load`, `loadBundle`, and `execute` using
the `@opentelemetry/api`.

- **Zero-runtime lock-in:** `@action-hub/core` has no dependency on an OpenTelemetry
  SDK or exporter. Without an initialized SDK, tracing calls default to zero-overhead
  no-ops. Hosts register and configure SDK exporters (`NodeSDK`, OTLP exporters,
  batch span processors) independently.
- **Privacy and cardinality boundaries:** Span attributes track low-cardinality metadata
  (operation names, action/server IDs, latency, payload sizes, token savings, error codes).
  Arguments, schemas, credentials, and tool output are strictly omitted.
- **Trace propagation:** For HTTP/SSE transports, W3C trace context (`traceparent`,
  `tracestate`) is injected into outbound HTTP headers alongside OAuth 2.0 credentials.
  Stdio transports remain untouched to protect stdio JSON-RPC framing.
- Detailed semantics and setup instructions are documented in [docs/telemetry.md](telemetry.md).

