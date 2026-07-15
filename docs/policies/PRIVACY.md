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
- canvas data, project settings, scoped approval records, audit records, and local snapshots
- verified SQLite backups when local backups are enabled

An enabled third-party coding-agent CLI may transmit the prompt and files that the user explicitly
attaches to that CLI's provider. Forgeboard shows the receiving adapter/provider and exact attachment
list before launch. Provider processing is governed by that provider's terms.

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

Direct GitHub operations remain incomplete. Forgeboard may detect a local `gh` CLI, but it does not
claim that as an active push or pull-request surface; any future operation must retain an
impact-specific confirmation.

Optional collaboration sends only collaboration-safe canvas metadata to the configured self-hosted
server. It never sends repository files, file contents, diffs, prompts, terminal output, environment
values, secrets, or transcripts.

The Data & Privacy screen exposes database and transcript locations, retention, connected providers,
outbound integrations, collaboration status, export/import, recovery, and deletion of
Forgeboard-managed local data. A user can choose a backup folder, automatic interval, bounded backup
cleanup target per folder, and whether changed local data is backed up on quit. SQLite backups contain a copy of the
local Forgeboard database and should be protected accordingly. Direct restore of a SQLite backup is
not yet available in the UI.

Portable JSON export/import covers Forgeboard settings, projects, canvases, agent runs, check
executions, snapshots, and audit history. It never embeds repository files or extension source
folders. Saved approvals are device-local and are not exported; a replace import clears them. Import
is an explicit merge-or-replace action with a renderer disclosure and native confirmation; the
selected file is validated again before the transaction. Deletion does not remove repository/build
artifacts or separately exported portable JSON files. It does remove every
Forgeboard-recorded SQLite backup from current and previously selected backup folders after
revalidating each recorded file's identity. If a recorded file is unavailable, Forgeboard requires
a separate cancel-default native choice to either reconnect it or explicitly forget the missing
record and continue. The warning explains that a forgotten copy may still exist on a detached drive
or network location and will no longer be tracked. The **Transcript retention (days)** setting also
removes old terminal project-check histories while preserving queued or running records for recovery.

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
