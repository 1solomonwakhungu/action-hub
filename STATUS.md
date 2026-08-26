# Status

Last updated: 2026-08-26

## Where things stand

Initial scaffold is complete and validated. Both layers build, the test suite
passes, and the MCP server has been exercised end-to-end against a real
downstream server.

**Verified:**

- `npm run build` — clean, both workspaces
- `npm run typecheck` — clean
- `npm test` — 92/92 passing
- End-to-end smoke test against `@modelcontextprotocol/server-filesystem`:
  the server exposed exactly one tool (`action_hub`), indexed 14 downstream
  tools, and completed a full search → load → execute cycle. Execute returned
  real file contents.
- Snapshot written to the canvas cache path with correct server state, tool
  counts, invocation history, and a context estimate (1,843 eager tokens
  versus 600 for the hub, on a single small server).

## What is done

- `packages/core` — catalog persistence, BM25 search, dependency-free local
  semantic scoring, connection manager, permission policy, argument validator,
  bundles, and the `ActionHub` façade
- `packages/copilot-plugin` — plugin manifest, `.mcp.json`, skill, meta-MCP
  server, and the Capability Manager canvas
- Interactive canvas controls — enable/disable, trust changes, live search
  testing, and add-a-server, routed through a localhost control endpoint on the
  running hub
- `docs/architecture.md`, `docs/roadmap.md`, README, MIT license

## Next

In priority order, with rationale in `docs/roadmap.md`:

Catalog persistence is done: the catalog is cached to
`$XDG_CACHE_HOME/action-hub/catalog.json` (falling back to `~/.cache`), keyed
by a hash of the server config and a schema version, served on startup, and
re-indexed in the background. The cache file is a superset of the canvas
snapshot, so both stay in sync from one atomic, per-instance-serialised write
(unique temp file plus rename); the directory is `0700` and the file `0600`.

The approval flow is done: untrusted actions are gated behind single-use,
short-lived approval tokens bound to the exact arguments, surfaced by the MCP
server as an `approval_required` response.

Semantic scoring is done: `LocalSemanticIndex` is enabled by default at weight
0.2 and guarded against the 91-action evaluation corpus without regressing exact
matches.

Interactive canvas controls are done: enable/disable, trust changes, live search
testing, and add-a-server are routed through an authenticated localhost control
plane owned by the running hub.

## Notes for future sessions

- Tests import from `dist/`, not `src/`, so `npm test` runs `npm run build`
  first. Node's type-stripping does not remap `.js` specifiers to `.ts`.
- Test files cannot use TypeScript syntax that emits code — no parameter
  properties, enums, namespaces, or decorators. Strip-only mode rejects them.
- After changing `packages/core` types, rebuild before running `typecheck` in
  the server workspace; it reads core's emitted declarations.
- `gh` commands needing elevated scopes must be prefixed with `env -u GH_TOKEN`
  to fall back to the keyring token, which has `delete_repo`.
