# Privacy

Forgeboard's default solo mode is local and private. It has no Forgeboard account, telemetry,
analytics, crash upload, session recording, model proxy, or cloud dependency.

## Data Forgeboard stores locally

- repository paths and contents
- selected context and prompts
- terminal and development-server output
- Git diffs and local review comments
- agent transcripts and normalized events
- project-check status and bounded raw output
- interactive Terminal session metadata and private bounded raw PTY output
- canvas data, project settings, scoped approval records, content-bound delivery-readiness evidence,
  audit records, and local snapshots
- device-local settings-repair evidence when an upgrade replaces an unsafe legacy value, with each
  original or repaired JSON value capped at 16 MiB of UTF-8 data
- verified SQLite backups when local backups are enabled

An enabled third-party coding-agent CLI may transmit the prompt and files that the user explicitly
attaches to that CLI's provider. Forgeboard shows the receiving adapter/provider and exact attachment
list before launch. Provider processing is governed by that provider's terms.

Selected context is copied immediately before launch into a randomized, per-run private snapshot;
the provider receives those verified bytes rather than mutable source paths. On Windows, Host and
Docker snapshots stay inside Forgeboard's per-user application-data directory under separate
scope-and-SID-hash namespaces. Their markers bind the full current SID, are limited to 4 KiB, and are
read with stable no-follow handles. Exact current-SID/LocalSystem DACLs on the private directories and
files are revalidated before the launch bind. A normal startup permission failure does not prevent
the privacy and recovery UI from opening, but context-bearing launches remain blocked while the
protected store cannot be verified.

An approved project check is an ordinary, unsandboxed user process. It can read or change files and
contact external services according to operating-system permissions and the repository tooling's
configuration. Forgeboard does not upload the captured output itself. Output is unredacted, so a
check that prints an environment value or token can place that value in local history and JSON
exports.

Only project checks can currently be remembered. If the user selects **Remember only this exact
check for this project for 30 days** in the native dialog, Forgeboard keeps a device-local grant over
the exact project, command/action fingerprint, and resolved executable/package-script identity. The
renderer cannot choose which saved approval authorizes a launch. **Settings → Permissions → Scoped
approvals** lists and immediately revokes these records. Agent launches, context expansion, Docker
pulls, implemented external sends, and destructive Git actions remain per-use and do not inherit the
check grant; unfinished action surfaces remain unavailable.

The Git / PR node can perform an exact normal push and, through an optional local `gh` CLI, explicit
GitHub repository, pull-request, and exact-head CI actions. Every operation is initiated in the UI
and retains an action-specific cancel-default native confirmation. Forgeboard stores no GitHub
token, never polls CI, sends a pull-request body only through `gh` standard input, and keeps only
bounded redacted audit metadata and digests rather than that body. Git and `gh` may use credentials
already managed by the operating system, SSH agent, process environment, or `gh` authentication.
Users can choose automatic discovery or a custom GitHub CLI executable in Settings. A custom
selection stores its canonical path, file identity, SHA-256, validated version, and timestamp in the
device-local database; the renderer receives only path-free identity/status. The local `--version`
validation receives a minimal environment that excludes ambient authentication values. After
startup or privacy reset, a passively detected automatic executable remains unverified and cannot
run auth or API commands until an explicitly confirmed status action validates that exact identity
the same way. Actual separately confirmed GitHub actions may then use the selected CLI's existing
authentication. The binding is excluded from portable JSON, survives merge/replace import as
machine-specific configuration, and is removed by complete local-data deletion.

Optional collaboration sends only collaboration-safe canvas metadata to the configured self-hosted
server. It never sends repository files, file contents, diffs, prompts, terminal output, environment
values, secrets, or transcripts. The session access token is never written to settings or SQLite; it
is held only in volatile main-process memory for the active session and approved reconnect, then
cleared on leave, privacy reset, or quit. Bounded local recovery rows contain only the allowlisted
baseline, pending metadata intent, and exact delivery candidates, scoped to the project, canvas,
server, room, and subject. Per-scope row and byte caps fail closed, and the journal expires after 30
days without activity. Rejected comment IDs are derived from those existing allowlisted snapshots;
they do not add another content store. Human-authored titles and comments are not content-redacted,
so users must not paste secrets or source code into shared text fields.

