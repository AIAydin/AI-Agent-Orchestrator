# Releases and signing

End users download Forgeboard from GitHub Releases; they do not need Node.js, pnpm, a source
checkout, or config-file edits. Each tagged release builds native installers on GitHub-hosted macOS,
Windows, and Linux runners, executes the verification and packaged-app smoke suites, and publishes
SHA-256 checksums.

## Creating a release

1. Confirm `pnpm verify`, Electron E2E, `pnpm package`, and `pnpm smoke:packaged` are green.
2. Update the version and release notes.
3. Create and push a signed `v*` tag.
4. Verify each GitHub Actions artifact and checksum before publishing or announcing the release.

## Optional signing credentials

Signing is a maintainer/repository concern and never an end-user setup step. Configure the following
GitHub Actions secrets to enable platform signing:

- macOS: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and
  `APPLE_TEAM_ID`.
- Windows: `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`.

Development builds can be produced without those secrets, but must be described as unsigned. Public
production releases should be signed and notarized. Linux packages publish checksums and should add
distribution-specific signing when an official package repository is introduced.
