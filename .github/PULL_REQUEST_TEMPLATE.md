<!-- Title: conventional prefix + scope, e.g. "fix(server): ..." or "docs: ...". -->

## What

<!-- One or two sentences. What changes, and for whom. -->

## Why

<!-- The problem, the finding, or the issue number. Link it if it exists. -->

## How to verify

<!-- Commands a reviewer can run. Keep what applies, delete the rest. -->

- [ ] `npm run build && npm run typecheck && npm test` pass locally
- [ ] `npm run eval` baseline holds (required for any change under `packages/core/src/search/`, `packages/core/eval/`, or to catalog text that feeds the index)
- [ ] `node stress/goal-only-gate.mjs` floors hold (required for ranking or synonym changes; needs the generated corpus, see `stress/README.md`)
- [ ] New behaviour has a test; a fixed bug has a regression test

## Docs

- [ ] README / `docs/` / `CHANGELOG.md` updated where a claim changed, or nothing user-facing changed

## Notes for the reviewer

<!-- Anything non-obvious: trade-offs, follow-ups, numbers that moved and why. -->
