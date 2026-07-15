# Forgeboard architecture

## Trust boundaries

Forgeboard uses three desktop trust zones:

1. The sandboxed React renderer displays untrusted repositories, transcripts, Markdown, diffs,
   and previews. It has no Node.js access.
2. A context-isolated preload exposes a narrow, typed API. Every message is runtime-validated.
3. The Electron main process owns SQLite, the filesystem, Git, PTYs, child processes, and OS
   dialogs.

The preview runtime binds and probes loopback-only servers with validated commands and bounded
logs. Web and mobile preview nodes embed only runtime-owned loopback ports in sandboxed frames with
Node disabled, a restrictive session, validated navigation, denied popups/downloads/permissions,
and no Forgeboard preload access. Native development commands are never described as an OS sandbox.
Docker-isolated agent profiles use a separate main-owned runner with an exact worktree mount,
non-root identity, resource limits, no implicit host credentials or sockets, and network denial by
default.

## Packages

- `@forgeboard/core` contains versioned graph schemas, workflow planning and recovery, permission
  policy, context selection, audit contracts, and persistence interfaces.
- `@forgeboard/agent-adapters` converts local CLI processes into normalized lifecycle events while
  retaining raw output.
- `@forgeboard/extension-runtime` validates and snapshots data-only local adapter and canvas-node
  extensions, with content-bound permission approvals and no renderer code execution.
- `@forgeboard/git-engine` executes native Git with argument arrays, provisions per-run branches
  and worktrees, and provides diff/review/change integration primitives.
- `@forgeboard/ui` provides the visual language and accessible primitives shared by renderers.
- `@forgeboard/test-agent` is a deterministic executable that exercises the full workflow without
  a paid provider.
- `@forgeboard/collab-server` is optional. It accepts only collaboration-safe graph metadata.

## Data flow

Project files are referenced by canonical relative paths and read only after policy evaluation in
the main process. The renderer requests an operation over validated IPC; the main process resolves
the project root, checks canonical paths and permissions, performs the operation, appends a redacted
audit event, and returns serializable data.

Agent runs start in dedicated application-managed worktrees. A launch preview displays executable,
arguments, working directory, environment variable names, permission profile, provider, and exact
context file list. The trusted runtime records redacted allowed, denied, and failed audit outcomes
around the supervised launch; a project-check saved grant is never accepted as agent-run approval.

Git review accepts either a stored project ID for the primary checkout or a stored project/run ID
pair for an agent worktree. It never accepts a renderer-selected repository or worktree path.
Electron main resolves primary roots canonically; agent targets additionally require a terminal
persisted run, immutable run-to-worktree binding, active ownership record, matching branch and base,
and shared Git common directory. It then reads authoritative status/diffs, serializes mutations, and
audits each action with its target identity. Destructive hunk discard and commit use owner-bound,
expiring, single-use plans followed by a native confirmation. The Git engine rechecks HEAD and exact
patch or staged-content digests immediately before mutation; Forgeboard commits also bind the
reviewed author identity while disabling repository hooks and signing. Worktree review never writes
primary-checkout health state.

Project checks follow the same renderer-untrusted boundary. The renderer selects only a stored
check identity. Electron main resolves the canonical project root and configured executable,
constructs an owner-bound, short-lived, single-use plan, and discloses the exact executable,
argument array, working directory, and environment-variable names in a cancel-default renderer
disclosure. Without an exact active remembered grant, a cancel-default native confirmation follows.
The user may remember only the main-computed resource fingerprint for that exact project check for
30 days. Main looks up the scoped record without accepting a renderer-selected approval ID; command,
root, executable, or package-script drift fails the match. It revalidates settings, paths,
executable identity, and recognized package-script metadata immediately before launch, then
supervises and cancels the complete process tree. The renderer cannot provide a command, working
directory, environment value, or authorizing grant identity.

Forgeboard-owned Git clone and Docker image pull use a separate outbound boundary. Main creates an
owner-bound, expiring, single-use plan over the exact destination disclosure, parents a
cancel-default native dialog to the originating window, rebuilds the disclosure after approval, and
issues an opaque permit only if its SHA-256 fingerprint still matches. The low-level clone and pull
executors reject calls without that permit.

## Configuration and distribution

The settings database is the canonical configuration source. Implemented desktop screens cover
agent discovery and executable pickers, custom CLI setup, permission profiles, argument-array
preview and project-check commands, worktree locations, Docker profiles, extensions, and local
storage/retention. Backup settings cover the destination picker, automatic interval, quit-time
behavior, and a per-folder retention target. The optional Git commit identity override is active and falls
back to repository/global Git config when both UI fields are blank. Several persisted settings are
not yet connected to a complete runtime surface, including Git remote behavior, terminal,
collaboration, and updates. Direct SQLite backup restore UI remains unfinished; its presence in a
schema is not treated as implemented behavior.

First-run setup treats agent readiness as a trusted gate. Main resolves and probes only the selected
bundled, detected, overridden, or custom executable and returns strict ready/failure evidence;
missing, mismatched, invalid, or unrecognized candidates keep the renderer's **Continue** action
disabled. Readiness does not persist a draft override or mint launch authority.

Docker configuration starts blank rather than guessing that a generic image contains an agent CLI.
The renderer can request a readiness check, but only the main process resolves Docker, validates the
local image, probes the exact in-image executable, and performs a native-confirmed bounded image
pull. Settings import/export uses the same validated schemas but is optional for the implemented
setup flow.

