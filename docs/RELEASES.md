# Releases and signing

Forgeboard is intended to be downloaded by end users from GitHub Releases without Node.js, pnpm, a
source checkout, or config-file edits. The source repository is public and currently has no tags or
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
machine-readable `RELEASE-INFO` file that binds its source commit and installer names to the
post-package signing and notarization checks that actually passed. The bundled local demo requires
no API key, development tools, or configuration file.

Unsigned development artifacts can trigger normal operating-system provenance warnings. Signed and
notarized releases remove or reduce those warnings; release notes must always state which kind was
produced.

Installed builds expose **Settings → Connectivity → Application updates** for an explicit
stable, prerelease, or disabled check against the fixed official Forgeboard GitHub Releases
endpoint. The check runs only after a cancel-default native approval. Forgeboard does not poll,
download, or install updates automatically; it can only show a validated release and, after another
native confirmation, open that exact release page in the system browser. This capability does not
mean a release exists; availability is determined from the official repository at check time.

Developers who intentionally build from a clone can use the single cross-platform command
`corepack pnpm start`. It installs the pinned lockfile and starts the desktop app; it is not required
for normal end-user installation.

## Creating a release

1. Confirm `pnpm verify`, Electron E2E, `pnpm package`, and `pnpm smoke:packaged` are green.
2. Run `corepack pnpm version:bump <new-semver>` (for example,
   `corepack pnpm version:bump 0.2.0`). The command validates that the current root and desktop
   versions agree, updates both manifests together, and creates the matching
   `docs/releases/v<new-semver>.md` file. It preserves an existing matching notes file and refuses
   invalid, unchanged, lower, or inconsistent versions without modifying the manifests. Review and
   complete the prepared notes before continuing.
3. Create and push a `v*` tag whose value is exactly `v` plus that package version. The workflow
   enforces the tag/version binding; cryptographic Git tag signing is an optional maintainer policy,
   not a release-workflow guarantee.
4. Pushing the tag starts automatic publication. Every build, metadata check, checksum, and native
   smoke must pass before the publish job runs; after publication, verify the GitHub Release assets
   and signing disclosure before announcing it.

The workflow rejects version/tag mismatches and validates installed Dugite metadata against
[`third_party/dugite-sources.json`](../third_party/dugite-sources.json). A Dugite upgrade must update
that ledger and all corresponding immutable source commits in the same reviewed change.

## Current publication blockers

As verified on 2026-07-25, the official repository is public and has no tags or published Releases.
The latest four-platform workflow attempt, from 2026-07-14, failed before any runner step started;
its jobs contain no runnable-step logs. Before tagging, rerun the workflow to confirm that hosted
runner access is available. The remaining release evidence is a successful native
install-and-launch smoke on every hosted target, including Windows, Linux, and both macOS
architectures, followed by a tag-gated publication whose assets and checksums are independently
verified. Production signing also remains optional external maintainer setup: do not claim macOS
signing/notarization or Windows Authenticode until the generated artifacts themselves pass the
workflow's post-package verification.

## Optional signing credentials

Signing is a maintainer/repository concern and never an end-user setup step. Configure the following
GitHub Actions secrets to enable platform signing:

- macOS: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and
  `APPLE_TEAM_ID`.
- Windows: `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`.

Development builds can be produced without those secrets. The workflow derives release metadata
from post-package Developer ID, stapled notarization-ticket, and Authenticode verification;
configured credentials that do not produce the expected proof fail the build. The tag-gated publish
job then derives the visible release title and a leading signing warning from all four verified
`RELEASE-INFO` records. Public production releases should be signed and notarized. Linux packages
publish checksums and should add distribution-specific signing when an official package repository
is introduced.

The release workflow uses read-only repository permissions while building. Only the tag-gated
publish job receives `contents: write`. A manual workflow dispatch builds and uploads CI artifacts
but cannot create a GitHub Release; publication requires a matching `v<package-version>` tag.
