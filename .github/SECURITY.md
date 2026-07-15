# Security policy and threat model

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Until a dedicated security contact
is configured, use GitHub's private vulnerability reporting for this repository. Include impact,
reproduction steps, affected versions, and any suggested mitigation.

## Security posture

Forgeboard treats repositories, files, imported canvases, terminal output, agent messages, rendered
Markdown/SVG, collaboration clients, and preview pages as untrusted. No repository instruction is
authority to execute a command or broaden permissions.

### Malicious repositories and prompt injection

Ignored and sensitive files are not attached automatically. Context is explicit and previewed before
launch. Repository text cannot approve operations or alter policy. Rich Markdown/SVG rendering is
kept disabled until its sanitizer and tests are complete.

### Terminal and agent execution

First-run setup accepts the selected agent only after main-process readiness verification of the
exact bundled, detected, overridden, or custom executable. Missing executables, invalid custom
configuration, adapter/executable mismatch, failed bounded probes, and unrecognized versions keep
the setup step blocked. Readiness evidence is not process-launch authority.

Agent launches use executable-plus-argument arrays without Forgeboard shell interpolation. Writable
agents default to isolated Git worktrees. CWD isolation is explicitly not described as a sandbox. An
optional Docker profile runs a configured in-image agent as a non-root user with one
assigned-worktree mount, resource limits, a read-only container filesystem, default seccomp, dropped
capabilities, and network disabled unless the user explicitly enables it. Forgeboard adds no host
credential stores, keychains, SSH agents, Docker socket, or extra host mounts to the container.

Docker images are never pulled automatically. Run planning uses an identity-bound Docker client to
inspect the local daemon and image metadata, declared volumes, Linux compatibility, and immutable
image ID without running the image. Pulling is a separate UI action followed by a
BrowserWindow-parented, owner-bound, expiring, single-use native outbound confirmation. The dialog
binds the exact image, registry endpoint, Docker executable, and expected in-container executable;
main rechecks the disclosure before issuing the executor-only permit. The pull uses a bounded
argument array and output/timeout limits; the explicit Settings readiness action can then use a
disposable,
no-network, no-mount `--version` probe. Immediately before an approved launch, Forgeboard rechecks
the Docker client identity and mutable tag-to-image-ID binding, then runs the exact disclosed argv
once against the approved immutable image ID with `--pull never`. A missing or broken in-image
entrypoint fails that supervised launch instead of causing an undisclosed preflight execution.

### Project checks

Lint, typecheck, test, build, and custom checks execute user-approved, potentially untrusted
repository code with the user's desktop privileges; they are quality tools, not a sandbox. A package
manager may invoke repository scripts, lifecycle hooks, or its own shell. Forgeboard directly spawns
native executables with `shell: false`; supported Windows package-manager `.cmd` shims use a
constrained, disclosed absolute `cmd.exe` wrapper. The renderer supplies only a stored check
identity. Electron main owns the configured executable, arguments, canonical working directory, and
bounded allowlist of inherited environment-variable names. Values are not stored as structured
configuration or shown in approval, but unredacted raw output can contain and persist any value the
check prints.

Every launch uses an owner-bound, expiring, single-use plan and a cancel-default renderer
disclosure. Normally it then requires a cancel-default native confirmation. The user may choose to
remember only that exact main-computed project/check fingerprint for 30 days. The durable grant is
scoped to the project and `command-execute` action; it binds the check identity/kind, command and
working directory, environment-variable names, repository-root identity, executable/shim identity,
and relevant package-script bytes. Electron main, not the renderer, selects an exact active grant.
Drift, expiry, revocation, denial, or prior single-use consumption restores the native confirmation.

Main revalidates the settings, project root, executable identity, and recognized package-script
metadata before spawning. Concurrent launch reservations are bounded. Output is retained as bounded
raw text with an explicit truncation marker. Cancellation and shutdown attempt verified full-tree
termination; termination failures are recorded as lost, and shutdown awaits finalization before
closing storage.

