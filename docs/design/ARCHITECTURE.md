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

Writable agent runs start in dedicated application-managed worktrees. A launch preview displays
executable, arguments, working directory, environment variable names, permission profile, provider,
and exact context file list. The trusted runtime records redacted allowed, denied, and failed audit
outcomes around the supervised launch; a project-check saved grant is never accepted as agent-run
approval.

Renderer drag payloads contain only a strict project ID, project-relative path, and optional source
File-node ID. They are not launch authority. A configured File-node center dropped on an unlocked
Agent links that exact existing node, while a drop elsewhere remains a normal canvas move; locked,
read-only, directory, missing, and cross-project cases fail closed. Before preparation, the renderer
synchronously stores the current effective permission profile on the Agent and requires the canvas
flush to succeed. Main reloads the persisted Agent and requires its prompt, adapter, and permission
profile to match the request before resolving its opaque context links through current
ignore/sensitive/symlink policy and building a hashed manifest. The renderer flushes again before
approval. After native approval, main reloads and fingerprints the Agent configuration and manifest
again; the runtime then rechecks current policy, canonical identity, and bytes immediately before
spawn.

The runtime opens each approved ordinary file without following symlinks, copies the exact
digest-matching bytes into a private per-run snapshot through that stable handle, verifies the
snapshot, and rebinds the actual main-owned launch arguments, initial input, and context list to the
snapshot rather than the mutable source path. The renderer and review retain only the logical paths
and hashes. Host launches use randomized private paths; Docker adds one separate read-only
`/forgeboard-context` snapshot mount while leaving the approved whole-worktree mount and its access
policy unchanged. Main retains the snapshot through the supervised session and removes it on a
terminal result or launch failure. On Windows, both Host and Docker snapshots are created below the
per-user application-data directory in separate host/managed namespaces whose names include a
domain-separated SHA-256 of the current token SID. The full SID is bound inside the root and instance
markers. The managed-worktree root still receives its structural ACL check, but it does not contain
the private Docker snapshot bytes. Before every snapshot creation and launch bind, main revalidates
the base, parent, instance, per-run directory, marker identity, snapshot-file identity, and exact
current-SID/LocalSystem private DACLs.

Snapshot crash recovery is confined to Forgeboard's dedicated marker-owned stores. Only after
Electron wins its single-instance lock does host startup inspect direct prior instance/quarantine
children, validate ownership, markers, containment, and directory identity, and atomically quarantine
an eligible instance before deletion. Recent live-PID instances are preserved; dead instances and
instances older than the bounded lease age are eligible so PID reuse cannot retain them forever.
Unknown, malformed, and symlink entries are not followed or removed, and a later startup can finish
validated quarantine cleanup interrupted by another crash. Managed-Docker-root scavenging runs
lazily on first use of that root and inspects only its dedicated store, never checkout/worktree
content. Marker reads are bounded to 4 KiB, require an ordinary single-link file, use a no-follow
handle, and require stable identity across open and read. Host-store warm-up failure is contained in
normal desktop startup: the UI and non-context surfaces open, while a later context-bearing launch
retries the same checks and fails closed until protected storage is available.

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

Primary delivery adds a separate content-bound readiness authority. From the Git review UI, the
user chooses one or more configured project checks; the renderer never supplies a command, path,
environment value, or worktree identity. Electron main resolves the managed worktree, clean source
HEAD and tree, configured checks, executable and working-directory identities, inherited
environment-value digest, and relevant private file identities into an exact readiness fingerprint.
Each check result is bound to that fingerprint. A local human can approve quality only after every
required check passes, and reviewer or AI decisions never satisfy this gate. Any source, check,
executable, environment, or evidence drift makes the approval stale. Commit delivery binds the exact
human approval into its single-use plan, revalidates it before the cancel-default native delivery
confirmation, then revalidates it again immediately before the Git engine mutates primary.

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

Forgeboard-owned Git clone, Docker image pull, normal branch push, and GitHub status/PR/CI actions
use a separate outbound boundary. Main creates an owner-bound, expiring, single-use plan over the
exact destination and impact disclosure, parents a cancel-default native dialog to the originating
window, rebuilds the disclosure after approval, and issues an opaque permit only if its SHA-256
fingerprint still matches. Permit-bound executors are the sole production construction/call site
for network-capable Git and `gh` operations. Push/PR additionally bind content-bound deterministic
check evidence and exact human approval, then revalidate source, remote, branches, evidence, and
GitHub head state immediately before execution. PR bodies travel on standard input; CI results are
filtered to the exact branch and full SHA.

