# Releases and signing

End users download Forgeboard from GitHub Releases; they do not need Node.js, pnpm, a source
checkout, or config-file edits. Each tagged release builds native installers on GitHub-hosted macOS,
Windows, and Linux runners, executes the verification and packaged-app smoke suites, and publishes
platform-and-architecture-specific SHA-256 checksums. Releases also attach the immutable
corresponding source archives for the bundled Git toolchain; see
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

## Installing Forgeboard

1. Open the repository's **Releases** page and choose the newest stable release.
2. Download the artifact for the current operating system: macOS DMG/ZIP for Apple Silicon or Intel,
   Windows installer, or Linux AppImage/DEB.
3. Compare the file against the matching platform-and-architecture `SHA256SUMS` file attached to
   that release.
4. Install or open Forgeboard, then complete the first-run screens. The bundled deterministic demo
   requires no provider account, API key, development tools, or configuration file.

Unsigned development releases trigger normal operating-system provenance warnings. Signed and
notarized releases remove or reduce those warnings; release notes must always state which kind was
produced.

Developers who intentionally build from a clone can use the single cross-platform command
`corepack pnpm start`. It installs the pinned lockfile and starts the desktop app; it is not required
for normal end-user installation.

## Creating a release

1. Confirm `pnpm verify`, Electron E2E, `pnpm package`, and `pnpm smoke:packaged` are green.
2. Update the identical versions in the root and desktop package manifests and update release notes.
3. Create and push a signed `v*` tag whose value is exactly `v` plus that package version.
4. Verify each GitHub Actions artifact and checksum before publishing or announcing the release.

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