### Filesystem boundaries

Forgeboard-owned file selection and context paths are canonicalized, symlinks resolved, and
containment checked against approved roots immediately before access. Traversal, NUL bytes, device
paths, credential patterns, and symlink escapes are denied. Ignored and sensitive files are not
attached as context unless the exact file has the required high-friction override. A Custom profile
may separately permit its process to read matching content already visible in the assigned
worktree; this never attaches that content automatically. Custom Host visibility is disclosure-only,
while a Custom Docker whole-worktree bind technically exposes every file present in that worktree.
Approved native checks remain ordinary user processes and can access other filesystem locations or
the network according to operating-system permissions.

### Backups and recovery imports

SQLite backup creation is main-owned and accepts only the UI-selected destination. Forgeboard
requires a canonical ordinary directory, builds each backup in an isolated staging folder, rejects
links and path changes, performs a SQLite integrity check, and verifies stable size and SHA-256
content before recording success. POSIX builds require a current-user-owned destination that is not
group/other writable, use a `0700` staging directory, and publish `0600` backup files. Windows builds
inherit the chosen folder's ACL and show a warning to select a folder
available only to the user's Windows account. Automatic interval, quit-time behavior, and the
per-folder retention target are configured in the UI. Retention removes only recorded ordinary backup files whose
canonical path, identity, size, and digest still match, and it applies separately to each selected
destination. Cleanup failures remain visible in Backup health and do not invalidate the newly
created backup. A missing recorded backup is never treated as proof of deletion; complete local-data
deletion requires a separate cancel-default native choice before forgetting its record, with an
explicit warning that a detached copy may survive. Direct SQLite backup restore is not implemented
in the UI.

Canvas restore and portable JSON import never accept renderer-supplied file contents. Pending
actions are window-owned, expiring, bounded, and single-use, followed by a cancel-default native
confirmation. Snapshot restore binds the exact selected snapshot digest and current canvas digest,
rechecks both before mutation, and first preserves the displaced canvas as a new checkpoint when its
content differs. Import requires a user-selected ordinary file no larger than 16 MiB, rejects a
final-component symlink, validates the strict versioned export schema, and records an exact-byte
SHA-256 digest. Immediately
before a transactional merge or replacement, Forgeboard rereads the same stable file and requires
its file name, size, digest, and disclosed record counts to match. Portable files do not contain
repository files or extension source folders.

### Git and agent overreach

Remembered project-check approvals cannot authorize Git. The implemented clone path uses a
main-owned, short-lived, owner-bound, single-use native outbound plan over the credential-free remote
endpoint/resource and exact local destination. Main rebuilds that disclosure after confirmation,
and the low-level clone executor rejects calls without the gate-issued permit. URLs containing
credentials, query values, fragments, option-like prefixes, or unsupported transports are rejected.

Implemented commit and destructive hunk-discard mutations remain target-bound and per-use. Broader
push, pull-request, merge, cherry-pick, rebase, reset, clean, force-push, worktree-removal, and branch
deletion surfaces remain incomplete; policy requires impact-specific human approval before any of
them can become executable. Provider prompts are never auto-approved.

The review bridge accepts a stored project ID for primary review or a stored project/run ID pair for
agent-worktree review rather than a renderer-selected repository path. For agent targets, main
requires immutable persisted run metadata to match the active application-owned worktree record,
branch, base commit, agent, task, canonical repository, and Git common directory. Missing, legacy,
cross-project, nonterminal, inactive, or mismatched targets fail closed. Main creates all
content-bound Git approvals. Commit and destructive hunk-discard plans are window-owned,
target-bound, short-lived, single-use, stale-checked, and followed by a cancel-default native
confirmation. Commit author identity is fixed with literal Git arguments; inherited
author/committer environment variables, hooks, and signing cannot override the reviewed operation.