Git connection configuration is a separate local-only authority. The renderer selects a saved
project and may submit a credential-free network URL, while local repository and custom `gh` paths
come only from main-owned native pickers. Main inspects exact local Git configuration, filesystem and
executable identity, creates an owner-bound expiring plan, and requires both renderer review and a
cancel-default native confirmation. Remote changes never test reachability or contact a destination.
The optional custom `gh` binding is device-local and content-bound; its reviewed `--version` probe
uses a minimal credential-free environment. Automatic discovery remains unavailable after startup or
privacy reset until either its Settings review or an explicitly confirmed GitHub status action runs
the same credential-free probe successfully. Nonzero or malformed output cannot unlock auth or API
commands. Outbound GitHub plans bind the selected source, path, SHA-256, validation state, and
identity-guarded runner again before every command. GitHub CLI changes are serialized against
delivery and invalidate only CLI-bound plans and status, preserving unrelated push plans.

## Configuration and distribution

The settings database is the canonical configuration source. Implemented desktop screens cover
agent discovery and executable pickers, custom CLI setup, permission profiles, argument-array
preview and project-check commands, worktree locations, Docker profiles, extensions, and local
storage/retention. Backup settings cover the destination picker, automatic interval, quit-time
behavior, and a per-folder retention target. The optional Git commit identity override and default
Git remote name are active; identity falls back to repository/global Git config when both UI fields
are blank. The Git connections screen inspects a selected saved project, adds credential-free
network or picker-selected local remotes, replaces simple managed targets, removes exactly disclosed
managed configuration and tracking refs, and selects automatic or custom GitHub CLI discovery.
Collaboration connection settings drive the explicit desktop join/leave boundary; its access token
remains volatile and is not persisted with those settings. Several persisted settings are not yet
connected to a complete runtime surface, including updates. Terminal process defaults and
environment allowlists are consumed by its main-owned PTY runtime and can be overridden per node in
the inspector. Direct SQLite backup restore UI remains unfinished; its presence in a schema is not
treated as implemented behavior.

First-run setup treats agent readiness as a trusted gate. Main resolves and probes only the selected
bundled, detected, overridden, or custom executable and returns strict ready/failure evidence;
missing, mismatched, invalid, or unrecognized candidates keep the renderer's **Continue** action
disabled. Readiness does not persist a draft override or mint launch authority.

The Settings renderer requires current, fingerprint-bound readiness for every configured built-in
or custom agent and every configured preview/check command. The trusted `settings:update`
transaction does not rely on that renderer state: before saving, main independently revalidates
newly changed agent executables/configurations and commands against main-admitted evidence, then
passively re-resolves the executable identity or command in its original project context. Newly
changed worktree destinations and newly enabled or changed backup destinations receive a direct
main-process `stat`/`access` preflight in the same transaction. These changed-only persistence checks
prevent a new UI or IPC draft from bypassing readiness. Startup separately handles pre-current
stored settings: after schema migration and audit initialization but before strict integrity
validation, a known legacy-only field can be normalized, disabled, or replaced with the injected
device default. The repair and immutable original/current JSON evidence are one transaction with a
redacted audit event. A current-version row is checked too, closing the crash window between schema
migration and repair; unknown corruption is never treated as legacy. Numeric drafts, loopback-only
preview hosts, bounded absolute destinations, and imported settings are parsed before persistence.
Folder preflight does not create a directory, write a probe file, start a process, or return
canonical host paths and raw filesystem error paths to the renderer. Managed-worktree readiness
rejects a symbolic-link or noncanonical alias at the selected folder or nearest existing parent.
Backup readiness instead resolves and checks the canonical target, returns only a warning rather than
the target path, and backup creation publishes and records files at that canonical destination.