The permission centre owns all four launch profiles. Custom Host runs always use a managed
worktree, canonical folder roots, an identity-bound top-level executable, and explicit disclosure
that host policy cannot constrain the current user or descendants. Custom Docker accepts only a
whole-worktree bind and discloses its exact network/resource policy. Docker run planning invokes an
identity-bound client only for bounded daemon/image metadata, pins actual argv to a strict immutable
image ID, and leaves the first in-image agent execution behind the exact approval gate. Selected
context carries resolver-supplied manifest evidence plus a separately enforced per-file SHA-256;
primary and remapped worktree bytes are checked against that digest during preparation and again
immediately before spawn.

Local extension manifests are author-facing packages, not ordinary user configuration. Users select
an extension folder or manifest in Settings with a native picker; the trusted process validates its
declarative content, shows the exact identity, version, two digests, and permissions in a
BrowserWindow-parented system confirmation, and stores a data-only snapshot. A trusted SQLite
ledger is staged before mutation and activated only after success; discovery exposes contributions
only when that active record exactly matches the snapshot. Window-bound pending plans, trust state,
and registry mutations never cross into renderer authority. Typed discovery views contain only
validated manifest, record, safe canvas projection, and safe-text documentation data. Forgeboard's
generic canvas renderer owns extension fields and native file/folder pickers, while namespaced agent
manifests re-enter the same launch disclosure and approval pipeline as built-in adapters.

The release workflow is configured to build platform artifacts and checksums on each target
operating system, enabling code signing/notarization only when maintainers configure the relevant
repository secrets. Unpacked packaged applications have passed smoke tests on macOS arm64, macOS
Intel, Windows, and Linux. Unsigned native macOS arm64 and Intel DMGs have also passed generation,
installation, launch, smoke, and checksum checks; full Windows/Linux installer proof and GitHub
Release publication remain open. A copied macOS arm64 application proved its bundled Git runtime
outside the repository under a minimal `PATH`. The verified packaged app bundles its
renderer/runtime and does not require Node.js or pnpm on the end user's machine. External agent CLIs
remain optional capabilities detected and explained in the UI.

## Persistence

SQLite is local, versioned by transactional migrations, and configured for WAL where supported.
Structured secret and authentication-token fields are excluded. Retained raw subprocess output is
not redacted and can contain any value the process prints. Run summaries are persisted and
interrupted runs recover as lost records rather than fictional live processes. Durable bounded
raw-transcript storage remains unchecked in the implementation ledger and is not represented as
complete. Project-check execution records and bounded raw output are persisted locally, recover
interrupted processes as lost, transition through a validated monotonic state machine, and apply the
configured retention period only to terminal records.

Scoped approval records are device-local SQLite state. The current creation path stores only exact
30-day project-check grants; list/revoke contracts are renderer-visible, while creation, exact-scope
selection, and consumption stay in Electron main. Replace import and privacy deletion clear these
grants rather than making them portable.

Desktop audit events redact metadata before appending a previous/event SHA-256 hash chain. Startup
and backup integrity checks recompute events and retention checkpoints and validate SQLite triggers
that reject event/checkpoint updates and unhashed inserts. Retention deletes only a verified prefix
after anchoring it in a chained checkpoint. This has no external signing key or remote anchor, so it
is local tamper evidence rather than protection from an actor able to rewrite the entire database.

Canvas changes use serialized revision-aware autosave. Internal project close and native
window/application close explicitly flush the latest revision before renderer teardown or storage
disposal. A failed or timed-out save keeps Forgeboard open by default and requires a separate native
choice to close without saving.

The main-owned automatic-backup coordinator observes durable local-data revisions and serializes
scheduled, manual, and quit-time SQLite backups. The UI selects a destination, an interval from 1
through 168 hours, whether to back up changed data on quit, and a retention count from 1 through 365
files. On POSIX systems Forgeboard requires a current-user-owned destination that is not writable by
group/other users, creates a `0700` staging directory, and publishes a `0600` backup file. On
Windows it validates canonical ordinary paths, inherits the selected folder's ACL,
and warns the user to choose a folder limited to their Windows account. Each backup is staged,
integrity-checked, SHA-256 verified while stable, published as an ordinary file, and recorded before
older verified records in that destination are pruned. A cleanup failure is persisted in Backup
health while the newly verified backup remains recorded, so the selected count is a cleanup target
rather than a reason to discard a successful backup. Forgeboard does not yet provide a UI to restore
one of these SQLite backup files.

Canvas recovery and portable data import use a separate main-process service. Snapshot listings
expose bounded summaries rather than complete canvas documents. A restore plan is window-owned,
expiring, single-use, and bound to both the selected snapshot digest and the current canvas digest;
the current canvas becomes another checkpoint when its content differs before the reviewed snapshot
is restored after a cancel-default native confirmation. Portable imports accept a user-selected,
bounded, ordinary JSON file, validate its versioned schema, and disclose record counts plus its
exact-byte SHA-256 digest.
After native confirmation, the file is read and validated again and its size and digest must match
before a transactional merge or replacement. Portable JSON covers settings, projects, canvases,
runs, checks, snapshots, and audit history, not repository files or extension source folders.

## Collaboration

Yjs documents contain canvas layout, non-sensitive node metadata, task state, comments, presence,
and workflow status. Schemas reject file contents, prompts, diffs, terminal output, environment
values, secrets, and transcripts at both client and server boundaries. The optional server and
privacy schemas exist, but the Forgeboard desktop collaboration client remains unfinished.
