# Releases and signing

Forgeboard is intended to be downloaded by end users from GitHub Releases without Node.js, pnpm, a
source checkout, or config-file edits. The repository is currently private and has no tags or
published end-user release. For a matching release tag, the workflow is configured to build native
installers on GitHub-hosted macOS, Windows, and Linux runners, execute the verification and
packaged-app smoke suites, and publish platform-and-architecture-specific SHA-256 checksums only
after every required job succeeds. The current repository-account billing state prevents hosted jobs
from starting, so pushing a tag now would not produce a release. Published releases also attach the
immutable corresponding source archives for the bundled Git toolchain; see
[`THIRD_PARTY_NOTICES.md`](legal/THIRD_PARTY_NOTICES.md).

## Installing Forgeboard

Follow the concise [platform install guide](install/README.md) for exact architecture-specific
filenames, checksum commands, and first-launch instructions. Each published build will attach a
machine-readable `RELEASE-INFO` file that binds its source commit, installer names, and declared
signing/notarization credential state. The bundled deterministic demo requires no provider account,
API key, development tools, or configuration file.

Unsigned development artifacts can trigger normal operating-system provenance warnings. Signed and
notarized releases remove or reduce those warnings; release notes must always state which kind was
produced.

Developers who intentionally build from a clone can use the single cross-platform command
`corepack pnpm start`. It installs the pinned lockfile and starts the desktop app; it is not required
for normal end-user installation.

## Creating a release

1. Confirm `pnpm verify`, Electron E2E, `pnpm package`, and `pnpm smoke:packaged` are green.
2. Update the identical versions in the root and desktop package manifests and update release notes.
3. Create and push a signed `v*` tag whose value is exactly `v` plus that package version.
4. Verify each GitHub Actions artifact, `RELEASE-INFO` file, checksum, and native smoke result before
   publishing or announcing the release.

The workflow rejects version/tag mismatches and validates installed Dugite metadata against
[`third_party/dugite-sources.json`](../third_party/dugite-sources.json). A Dugite upgrade must update
that ledger and all corresponding immutable source commits in the same reviewed change.

## Optional signing credentials

Signing is a maintainer/repository concern and never an end-user setup step. Configure the following
GitHub Actions secrets to enable platform signing:

- macOS: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and
  `APPLE_TEAM_ID`.
- Windows: `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`.

Development builds can be produced without those secrets, but must be described as unsigned. Public
production releases should be signed and notarized. Linux packages publish checksums and should add
distribution-specific signing when an official package repository is introduced.

The release workflow uses read-only repository permissions while building. Only the tag-gated
publish job receives `contents: write`. A manual workflow dispatch builds and uploads CI artifacts
but cannot create a GitHub Release; publication requires a matching `v<package-version>` tag.
