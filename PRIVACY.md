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
- canvas data, project settings, audit records, and local snapshots
- verified SQLite backups when local backups are enabled

An enabled third-party coding-agent CLI may transmit the prompt and files that the user explicitly
attaches to that CLI's provider. Forgeboard shows the receiving adapter/provider and exact attachment
list before launch. Provider processing is governed by that provider's terms.

An approved project check is an ordinary, unsandboxed user process. It can read or change files and
contact external services according to operating-system permissions and the repository tooling's
configuration. Forgeboard does not upload the captured output itself. Output is unredacted, so a
check that prints an environment value or token can place that value in local history and JSON
exports.

Optional GitHub operations use the locally installed `gh` CLI after an impact-specific confirmation.
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
folders. Import is an explicit merge-or-replace action with a renderer disclosure and native
confirmation; the selected file is validated again before the transaction. Deletion does not remove
repository/build artifacts or separately exported portable JSON files. It does remove every
Forgeboard-recorded SQLite backup from current and previously selected backup folders after
revalidating each recorded file's identity. If a recorded file is unavailable, Forgeboard requires
a separate cancel-default native choice to either reconnect it or explicitly forget the missing
record and continue. The warning explains that a forgotten copy may still exist on a detached drive
or network location and will no longer be tracked. The **Transcript retention (days)** setting also
removes old terminal project-check histories while preserving queued or running records for recovery.
