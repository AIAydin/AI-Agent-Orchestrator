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
context file list. Human approval produces a scoped audit record before the process starts.

Primary-checkout Git review accepts only a stored project ID from the renderer. Electron main
resolves that project's canonical repository, reads authoritative status/diffs, serializes index
mutations, and audits each action. Destructive hunk discard and commit use owner-bound, expiring,
single-use plans followed by a native confirmation. The Git engine rechecks HEAD and exact patch or
staged-content digests immediately before mutation; Forgeboard commits also bind the reviewed author
identity while disabling repository hooks and signing.

Project checks follow the same renderer-untrusted boundary. The renderer selects only a stored
check identity. Electron main resolves the canonical project root and configured executable,
constructs an owner-bound, short-lived, single-use plan, and discloses the exact executable,
argument array, working directory, and environment-variable names before a cancel-default native
confirmation. It revalidates settings, paths, executable identity, and recognized package-script
metadata immediately before launch, then supervises and cancels the complete process tree. The
renderer cannot provide a command, working directory, or environment value.

## Configuration and distribution

The settings database is the canonical configuration source. Implemented desktop screens cover
agent discovery and executable pickers, custom CLI setup, permission profiles, argument-array
preview and project-check commands, worktree locations, Docker profiles, extensions, and local
storage/retention. The optional Git commit identity override is active and falls back to
repository/global Git config when both UI fields are blank. Several persisted settings are not yet
connected to a complete runtime surface, including Git remote behavior, terminal, collaboration,
and updates. Backup restore and full-data import UI are also unfinished; their presence in a schema
is not treated as implemented behavior.

Docker configuration starts blank rather than guessing that a generic image contains an agent CLI.
The renderer can request a readiness check, but only the main process resolves Docker, validates the
local image, probes the exact in-image executable, and performs a native-confirmed bounded image
pull. Settings import/export uses the same validated schemas but is optional for the implemented
setup flow.

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

## Collaboration

Yjs documents contain canvas layout, non-sensitive node metadata, task state, comments, presence,
and workflow status. Schemas reject file contents, prompts, diffs, terminal output, environment
values, secrets, and transcripts at both client and server boundaries. The optional server and
privacy schemas exist, but the Forgeboard desktop collaboration client remains unfinished.
