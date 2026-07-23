# Forgeboard

Run Claude Code, Codex, Gemini CLI, and OpenCode side by side on a spatial canvas. Each agent works
in its own isolated Git worktree, and nothing reaches the primary checkout without explicit human
review and approval. Everything is local: no accounts, no API keys, and no telemetry.

```bash
git clone https://github.com/AIAydin/AI-Agent-Orchestrator.git
cd AI-Agent-Orchestrator
corepack pnpm start
```

Running from source requires Node.js 22.12 or later with Corepack. Packaged installers are not
published yet, so this source bootstrap is currently the only way to try Forgeboard.

Forgeboard is an MIT-licensed, local-first visual workshop for building software with locally
installed coding-agent CLIs. The current desktop application combines a spatial canvas, isolated
Git worktrees, streamed agent sessions, loopback web/mobile previews, and explicit launch and
workflow approval gates, authoritative primary-checkout Git review, staging, and commits, plus
UI-configured project checks with persisted output. Completed writable runs can also be reopened as
authoritative, isolated agent-worktree reviews without entering a path or editing configuration.
Their local delivery flow requires selected configured checks bound to exact evidence and explicit
human quality approval bound to the exact committed source before primary can change.
The Git / PR node applies that same authority to an exact normal branch push and optional on-demand
GitHub repository, pull-request, and exact-head CI actions through the user's local `gh` CLI.
The permission centre exposes Plan/read-only, Worktree write, Docker isolated, and a reusable
Custom profile with complete host/Docker controls and honest enforcement disclosures.
The first-run agent step uses provider-owned browser sign-in for Codex and Claude Code, and requires
normalized main-process connection evidence before either can become the default. The bundled solo
test agent needs no account. Gemini, OpenCode, and custom CLIs retain their local executable-readiness
flow. Only an exact fingerprinted project
check can optionally be remembered for 30 days; saved check approvals can be revoked immediately
under **Settings → Permissions** and do not authorize agent launches or other actions.
Data & Privacy also provides UI-configured scheduled and quit-time SQLite backups with a per-folder
retention target, canvas snapshot recovery, and reviewed portable JSON export/import. Other
unchecked surfaces in the implementation ledger are still under construction.

> Forgeboard is under active construction. `IMPLEMENTATION_CHECKLIST.md` is the authoritative
> status ledger; unchecked items are not claimed as complete.

New users can follow the consolidated [Forgeboard user guide](docs/user/USER_GUIDE.md). For
problem-first recovery steps covering missing tools, moved projects, preview collisions, Git
conflicts, offline collaboration, malformed imports, and database recovery, see
[Troubleshooting](docs/support/TROUBLESHOOTING.md). The same common workflows and failures are
searchable offline inside **Settings → Help & shortcuts**.

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
- Codex and Claude Code connections start their official CLI-owned browser OAuth flows from first-run
  setup or **Settings → Agents & runtime**. Forgeboard does not receive or store OAuth tokens, read
  provider credential stores, or proxy model traffic. This OAuth connection UI does not apply to
  Gemini, OpenCode, or custom CLIs.
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

This repository is public but has no published tags or GitHub Releases yet, and therefore has no
installer download. Earlier exact-commit checkpoints recorded passing production builds and
unpacked-application smoke tests on macOS arm64, macOS Intel, Windows, and Linux, plus unsigned native
macOS arm64 and Intel DMG generation, installation, launch, smoke, and checksum evidence. The current
tree still needs fresh Windows, Linux, and macOS Intel hosted proof, signing/notarization, and GitHub
Release publication. The latest hosted rerun was prevented from starting by the repository account's
GitHub Actions billing state.

For implemented solo workflows, the first-run wizard and Settings provide UI controls for Codex and
Claude Code browser connection, agent detection and optional advanced executable/model selection,
custom CLI setup, permission profile selection, Docker,
project/worktree locations, Git remotes and the optional GitHub CLI, preview commands, extensions,
and local storage, backup, and retention behavior. Source and config-file edits are optional for
these flows.
Lint, typecheck, test, build, and custom project checks can likewise be configured, approved, run,
cancelled, and inspected entirely in the UI. See [Permission profiles](docs/PERMISSIONS.md) for the
exact technical and disclosure-only boundaries.

Interactive Terminal nodes are configured entirely in the inspector. A new node inherits the shell
and environment-variable allowlist selected in Settings; executable, literal argument array,
project-relative working directory, and environment names can then be changed per node. Launches
require both an in-app exact-command review and a separate cancel-default native confirmation. The
main process rechecks executable identity, canonical project/cwd containment, Settings allowlist,
expiry, and originating window immediately before starting a real PTY. The xterm surface supports
ANSI output, raw input, resize, search, display clearing, replay, interrupt, terminate, and fresh
reviewed restart. See [Interactive Terminal](docs/terminal/README.md) for its unsandboxed host
boundary and retention behavior.

Web Preview and Mobile Preview nodes are also configured entirely in the inspector. Users choose the
primary checkout or an available application-owned agent worktree, enter a literal command or select
a detected package script, and set readiness/navigation paths and device controls without editing a
manifest. The running page is displayed in a main-owned sandboxed loopback-only surface with browser
console capture, navigation/history/reload, native-reviewed screenshots, and confirmed external
opening. Mobile frames use Chromium touch emulation. A normal side-by-side device view can show one
target at two viewport sizes; **Compare agent worktrees** instead binds two distinct opaque completed
run IDs to independently owned sessions, ports, device presets, controls, and secured native
surfaces. Schema, renderer, and main-process launch reservations reject selecting or concurrently
launching the same worktree on both sides.

