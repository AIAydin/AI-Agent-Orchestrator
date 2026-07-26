# Permission profiles

Artemis permission profiles are configured in **Settings → Permissions** or during first-run
setup. Agent nodes can then choose a profile from the inspector. Normal use does not require
editing source files, JSON, environment files, or adapter manifests; settings export/import is an
optional portability feature.

## Selected-agent readiness is a setup gate

The first-run agent step cannot continue until the currently selected CLI has ready evidence from
Electron main. Artemis resolves the bundled executable, detected command, UI-selected override,
or complete custom-CLI draft, then runs only that candidate's bounded version and capability probes.
An invalid custom configuration, missing executable, failed probe, adapter mismatch, or unrecognized
version keeps **Continue** disabled and shows an actionable reason. A successful result includes the
validated executable and version.

Readiness is not launch approval. Checking a draft override does not persist it, and completing setup
does not let the renderer start that executable. Task-style Agent runs still use the exact
cancel-default launch review described below. The embedded built-in worktree session uses the
main-reconstructed automatic path described under **Interactive Agent sessions**.

The Settings UI applies the same rule to every explicitly configured provider, enabled custom CLI,
preview command, and standard or custom check command. The save transaction independently enforces
new changes: agent evidence must have been admitted by main after the exact confirmed probe and is
re-hashed without another launch; command evidence must have come from a live main-frame request and
is passively recomputed with the same project context. A changed worktree destination, or a newly
enabled or changed backup destination, is checked directly by main before persistence. Imported
drafts go through this same comparison when saved. During an upgrade, known legacy-only unsafe
machine values are repaired before startup integrity validation, with unaffected fields preserved
and device-local original/repaired evidence available in Data & Privacy. Unknown corruption still
fails closed. Folder checks create or write nothing and return guidance without disclosing canonical
or raw-error paths. Managed-worktree storage rejects an alias at either the destination or nearest
existing parent. Backup storage may follow an alias only after checking the canonical target and
showing that canonicalization as a warning; backup creation then uses and records the canonical
destination.

Every task-style Agent run has a cancel-default review step. The review shows the exact top-level executable,
arguments, working directory, inherited environment-variable names, selected context, context
hashes, effective permission profile, and known limitations. Cancelling releases the prepared run
without starting the agent.

Before main prepares that review, the renderer stores the current effective permission profile on
the selected Agent and requires the exact canvas save to complete. Main reloads the persisted Agent
and rejects a request whose prompt, adapter, or permission profile does not match it. A save failure
therefore prevents preparation instead of running with transient renderer state or a fallback
profile. The renderer saves again immediately before approval; after the native confirmation, main
re-resolves the persisted configuration and context authority before launch.

## Interactive Agent sessions

The embedded **Start** and **Restart** controls use a narrower path than a task-style Agent run. For a
built-in adapter with **Write in a worktree**, one click is enough: Electron main reloads the exact
saved Agent node, provisions its dedicated worktree, independently resolves the configured
executable, model arguments, and main-created peer-tool arguments, and validates their identities
again immediately before spawning. Renderer-provided executable, arguments, working directory, and
environment names are replaced rather than trusted, so no additional native terminal dialog is
shown. Ordinary Terminal nodes, other access profiles, and custom or extension-provided adapters
retain native launch confirmation.

## Windows filesystem permission authority

Windows folder and private-file decisions do not infer confidentiality from POSIX mode bits. Main
invokes the system Windows PowerShell executable by absolute path, with no shell, a fixed encoded
script, bounded output and time, and the target path passed only through an environment value. The
authority reads the raw security descriptor to require a present DACL and to detect callback or
otherwise unsupported raw ACEs before evaluating the exact bounded projected-rule report. A missing
DACL, unsupported raw ACE, unexpected field or rule, unavailable identity/inspection service, or
malformed report fails closed.

The structural parent check rejects untrusted create, write, replace, delete, permission-change, and
ownership-change authority while permitting read-only discovery. Existing backup destinations use a
stricter confidential-parent check that also rejects untrusted read, list, and traverse access.
Artemis-created private directories and files use protected DACLs owned by the current user SID
with exactly current-SID and LocalSystem full-control rules; any later drift blocks the operation.

## Built-in profiles

### Plan / read-only

Artemis asks a supported provider to use its plan/read-only mode in the primary checkout. This
is a provider control, not an operating-system sandbox. A generic process can still have the
current desktop user's filesystem and network privileges.

### Worktree write

Artemis creates a dedicated managed Git worktree and asks the provider to confine writes to it.
Changes remain outside the primary checkout until reviewed. A working directory alone does not
prevent a host process or its descendants from accessing other locations allowed to the desktop
user.

### Docker isolated

Artemis runs a configured in-image agent as a non-root user with one assigned-worktree bind,
`--pull never`, a read-only container filesystem, dropped capabilities, no-new-privileges,
resource limits, and no host credential mounts. Network access is disabled unless explicitly
enabled in the UI.

