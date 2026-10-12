# Contributing to Action Hub

Action Hub is an indexed, on-demand capability layer for MCP servers and
skills. This page covers how to build it, how the tests are laid out, and what
a change needs before it can merge. The design rules it must respect are the
five principles at the end of the [README](README.md); the one that bites most
often is **search never returns schemas**.

## Prerequisites

- Node.js **20.11 or newer** (`engines` in `package.json`; CI runs the suite on
  Node 22 and a basic CLI check on 20.11.0). No other runtime is needed: the
  embedding model and its WASM runtime are vendored under
  `packages/core/vendor/`.
- npm (the repo uses npm workspaces and `package-lock.json`).
- A POSIX shell for the stress scripts. The unit tests and build run on
  macOS, Linux, and Windows (CI's binary smoke job covers all three).

## Build, typecheck, test

```bash
npm ci
npm run build       # tsc in every workspace, then the site bundle
npm run typecheck   # tsc --noEmit in core (src + eval), server, and cli
npm test            # node --test per workspace; each workspace builds first
npm run eval        # retrieval-quality gate (packages/core/eval), see below
```

Per-workspace variants work too, for example
`npm test --workspace @action-hub/core` or
`npm run build --workspace @action-hub/cli`. The workspace names are
`@action-hub/core`, `@action-hub/mcp-server`, `@action-hub/cli`, and
`@action-hub/site`.

`npm test` preloads `test-isolation.mjs`, which points `HOME`, the `XDG_*`
dirs, every `ACTION_HUB_*` path variable, the harness config dirs, and the OS
temp location at a fresh per-process directory. Tests therefore cannot read or
write your real config, cache, credentials, or harness settings, and you do
not need to clean anything up afterwards.

Running the suite **as root** makes four tests fail (three in core, one in
the CLI). They simulate unreadable or unwritable paths with `chmod`, which
root ignores. Run as an ordinary user, or treat those four as known
environment failures.

## Workspace layout

| Path | Package | What lives there |
| --- | --- | --- |
| `packages/core` | `@action-hub/core` | Layer 1: catalog, search (BM25, synonyms, embeddings, hashed fallback), connection manager, permissions and approvals, validator, bundles, catalog cache, OAuth, telemetry, discovery and migration. No dependency on any host or on the MCP SDK; only `@opentelemetry/api`. `eval/` holds the retrieval gate, `vendor/` the pinned model. |
| `packages/plugin/server` | `@action-hub/mcp-server` | Layer 2: the meta-MCP server exposing the single `action_hub` tool over stdio, streamable HTTP, and the shared daemon; config loader; SDK client adapter; output hardening; snapshots. |
| `packages/plugin` | (bundle) | `plugin.json`, `.mcp.json`, and `skills/action-hub/SKILL.md`, the skill that teaches a model the search → load → execute loop. |
| `packages/cli` | `@action-hub/cli` | The `action-hub` developer CLI: `doctor`, `auth`, `migrate`, `import`, `test-search`, `list`, `bundle`, `start`, `harness`, `serve`, `connect`, `daemon`, `licenses`. Runs the server in-process so the SEA binary works without a separate `node`. |
| `site` | `@action-hub/site` | Static explainer deployed to GitHub Pages. |
| `stress` | — | Fleet-scale generators, bench, chaos, retrieval evaluation, gates. Not an npm workspace; plain `.mjs` scripts driven by `node`. |
| `scripts` | — | esbuild bundle, Node SEA binary build, smoke test, checksums, Homebrew and winget manifest generators. |

The boundary between `packages/core` and everything else is load-bearing:
core must never import a host harness, the MCP SDK, or `process.env` for
secrets. If a change needs something platform-specific, inject it (see
`TokenStore` and `McpClientFactory` in core for the pattern).

## Test conventions

These are the conventions that are easy to trip over. They came from the
project's own early sessions and still hold.

- **Tests import from `dist/`, not `src/`**, so every workspace's `npm test`
  runs `npm run build` first. Node's type-stripping does not remap `.js`
  specifiers to `.ts`, so an unbuilt workspace produces module-not-found
  errors rather than stale results.
- **Test files cannot use TypeScript syntax that emits code.** They run under
  Node's strip-only mode, which rejects parameter properties, enums,
  namespaces, and decorators. Plain type annotations, interfaces, and `as`
  casts are fine.
- **After changing `packages/core` types, rebuild core before running
  `typecheck` in the server or CLI workspace.** Both read core's emitted
  declarations from `packages/core/dist`.
- Tests are `node --test` with `node:assert`; no test framework. Each test
  file under `packages/*/test/*.test.ts` is self-contained and creates its own
  temp directories.
- Core's suite drives the whole system with in-memory fakes and no
  subprocesses. Spawned-process tests belong in the server or CLI workspace,
  and must bound every wait so a hang fails instead of stalling CI.
- Unit-test hubs disable embeddings (`embeddings: null`) unless the test is
  about embeddings; a cold embed of even a small catalog takes seconds and
  the hashed fallback exercises the same code paths.

## Search changes must pass the retrieval gates

Retrieval regressions are bugs. Any change under `packages/core/src/search/`,
to `packages/core/eval/`, or to catalog text that feeds the index (summaries,
tags, skill front matter) has to clear the following, and the pull request
should quote the before/after numbers.

1. **`npm run eval`** (`packages/core/eval/run.ts`). Runs the 40 labelled
   queries over the 91-action corpus through the lexical ranker and fails if
   `recall@1`, `recall@5`, or MRR drops below the floors in
   `packages/core/eval/baseline.ts` (`BASELINE`). `packages/core/test/eval.test.ts`
   additionally enforces the per-band floors (`BAND_BASELINE`) and the floors
   for the built-in hashed semantic scorer (`SEMANTIC_BASELINE`,
   `SEMANTIC_BAND_BASELINE`), so `npm test` is part of this gate too.
2. **`node stress/goal-only-gate.mjs`** scores the 30 goal-only rows of the
   hand-written realistic fixture against the generated 44-server / 10,000-tool
   / 5,000-skill corpus, per engine, and fails if any engine drops below
   `GOAL_ONLY_FLOORS`. It needs the corpus first:

   ```bash
   node stress/gen-tools.mjs && node stress/gen-skills.mjs
   node stress/goal-only-gate.mjs                                   # keyword + hashed, ~10 s
   node stress/goal-only-gate.mjs --engines keyword,hashed,embeddings --fails   # production wiring, ~10 min
   ```

   The embeddings engine is opt-in because embedding 15K records takes
   minutes. Run it for any change that touches fusion, the embedding index,
   or the synonym table.
3. **`node stress/validate-realistic-queries.mjs`** if you edit
   `stress/fixtures/realistic-queries.json`: every gold label must exist in
   the seeded corpus and the band mix must stay fixed. The synonym table was
   built on `split-tune.json` only; do not consult `split-held.json` when
   tuning anything.
4. **`node stress/abstention-threshold.mjs --semantic both`** if you touch
   the abstention gate or its threshold; the calibration tables in
   `docs/harness-guides.md` must be updated from the output.

When retrieval genuinely improves, **raise the floors in the same commit** and
record the new numbers in the pull request. A baseline that is never raised
stops protecting anything. Never lower a floor to make a change pass.

Numbers in the docs that cite a commit or PR were measured at that commit.
If you re-measure, add the new figure with its date and keep or clearly
supersede the old one; do not silently overwrite it.

## Commits and pull requests

- Commit subjects follow the pattern already in the log:
  `type(scope): summary`, where `type` is one of `feat`, `fix`, `docs`,
  `test`, `chore`, `stress`, and `scope` is `core`, `server`, `cli`,
  `search`, `daemon`, `stress`, or similar. Reference the finding or packet id
  when there is one (`F26`, `SQ4`), and the PR number is appended by GitHub
  on squash.
- One concern per pull request. A fix plus the regression test that proves it
  is one concern; a fix plus an unrelated refactor is two.
- Every behaviour change has a test. Every reliability fix has a regression
  test that failed before the fix.
- Update the prose when a claim changes: README, the relevant file under
  `docs/`, `SKILL.md` if the model-facing contract moved, and the
  `Unreleased` section of `CHANGELOG.md`.
- Do not add runtime dependencies to `@action-hub/core` beyond
  `@opentelemetry/api`. Build-time dependencies go in the root `package.json`
  with exact versions.
- Fill in the pull request template. CI (`.github/workflows/ci.yml`) runs
  typecheck, build, and tests on Node 22, a basic CLI check on Node 20.11.0,
  and the standalone-binary smoke on Ubuntu, macOS, and Windows; all three
  jobs must be green.
- **Third-party GitHub Actions are pinned to full commit SHAs** with the
  version in a trailing comment (`uses: actions/checkout@11d5960a… # v4.4.0`).
  Keep that when you add or bump an action in any workflow; a bare tag will
  be sent back.

## Running the stress suite

The stress scripts spawn dozens of fake MCP servers and write results under
`stress/.generated/` (gitignored). They build their own isolated environment
for every child, but they are heavy: a full `bench-load.mjs` run or an
embeddings-engine gate takes minutes and several hundred megabytes of RAM.
`stress/README.md` lists every script, what it measures, and the findings
recorded so far. Never point a stress script at a real config or cache.

## Reporting problems

Use the issue templates for bugs and feature requests. Anything that looks
like an approval bypass, a token leak, or a daemon authentication problem
should go through the private channel in [`SECURITY.md`](SECURITY.md), not an
issue.

## Development notes

Preserved from the project's status notes because they still save time.

- Tests import from `dist/`, not `src/`, so `npm test` runs `npm run build`
  first. Node's type-stripping does not remap `.js` specifiers to `.ts`.
- Test files cannot use TypeScript syntax that emits code: no parameter
  properties, enums, namespaces, or decorators. Strip-only mode rejects them.
- After changing `packages/core` types, rebuild before running `typecheck` in
  the server workspace; it reads core's emitted declarations.
- Maintainer environment only: `gh` commands needing elevated scopes must be
  prefixed with `env -u GH_TOKEN` to fall back to the keyring token, which has
  `delete_repo`. This describes the maintainer's machine, not a project
  requirement.
