# Packaging

Distribution manifests for the Action Hub standalone binaries. The manifests
here are **generated per release** from the published artifacts and their
checksums, so most files in this directory are git-ignored.

## Layout

```
packaging/
├── homebrew/
│   └── action-hub.rb        # generated: `npm run gen:homebrew` (git-ignored)
└── winget/
    └── SolomonWakhungu.ActionHub/<version>/
        ├── SolomonWakhungu.ActionHub.yaml            # version manifest
        ├── SolomonWakhungu.ActionHub.locale.en-US.yaml
        └── SolomonWakhungu.ActionHub.installer.yaml  # generated (git-ignored)
```

## Regenerating locally

Both generators read `dist-bin/SHA256SUMS.txt`, so build the binaries and their
checksums first (or point `--checksums` at a downloaded `SHA256SUMS.txt`):

```bash
npm run dist          # build workspaces + bundle + host binary
npm run checksums     # writes dist-bin/SHA256SUMS.txt
npm run gen:homebrew  # writes packaging/homebrew/action-hub.rb
npm run gen:winget    # writes packaging/winget/.../*.yaml
```

The release workflow performs the same steps across every target and attaches
the results to the GitHub release. See [`docs/releasing.md`](../docs/releasing.md)
for the full release and submission process.
