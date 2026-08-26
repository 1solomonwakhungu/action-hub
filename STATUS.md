# Status

Last updated: 2026-08-26

## Where things stand

Initial scaffold is complete and validated. Both layers build, the test suite
passes, and the MCP server has been exercised end-to-end against a real
downstream server.

**Verified:**

- `npm run build` — clean, both workspaces
- `npm run typecheck` — clean
- `npm test` — 49/49 passing
- End-to-end smoke test against `@modelcontextprotocol/server-filesystem`:
  the server exposed exactly one tool (`action_hub`), indexed 14 downstream
  tools, and completed a full search → load → execute cycle. Execute returned
  real file contents.
- Snapshot written to the canvas cache path with correct server state, tool
  counts, invocation history, and a context estimate (1,843 eager tokens
  versus 600 for the hub, on a single small server).

## What is done

- `packages/core` — catalog, BM25 search, dependency-free local semantic
  scoring, connection manager, permission policy, argument validator, bundles,
  and the `ActionHub` façade
- `packages/copilot-plugin` — plugin manifest, `.mcp.json`, skill, meta-MCP
  server, and the Capability Manager canvas
- `docs/architecture.md`, `docs/roadmap.md`, README, MIT license

## Next

In priority order, with rationale in `docs/roadmap.md`:

1. Catalog persistence — startup currently re-indexes every server every time
2. Interactive canvas controls — the canvas is read-only today

Recently landed: a search evaluation suite (recall/MRR regression gate),
single-use approval tokens for gated actions, and dependency-free local
semantic scoring. `LocalSemanticIndex` now implements `SemanticScorer` and is
on by default, blended at a conservative weight with a non-throwing fallback to
pure BM25. See `docs/architecture.md`.

## Notes for future sessions

- Tests import from `dist/`, not `src/`, so `npm test` runs `npm run build`
  first. Node's type-stripping does not remap `.js` specifiers to `.ts`.
- Test files cannot use TypeScript syntax that emits code — no parameter
  properties, enums, namespaces, or decorators. Strip-only mode rejects them.
- After changing `packages/core` types, rebuild before running `typecheck` in
  the server workspace; it reads core's emitted declarations.
- `gh` commands needing elevated scopes must be prefixed with `env -u GH_TOKEN`
  to fall back to the keyring token, which has `delete_repo`.
