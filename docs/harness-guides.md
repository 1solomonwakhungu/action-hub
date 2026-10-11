# Harness Guides

How to connect Action Hub to the AI harnesses and editors it supports.

Action Hub ships a Model Context Protocol (MCP) server. Every harness below
speaks MCP over stdio, and two stdio entry forms are valid:

- the bundled server script
  `<ABSOLUTE_PATH_TO_ACTION_HUB>/packages/plugin/server/dist/index.js`, or
- the CLI entrypoint `<ABSOLUTE_PATH_TO_ACTION_HUB>/packages/cli/dist/index.js`
  with the `start` argument (this is the form the `action-hub harness`
  command emits).

The fastest path is automatic setup with the `action-hub harness` command
(see the next section). If your harness is not covered by that command, or
you prefer to manage the config yourself, use the manual snippets in the
sections below — copy the snippet for your harness, substitute the absolute
path, and restart. The supported harnesses: Claude Code, Claude Desktop,
Cursor, VS Code, Codex, OpenCode, Zed, and Windsurf.

## Automatic setup

Most harnesses can be configured for you by the `action-hub harness` command.
The shape:

- `action-hub harness <target>` prints the target's config snippet
  (`export` mode, the default).
- `action-hub harness <target> install --write` writes the snippet into the
  harness config file. `install` requires `--write` as a safety guard.
- `--config <path>` points the harness at a specific Action Hub config file
  (exported as `ACTION_HUB_CONFIG` in the snippet).
- `--node <path>` overrides the `node` command in the snippet. By default the
  snippet runs `node` from `PATH`; pass an absolute node path for GUI
  harnesses that cannot find `node` on their `PATH` (for example nvm
  installs).
- `--json` applies to JSON targets only — it prints just the JSON document on
  stdout. For TOML targets such as `codex`, `--json` is rejected with a clear
  error.

Targets: `claude-code`, `claude-desktop`, `cursor`, `codex`, `opencode`, `pi`,
`vscode`. (Run `action-hub harness --help` for the current exact grammar.)

The `pi` target writes `$PI_CODING_AGENT_DIR/mcp.json` (default
`~/.pi/agent/mcp.json`), matching pi's agent-dir resolution: a non-empty
`PI_CODING_AGENT_DIR` overrides the default and a leading `~` expands to your
home directory. pi loads MCP servers through the pi-mcp-adapter, so install it
first with `pi install npm:pi-mcp-adapter`.

`export` prints the snippet for you to paste; `install` writes it into the
harness config file and requires `--write`. When an existing config file is
present, `install` first writes a timestamped backup of it, named
`<file>.bak-<ISO timestamp>` (for example
`mcp.json.bak-2026-09-26T08-24-51-422Z`), so the original is always
recoverable. A first install has no original file, so no backup is created.

```bash
action-hub harness claude-code                 # print the Claude Code snippet
action-hub harness claude-code install --write
action-hub harness codex install --write --config ~/.config/action-hub/servers.json
```

The supported targets are `claude-code`, `claude-desktop`, `cursor`, `codex`,
`opencode`, `pi`, and `vscode`. Zed and Windsurf are covered by the manual
snippets below, which remain the fallback for every harness. If the CLI is not
on your `PATH`, run the same commands via
`node <ABSOLUTE_PATH_TO_ACTION_HUB>/packages/cli/dist/index.js harness ...`.

Replace `<ABSOLUTE_PATH_TO_ACTION_HUB>` with the absolute path to your checkout
(for example `/Users/me/Projects/action-hub`), and make sure the build exists:

```bash
cd <ABSOLUTE_PATH_TO_ACTION_HUB>
npm install && npm run build
```

## Claude Code

Run:

```bash
claude mcp add action-hub -- node <ABSOLUTE_PATH_TO_ACTION_HUB>/packages/plugin/server/dist/index.js
```

This writes the server into `~/.claude.json`. Restart Claude Code, then check
that the Action Hub tools appear.

## Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows) and add:

```json
{
  "mcpServers": {
    "action-hub": {
      "command": "node",
      "args": ["<ABSOLUTE_PATH_TO_ACTION_HUB>/packages/plugin/server/dist/index.js"]
    }
  }
}
```

Fully quit and reopen Claude Desktop, then check Settings → Developer for the
Action Hub server.

## Cursor

Edit `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project) and add:

```json
{
  "mcpServers": {
    "action-hub": {
      "command": "node",
      "args": ["<ABSOLUTE_PATH_TO_ACTION_HUB>/packages/plugin/server/dist/index.js"]
    }
  }
}
```

Restart Cursor or reload the window, then check Cursor Settings → MCP.

## VS Code

Edit `.vscode/mcp.json` in the workspace (or use
**MCP: Add Server** in the Command Palette) and add:

```json
{
  "servers": {
    "action-hub": {
      "command": "node",
      "args": ["<ABSOLUTE_PATH_TO_ACTION_HUB>/packages/plugin/server/dist/index.js"]
    }
  }
}
```

Reload the window, then check the MCP panel for Action Hub.

## Codex

Edit `~/.codex/config.toml` and add:

```toml
[mcp_servers.action-hub]
command = "node"
args = ["<ABSOLUTE_PATH_TO_ACTION_HUB>/packages/plugin/server/dist/index.js"]
```

Restart any running Codex session so it picks up the new server.

## OpenCode

Edit `opencode.json` (project) or `~/.config/opencode/opencode.json` (global)
and add:

```json
{
  "mcp": {
    "action-hub": {
      "type": "local",
      "command": ["node", "<ABSOLUTE_PATH_TO_ACTION_HUB>/packages/plugin/server/dist/index.js"],
      "enabled": true
    }
  }
}
```

Note OpenCode takes `command` as a single argv array. Restart the OpenCode
session so it discovers the Action Hub tools.

## Zed

Edit Zed's `settings.json` and add:

```json
{
  "context_servers": {
    "action-hub": {
      "command": "node",
      "args": ["<ABSOLUTE_PATH_TO_ACTION_HUB>/packages/plugin/server/dist/index.js"]
    }
  }
}
```

Restart Zed, then check the Agent Panel settings for the Action Hub server.

## Windsurf

Edit `~/.codeium/windsurf/mcp_config.json` and add:

```json
{
  "mcpServers": {
    "action-hub": {
      "command": "node",
      "args": ["<ABSOLUTE_PATH_TO_ACTION_HUB>/packages/plugin/server/dist/index.js"]
    }
  }
}
```

Restart Windsurf or reload the window, then check the MCP servers panel.

## MCP startup budgets (verified)

MCP hosts and adapters bound the server handshake with a startup budget.
Budgets verified against real harnesses at fleet scale
(44 servers / 10,000 tools / 5,000 skills):

| Harness | MCP startup budget | Source |
| --- | --- | --- |
| pi (pi-mcp-adapter) | **30 s** adapter wait budget (`INIT_WAIT_TIMEOUT_MS`, an `awaitWithTimeout` around initialization — it returns `init_timeout` while initialization keeps running; it is **not** a spawn kill) | [pi-mcp-adapter `index.ts` (pinned v3.0.0)](https://github.com/nicobailon/pi-mcp-adapter/blob/v3.0.0/index.ts#L56) (`INIT_WAIT_TIMEOUT_MS = 30_000`) |
| Codex | **30 s** spawn-kill deadline (`DEFAULT_STARTUP_TIMEOUT`) | [openai/codex `rust-v0.154.0`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/codex-mcp/src/rmcp_client.rs#L102) (`codex-rs/codex-mcp/src/rmcp_client.rs:102`); the 1.1 s constant is `DEFAULT_OPTIONAL_MCP_STARTUP_GRACE`, not a spawn kill |

Startup measurements at 15K actions:

- **Current (with #68's deferred refresh):** a warm hub serves `initialize`
  immediately and re-indexes afterwards — PR #68 measured warm initialize at
  **1.5 s**, down from **4.1 s**.
- **Historical (pre-deferred-refresh, PR 62 stress measurements):** cold
  `createHubRuntime` ≈ **20 s**, warm cache ≈ **13 s**. These describe the
  pre-#68 behavior and are kept only as context for hosts on older builds.

Hosts whose effective budget is tighter than the cold-start cost should point
their config at the shared daemon (see below) or raise their MCP
`startup_timeout_ms`.

## Verifying the setup

From the checkout, run:

```bash
node <ABSOLUTE_PATH_TO_ACTION_HUB>/packages/cli/dist/index.js doctor
```

This reports whether the CLI config, catalog, and discovered servers are
healthy.

## Skills

Action Hub indexes skills the same way it indexes tools. Drop skill folders —
each containing a `SKILL.md` — into:

```
~/.action-hub/skills/
```

(or a directory of your choice exported as `ACTION_HUB_SKILLS_DIR`). The hub
scans that directory and adds every skill it finds to the catalog, so the same
skills appear in every harness connected to the hub — no per-harness installs.

## Using the shared daemon

Running one server process per harness duplicates the catalog and every
activated downstream MCP process. The shared daemon avoids that: one
background hub, many harnesses bridged over stdio.

If the CLI is on your `PATH` (for example, installed via npm):

```bash
action-hub daemon start
```

Then set the command in each harness config to `action-hub connect`:

```json
{
  "command": "action-hub",
  "args": ["connect"]
}
```

If the CLI is *not* on your `PATH`, use the portable form instead — it works in
any harness from any machine with the checkout:

```json
{
  "command": "node",
  "args": [
    "<ABSOLUTE_PATH_TO_ACTION_HUB>/packages/cli/dist/index.js",
    "connect"
  ]
}
```

`connect` bridges the harness's stdio to the running daemon over an
authenticated local socket. Each connection gets its own MCP session; the
catalog, connection pool, and auth are shared process-wide.

## Domain awareness for vague asks (`list_servers`)

A goal-only request ("straighten out that messy contact record") gives the
ranker little to match and gives the model no idea which integration owns
it. Rather than growing the tool description (which must stay static so hosts
can cache it), the hub serves a compressed server directory as a tool result:

```json
{ "operation": "list_servers" }
```

```json
{
  "ok": true,
  "count": 2,
  "servers": [
    { "server": "jira", "display_name": "Jira Cloud", "description": "Tickets for the payments team",
      "actions": 42, "kinds": ["tool"], "keywords": ["ticket", "sprint", "board", "epic", "transition", "comment", "assignee", "project"] },
    { "server": "s3", "actions": 12, "kinds": ["tool"], "keywords": ["bucket", "object", "storage", "upload", "prefix", "region", "lifecycle", "acl"] }
  ],
  "next": "Pick the server whose domain words fit the task, then search with those words or pass its id as server_id."
}
```

- `keywords` are chosen per server by coverage times a server-level IDF, so
  words every server shares (API boilerplate, generic verbs) sink and each
  server's own domain vocabulary rises. The server id's own tokens are
  omitted. Keyword ties break in code-point order, so the same catalog gives
  the same directory on every host. Measured on the 44-server stress corpus
  (15,000 records): 8 keywords per server is about 6.5 KB of compact JSON
  (roughly 1.6K tokens; the pretty-printed tool result is about twice that)
  and builds in well under a second, memoized until the catalog changes.
- `display_name` and `description` come from the server config
  (`servers[].displayName`, `servers[].description`); set `description` to
  a one-line statement of what the server covers for the best effect. Both
  are redacted and capped like every other echoed field.
- The compact form (`server` plus four keywords) also rides along on the two
  "nothing confident" responses: an abstention (`abstained: true`) and an
  empty result page, so the agent can re-aim without another round trip.
  It is capped at 64 servers (in id order); past that the response carries
  `servers_truncated: { shown, total, next }` and `list_servers` has the
  full set. A search that returns hits is unchanged.
- The static tool description tells the model when to use it: on a vague
  request, call `list_servers` first, then search with the domain words or
  restrict with `server_id`.

## No-confident-match abstention (search)

By default `action_hub` search always returns its hits, even when nothing in
the catalog is a good match (the scorer is "confidently" ranking distractors).
An optional flag makes the search say so instead:

```json
{
  "search": {
    "abstention": {
      "enabled": false,
      "threshold": 0.8
    }
  }
}
```

- `enabled` (default **false**): when true, a search whose top hit scores
  below `threshold` returns an abstention response instead of hits:
  `{ ok, count: 0, results: [], abstained: true, reason: "no_confident_match",
  threshold, closestMatch: { id, score } | null, hint, servers: [{ server,
  keywords }] }` (the query itself is deliberately not echoed — every echoed
  field carries an output budget; `servers` is the compact server directory
  described under `list_servers`, capped at 64 rows).
- `threshold` (default 0.8, clamped to [0, 1]): compared against the top
  hit's raw semantic score (`hits[0].semantic`), which is the MiniLM cosine
  under the default embeddings channel and the hashed-index cosine under the
  fallback channel; the fused ranking score is used only when no semantic
  channel is active. **The 0.8 default is not calibrated for the current
  production channel; see the calibration below before enabling the flag.**
  A query that matches a bundle never abstains: bundle discovery runs first
  and its matches are returned as usual.

The response shape is additive: clients that only read `count`/`results`
see an ordinary empty result.

**How an agent should react to `abstained: true`:** do not call a tool on a
guess. First try one rephrased search using an exact tool or domain name
(the `closestMatch.id` is a good starting point, and the `servers` list on
the same response names each server's domain words, so a second attempt can
narrow with `server_id`); if that also abstains, ask
the user how to proceed instead of picking a near-miss action. When the flag
is off, treat a search whose top hits share only loose words with the query
the same way — the response gives you no confidence signal by itself.

### Calibration (2026-10-11, held-out)

The original 0.8 figure ("0 of 51 real matches refused, 5 of 7 held-out
no-match queries abstained, 12 negative rows in total") was measured before
SQ4 on the fused blend score. The gate now reads the raw semantic cosine, so
that figure no longer describes what enabling the flag does. The
recalibration below was produced by `stress/abstention-threshold.mjs` on the
binding generated corpus (44 servers / 10,000 tools / 5,000 skills) with the
exact gate input the server uses, at the server's default page size. Rows:
106 realistic positives (paraphrase / goal-only / near-duplicate / multi)
and 87 negatives (the 15 realistic no-match rows plus the 72 rows in
`stress/fixtures/no-match-queries.json`, 36 off-domain and 36 adjacent).
Thresholds were chosen on the tune split and are reported on the held
split only (43 positives, of which 31 had the gold in the top 10 under
embeddings and 27 under hashed; 35 negatives). "Refused" counts a correct
top-10 retrieval that the gate would hide.

Default channel (vendored MiniLM embeddings, RRF fusion):

| Threshold | Correct retrievals refused (held) | Rank-1 matches refused | No-match abstained (held) |
| --- | ---: | ---: | ---: |
| 0.8 (shipped) | 31 / 31 (100%) | 24 / 24 | 35 / 35 |
| 0.4 | 5 / 31 (16%) | 3 / 24 | 35 / 35 |
| 0.36 (tune pick) | 1 / 31 (3%) | 0 / 24 | 33 / 35 (94%): off-domain 14/14, adjacent 14/15, realistic 5/6 |
| 0.3 | 0 / 31 | 0 / 24 | 29 / 35 (83%) |

Correct held-out retrievals score 0.35 to 0.74 (median 0.53; rank-1
matches median 0.55); no-match queries score 0 to 0.38 (median 0.07, 90th
percentile 0.31). The two populations separate well, but at 0.8 the gate
refuses every real match, including 183 of 183 synthetic exact-name lookups
whose gold was in the top 10. Enabling the flag at the shipped default on
the default channel turns search off.

Fallback channel (dependency-free hashed index, blend fusion):

| Threshold | Correct retrievals refused (held) | No-match abstained (held) |
| --- | ---: | ---: |
| 0.8 (shipped) | 5 / 27 (19%) | 34 / 35 |
| 0.48 (largest zero-refusal) | 0 / 27 | 6 / 35 (17%) |

Here the populations overlap (correct matches 0.48 to 1.0, no-match 0.37 to
0.83), so no threshold both keeps real matches and rejects most no-match
queries.

What this means for the defaults:

- **The flag stays off by default.** The decision rule in the script
  (at most 2% of correct retrievals refused and at least 80% of no-match
  queries abstained, on the held split of every channel, at the shipped
  threshold) fails on both channels at 0.8. The shipped threshold is left
  unchanged in this change; the measured operating point is documented here
  for the owner to adopt deliberately.
- **If you enable the flag on the default channel, set `threshold` near
  0.36**, then re-run the script against your own catalog. That point
  refused 1 of 31 held-out correct retrievals (3%, above the 2% bar on a
  base of 31: "turn down that onboarding request" at 0.355) and abstained
  on 33 of 35 no-match queries. Across all 87 negatives only four score
  above 0.36, and they are the asks that borrow catalog vocabulary:
  "translate the onboarding email into japanese" (0.53, nearest hit
  `globex-email:update_onboarding`), "edit the red eye out of this photo"
  (0.44), "track my daily step count" (0.38), and "reschedule my dentist
  appointment to friday" (0.37).
- **A 0.36 threshold is harmless under fallback.** If the embedding model
  fails to load and the hub degrades to the hashed scorer, 0.36 sits below
  every correct retrieval observed (minimum 0.49) and below all but three
  of the 87 negatives (lowest 0.23, all tune rows), so it refuses nothing
  and almost never abstains: no benefit, but no refusals either.
- **The held base is still thin.** 31 correct retrievals and 35 negatives
  per channel give a few-percent resolution at best. Add rows to
  `stress/fixtures/no-match-queries.json` (banded, validated by
  `stress/abstention-threshold.test.mjs`) and re-run before changing any
  default.

Reproduce: `node stress/gen-tools.mjs && node stress/gen-skills.mjs && node
stress/abstention-threshold.mjs --semantic both`. The summary lands in
`stress/.generated/results/abstention-threshold.json` (a single-channel run
writes `abstention-threshold.<channel>.json` instead, so the two channels
never overwrite each other) and every row's gate input, rank, and top hit in
the sibling `.detail.json` for audit.

## Loaded schemas after compaction

Action Hub keeps the host's prompt cache stable by exposing one fixed tool
and returning argument schemas as tool results (README, "Cache-stable by
design"). The cost of that choice is that a loaded schema is conversation
history, not a tool definition the host holds on to. Harnesses that compact
long sessions (Claude Code's context compaction, Codex, custom agent loops
that summarize older turns) can drop or summarize a `load` result while the
model still remembers having loaded the action.

What the hub guarantees regardless:

- **A stale guess cannot reach a downstream server.** `execute` validates
  every call against the verbatim upstream schema before dispatch. Argument
  names and required fields are not recoverable from an action id, so a call
  built from a remembered schema fails locally with `Invalid arguments: ...`
  and nothing runs. The right reaction is to `load` again, not to guess
  again.
- **Re-loading is cheap.** One `load` round trip returns about 2.9 KB
  (roughly 730 tokens) for a full-scale schema; see the token-cost finding in
  `stress/README.md`. For a single confident candidate, `search` with
  `limit: 1` and `include_schema: true` returns the candidate and its schema
  in one call.

Guidance for host authors and for anyone writing a system prompt around the
hub:

1. If your compaction keeps tool results, keep `action_hub` `load` results
   (and `include_schema` search results) verbatim. If it keeps a summary,
   have the summary say that previously loaded schemas were removed.
2. Tell the model what "loaded in this conversation" means: the schema text
   is in the current context. After a compaction, `load` again before
   `execute`. The `next` hint on a search response ("execute directly if you
   already have the schema") uses the same meaning of "have".
3. Do not pin schemas into the system prompt or the tool definition to work
   around compaction. That reintroduces the per-turn cost the hub exists to
   remove and changes the cached prefix.
4. Treat `Invalid arguments` after a compaction as the signal it is: reload
   and retry once. A second validation failure means the wrong action was
   chosen, so search again.

## Raw MCP clients

If you hand-roll an MCP client instead of using an SDK, three framing
details matter. Malformed-frame behavior is transport-specific (verified
against the running server, both transports):

- **Body is not valid JSON at all (HTTP):** the HTTP layer answers `400`
  with a plain `{ "error": "Invalid JSON body" }` — the payload never
  reaches the JSON-RPC layer, so there is no `-32700` envelope.
- **Valid JSON that is not a JSON-RPC message (HTTP):** e.g. a top-level
  `arguments` object — answered `400` with a JSON-RPC error envelope:
  `{ "code": -32700, "message": "Parse error: Invalid JSON-RPC message" }`
  (`id: null`). Over **stdio**, the same frame is answered instead of
  dropped: a parseable-but-invalid frame gets a JSON-RPC `-32600 Invalid
  Request` reply and an unparseable line gets `-32700` (both with `id: null`
  — the SDK's error report does not expose the original frame's id, so none
  is guessed); the session then continues serving.

1. **Request payloads live under `params`, not `arguments`.** A tool call
   is `{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
   "name": "action_hub", "arguments": { "operation": "search", "query":
   "deploy" } } }`. A top-level `arguments` key is rejected as a parse
   error (see above), not `-32602 invalid params`; `-32602` is reserved for
   well-formed requests whose `params` do not validate (e.g. `tools/list`
   with a `cursor`, below).
2. **Send the `initialized` notification before any other request.** After
   the `initialize` response, send `{ "jsonrpc": "2.0", "method":
   "notifications/initialized" }` (no `id`), then call tools. The SDK
   client does this for you; a raw client that skips it will be rejected.
3. **The daemon socket expects an auth frame first.** The first line on a
   daemon connection is `{ "token": "<token>", "command": "mcp" }`
   followed by a newline; the daemon replies `{ "ok": true }` and only then
   speaks JSON-RPC. Lines are newline-delimited, not content-length framed.

`tools/list` pagination is not used by this server; sending a `cursor`
(correctly returns `-32602` invalid params per the MCP spec's
recommendation).

## Migrating your existing MCP servers and skills

If you already have MCP servers and skills configured in Claude Desktop,
Cursor, VS Code, or elsewhere, pull them into Action Hub once. Preview first
(without `--write`) to see what would change:

```bash
action-hub migrate --type all
```

Then write the result:

```bash
action-hub migrate --type all --write
```

(Use `node <ABSOLUTE_PATH_TO_ACTION_HUB>/packages/cli/dist/index.js migrate --type all --write`
if the CLI is not on your `PATH`.) The migration engine discovers MCP servers,
skills, and plugins from your local agent configurations and merges them into
the Action Hub config, preserving entries that are already there.

For a servers-only pass, `action-hub import` previews MCP servers discovered
from your local agent configurations, and `action-hub import --write` writes
them. Since the raw-config fix, `--write` preserves everything already in the
config (existing entries win, unknown top-level settings survive, and the
write is atomic with `0600` permissions; it fails closed on a malformed
config). It does not bring in skills, so use `migrate --type all --write`
when you want servers *and* skills written.