On Windows, these folder checks, context storage, and backup creation share a bounded main-process
ACL authority. It invokes the absolute system PowerShell executable without a shell and passes target
paths only through environment values. The fixed script inspects the raw security descriptor to
require a DACL and detect callback or otherwise unsupported raw ACEs before projecting rules into an
exact versioned JSON report. Missing identity/inspection services, absent DACLs, unsupported ACEs,
unexpected report fields, and malformed values fail closed. Structural parents reject untrusted
write/delete/permission/ownership authority; confidential backup parents also reject untrusted
read/list/traverse; Forgeboard-created private objects require protected current-SID and LocalSystem
DACLs.

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
primary and remapped worktree bytes are checked against that digest during preparation. Immediately
before spawn, main rechecks current policy and source identity while copying through stable file
handles, then launches only the verified private snapshot bytes described above.

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
repository secrets. Earlier exact-commit ledger checkpoints record unpacked-application smoke proof
on macOS arm64, macOS Intel, Windows, and Linux, unsigned native macOS arm64 and Intel DMG generation,
installation, launch, smoke, and checksums, and a copied macOS arm64 application's bundled Git runtime
outside the repository under a minimal `PATH`. Those historical results do not prove the current
tree: fresh Windows, Linux, macOS Intel, signed/notarized native-installer, and GitHub Release evidence
remain open. Packaged applications bundle their renderer/runtime and do not require Node.js or pnpm
on the end user's machine. External agent CLIs remain optional capabilities detected and explained in
the UI.

## Persistence

SQLite is local, versioned by transactional migrations, and configured for WAL where supported.
Structured secret and authentication-token fields are excluded. Retained raw subprocess output is
not redacted and can contain any value the process prints. Run summaries are persisted and
interrupted runs recover as lost records rather than fictional live processes. Durable bounded
raw-transcript unification across every process surface remains unchecked in the implementation
ledger and is not represented as complete. Interactive Terminal history rows are path-free and
argument-redacted in SQLite, while UI-authored process configuration remains durable canvas data;
resolved canonical paths and the exact live-session overlay are main-memory only. Its private raw
JSON-lines files are bounded to 16 MiB per session, 256 MiB and 10,000 files in total, owner-routed
while live, pruned by the configured transcript-retention window at startup, and excluded from
portable JSON. Active sessions recover as `lost`, never alive. Project-check
execution records and bounded raw output are persisted locally, recover
interrupted processes as lost, transition through a validated monotonic state machine, and apply the
configured retention period only to terminal records.

The bounded settings-repair ledger keeps at most 20 device-local records with immutable rows,
full-source and repaired SHA-256 checks, strict JSON/schema validation, and redacted audit linkage.
Each source and repaired JSON value has an independent 16 MiB UTF-8 cap enforced by both the schema
and SQLite `length(CAST(... AS BLOB))`. Queries select the full value only when its byte count is in
range, so corrupt oversized settings or evidence fail with explicit recovery guidance before a large
allocation or partial evidence copy. The ledger is omitted from ordinary portable merge/replace
exports and remains available only through the Data & Privacy review and explicit evidence export.
Complete local-data deletion clears it. The persisted canvas schema deliberately remains able to
read legacy Agent nodes with more than 256 context links without truncation; ordinary UI linking and
both direct-run and workflow execution boundaries reject additions/execution above 256.

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
Windows an existing canonical destination must pass the confidential-parent ACL check. A missing
destination is created only after the nearest existing canonical parent passes the structural check,
then receives an exact protected private DACL. Every staging directory is protected before SQLite
writes, the staged database receives and revalidates an exact private file DACL, and publication uses
a hard link to that same protected inode before rechecking its path, DACL, digest, size, and identity.
Each backup is integrity-checked and recorded before older verified records in that destination are
pruned. Removal never rewrites a recorded file's ACL before canonical path, ordinary-file identity,
size, and digest match its ledger row. A cleanup failure is persisted in Backup health while the
newly verified backup remains recorded, so the selected count is a cleanup target rather than a
reason to discard a successful backup. Forgeboard does not yet provide a UI to restore one of these
SQLite backup files.

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
values, secrets, and transcripts at both client and server boundaries. The desktop joins only after
an explicit native network confirmation and keeps the access token in volatile main-process memory
for that session and its approved reconnects. Owner/editor graph writes and reviewer-safe comment
writes are role-separated and receipt-bound; viewers remain read-only.

Main atomically stores a bounded, expiring baseline, pending metadata intent, and exact candidate
for each outstanding receipt under the local project/canvas and authenticated server/room/subject
tuple. Highest-sequence acknowledgements advance the durable baseline without letting later rejected
intent disappear; row, aggregate-byte, schema, digest, and state-to-ledger projection checks fail
closed. Storage derives rejected comment IDs across intermediate ledger rows so a newer unsettled
candidate cannot mask their renderer quarantine; failed rejection persistence pauses recovery.
On reconnect or restart, a three-way merge reapplies disjoint intent, stops on same-field conflicts,
and retains rather than publishes intent after a role downgrade. Presence is ephemeral;
the renderer displays cursors, selection, activity, and a bounded idle-collaborator roster without
persisting access tokens or repository content.
