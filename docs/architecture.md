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
        ├── Catalog
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
