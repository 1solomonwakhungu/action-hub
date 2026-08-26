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

An optional `SemanticScorer` can be attached. It is blended rather than
substituted:

```
score = (1 - w) · (s / (1 + s)) + w · semantic     w = 0.4
```

The lexical score is squashed into `[0, 1)` before blending so the two signals
are commensurate, and the weight is deliberately below 0.5 so a weak or
misconfigured embedding model degrades results instead of destroying them.

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

## Permissions

Three tiers: `blocked` < `untrusted` < `trusted`.

`autoApproveAtOrAbove` sets the floor for silent execution. Anything below it
is *allowed but gated* — the decision carries `requiresApproval: true` and the
host decides what to do. A host that can prompt the user should surface the
prompt; a host that cannot should set `denyOnApprovalRequired: true` and fail
closed.

Per-server `allowTools` / `denyTools` filter at both index time and execute
time. Deny always beats allow, so an explicitly denied tool cannot be reached
by any path.

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
