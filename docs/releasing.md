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
| macOS   | x64   | `action-hub-macos-x64`          | `macos-15-intel`   |
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

Releases are automated with
[release-please](https://github.com/googleapis/release-please) in manifest
mode ([`release-please-config.json`](../release-please-config.json),
[`.release-please-manifest.json`](../.release-please-manifest.json)).

1. Merge conventional commits (`feat:`, `fix:`, `feat!:` ...) to `main` as
   usual.
2. The [`Release Please`](../.github/workflows/release-please.yml) workflow
   keeps one release PR open (`chore: release main`). It bumps the versions of
   `@action-hub/cli`, `@action-hub/core` and `@action-hub/mcp-server` in
   lockstep (the `linked-versions` plugin), updates each package's
   `CHANGELOG.md`, the root `package-lock.json`, the plugin manifest
   (`packages/plugin/plugin.json`) and every source line annotated with
   `x-release-please-version` (for example `packages/cli/src/version.ts`).
3. Merging the release PR creates the tags and GitHub releases:
   `v<version>` for the CLI (the product release), plus `core-v<version>` and
   `mcp-server-v<version>`. The `v*` release is marked as latest so the
   README's `releases/latest/download/...` links keep pointing at the binaries.
4. The same run calls the [`Release`](../.github/workflows/release.yml)
   workflow with the `v*` tag. It builds every target, smoke-tests each binary,
   generates checksums plus the Homebrew and winget manifests, and attaches
   them to the existing release.
5. If the `NPM_TOKEN` secret is set, the `npm-publish` job publishes the
   packages (see [npm](#npm)). Without it the job logs a notice and skips.

Before 1.0, `feat:` bumps the minor version and breaking changes also bump the
minor (`bump-minor-pre-major`). To force a version, add `Release-As: x.y.z` to
a commit body.

### One-time repository settings

- **Settings -> Actions -> General -> Workflow permissions**: enable *Allow
  GitHub Actions to create and approve pull requests*. Without it
  release-please cannot open the release PR with `GITHUB_TOKEN`.
- Pull requests and tags created with `GITHUB_TOKEN` do not trigger other
  workflows, so CI does not run on the release PR automatically. Close and
  reopen the PR to run CI on it. The binary build is invoked directly by the
  release-please workflow, so it does not depend on the tag push event.

### Manual re-runs

`release.yml` still triggers on a manually pushed `v*` tag, on `release:
published`, and on `workflow_dispatch` (with a `tag` input), and checks out the
requested tag. Use these to rebuild assets for an existing release. Third-party
actions are pinned to immutable commit SHAs.

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

The `@action-hub/cli` package exposes the `action-hub` bin via
`dist/index.js`, and the meta-MCP server via `@action-hub/mcp-server`. The
standalone binaries are an additional channel, not a replacement.

`scripts/publish-npm.mjs` publishes the packages listed in
`release-please-config.json` in dependency order, with npm provenance. It is
safe to re-run: it skips a package that

- is marked `"private": true`,
- depends on a private workspace package, or on one through a `*` range
  (the published package would not install), or
- already has that exact version on the registry.

Today `@action-hub/core` and `@action-hub/mcp-server` are private, so the CLI
is skipped as well until they are made public. Preview what would happen with
`npm run build && node scripts/publish-npm.mjs --dry-run`.

## Third-party license notice (SQ4)

The standalone binary redistributes the Apache-2.0 MiniLM model and the MIT
onnxruntime-web subset. Their terms ship in three places; all are covered by
the binary smoke:

- **Inside the binary** as SEA assets — `action-hub licenses` prints the
  vendored provenance notice (VENDOR.md) and both license texts;
- **Next to the binaries** in the release assets as `THIRD_PARTY_LICENSES.txt`
  (uploaded by the release workflow);
- **In the npm package** under `packages/core/vendor/` (VENDOR.md +
  `licenses/`), asserted by the packaging regression test.
