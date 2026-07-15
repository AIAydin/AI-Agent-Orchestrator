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
outbound integrations, collaboration status, export, and deletion of Forgeboard-managed local data.
Deletion does not remove repository/build artifacts or separately exported files. The **Transcript
retention (days)** setting also removes old terminal project-check histories while preserving queued
or running records for recovery.
