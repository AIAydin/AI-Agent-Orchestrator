# Forgeboard

Forgeboard is an open-source, local-first visual workshop for building software with locally
installed coding-agent CLIs. The current desktop application combines a spatial canvas, isolated
Git worktrees, streamed agent sessions, loopback web/mobile previews, and explicit launch and
workflow approval gates, authoritative primary-checkout Git review, staging, and commits, plus
UI-configured project checks with persisted output. Completed writable runs can also be reopened as
authoritative, isolated agent-worktree reviews without entering a path or editing configuration.
The interactive terminal node and other unchecked surfaces in the implementation ledger are still
under construction.

> Forgeboard is under active construction. `IMPLEMENTATION_CHECKLIST.md` is the authoritative
> status ledger; unchecked items are not claimed as complete.

The release target is download-first: finished GitHub Releases will provide native installers for
macOS, Windows, and Linux so a user can install Forgeboard and use its deterministic demo without
developer tools. That full installer publication has not yet been verified. The implemented solo
setup flow is completed in the UI without editing source, JSON, environment files, or hand-written
configuration; broader unfinished product areas remain listed below and in the checklist.

## Local-first principles

- Solo mode requires no account, cloud service, model API key, or Forgeboard server.
- Repository contents, paths, prompts, transcripts, terminal output, and diffs stay local by
  default.
- Forgeboard uses its bundled Git runtime and launches the user's installed Codex, Claude Code,
  Gemini CLI, OpenCode, or custom
  CLI. Those tools may send selected context to their providers under their own terms.
- There is no telemetry, analytics, crash upload, model proxy, or automatic log collection.
- The optional collaboration protocol/server accepts approved canvas metadata only, never
  repository files or raw transcripts. Its desktop client is not complete yet.

## Workspace

```text
apps/
  desktop/          Electron main/preload and React renderer
  collab-server/    Optional self-hosted Hocuspocus/Yjs service
packages/
  core/             Domain models, workflow engine, security and persistence contracts
  agent-adapters/   Local coding-agent process adapters
  extension-runtime/ Validated data-only local extension lifecycle
  git-engine/       Safe Git repository/worktree/change services
  ui/               Accessible shared component system
  test-agent/       Deterministic local agent used by tests and the demo
```

## Current availability

Forgeboard does not yet claim a published, end-user-ready GitHub Release. The current checkpoint
has a passing production build and verified unpacked applications on macOS arm64, macOS Intel,
Windows, and Linux. Unsigned native macOS arm64 and Intel DMGs have also been generated, installed,
launched, smoke-tested, and checksummed. The current Windows and Linux installer rerun, and GitHub
Release publication for every platform, remain open; the latest hosted rerun was prevented from
starting by the repository account's GitHub Actions billing state.

For implemented solo workflows, the first-run wizard and Settings provide UI controls for agent
detection and executable selection, custom CLI setup, permission profile selection, Docker,
project/worktree locations, preview commands, extensions, and local storage/retention. Source and
config-file edits are optional for these flows. Lint, typecheck, test, build, and custom project
checks can likewise be configured, approved, run, cancelled, and inspected entirely in the UI.

Docker isolation is optional. Forgeboard does not bundle or silently choose an agent image: select
the Docker executable, exact image, and in-image agent executable in the UI. Forgeboard checks that
combination locally and requires a native confirmation before any explicit image download.

The release workflow is designed to emit clearly identified unsigned development artifacts until
the optional signing secrets documented in the release guide are configured. Such artifacts may
trigger the operating system's standard warning.

Still unfinished are agent comparison and merge/push flows, the interactive terminal node,
collaboration client, updater, backup restore/full-data import UI, and complete wiring of every
persisted setting. See `IMPLEMENTATION_CHECKLIST.md` for the complete evidence-backed status.

Git review is opened from the command bar for the primary checkout or from a completed run's entry
in **Changes** for that run's managed worktree. Forgeboard resolves the worktree from its persisted
run and ownership records; the UI never asks for or accepts a worktree path. The review header and
every commit/discard disclosure identify the active target, and agent-worktree actions leave the
primary checkout untouched.

## Development

Prerequisites: Node.js 22.12 or later with Corepack. Forgeboard supplies its own Git runtime.

For a developer source checkout, the one-command bootstrap is:

```bash
corepack pnpm start
```

The equivalent explicit commands are `corepack pnpm install --frozen-lockfile` followed by
`corepack pnpm dev`.

No external credentials are required for the deterministic demo flow. Real agent CLIs and `gh`
are detected locally and remain optional.

Developers may build from source with the commands below. The download-first release goal is that end
users will not need to clone the repository or install Node.js; publication of those installers is
not yet claimed. The current Settings UI detects local tools and offers executable and directory
pickers, argument-array command builders, validation, and safe defaults for the implemented solo
features. The guided first-run setup wizard exposes the same choices without requiring a config
file.

## Verification

```bash
corepack pnpm verify
corepack pnpm test:e2e
corepack pnpm package
corepack pnpm smoke:packaged
```

`verify` includes the 2,000-line structure gate, formatting, lint, strict typechecking, unit and
integration tests, and production builds. Packaging commands do not by themselves prove that every
platform installer has been generated and installed successfully.

See [Architecture](ARCHITECTURE.md), [Security](SECURITY.md), [Privacy](PRIVACY.md),
[Releases and signing](docs/RELEASES.md), [Local extensions](docs/EXTENSIONS.md), and
[Contributing](CONTRIBUTING.md) for design and policy details. Installer third-party licenses and
corresponding-source details are in [Third-party notices](THIRD_PARTY_NOTICES.md).

## License

MIT