Clicking **Review & run** invokes the selected Docker client for bounded daemon and image-metadata
preflight. It does not run the in-image agent. Artemis binds the reviewed launch to a strict
immutable `sha256:` image ID, rechecks the Docker client identity and tag binding after approval,
and then starts the exact disclosed agent command once. The separate **Check Docker** action in
Settings may run a constrained, no-network, no-host-mount `--version` readiness probe.

## Custom profile

Custom is one reusable, fully UI-configured policy with either a Host or Docker runtime.

The editor controls:

- whole-worktree read-only, whole-worktree read/write, or host-only explicit relative roots;
- ignored and sensitive worktree-content visibility;
- the selected top-level agent executable or an exact executable allowlist;
- advisory requests about development servers and tests;
- Docker network, CPU, and memory limits; and
- the always-on requirement to review changes before they reach the primary branch.

### Custom Host

Every Custom Host run receives a managed worktree. Artemis canonicalizes configured roots,
rejects traversal, symlink aliases, non-folder roots, and context outside readable roots, and binds
the selected top-level executable's identity and content immediately before launch.

Host roots, ignored/sensitive visibility, network behavior, and development-server/test choices
are disclosed policy and agent instructions. They do not create an operating-system sandbox or
technically constrain descendant processes. The approval screen repeats those limitations for
every run.

### Custom Docker

Docker can technically enforce only a whole assigned-worktree read-only or read/write bind, so
explicit subdirectory roots are unavailable. A whole-worktree bind cannot hide individual ignored
or sensitive files that are present in that worktree; both visibility choices therefore require
an explicit **Allow** before the profile can be saved. Allowing visibility does not attach any file
as agent context.

The exact in-container entrypoint is disclosed separately from the outer Docker client. The launch
uses the Custom network and resource limits shown in the approval dialog and never mounts host CLI
credentials.

## Delivery readiness is content-bound

Managed agent commits cannot be delivered to the primary checkout until the user completes the
readiness panel in Git review. The ordinary flow is entirely in the UI: select one or more
configured project checks, save the requirements, run every check, review the results, and record
human quality approval. Source edits, environment files, and hand-written manifests are not
required.

The renderer sends only stored project, run, readiness, and check identifiers. Electron main
resolves the managed worktree and exact configured commands, then binds results to the clean source
HEAD and tree, worktree ownership, check configuration, executable and working-directory
identities, inherited environment values through a private digest, and relevant file identities.
The native check-launch confirmation discloses the executable, literal argument array, working
directory, and environment-variable names without exposing values to the renderer.

Human quality approval is available only after every required check has passed for the same exact
evidence. AI or reviewer approval is intentionally insufficient. Re-running a check or changing the
source, command, executable, environment, or bound file identities makes the approval stale. A
delivery plan carries the matching human approval and is checked once before its cancel-default
native delivery confirmation and again immediately before Git changes primary or contacts a remote.
The same authority now governs both the local managed-worktree-to-primary delivery flow and the
Git / PR node's normal push and pull-request creation. GitHub status and exact-head CI are explicit
read-only actions and do not themselves satisfy delivery readiness.

## Remembered project-check approvals

Remembered approvals are deliberately limited to project checks. After reviewing a lint, typecheck,
test, build, or custom check, the native confirmation can optionally remember that exact check for
30 days. Electron main creates and later selects the grant; the renderer never supplies the approval
identity that authorizes execution.

The SHA-256 resource fingerprint binds all of the following:

- project, stored check identity, label, and check kind;
- resolved executable, literal argument array, and canonical working directory;
- inherited environment-variable names, but not their values;
- repository-root filesystem identity; and
- executable/shim identities and relevant package-script content.

The grant also carries its project and `command-execute` action scope. Any command, path, executable,
package-script, or identity drift stops the match and restores the native confirmation. The current
UI creates reusable check records only for the fixed 30-day window; it does not expose general grant
creation.

**Settings → Permissions → Scoped approvals** lists active and inactive local records and revokes an
active grant immediately. This list is live security state, not part of the unsaved Settings draft.
Saved approvals are device-local and are not a general permission-profile setting.

## Per-use actions and outbound approval

A remembered check never authorizes an agent launch, a context attachment or sensitive-file
override, a Docker pull, a Git clone, another external send, or a destructive Git action. Those
implemented operations retain their own per-use review or confirmation.

Git clone, Docker image pull, normal branch push, GitHub repository status, pull-request creation,
and exact-head CI reads pass through a main-owned outbound gate. The cancel-default native dialog
displays the exact action, transport, credential-free endpoint/resource, and action-specific impact.
For a pull request this includes the exact bounded title and body; the body is sent through standard
input and is not stored in audit metadata. The plan is bound to the originating window, expires
after a short interval, and is consumed once. After approval, Artemis rebuilds and fingerprints
the disclosure; changed destinations, source evidence, or actions fail closed. Only the gate can
mint the opaque permit accepted by the low-level outbound executors. See
[Remote Git and GitHub delivery](git/GITHUB_DELIVERY.md).

