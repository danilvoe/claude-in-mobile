# Fork versioning

This repository keeps its own version line while the changes are being prepared
for the main branch. That keeps fork builds identifiable and avoids mixing them
with upstream releases.

## Scheme

| Build | Version | Git tag |
|-------|---------|---------|
| Fork release | `X.Y.Z-fork.N` | `vX.Y.Z-fork.N` |
| Release merged into the main branch | `X.Y.Z` | `vX.Y.Z` |

- `N` starts at `1` and increments for every fork build based on the same
  upstream base version.
- The base `X.Y.Z` is the next upstream version the fork is based on.
- Once the changes land in the main branch, the fork line stops and the regular
  `X.Y.Z` numbering continues.

## What the release workflow does with a fork tag

The existing `release.yml` already classifies any tag with a `-` suffix as a
pre-release:

- the GitHub release is marked **pre-release** and does not become "Latest";
- npm publishes under the dist-tag derived from the suffix (`fork` for
  `4.5.0-fork.1`), so `latest` is untouched;
- the Homebrew job is skipped for pre-releases.

No workflow changes are needed for this scheme.

## Current line

- `4.5.0-fork.1` — first fork release: Aurora UI tree (Flutter VM Service and
  qtium/QML backends), `aurora_ui_setup`, crash logs, log filters, screenshot
  `saveTo`, rootless Flutter detection and UI-tree hardening.

## Publishing note

Fork builds are prepared locally. Publishing (npm/Homebrew/GitHub release)
requires the fork's own credentials and an explicit confirmation.
