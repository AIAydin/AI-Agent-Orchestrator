# Forgeboard

Forgeboard is an open-source, local-first visual workshop for building software with locally
installed coding-agent CLIs. The current desktop application combines a spatial canvas, isolated
Git worktrees, streamed agent sessions, loopback web/mobile previews, and explicit launch and
workflow approval gates, authoritative primary-checkout Git review, staging, and commits, plus
UI-configured project checks with persisted output. Completed writable runs can also be reopened as
authoritative, isolated agent-worktree reviews without entering a path or editing configuration.
The permission centre exposes Plan/read-only, Worktree write, Docker isolated, and a reusable
Custom profile with complete host/Docker controls and honest enforcement disclosures.
The first-run agent step requires main-process readiness evidence for the selected bundled,
detected, overridden, or custom CLI before setup can continue. Only an exact fingerprinted project
check can optionally be remembered for 30 days; saved check approvals can be revoked immediately
under **Settings → Permissions** and do not authorize agent launches or other actions.
Data & Privacy also provides UI-configured scheduled and quit-time SQLite backups with a per-folder
retention target, canvas snapshot recovery, and reviewed portable JSON export/import. The interactive
terminal node and other unchecked surfaces in the implementation ledger are still under
construction.

> Forgeboard is under active construction. `IMPLEMENTATION_CHECKLIST.md` is the authoritative
> status ledger; unchecked items are not claimed as complete.

The release target is download-first: finished GitHub Releases will provide native installers for
macOS, Windows, and Linux so a user can install Forgeboard and use its deterministic demo without
developer tools. That full installer publication has not yet been verified. The implemented solo
setup flow is completed in the UI without editing source, JSON, environment files, or hand-written
configuration; broader unfinished product areas remain listed below and in the checklist.

