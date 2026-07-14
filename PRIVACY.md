# Privacy

Forgeboard's default solo mode is local and private. It has no Forgeboard account, telemetry,
analytics, crash upload, session recording, model proxy, or cloud dependency.

## Data that stays on the device

- repository paths and contents
- selected context and prompts
- terminal and development-server output
- Git diffs and local review comments
- agent transcripts and normalized events
- canvas data, project settings, audit records, and local snapshots

An enabled third-party coding-agent CLI may transmit the prompt and files that the user explicitly
attaches to that CLI's provider. Forgeboard shows the receiving adapter/provider and exact attachment
list before launch. Provider processing is governed by that provider's terms.

Optional GitHub operations use the locally installed `gh` CLI after an impact-specific confirmation.
Optional collaboration sends only collaboration-safe canvas metadata to the configured self-hosted
server. It never sends repository files, file contents, diffs, prompts, terminal output, environment
values, secrets, or transcripts.

The Data & Privacy screen exposes database and transcript locations, retention, connected providers,
outbound integrations, collaboration status, export, and complete deletion.
