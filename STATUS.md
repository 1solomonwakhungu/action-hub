# Status

Last updated: 2026-10-17 (covers `main` through `fd47602`, #111)

## Where things stand

Action Hub is feature-complete for its core loop and has been hardened at
fleet scale. One MCP tool (`action_hub`) fronts any number of downstream MCP
servers and skills through search, load, and execute. It ships as npm
workspaces, standalone binaries, a shared daemon, and an HTTP transport. An
explainer site is live on GitHub Pages.

`v0.1.0` is the first release (2026-10-17), cut by release-please. The
[GitHub release](https://github.com/1solomonwakhungu/action-hub/releases/tag/v0.1.0)
carries binaries for macOS (arm64, x64), Linux (x64, arm64), and Windows (x64),
plus `SHA256SUMS.txt`, the Homebrew formula, winget manifests, and
`THIRD_PARTY_LICENSES.txt`. `core-v0.1.0` and `mcp-server-v0.1.0` were tagged
alongside it. Nothing is on npm yet.

**Verified on `main` (local run, Node 22):**

- `npm ci`, `npm run build`, and `npm run typecheck` are clean
- `npm test` passes all 440 tests: core 293, mcp-server 39, cli 90,
  site 4, stress as-of execution eval 14
- Fleet-scale stress profile: 44 servers, 10,000 tools, 5,000 skills.
  Load numbers are in the README's "Scale & reliability" section.

## What shipped since 2026-08-26

100 commits, merged PRs #12 to #111. Numbers below are PRs or the issues
they closed.

**Product surface (2026-08-28 to 2026-09-09)**

- Auto-discovery, speculative schema search, and execution timeouts (#12)
- Action Bundles for compound workflows and batch loading (#8)
- Connection resilience: health checks, circuit breaker (#10), then circuit
  recovery, heartbeats, and Node memory limits (#21)
- Developer CLI suite (#9) and the Capability Manager canvas dashboard with a
  search playground and presets (#11)
- Universal capability migration for MCPs, skills, and plugins (#19)
- OAuth 2.0 with refresh-token rotation for remote servers (#23)
- Standalone binaries (Node SEA) with Homebrew and winget manifests (#22)
- OpenTelemetry tracing and trace propagation (#25)
- Authenticated shared daemon mode (#24)

**Integrations and CLI (2026-09-26)**

- Multi-harness MCP auto-discovery (#26) and `--source` filters (#38)
- MCP over Streamable HTTP with bearer-token auth (#31); stateless POSTs
  answered with plain JSON (#88)
- `action-hub harness` setup/export (#40), per-harness guides (#36), a `pi`
  target (#44), and a harnesses and skills tab in the canvas (#27)
- `doctor` diagnostics with redacted transport details (#37)
- `bundle --export` (#43); skills directory scanning at `~/.action-hub/skills`
  (#34)
- Result caching for idempotent reads and tool-annotation propagation (#28)
- Harness-neutral naming: `packages/plugin` and `@action-hub/mcp-server` (#55)

**Search quality**

- Query-side stopwords, unicode-aware tokenization, token cap, optional
  minimum score (#52)
- Flagged "no confident match" abstention (SQ3, #82), recalibrated on a
  held-out set with 87 negatives (#105)
- Curated verb-synonym query expansion (SQ2, #83)
- Local MiniLM embeddings for semantic search (SQ4, #92); off by default in
  unit-test hubs (#102)
- Compressed server directory (`list_servers`) and goal-only recall gate
  (#104)
- Corpus statistics memoized per catalog version (#67)

**Reliability and security fixes**

- Response-size caps and redaction of known secret prefixes (#51)
- Collision-safe skill ids, first-wins duplicate tool names (#50)
- Credential redaction in `import`, atomic `0600` config writes, raw config
  preserved on `import --write` (#35, #39, #42)
- Execute-time connection errors trip the breaker (#59); repeated execute
  timeouts isolate a server (#73); per-server activation deadline (#65)
- Deferred startup refresh and debounced snapshots (#68); cooperative index
  embedding so the daemon stays responsive during reindex (#63)
- Progress-aware daemon start readiness (#70); deterministic `doctor` under
  flapping servers (#61)
- Process-group teardown that is anchored and reuse-safe (#77), with
  winner-path identity checks (#96, #97)
- JSON-RPC edge cases: malformed stdio frames (#89), `-32602` for empty
  queries and unknown cursors (#81)
- Piped output over 64 KiB is no longer truncated (#53)

**Stress and evaluation harness (`stress/`)**

- Generators: 10k-tool corpus (#49), 5,000 skills (#45), adversarial catalog
  content (#48), a fake MCP server over stdio and HTTP (#46)
- Chaos and resilience harness on a 44-server fleet (#56), harness e2e (#62),
  external k6 stress tools (#47, #95), load and performance bench (#58), CLI
  scale benchmarks (#57)
- Retrieval quality evaluation (#66) with strict validators (#85), realistic
  paraphrase queries (#72, #76), and execution success and abstention scored
  separately (#103)
- Fixture-backed as-of execution eval that tells "no data" apart from zero
  (#107)
- Shared harness lib with isolation, process-group runner, and interrupt-safe
  `main()` (#64, #75, #94)

**Docs and site**

- Scale and reliability docs (#80), framing corrections (#86), cache-stable
  design and compaction guidance (#105)
- Explainer microsite deployed to GitHub Pages from `site/dist` (#106)

**Release (2026-10-17)**

- release-please in manifest mode with linked versions for cli, core, and
  mcp-server; the release workflow builds and attaches binaries to the
  `v*` release (#109)
- First release `v0.1.0` (#111)

## Next

1. **npm publishing.** Release automation is live (#109): release-please
   keeps a `chore: release main` PR open, and merging it tags, builds, and
   attaches the binaries. The npm job publishes nothing until an `NPM_TOKEN`
   secret exists, the `@action-hub` npm scope is created, and
   `@action-hub/core` and `@action-hub/mcp-server` stop being private. CI does
   not run on the release PR automatically; close and reopen it first. See
   `docs/releasing.md`.
2. **Editor extensions (#20, open).** One-click extensions for VS Code,
   Cursor, and JetBrains. Each would register Action Hub as the meta-MCP
   provider, auto-detect existing MCP configs, show daemon status (indexed
   tools, latency) in the status bar, and embed the capability browser and
   permission controls. The harness setup/export command (#40) and
   multi-harness discovery (#26) are the building blocks.
3. Pick further search and reliability work from the committed evaluation
   results and production usage, as `docs/roadmap.md` says.

**Roadmap "Later" items, current state:**

| Item | State |
| --- | --- |
| Authentication state per server, with OAuth refresh surfaced to the host | Partly done. OAuth 2.0 and refresh rotation shipped (#23); surfacing auth state to the host is still open. |
| Bundles exposed to the model, so a task can scope itself to a subset | Partly done. Bundles exist (#8) and export as JSON (#43); model-facing scoping is still open. |
| Result caching for idempotent reads | Done (#28). |
| Richer host integration than the single MCP tool (native tool listings, per-host skill formats) | Open. This overlaps with #20. |

`docs/roadmap.md` still lists result caching under "Later", and its
"Implemented" section predates most of the work above. It should be updated
alongside this file.

## Notes for future sessions

- Tests import from `dist/`, not `src/`, so `npm test` runs `npm run build`
  first. Node's type-stripping does not remap `.js` specifiers to `.ts`.
- Test files cannot use TypeScript syntax that emits code: no parameter
  properties, enums, namespaces, or decorators. Strip-only mode rejects them.
- After changing `packages/core` types, rebuild before running `typecheck` in
  the server workspace; it reads core's emitted declarations.
- Tests isolate `HOME` and `XDG_*` (#60). Stress runs need a fully isolated
  environment; never point them at real config or cache.
- `packages/cli/src/version.ts` must match `packages/cli/package.json`, and a
  unit test enforces it.
- `gh` commands needing elevated scopes must be prefixed with `env -u GH_TOKEN`
  to fall back to the keyring token, which has `delete_repo`.
- The full test suite opens many local sockets. Network calls (including
  `gh`) made in parallel with it can fail with "can't assign requested
  address".