When a release is available, download the architecture-specific installer from
[GitHub Releases](https://github.com/AIAydin/AI-Agent-Orchestrator/releases) and follow the
[install and checksum guide](docs/install/README.md). Release installation requires no source
checkout or configuration-file editing.

## Local-first principles

- Solo mode requires no account, cloud service, model API key, or Forgeboard server.
- Repository contents, paths, prompts, transcripts, terminal output, and diffs stay local by
  default.
- Forgeboard uses its bundled Git runtime and launches the user's installed Codex, Claude Code,
  Gemini CLI, OpenCode, or custom CLI. Those tools may send selected context to their providers
  under their own terms.
- There is no telemetry, analytics, crash upload, model proxy, or automatic log collection.
- The optional collaboration protocol/server accepts approved canvas metadata only, never
  repository files or raw transcripts. Joining and leaving an authenticated room is configured in
  Settings; the access token is kept only for the active main-process session and is never saved.

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
config/
  tooling/          Shared TypeScript, lint, formatting, and test configuration
scripts/
  startup/          One-command source bootstrap
  structure/        Line-count and folder-density enforcement
  release/          Release metadata, sources, and checksum tooling
docs/
  design/           Architecture documentation
  policies/         Privacy and operating policies
  legal/            Third-party notices
  install/          End-user downloads, checksums, and platform installation
.github/
  workflows/        Cross-platform verification and release automation
```

Only standard repository entry files remain at the top level. Maintained folders are limited to 12
direct hand-written files of any type, and the structure gate requires a named feature/domain
subfolder before that limit is exceeded.

## Current availability

Forgeboard does not yet claim a published, end-user-ready GitHub Release. The current checkpoint
has a passing production build and verified unpacked applications on macOS arm64, macOS Intel,
Windows, and Linux. Unsigned native macOS arm64 and Intel DMGs have also been generated, installed,
launched, smoke-tested, and checksummed. The current Windows and Linux installer rerun, and GitHub
Release publication for every platform, remain open; the latest hosted rerun was prevented from
starting by the repository account's GitHub Actions billing state.

For implemented solo workflows, the first-run wizard and Settings provide UI controls for agent
detection and executable selection, custom CLI setup, permission profile selection, Docker,
project/worktree locations, preview commands, extensions, and local storage, backup, and retention
behavior. Source and config-file edits are optional for these flows. Lint, typecheck, test, build,
and custom project checks can likewise be configured, approved, run, cancelled, and inspected
entirely in the UI. See [Permission profiles](docs/PERMISSIONS.md) for the exact technical and
disclosure-only boundaries.

The selected first-run CLI must have current ready evidence from the trusted process: Forgeboard
resolves the exact executable and runs its bounded version/capability probe, while missing,
mismatched, or invalid configurations keep **Continue** disabled. Checking a draft executable does
not silently save it or approve a later launch.

Settings shows readiness for every configured built-in/custom agent and preview/check command. On
save, main independently blocks newly changed agent or command configuration unless exact
main-admitted evidence still passes a passive identity/readiness recomputation; changed worktree and
newly enabled or changed backup destinations are checked directly in that same transaction.
On upgrade, known legacy values that no longer satisfy those rules are repaired field by field before
the strict startup integrity check. Unaffected settings remain intact, unsafe executables/hosts/paths
fall back to device-correct defaults or are disabled, and unrelated corruption still fails closed.
Numeric fields, loopback preview hosts, executable inputs, and destinations are also validated by
trusted IPC contracts, and imported drafts pass the same save rules. Folder checks inspect only—they
create no directory, write no probe, start no process, and expose no canonical host path. A
managed-worktree destination is rejected if it or its nearest existing parent is a symbolic-link or
noncanonical alias. A backup alias is instead checked at its canonical destination and shown with a
warning; actual backups are published and recorded only under that canonical path.

Project checks normally retain their cancel-default native launch confirmation. That dialog can
optionally remember only the exact main-resolved project/check fingerprint for 30 days. The
fingerprint binds the project, check identity and kind, executable and arguments, working directory,
inherited environment-variable names, repository-root identity, executable identity, and relevant
package-script bytes. Drift produces a different fingerprint and requires a new confirmation.
Remembered approvals are listed and immediately revocable in **Settings → Permissions → Scoped
approvals**. Agent launches, selected/expanded context, Docker pulls, external sends, and destructive
Git actions never reuse this check grant.

Existing folders can be opened without Git. Forgeboard then offers an **Initialize Git** action in
the project rail. A cancel-default native confirmation names the exact folder before Forgeboard
creates Git metadata; existing files are left untouched, unstaged, and uncommitted.

Repository clone and Docker image pull use a separate main-owned outbound gate. Each native dialog
shows the exact action, transport, credential-free endpoint/resource, and destination details. Its
short-lived approval is owner-bound and single-use; Forgeboard rebuilds the disclosure after the
dialog and refuses execution if anything changed. The low-level clone and pull executors require the
gate-issued permit, so a renderer response alone is not authority to send data.

The Data & Privacy screen can browse and create canvas snapshots, restore an exact reviewed
snapshot after native confirmation, and import a validated portable JSON export in merge or replace
mode. Import revalidates the selected file's exact-byte SHA-256 digest immediately before its
transaction. Portable exports include Forgeboard settings, projects, canvases, runs, checks,
snapshots, and audit history; they do not embed repository files, extension source folders, or the
device-local settings-repair ledger. When an upgrade repairs settings, a startup notice links to
**Settings → Data & privacy**, where the affected fields and preserved original can be reviewed and
explicitly exported. Complete local-data deletion clears that recovery evidence.

Each preserved original or repaired settings JSON value is independently limited to 16 MiB of UTF-8
data. SQLite enforces the same byte boundary before the full value is loaded; an oversized legacy row
stops with recovery guidance instead of creating partial evidence or silently dropping settings.

On Windows, backup readiness and creation use a fail-closed ACL authority rather than POSIX mode-bit
assumptions. An existing destination must prevent untrusted local accounts from reading, discovering,
replacing, or deleting backup content. A newly created destination and every staging directory and
database file receive a protected DACL for the current Windows SID and LocalSystem before bytes are
published, and the final hard-linked file is rechecked before success is recorded.

Desktop audit metadata is redacted before storage and linked by SHA-256 previous/event hashes.
Forgeboard verifies the chain and its required immutability triggers at startup and when validating
a backup. Audit retention removes only a verified leading prefix and writes a chained checkpoint,
so it never punches an unverifiable hole through later events. This is tamper-evident local storage,
not an externally anchored signature: a privileged actor able to rewrite the whole database can
recompute an unkeyed chain, and raw subprocess output is not made safe by audit redaction.

Docker isolation is optional. Forgeboard does not bundle or silently choose an agent image: select
the Docker executable, exact image, and in-image agent executable in the UI. Forgeboard checks that
combination locally and requires the exact single-use native outbound confirmation before any
explicit image download. Agent run planning performs only bounded Docker daemon/image metadata
preflight, pins the approved launch to an immutable image ID, and does not execute the in-image agent
until exact launch approval.

The release workflow is designed to emit clearly identified unsigned development artifacts until
the optional signing secrets documented in the release guide are configured. Such artifacts may
trigger the operating system's standard warning.

Still unfinished are agent comparison and merge/push flows, the interactive terminal node, updater,
direct SQLite backup restore UI, and complete wiring of every persisted setting. See
`IMPLEMENTATION_CHECKLIST.md` for the complete evidence-backed status.

Optional collaboration is explicitly enabled and configured under **Settings → Connectivity**.
After native network confirmation, the desktop joins the named self-hosted room with a short-lived
access token, synchronizes allowlisted canvas metadata, and shows shared cursors, selections,
presence, idle collaborator avatars, and node comments according to the authenticated role. Pending
metadata intent is retained locally for bounded restart/offline recovery; same-field conflicts pause
for review instead of silently overwriting either side. Solo mode never starts or contacts the
collaboration service.

Git review is opened from the command bar for the primary checkout or from a completed run's entry
in **Changes** for that run's managed worktree. Forgeboard resolves the worktree from its persisted
run and ownership records; the UI never asks for or accepts a worktree path. The review header and
every commit/discard disclosure identify the active target, and agent-worktree actions leave the
primary checkout untouched.

Safe project-tree files can be dragged or selected with the keyboard for an Agent. A configured File
node can also be linked by moving its canvas center onto an unlocked Agent or by using its
keyboard-accessible target picker. Moving it elsewhere remains an ordinary canvas move, and
read-only collaboration, locked nodes, directories, missing files, and cross-project targets are
rejected. The direct drop links that exact existing File-node ID instead of creating a duplicate.

Before ordinary **Review & run**, the renderer writes the current effective permission profile onto
the Agent and requires the canvas save to finish. Main then reloads the saved Agent and rejects any
prompt, adapter, or permission-profile mismatch before resolving and hashing its opaque context
links. A failed save prevents preparation. The renderer saves again immediately before approval,
after which main re-resolves the persisted configuration and attachment manifest; drift consumes the
prepared plan and requires a fresh review.

Reviewed context paths remain logical labels. Immediately before spawn, Electron main copies the
approved digest-bound bytes through stable ordinary-file handles into a private per-run snapshot and
substitutes only snapshot paths in the actual launch arguments, standard input, and context list.
Docker runs receive the same bytes through one separate read-only `/forgeboard-context` mount without
changing the approved worktree mount or its access policy. Randomized snapshot paths never enter the
renderer disclosure, and main removes the snapshot after the session ends or a launch fails. If the
desktop process crashes, the next single-instance owner scavenges only marker-validated, owner-only
dead or expired instances inside Forgeboard's dedicated snapshot store. It preserves recent live
instances, ignores unknown and symlink entries, resumes validated interrupted quarantine cleanup,
and performs managed-Docker-root cleanup lazily without scanning project checkouts. Ownership markers
are read through stable, no-follow file handles and are rejected above 4 KiB.

Normal desktop startup only warms this context store. If that warm-up cannot establish the protected
storage boundary, Forgeboard still opens so non-context work and recovery UI remain available;
context-bearing runs retry the checks and remain blocked while the failure persists. On Windows,
both Host and Docker context snapshots live under Forgeboard's per-user application-data directory in
separate scope-and-SID-hash namespaces, not inside a shared managed-worktree root. The root and
instance markers bind the current SID, private directories and files allow only that SID plus
LocalSystem, and their identities and DACLs are revalidated immediately before each launch bind.

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

See [Architecture](docs/design/ARCHITECTURE.md), [Security](.github/SECURITY.md),
[Privacy](docs/policies/PRIVACY.md),
[Permission profiles](docs/PERMISSIONS.md), [Releases and signing](docs/RELEASES.md),
[Local extensions](docs/EXTENSIONS.md), and [Contributing](.github/CONTRIBUTING.md) for design and
policy details. Installer third-party licenses and corresponding-source details are in
[Third-party notices](docs/legal/THIRD_PARTY_NOTICES.md).

## License

MIT
