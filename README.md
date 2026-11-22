# Action Hub

**One fixed, cache-stable MCP tool in front of all your MCP servers and skills — with offline hybrid semantic search, lazy activation, and a shared multi-harness daemon.**

Works with **Claude Code**, **Claude Desktop**, **Cursor**, **VS Code**, **Codex**, **OpenCode**, **Zed**, **Windsurf**, **`pi`**, and local-LLM MCP hosts.

[![Release](https://img.shields.io/github/v/release/1solomonwakhungu/action-hub)](https://github.com/1solomonwakhungu/action-hub/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Explainer Site](https://img.shields.io/badge/docs-explainer%20site-0d1117)](https://1solomonwakhungu.github.io/action-hub/)

---

## Why Action Hub?

Every MCP server you connect injects its full set of tool schemas into the model's prompt on **every turn**. Connect GitHub, Linear, Slack, Postgres, and a browser server and you're burning 15K–90K+ tokens before typing a prompt — while degrading tool-selection accuracy and bloating context windows (especially fatal on local models).

Action Hub replaces that eager tool list with **one fixed tool (`action_hub`, ~600 tokens)** backed by a local, hybrid-indexed catalog (`BM25` + vendored offline int8 `all-MiniLM-L6-v2` ONNX/WASM embeddings with RRF fusion).

```text
Claude Code / Cursor / Codex / VS Code / OpenCode / Zed / Windsurf / Local LLMs
                                    │
                       action_hub (1 fixed tool, ~600 tokens)
                                    │
                     Action Hub (stdio, HTTP, or shared daemon)
                                    │
        ┌──────────────┬────────────┼────────────┬──────────────────┐
        ▼              ▼            ▼            ▼                  ▼
   GitHub MCP     Linear MCP    Slack MCP    Remote OAuth2     ~/.action-hub/skills
   (lazy spawn)   (lazy spawn)  (gated)      (PKCE + rotate)   (SKILL.md catalog)
```

### How the loop works

The model sees one tool with three core operations plus discovery helpers:

1. **`search`** — hybrid BM25 + local MiniLM semantic search over tools and skills. Returns ranked `action_id`s and one-line summaries (**never full schemas** unless `include_schema: true` is passed).
2. **`load`** — fetches the verbatim upstream JSON Schema (or `SKILL.md` instructions for a skill) as a conversation tool result on demand.
3. **`execute`** — validates arguments locally against the upstream schema, enforces trust/approval policy, and lazily activates + dispatches to the owning MCP server.
4. **Discovery helpers** — `list_servers` returns a compressed IDF-keyword directory of connected servers for vague/goal-only prompts; `search_bundles` / `load_bundle` load multi-tool workflows in one turn.

---

## Quickstart (60 Seconds)

Action Hub ships as a **zero-dependency standalone binary** (Node SEA) bundling the runtime, CLI, in-process MCP server, and vendored MiniLM model — no Node.js installation required.

### 1. Install the binary

**macOS (Apple Silicon) — direct verified download:**

```bash
curl -LO https://github.com/1solomonwakhungu/action-hub/releases/latest/download/action-hub-macos-arm64
curl -LO https://github.com/1solomonwakhungu/action-hub/releases/latest/download/SHA256SUMS.txt
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
chmod +x action-hub-macos-arm64
sudo mv action-hub-macos-arm64 /usr/local/bin/action-hub
action-hub --version
```

> Binaries for **macOS (`arm64`, `x64`)**, **Linux (`x64`, `arm64`)**, and **Windows (`x64`)** plus `action-hub.rb` (Homebrew formula) and `winget-manifests.tar.gz` are attached to the [latest release](https://github.com/1solomonwakhungu/action-hub/releases/latest).
>
> <details>
> <summary>Other install options (Homebrew formula, build from source, npm / MCP Registry status)</summary>
>
> **Homebrew (from release formula or tap):**
> ```bash
> # Directly from the release asset:
> curl -LO https://github.com/1solomonwakhungu/action-hub/releases/latest/download/action-hub.rb
> brew install --formula ./action-hub.rb
> # Or via tap (when published):
> brew tap 1solomonwakhungu/tap && brew install action-hub
> ```
>
> **Build from source (Node.js 20.11+):**
> ```bash
> git clone https://github.com/1solomonwakhungu/action-hub.git
> cd action-hub
> npm install && npm run build && npm test
> ```
>
> **npm & Official MCP Registry status:** `@action-hub/cli` npm package publishing and Official MCP Registry metadata (`server.json`) are prepped in-repo and pending npm scope/token activation; see [`docs/releasing.md`](docs/releasing.md).
> </details>

### 2. Onboard in one command (or step by step)

**One-command setup** (discovers existing MCP servers & skills, installs into your harness with a `.bak` backup, and prints your real per-turn token savings):

```bash
action-hub init --harness claude-code
# Supported targets: claude-code, claude-desktop, cursor, codex, opencode, pi, vscode
```

**Or run each step individually:**

```bash
# 1. Auto-discover MCP servers, skills, and plugins from Claude Desktop, Cursor,
#    VS Code, Copilot, Codex, Windsurf, Cline, and Roo Code (redacted preview + atomic 0600 write):
action-hub migrate --type all          # dry-run preview
action-hub migrate --type all --write  # save to ~/.config/action-hub/servers.json

# 2. Connect your AI harness (writes a timestamped .bak backup before editing):
action-hub harness claude-code install --write

# 3. Verify health, measure actual token savings, and inspect live hybrid search:
action-hub doctor
action-hub test-search "open a pull request"
```

For **Zed** and **Windsurf**, see [`docs/harness-guides.md`](docs/harness-guides.md).

Example `action-hub doctor` output:

```text
Context Savings Estimate:
  Total tools indexed:   184
  Eager tokens estimate: 41200
  Hub tokens estimate:   600
  Estimated token savings per turn: ~99%
```

*(Note: `action-hub` also runs `autoDiscover` by default when no `servers.json` exists yet, and indexes any `SKILL.md` folders dropped into `~/.action-hub/skills/`.)*

---

## Why Action Hub vs. Native Tool Search or MCP Proxies?

If you only ever use Claude Code with Anthropic's built-in Tool Search (`ENABLE_TOOL_SEARCH`), native deferral already cuts a lot of upfront bloat. Action Hub is built for what native client deferral and manual proxies don't solve:

| Capability | Anthropic Tool Search | Manual Proxies (MetaMCP / MCP Router) | **Action Hub** |
| --- | :---: | :---: | :---: |
| Works across Cursor, Codex, OpenCode, VS Code, Zed, Windsurf, `pi`, local LLMs | No (Claude only) | Yes | **Yes** |
| Byte-stable single tool (zero `tools/list_changed`, preserves prompt cache) | Provider-managed | Varies | **Yes (pinned by test)** |
| Offline hybrid BM25 + MiniLM semantic search (no API keys, no manual tool toggling) | Provider-side | Usually manual grouping | **Yes (vendored WASM ONNX)** |
| Unified catalog for **MCP tools + `SKILL.md` skills + bundles** | Separate systems | Tools only | **Yes** |
| Shared local daemon across multiple editors simultaneously | No | Docker / external server | **Yes (`0600` Unix socket)** |
| Argument-bound single-use approval tokens + OAuth 2.0 PKCE + circuit breakers | Client-specific | Partial | **Built-in** |
| Zero-dependency single binary (no Docker, no Node install required) | Built into CLI | No | **Yes (Node SEA)** |

---

## Shared Daemon Mode

Running a separate MCP server per editor duplicates downstream processes and OAuth state. Start one background daemon and wire every harness to it in one command:

```bash
action-hub daemon start
action-hub daemon status
action-hub harness cursor install --daemon --write
action-hub harness claude-code install --daemon --write
```

Or configure any stdio MCP host manually to bridge through the shared daemon:

```json
{
  "command": "action-hub",
  "args": ["connect"]
}
```

- **macOS / Linux:** User-only `0600` Unix domain socket inside a `0700` runtime directory.
- **Windows:** Ephemeral `127.0.0.1` loopback port.
- **Auth:** 256-bit random per-daemon token stored `0600`, verified in constant time. Clients that cannot read the token are rejected.
- **Streamable HTTP:** Need HTTP instead of stdio? Run `action-hub serve --port 6290` (loopback-only, bearer-token protected).

---

## Measured Economics, Performance & Scale

### Context & payload costs

| Metric | Eager MCP | Action Hub | Source |
| --- | ---: | ---: | --- |
| Fixed baseline tool schema per turn | ~15K tokens (5 servers / ~60 tools)<br>~90K tokens (20 servers / ~400 tools) | **~600 tokens** (1 fixed tool) | `packages/core/src/action-hub.ts` (`HUB_TOOL_TOKENS`) |
| Marginal baseline cost of server #101 | Linear growth | **0 tokens** | Fixed tool surface |
| `search` (limit 10) tool result | — | **~3.6 KB (~900 tokens)** | Measured on 15K-action corpus (`stress/README.md`) |
| `load` (1 schema) tool result | — | **~2.9 KB (~730 tokens)** | Measured on 15K-action corpus (`stress/README.md`) |
| `list_servers` (44 servers, 8 keywords/server) | — | **~6.5 KB compact JSON (~1.6K tokens)** | Measured on 44-server corpus (`docs/harness-guides.md`) |

### Cache-stable by design

Hosts that cache prompt prefixes (Anthropic, OpenAI, Claude Code, Cursor, Codex) invalidate the cache whenever the tool list changes. Action Hub pins three invariants in [`packages/plugin/server/test/cache-stable.test.ts`](packages/plugin/server/test/cache-stable.test.ts):

1. **One fixed tool** (`action_hub`) registered once before transport connect; single-page `tools/list` with no pagination cursor.
2. **No `tools/list_changed` notifications emitted** even when the catalog re-indexes or skills change underneath.
3. **Schemas arrive as tool results**, keeping the cached prefix untouched. *(For how to handle loaded schemas after host context compaction, see [`docs/harness-guides.md#loaded-schemas-after-compaction`](docs/harness-guides.md#loaded-schemas-after-compaction).)*

### Fleet-scale stress results (44 servers / 10,000 tools / 5,000 skills)

Tested in an isolated stress harness ([`stress/`](stress/)):

- **Search latency (c1):** stdio p50 **~33 ms**, HTTP p50 **~40 ms** across 15,000 indexed records ([`stress/README.md`](stress/README.md)).
- **Warm startup (`initialize`):** **1.5 s** with deferred background refresh (persisted catalog + hydrated embedding vectors).
- **Sustained load (10–40 RPS, k6 JSON-RPC mix):** **0% errors**, search p95 **747 ms**; throughput knee near **~110 RPS**; saturation ramp (100→500 VU + 5-min soak) **263.6 RPS** at **1.73% HTTP failures**, peak RSS **765 MB**.
- **Shared daemon:** 20/20 concurrent `action-hub connect` clients connect and search with **0 errors** (~346 MB daemon RSS).
- **Test suite:** **440+ passing tests** (`v0.1.0` baseline: `core` 293, `mcp-server` 39, `cli` 90, `site` 4, `as-of execution eval` 14 — see [`STATUS.md`](STATUS.md)).

---

## Security, Auth & Reliability Built In

- **Trust tiers & argument-bound approval tokens:** Servers are `blocked`, `untrusted`, or `trusted` with per-server `allowTools` / `denyTools` (deny always beats allow, evaluated before approval). Gated executions return an `approval_required` envelope with a single-use token bound to a **SHA-256 hash of canonicalized arguments** (5-minute default TTL).
- **OAuth 2.0 for remote HTTP MCP servers:** Standards-based PKCE and `client_credentials` via config (`action-hub auth login/status/logout`), proactive 60 s pre-expiry refresh, deduplicated concurrent refreshes, and RFC 6749 refresh-token rotation stored `0600`.
- **Downstream resilience:** Lazy server activation, per-server activation deadlines (`timeoutMs`), closed/open/half-open circuit breakers (3 transport failures → 10 s cooldown → half-open probe; tool errors never trip the breaker), heartbeat probes, exponential restart backoff with jitter, cooperative chunked re-indexing, and `--max-old-space-size` memory caps for Node stdio servers.
- **Zero-lock-in OpenTelemetry:** Instrumented via `@opentelemetry/api` (no-op when no SDK is registered); W3C `traceparent`/`tracestate` propagation on HTTP transports; strict low-cardinality attributes with zero leaked arguments, schemas, or secrets ([`docs/telemetry.md`](docs/telemetry.md)).

---

## Honest Tradeoffs & Known Limitations

Action Hub moves complexity rather than eliminating it. Read the full engineering notes on the [explainer site](https://1solomonwakhungu.github.io/action-hub/#design-notes), [`docs/harness-guides.md`](docs/harness-guides.md), and [`stress/README.md`](stress/README.md):

- **Vague / goal-only queries are the hardest retrieval band:** On our 30 hand-written goal-only queries over 15,000 records, `recall@5` is **0.533** with vendored MiniLM + RRF vs. **0.433** BM25 and **0.267** hashed fallback (`stress/goal-only-gate.mjs`). Use `list_servers` or bundles when requests lack domain vocabulary.
- **Total session tokens include discovery turns:** Failed searches and repeated `load` calls still consume conversation tokens; a small fixed baseline is not a guarantee of lower total session cost on poorly phrased loops.
- **Host approval UI visibility:** Hosts that only see `action_hub` rely on the hub's `approval_required` response for downstream consent. Approval tokens are cryptographically bound to exact arguments, and execute OTel spans now emit `action_hub.approval.args_sha256` (while upstream server version is still not emitted).
- **Opt-in abstention calibration:** Search abstention (`search.abstention.enabled`) is off by default and now ships with the MiniLM-calibrated **`0.36`** default threshold (replacing the legacy pre-SQ4 `0.8` default; see [`docs/harness-guides.md#calibration-2026-10-11-held-out`](docs/harness-guides.md#calibration-2026-10-11-held-out)).

---

## Architecture & CLI Reference

Action Hub splits cleanly into two layers ([`docs/architecture.md`](docs/architecture.md)):

- **Layer 1 (`packages/core`)** — runtime-agnostic catalog, BM25 + vendored MiniLM search, schema store, connection manager, OAuth 2.0 client, policy/approvals, bundles, OTel instrumentation, and evaluation harness. Zero host dependencies.
- **Layer 2 (`packages/plugin` + `packages/cli`)** — the `action_hub` meta-MCP server (stdio / Streamable HTTP / shared daemon), optional plugin bundle (`plugin.json`, `.mcp.json`, `SKILL.md`), and developer CLI.

### Common CLI commands

```bash
action-hub init --harness <target>                    # One-command onboarding: migrate + harness install + doctor
action-hub migrate --type all [--write]               # Import MCP servers, skills, and plugins from installed harnesses
action-hub import [--source cursor] --write           # Import MCP servers only
action-hub harness <target> install [--daemon] --write # Configure Claude Code, Cursor, Codex, VS Code, OpenCode, pi, Claude Desktop
action-hub doctor                                     # Validate config, probe servers, print token savings estimate
action-hub test-search "<query>"                      # Inspect live hybrid search rankings
action-hub list [--server <id>] [--kind skill|tool]   # List indexed tools, skills, and bundles
action-hub bundle [--load <id> | --export <id>]       # Inspect or export action bundles
action-hub auth <login|status|logout> [id]            # Manage OAuth 2.0 remote server grants
action-hub daemon <start|status|stop>                 # Manage the shared multi-harness daemon
action-hub connect                                    # Proxy stdio to the shared daemon
action-hub start                                      # Foreground isolated stdio MCP server
action-hub serve --port 6290                          # Loopback Streamable HTTP MCP server (bearer-token auth)
action-hub licenses                                   # Print vendored MiniLM + onnxruntime-web provenance & licenses
```

---

## Release Status & Docs

- **Current release:** [`v0.1.0`](https://github.com/1solomonwakhungu/action-hub/releases/tag/v0.1.0) — shipped with the core `search` / `load` / `execute` loop, standalone Node SEA binaries across 5 OS/arch targets, shared daemon mode, OAuth 2.0, Streamable HTTP, and 440+ passing tests. See [`STATUS.md`](STATUS.md) for the full shipped ledger and [`docs/roadmap.md`](docs/roadmap.md) for upcoming work (npm & MCP Registry activation, editor extensions [#20](https://github.com/1solomonwakhungu/action-hub/issues/20)).
- **Docs:** [Explainer microsite](https://1solomonwakhungu.github.io/action-hub/) · [Status](STATUS.md) · [Roadmap](docs/roadmap.md) · [Architecture](docs/architecture.md) · [Harness Guides](docs/harness-guides.md) · [Telemetry](docs/telemetry.md) · [Releasing](docs/releasing.md) · [Stress & Evals](stress/README.md)

## License

MIT — see [LICENSE](LICENSE). Vendored offline model (`all-MiniLM-L6-v2`, Apache-2.0) and `onnxruntime-web` WASM subset (MIT) notices are in [`packages/core/vendor/VENDOR.md`](packages/core/vendor/VENDOR.md) and via `action-hub licenses`.
