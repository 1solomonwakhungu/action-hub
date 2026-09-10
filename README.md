# Action Hub

**An indexed, on-demand capability layer for MCP servers and skills — delivered as a GitHub Copilot plugin.**

Action Hub replaces the eager capability surface of a typical MCP setup with a lazy, searchable one. An agent can reach 100,000 actions while its permanent context holds only a single tool schema.

---

## The problem

Every MCP server you connect injects all of its tool schemas into the model's context, permanently, on every turn. Ten servers is tolerable. A hundred is not.

| Setup | Servers | Tools | Context consumed every turn |
| --- | ---: | ---: | ---: |
| Typical | 5 | ~60 | ~15k tokens |
| Heavy | 20 | ~400 | ~90k tokens |
| Aspirational | 100+ | 10,000+ | Impossible |

This scales linearly with the number of connected capabilities and it is paid on *every single turn*, whether or not any of those tools are relevant to the task at hand. The practical ceiling on how capable an agent can be is set by context budget, not by how many integrations exist.

Worse, capability density actively hurts quality. A model choosing between 400 similarly-named tools selects incorrectly far more often than one choosing between 12.

## The approach

Do not put the catalog in the context. Put a **search interface** to the catalog in the context.

```
GitHub Copilot app
        |
        v
   Action Hub plugin
        |
        v
 Action Hub meta-MCP server
        |
        +-- GitHub MCP
        +-- Linear MCP
        +-- Slack MCP
        +-- AWS MCP
        +-- ~100 other MCP servers
        +-- ~10,000 skills
```

Copilot sees one tool. Action Hub sees everything.

```jsonc
{
  "operation": "search | load | execute",
  "query": "...",
  "action_id": "...",
  "arguments": {}
}
```

The three operations are deliberately minimal:

- **`search`** — hybrid lexical + semantic query over the indexed catalog. Returns ranked action IDs with one-line descriptions. Cheap; no schemas returned.
- **`load`** — fetch the full JSON Schema for a specific action, on demand, only once the model has committed to using it.
- **`execute`** — validate arguments against the original upstream schema and route the call to the owning MCP server.

Servers are activated lazily. A server is not spawned or authenticated until one of its actions is actually executed, so a hundred configured integrations cost nothing until used.

### Context economics

| | Eager MCP | Action Hub |
| --- | ---: | ---: |
| Tools visible to model | 10,000 | 1 |
| Baseline context per turn | ~2.5M tokens | ~600 tokens |
| Cost of an unused integration | Full schema, every turn | Zero |
| Marginal cost of server #101 | Linear growth | Constant |

## Architecture

The project is split into two layers, and the boundary between them is load-bearing.

### Layer 1 — `packages/core` (runtime-agnostic)

This is the actual intellectual property. It has **no dependency on Copilot** and no knowledge of the host that calls it.

| Module | Responsibility |
| --- | --- |
| Connection manager | Lifecycle for downstream MCP servers; lazy activation, health, reconnect, circuit breakers, heartbeats, restart backoff, Node memory caps |
| Catalog | Unified index of tools and skills, with provenance; persisted to disk and refreshed in the background |
| Search | Hybrid lexical + semantic retrieval and ranking |
| Schema store | Original upstream schemas, retrievable on demand |
| Permissions | Trust tiers, allow/deny policy, approval gates |
| Auth | OAuth 2.0 for remote HTTP servers: PKCE, proactive refresh, token rotation, host-injected credential storage |
| Observability | OpenTelemetry instrumentation for search, load, and execute; low-cardinality attributes; W3C trace propagation; zero runtime lock-in ([docs/telemetry.md](docs/telemetry.md)) |
| Router | Argument validation and dispatch to the owning server |
| Bundles | Named capability sets scoped to a task or repo |
| Evaluation | Retrieval-quality harness; guards against search regressions |

Because this layer is host-neutral, the same backend can later serve Claude Code, VS Code, Zed, or any MCP-compatible client without modification.

### Layer 2 — `packages/copilot-plugin` (integration)

A GitHub Copilot plugin, matching the format the app already loads:

```
packages/copilot-plugin/
├── plugin.json          # manifest: skills, agents, mcpServers
├── .mcp.json            # registers the Action Hub meta-MCP server
├── skills/
│   └── action-hub/
│       └── SKILL.md     # teaches the model the search -> load -> execute loop
├── server/              # the meta-MCP server (stdio)
└── canvas/
    └── capability-manager/
        └── extension.mjs # interactive control center
```

### Why a plugin and not a fork

The GitHub Copilot app is the right product surface. It already solves the expensive UX problems — parallel agent sessions, isolated git worktrees, repository and GitHub integration, diff review, terminals, browser canvases, automations, and a polished cross-platform desktop app.