Canvas pan, zoom, selection, grouping, guides, locking, duplication, keyboard movement, and private
node comments work in the default solo product and autosave locally. Viewport position and zoom are
restored on relaunch. In an optional collaboration room, private comments remain on the device unless
the user separately creates an explicitly shared, role-authorized room comment.

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

Managed agent delivery has its own stricter gate in Git review. Choose the required configured
checks, run each one, and record human quality approval entirely in the UI. The evidence binds the
clean managed-worktree HEAD and tree, ownership, resolved check configuration, executable,
working-directory and environment identities, and exact terminal results. Re-running a check or
changing any bound source or command evidence invalidates approval. Forgeboard revalidates that
evidence before the cancel-default native delivery confirmation and again before Git changes the
primary checkout; AI or reviewer outcomes cannot replace the human decision.

A Git / PR node can select the same opaque completed run, inspect its exact committed impact and
credential-free remote, open that readiness UI, and prepare a normal non-force push of exactly one
branch ref. **Settings → Git & previews → Git connections** can add credential-free HTTPS/SSH or
picker-selected local Git remotes, replace a simple managed target, remove an exactly reviewed
managed remote, and select either automatic discovery or a custom `gh` executable. These ordinary
flows require no source, environment, JSON, or manifest editing.

Main captures and revalidates the one exact effective push URL, then gives Git that approved literal
directly—an absolute path for a local destination—with only its selected protocol enabled. The
delivery renderer never receives a filesystem path or the configured effective push URL. The
Settings form can send a network URL the user typed; local paths remain native-picker and
native-confirmation data only. Validated PR and CI result URLs cross the typed boundary only so the
UI can display or copy them. With an authenticated selected `gh`, explicit on-demand confirmations
also inspect the bound GitHub host and repository, require the remote head to equal the approved
source before PR creation, send the exact natively disclosed PR body through standard input, and
return only CI runs matching the full source SHA. Pull requests remain branch-following GitHub
objects, so concurrent or later branch movement can change their contents even though Forgeboard
revalidates the reviewed snapshot immediately before the request. No object ID, command, force flag,
token, or approval evidence comes from the renderer. The exact unsupported configurations and
user-owned Git/network trust boundaries are documented in
[Remote Git and GitHub delivery](docs/git/GITHUB_DELIVERY.md).

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

**Settings → Connectivity → Application updates** provides an explicit stable, prerelease, or
disabled release check. Forgeboard contacts only the fixed official GitHub Releases endpoint after
the user selects **Check for updates** and approves the exact native outbound disclosure. It never
polls in the background or downloads or installs an update automatically; opening a discovered
release page requires another native confirmation. Availability depends on releases published to
the official repository at the time of the check.

If Forgeboard cannot safely open its local database, startup offers a cancel-default native chooser
for a verified Forgeboard SQLite backup before creating the application window. The selected source
is never edited: Forgeboard copies it into private staging, verifies exact Forgeboard provenance and
SHA-256 identity, then uses a durable quarantine-and-rollback journal for installation. Newer-version
or unavailable-storage failures remain quit-only, and recovery never falls through to an empty
replacement database.

Still unfinished are broader merge and visual conflict-resolution flows and complete wiring of
every persisted setting. See
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

For Codex or Claude Code, choose **Connect with OpenAI** or **Connect with Anthropic** in first-run
setup or **Settings → Agents & runtime**. Forgeboard prepares the exact CLI action, shows a native
confirmation, then lets that provider's CLI open its official browser sign-in. The card changes to
**Connected** only after normalized CLI status evidence. **Refresh**, **Cancel sign-in**,
**Disconnect**, and **Reconnect** remain explicit UI actions. An unsaved executable override in the
expanded **Advanced** section is validated and bound to the reviewed action without being persisted;
saving Settings remains the only way to store that path. The optional model field affects later
agent launches, not OAuth. Provider account and submitted model data remain governed by the
provider's terms.

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
corepack pnpm dev:collab
corepack pnpm package
corepack pnpm smoke:packaged
corepack pnpm smoke:installer
```

`verify` includes the 2,000-line structure gate, formatting, lint, strict typechecking, unit and
integration tests, and production builds. Packaging commands do not by themselves prove that every
platform installer has been generated and installed successfully. `dev:collab` starts the optional
localhost collaboration service; its health and production deployment configuration are documented
in [Optional self-hosted collaboration](docs/COLLABORATION.md).

See [Architecture](docs/design/ARCHITECTURE.md), [Security](.github/SECURITY.md),
[Privacy](docs/policies/PRIVACY.md),
[Permission profiles](docs/PERMISSIONS.md), [Releases and signing](docs/RELEASES.md),
[Local extensions](docs/EXTENSIONS.md), [Troubleshooting](docs/support/TROUBLESHOOTING.md), and
[Contributing](.github/CONTRIBUTING.md) for design and policy details. Installer third-party licenses
and corresponding-source details are in
[Third-party notices](docs/legal/THIRD_PARTY_NOTICES.md).

## License

MIT