Git remote and GitHub CLI configuration use a separate local-only review path under **Settings →
Git & previews → Git connections**. A renderer plan is path-free; the native confirmation shows an
exact local repository or custom executable path when one is involved. Main rechecks project/config
revision, filesystem or executable identity, and originating-window authority immediately before a
change. Remote configuration does not contact the destination. A selected custom GitHub CLI is
version-checked with a minimal credential-free environment, while later separately confirmed
GitHub actions may use that trusted executable's existing authenticated session. A passively
detected automatic CLI remains unavailable after startup or privacy reset until Settings review or a
confirmed GitHub status action validates its exact identity with that same credential-free probe;
failed or malformed version output blocks all auth and API commands. Changing the CLI invalidates
CLI-bound delivery approvals and cache, but does not authorize or cancel an unrelated ordinary Git
push.

### Local-effect classification

Artemis maintains an exact architecture-tested inventory of mutation-capable Electron, child-
process, filesystem, SQLite, and process-signal capabilities used by desktop main. A new capability
or owner module fails the normal test suite until it is assigned one reviewed policy: audited
authority, durable internal state, reviewed runtime, journaled startup recovery, ordinary project
save, or test/packaging only. A separate architecture gate enumerates direct and indirect network
transports and keeps implemented external sends behind the owner-bound outbound permit.

Two narrow classes are not separate security approvals. **Save** in the project editor is the user's
direct instruction to replace that exact file with the text currently in the editor; main requires
canonical containment, the same ordinary-file identity, and the exact content hash originally
opened before its atomic rename. A changed file fails closed instead of being overwritten. Startup
database repair runs before a trustworthy audit database exists and creates no new user authority:
user-selected restore is cancel-default, and every primary-file replacement is preceded by a
private, fsynced, identity-bound recovery journal that is deterministically reconciled after a
crash. Once the restored database is validated, its redacted recovery audit is part of that database.

## Context is separately approved

Permission to read visible worktree content is not permission to attach it to a provider prompt.
Artemis context uses explicit File nodes and resolver-supplied manifest evidence. Each
attachment carries its own SHA-256 digest; the source file, managed-worktree copy, and approved
digest must match. The review shows the logical selected paths and hashes; randomized runtime paths
are intentionally not exposed to the renderer. Immediately before spawn, Electron main re-evaluates
ignore and sensitive-path policy, opens each approved ordinary file without following symlinks, and
copies its exact digest-bound bytes through a stable handle into a private per-run snapshot. The
actual launch arguments, initial input, and context list use those snapshot files, not the mutable
source paths.

For Docker, Artemis adds one separate read-only snapshot mount at `/forgeboard-context`; the
approved whole-worktree mount and its read/write policy do not change. Main retains the snapshot
until the supervised session reaches a terminal result and removes it on completion or launch
failure. On Windows, Host and Docker snapshots both remain under Artemis's per-user
application-data folder in separate scope-and-SHA-256(SID) namespaces; the Docker managed root is
still structurally checked, but never stores those private snapshot bytes. Root and instance markers
bind the full current SID without placing it in the folder name. Snapshot parents, instances,
per-run directories, and files are identity-checked and have their Windows DACLs revalidated when a
snapshot is created and again immediately before the launch plan is bound.

Normal startup warms and scavenges the host snapshot store only after Electron wins the
single-instance lock. If that warm-up cannot verify the boundary, the desktop opens and retries when
a context-bearing launch asks for storage; such a launch remains blocked until the checks pass. A
fresh owner scans only direct children of the dedicated, marker-validated store. Ownership markers
must be ordinary single-link files no larger than 4 KiB and are read through stable no-follow handles.
The owner atomically quarantines and removes only validated dead or over-age prior instances,
preserves recent live instances and foreign-SID entries, ignores unknown or symlink entries, and can
finish a validated quarantine left by another crash. Managed-root validation is lazy and does not
inspect project checkouts or arbitrary worktrees.

Ordinary tree/File-node drag and keyboard linking accepts only normal, non-symlink files; ignored
and sensitive files are not draggable. Directly moving a configured File-node center over an
unlocked Agent links that exact existing node, while an ordinary move elsewhere remains a move.
Read-only collaboration, locked nodes, directories, missing files, and cross-project targets fail
closed. The broader exact per-file override UI remains unchecked rather than silently weakening this
rule.

## Choosing a safe profile

- Use **Plan / read-only** for provider-supported planning against the current checkout.
- Use **Worktree write** for ordinary coding work that should remain reviewable and separate from
  the primary checkout.
- Use **Docker isolated** when a technical filesystem/network boundary is required and a suitable
  local image is available.
- Use **Custom Host** for narrower, honestly disclosed policy over a managed worktree.
- Use **Custom Docker** for a tailored whole-worktree container boundary and resource policy.

If a saved profile is unavailable for the selected agent, Artemis preserves the configured
choice, explains why it cannot run, and disables **Review & run**. It does not silently substitute
a broader or different permission profile.