It cannot be forked. [`github/app`](https://github.com/github/app) is the public home for releases, documentation, issues, and discussions only; it does not contain application source, and it is licensed `© GitHub, Inc. All rights reserved.`

That constraint turns out not to matter, because GitHub exposes an official extension path:

- An MIT-licensed [Copilot SDK](https://github.com/github/copilot-sdk)
- A plugin system bundling skills, MCP servers, hooks, custom agents, and canvas extensions
- A plugin marketplace for distribution

So we do not clone the app. We live inside it, use its real interface, and replace its eager capability surface with an indexed one. Cleaner, faster, legally unambiguous, and immediately distributable.

## The capability manager canvas

Copilot canvases render interactive UI in the app's side panel. The `capability-manager` canvas is the control center:

- Installed MCP servers, with health and authentication state
- Tools indexed per server; installed skills
- Live search testing against the real index
- Permission levels and trusted vs. untrusted servers
- Tool invocation history
- Enable / disable controls
- Context savings and search-quality diagnostics

This gives a native-feeling control surface without recreating GitHub's desktop application.

## Repository layout

```
action-hub/
├── packages/
│   ├── core/                 # Layer 1 — runtime-agnostic engine
│   ├── cli/                  # Developer CLI + `action-hub start` (bundled into the binary)
│   └── copilot-plugin/       # Layer 2 — Copilot integration
│       ├── server/           #   meta-MCP server (also run in-process by the CLI)
│       └── canvas/           #   capability-manager canvas
├── .github/
│   ├── extensions/           # makes the canvas discoverable during development
│   └── workflows/            # CI and standalone-binary release automation
├── scripts/                  # esbuild + Node SEA binary build and packaging
├── packaging/                # generated Homebrew / winget manifests
├── config/
│   └── servers.example.json
├── docs/
│   ├── architecture.md
│   ├── releasing.md
│   └── roadmap.md
└── README.md
```

See [`docs/architecture.md`](docs/architecture.md) for why the layers are split
this way and why search must never return schemas.

## Install

Action Hub ships as a **standalone, zero-dependency binary** — the Node runtime,
the developer CLI, and the Copilot meta-MCP server in one executable. No system
Node install is required to run it.

### Homebrew (macOS, Linux)

```bash
brew tap 1solomonwakhungu/tap
brew install action-hub
```

### winget (Windows)

```powershell
winget install SolomonWakhungu.ActionHub
```

### Direct download

Grab the binary for your platform from the [latest release](https://github.com/1solomonwakhungu/action-hub/releases/latest),
verify it against `SHA256SUMS.txt`, then put it on your `PATH`:

```bash
# macOS (Apple Silicon) example
curl -LO https://github.com/1solomonwakhungu/action-hub/releases/latest/download/action-hub-macos-arm64
curl -LO https://github.com/1solomonwakhungu/action-hub/releases/latest/download/SHA256SUMS.txt
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
chmod +x action-hub-macos-arm64
sudo mv action-hub-macos-arm64 /usr/local/bin/action-hub
action-hub --version
```

Supported targets: macOS arm64/x64, Linux x64/arm64, Windows x64. Register the
binary as the Copilot MCP server by pointing `.mcp.json` at
`action-hub start`. See [`docs/releasing.md`](docs/releasing.md) for how the
binaries are built and published.

### npm / from source

The npm distribution is unchanged; see **Getting started** below to build from
source.

## Getting started

Requires Node.js 20.11+.

```bash
git clone https://github.com/1solomonwakhungu/action-hub.git
cd action-hub
npm install
npm run build
npm test
```

Configure downstream servers in `config/servers.example.json`, then copy it to `config/servers.json`.

Remote servers that speak OAuth 2.0 declare an `auth` block on their HTTP transport and are authorized once from the CLI:

```bash
action-hub auth login github-oauth   # opens the provider, stores the grant 0600
action-hub auth status               # per-server state; never prints a token
action-hub auth logout github-oauth
```

Tokens are then refreshed automatically ahead of expiry and rotated in place, so no re-entry is needed. Servers using a static `Authorization` header keep working unchanged.

## Status

Early development. The interfaces described above are the target design; see [`docs/roadmap.md`](docs/roadmap.md) for what is implemented versus planned.

## Design principles

1. **The core never imports Copilot.** If it does, the abstraction has failed.
2. **Schemas are loaded, never broadcast.** Context is the scarcest resource.
3. **Lazy everything.** Unused capability must cost zero.
4. **Search quality is a testable property.** Retrieval regressions are bugs, caught by the eval suite.
5. **Preserve upstream schemas exactly.** Action Hub routes and validates; it does not reinterpret.

## License

MIT — see [LICENSE](LICENSE).