The Data & Privacy screen exposes database and transcript locations, retention, connected providers,
outbound integrations, collaboration status, export/import, recovery, and deletion of
Forgeboard-managed local data. A user can choose a backup folder, automatic interval, bounded backup
cleanup target per folder, and whether changed local data is backed up on quit. A managed-worktree
folder alias is rejected; a backup alias is instead disclosed and resolved to the canonical
destination used for publication and the backup ledger. On Windows, a raw-DACL authority fails closed
if ACL inspection is unavailable or sees an absent or unsupported DACL. An existing destination must
exclude untrusted read/discovery as well as content mutation. New destinations, staging directories,
and backup files receive protected current-SID/LocalSystem DACLs before private bytes are published,
and the published hard link is rechecked. SQLite backups contain a copy of the local Forgeboard
database and should be protected accordingly. Direct restore of a SQLite backup is not yet available
in the UI.

Interactive Terminal output is unredacted and can contain secrets printed by the launched process.
The UI-authored executable, literal arguments, project-relative directory, and environment names are
stored in durable local canvas data. Forgeboard stores separate path-free, argument-redacted session
history metadata in SQLite; resolved canonical paths and the owning live-session exact overlay remain
in main-process memory. Raw output is kept in private per-session JSON-lines files under the
application transcript directory. Those files are capped at 16 MiB per session, 256 MiB and 10,000
files in total, use owner-only permissions where the platform supports them, and are not synchronized
or included in portable JSON. The configured transcript-retention window removes expired session
metadata and files at startup; complete local-data deletion removes both. A working directory limits
where a process starts, not what the operating-system user can access, and the process retains that
user's network permissions.

Portable JSON export/import covers Forgeboard settings, projects, canvases, agent runs, check
executions, snapshots, and audit history. It never embeds repository files or extension source
folders. Saved approvals, delivery-readiness records, the selected GitHub CLI binding, and
settings-repair evidence are device-local and are not included in this ordinary export. Repair
evidence can be reviewed and explicitly exported only from **Settings → Data & privacy**;
complete local-data deletion clears it, while
portable merge/replace leaves the local repair-evidence ledger intact. SQLite and IPC enforce the 16
MiB UTF-8 boundary before loading or exporting either full JSON value; an over-limit legacy setting
fails with recovery guidance and no partial evidence row. A replace import clears saved approvals
and delivery-readiness records. Import is an explicit
merge-or-replace action with a renderer disclosure and native confirmation; the selected file is
validated again before the transaction. Deletion does not remove repository/build
artifacts or separately exported portable JSON files. It does remove every
Forgeboard-recorded SQLite backup from current and previously selected backup folders after
revalidating each recorded file's identity. If a recorded file is unavailable, Forgeboard requires
a separate cancel-default native choice to either reconnect it or explicitly forget the missing
record and continue. The warning explains that a forgotten copy may still exist on a detached drive
or network location and will no longer be tracked. The **Transcript retention (days)** setting also
removes old terminal project-check histories and expired Interactive Terminal sessions. Queued or
running records first recover honestly as lost; they are never presented as resumed child processes.

## Audit retention and limits

Audit metadata is recursively redacted before local storage, then linked with SHA-256 previous/event
hashes. Forgeboard verifies the chain at startup and while validating SQLite backups. The **Audit
retention (days)** setting removes only a verified leading prefix and first writes a chained retention
checkpoint; it does not delete older rows from the middle of retained history. Portable audit export
contains the already-redacted metadata, not local chain hashes/checkpoints or a claim of an
externally verifiable signature. Imported audit events are redacted and chained again in the
receiving local database.

The desktop chain is local and unkeyed. It detects ordinary row changes, unhashed insertion,
uncheckpointed deletion, broken chain state, and missing/changed immutability triggers, but it has no
remote anchor or operating-system signing key. A privileged actor able to rewrite the entire SQLite
database can recompute a self-consistent chain. Audit redaction also does not redact separately stored
raw subprocess output, so backups and exports should still be treated as sensitive local data.
