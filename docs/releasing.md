# Releasing Action Hub

Action Hub ships as **standalone, zero-dependency executables** built with
[Node's Single Executable Application (SEA)](https://nodejs.org/api/single-executable-applications.html)
support. Each binary embeds the Node runtime, the developer CLI, and the MCP
server, so end users run `action-hub` without installing Node.

## Why Node SEA

The repository is an ESM monorepo already targeting Node ≥ 20.11. Node SEA is
the first-party, maintenance-free way to produce a single-file executable from
that runtime, with no bundled third-party runtime forks to track. The CLI and
MCP server are bundled into one CommonJS file with esbuild, then embedded into a
copy of the host `node` binary with `postject`. No new runtime dependency is
introduced — only two build-time dev dependencies (`esbuild`, `postject`).

The MCP server runs **in-process** from the CLI's `start` command rather than by
spawning a child `node`. This is what lets `action-hub start` work identically
from `node dist/index.js` and from the SEA binary, where `process.execPath` is
the binary itself and there is no separate `node` to spawn.

## Supported targets

| OS      | Arch  | Artifact                        | Build runner       |
| ------- | ----- | ------------------------------- | ------------------ |
| macOS   | arm64 | `action-hub-macos-arm64`        | `macos-14`         |
| macOS   | x64   | `action-hub-macos-x64`          | `macos-13`         |
| Linux   | x64   | `action-hub-linux-x64`          | `ubuntu-24.04`     |
| Linux   | arm64 | `action-hub-linux-arm64`        | `ubuntu-24.04-arm` |
| Windows | x64   | `action-hub-windows-x64.exe`    | `windows-latest`   |

SEA cannot cross-compile, so every target is built on a matching runner in the
release matrix. Building an unsupported target fails loudly in
`scripts/build-binary.mjs`.

## Local build

```bash
npm ci
npm run dist          # build workspaces -> bundle -> host SEA binary
npm run smoke:binary  # --version, --help, `list`, and a real MCP handshake
```

Outputs land in `dist-bin/`. `npm run checksums` writes a `sha256sum -c`
compatible `dist-bin/SHA256SUMS.txt`.

## Cutting a release

1. Bump the version in `packages/cli/package.json` **and**
   `packages/cli/src/version.ts` (a unit test enforces they match), plus the
   other workspace manifests if desired.
2. Commit, then tag: `git tag v0.1.0 && git push origin v0.1.0`.
3. The [`Release`](../.github/workflows/release.yml) workflow builds every
   target, smoke-tests each binary, generates checksums plus the Homebrew and
   winget manifests, and creates a GitHub release with all assets attached.

The workflow also triggers on `release: published` and `workflow_dispatch`
(with a `tag` input) for manual re-runs. Third-party actions are pinned to
immutable commit SHAs.

### Release assets

- `action-hub-<os>-<arch>[.exe]` — the standalone binaries
- `SHA256SUMS.txt` — checksums for all binaries
- `action-hub.rb` — the generated Homebrew formula
- `winget-manifests.tar.gz` — the generated winget manifests

## Homebrew

The formula installs the correct binary per OS/arch from the release and
verifies its SHA-256. To publish it to a tap, set a `HOMEBREW_TAP_TOKEN`
repository secret (a PAT with `contents:write` on `1solomonwakhungu/homebrew-tap`).
When present, the release workflow commits the regenerated formula to that tap.
Without the secret the step is skipped — the formula is still attached to the
release, and users can `brew install --formula ./action-hub.rb`.

```bash
brew tap 1solomonwakhungu/tap
brew install action-hub
```

## Winget

`winget-manifests.tar.gz` contains v1.6 manifests for the portable Windows
binary. Publishing to the public catalog requires a pull request to
[`microsoft/winget-pkgs`](https://github.com/microsoft/winget-pkgs), which needs
a fork and external credentials this repository does not hold. Submit with
either:

```powershell
# Option A: wingetcreate (recommended)
wingetcreate submit --token <GITHUB_TOKEN> .\SolomonWakhungu.ActionHub

# Option B: manual PR
# Copy manifests under manifests/s/SolomonWakhungu/ActionHub/<version>/ in a
# fork of microsoft/winget-pkgs and open a PR.
```

Users then install with `winget install SolomonWakhungu.ActionHub` once the
submission is merged.

## npm

npm distribution is unchanged. The `@action-hub/cli` package still exposes the
`action-hub` bin via `dist/index.js`, and the meta-MCP server via
`@action-hub/mcp-server`. The standalone binaries are an additional channel,
not a replacement.