### Untrusted previews

The Electron shell denies unexpected top-level navigation, new windows, permissions, downloads, and
non-loopback renderer traffic. Preview nodes accept only runtime-owned loopback ports and validated
hosts, then render the page in a sandboxed frame without Node or Forgeboard preload access. Preview
content cannot open a system-browser URL implicitly. Native development commands are still ordinary
user processes; Docker is required for hard network/filesystem isolation.

### Local extensions

Local extensions are untrusted data. Versioned strict schemas permit only declarative canvas fields,
ports, built-in visual tokens, and existing validated CLI adapter manifests. There is no extension
entrypoint and no renderer JavaScript, HTML, SVG, CSS, preload, or Node/Electron module loading. The
trusted process canonicalizes the user-selected folder, rejects symlink and traversal escapes,
bounds resources, and requires an exact digest-bound permission confirmation in a main-owned
system dialog before install or update. It stages a trusted ledger record before mutation and
activates only after success. Discovery revalidates installed snapshots, requires an exact active
ledger match, and quarantines missing, pending, revoked, mismatched, or corrupt entries instead of
loading them. Canvas controls and local-reference pickers are Forgeboard-owned; persisted values are
bounded and revalidated. Actual CLI runs resolve active manifests again immediately before launch
and retain their separate launch disclosure and approval. See
[`docs/EXTENSIONS.md`](../docs/EXTENSIONS.md).

### Secrets

`.env*`, private keys, certificates, common credential files, OS keychains, CLI auth stores, ignored
files, and configured secret patterns are excluded from automatic context by default. SQLite has no
structured authentication-token field. Unredacted agent, preview, or check output can still contain
a secret printed by the child process. Forgeboard currently delegates authentication to local CLIs
and therefore does not request or manage their tokens; a future integration that must handle one
cannot ship until an operating-system vault is wired.

### Desktop audit integrity

Desktop audit metadata is recursively redacted before it is serialized or hashed. Each event stores
its previous hash and a domain-separated SHA-256 event hash over the redacted stored fields. Startup
and backup validation recompute the chain, compare its durable head, and require the expected SQLite
triggers. Those triggers reject event updates, checkpoint updates, and unhashed direct inserts.

Configured audit retention can delete only the verified contiguous leading prefix. Before deletion,
Forgeboard appends a hash-linked checkpoint containing the first/last pruned sequence, terminal event
hash, count, and pruning time. It stops at the first retained event even if a later imported event has
an older timestamp. Portable replace resets the prior chain before imported redacted events are
re-chained locally, and it clears device-local saved approvals. Explicit privacy deletion clears the
chain and approvals.

This mechanism is tamper-evident, not tamper-proof. Deletes cannot be universally trigger-blocked
because retention and privacy reset require them; uncheckpointed deletion is detected by the chain
head and anchors. The hashes are intentionally local and unkeyed, with no remote timestamp, signing
key, transparency service, or write-once medium. An attacker with arbitrary database-write access
can potentially rebuild events, checkpoints, state, and triggers consistently. Raw agent, preview,
terminal, and check output is outside audit-metadata redaction and may still contain secrets.

### Collaboration authorization

The optional server enforces room roles, signed expiring invites, revocation, origin limits, rate
limits, and an audit trail. Collaboration schemas cannot carry source, prompts, diffs, transcripts,
terminal output, or environment values.

### Supply chain

Dependencies and the lockfile are committed, automated updates are scoped through Dependabot, CI
runs verification on pull requests, and release signing is documented per platform. Adapter and
local-extension manifests are validated in the process layer. The Settings installation surface
uses native selection, owner-bound expiring plans, validated IPC responses, digest-bound approval,
and audited mutations; it never loads extension code into the renderer.

## Supported versions

Forgeboard has no published release yet. After publication, security fixes will target the latest
released pre-1.0 version.
