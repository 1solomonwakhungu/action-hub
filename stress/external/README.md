# stress/external

External stress tools for Action Hub (builder-10). Per the contract:
generated data stays in `stress/.generated/` (gitignored), every run is fully
isolated (temp `HOME`, `XDG_*`, `ACTION_HUB_CONFIG`, `ACTION_HUB_SKILLS_DIR`,
`PI_CODING_AGENT_DIR`; `autoDiscover: false`), nothing is installed globally,
no dependencies are added to `package.json`, and every script ends with a
machine-readable JSON summary on stdout plus a copy under
`stress/.generated/results/`.

## Layout

| File | Purpose |
|---|---|
| `fixture-server.mjs` | Minimal stdio MCP server honoring contract-format manifests (`initialize`/`tools/list`/`tools/call` with per-tool latency/error/size behavior). Stand-in for builder-2's full fake server. |
| `make-fixture.mjs` | Deterministic small fixture generator: manifests + `servers.json` (stdio fixture servers, `autoDiscover:false`) + isolation `env.sh`. Replaced by builder-2/builder-4 generators at full scale. |
| `inspector-smoke.mjs` | MCP Inspector CLI (`@modelcontextprotocol/inspector@2.5.0 --cli`, pinned) probes `initialize` + `tools/list` against **both** transports: `action-hub start` (stdio) and `action-hub serve` (streamable HTTP + bearer). |
| `k6-mcp.js` | k6 load profile (binary pinned in `/tmp/action-hub-stress/bin/k6`, no brew): JSON-RPC mix of `initialize`, `tools/list`, `action_hub` search/load/execute with seeded queries; ramp 100→500 VUs plus 5-minute soak at 100 VUs (`K6_PROFILE=full`), or a 15s smoke (`K6_PROFILE=quick`). Per-op latency trends with p50/p90/p95/p99 + RSS of the serve process (sampled by the orchestrator). |
| `fuzz.mjs` | `mcp-fuzzer` (Python venv `/tmp/action-hub-stress/venv`, v0.7.0): `--phase both --seed 42 --security-audit`, stdio target additionally `--no-network --enable-safety-system`; HTTP target uses `--protocol streamablehttp` + bearer token via `--auth-env`. |
| `spec-test.mjs` | `@hasmcp/mcp-spec-test@0.1.5` (npx, pinned): conformance over both transports, `--disable-telemetry=1`, JSON reports. |
| `conformance.mjs` | `@modelcontextprotocol/conformance` (official suite, npx): `server --suite active` against `action-hub serve`. The suite has no bearer-token flag, so the recorded verdict reflects the server's 401 behavior. |
| `run-external.mjs` | Orchestrator: builds the fixture, starts `action-hub serve` isolated, runs the selected tools, samples serve RSS, aggregates one JSON summary. |

## Usage

```bash
node stress/external/make-fixture.mjs                # small fixture (3 servers x 20 tools)
node stress/external/run-external.mjs --k6           # inspector smoke + quick k6
node stress/external/run-external.mjs --k6 --k6-full # ramp 100→500 + 5m soak
node stress/external/fuzz.mjs                        # both transports, seed 42
node stress/external/spec-test.mjs                   # both transports
node stress/external/conformance.mjs                 # official server suite
```

## Install rules honored

- k6: official release zip → `/tmp/action-hub-stress/bin/k6` (v2.3.0). No brew.
- mcp-fuzzer: `python3 -m venv /tmp/action-hub-stress/venv` + pip install there.
- Inspector / spec-test / conformance: `npx` with pinned versions.
- Nothing global; no `package.json` changes.

## Full-scale rerun

When builder-1's skills, builder-4's tools, and builder-2's fake servers land,
point every runner at the monster config instead of the small fixture:

```bash
node stress/external/run-external.mjs --config stress/.generated/servers.json --k6 --k6-full
node stress/external/fuzz.mjs --config stress/.generated/servers.json --runs 50
node stress/external/spec-test.mjs --config stress/.generated/servers.json
```

`K6_QUERIES` / `K6_ACTIONS` point the k6 mix at the full-scale query pools.
