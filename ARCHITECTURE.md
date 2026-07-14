# Forgeboard architecture

## Trust boundaries

Forgeboard uses three desktop trust zones:

1. The sandboxed React renderer displays untrusted repositories, transcripts, Markdown, diffs,
   and previews. It has no Node.js access.
2. A context-isolated preload exposes a narrow, typed API. Every message is runtime-validated.
3. The Electron main process owns SQLite, the filesystem, Git, PTYs, child processes, OS dialogs,
   and credential-vault integration.

The preview process foundation binds and probes loopback-only servers with validated commands and
bounded logs. The still-unchecked embedded-preview UI will use isolated browser views/frames with
Node disabled, a restrictive session, navigation and popup controls, and no access to the
Forgeboard preload. See `IMPLEMENTATION_CHECKLIST.md`; that surface is not claimed complete yet.

## Packages

- `@forgeboard/core` contains versioned graph schemas, workflow planning and recovery, permission
  policy, context selection, audit contracts, and persistence interfaces.
- `@forgeboard/agent-adapters` converts local CLI processes into normalized lifecycle events while
  retaining raw output.
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

## Configuration and distribution

The settings database is the canonical configuration source. All normal configuration is created and
edited through validated desktop screens: agent executable discovery/pickers, argument-array command
builders, environment-name allowlists, Git behavior, Docker profile settings, preview ports,
retention, and collaboration. The presence of a setting does not imply its unchecked runtime feature
is enabled. Advanced manifest/config import and export uses the same schemas but is never required.

GitHub Releases provide platform installers and checksums. Release CI builds on each target operating
system and enables code signing/notarization only when maintainers configure the relevant repository
secrets. The packaged app bundles its renderer/runtime and does not require Node.js or pnpm on the end
user's machine. External CLIs are optional capabilities detected and explained in the UI.

## Persistence

SQLite is local, versioned by transactional migrations, and configured for WAL where supported.
Secrets are excluded. Run summaries are persisted and interrupted runs recover as lost records rather
than fictional live processes. Durable bounded raw-transcript storage remains unchecked in the
implementation ledger and is not represented as complete.

## Collaboration

Yjs documents contain canvas layout, non-sensitive node metadata, task state, comments, presence,
and workflow status. Schemas reject file contents, prompts, diffs, terminal output, environment
values, secrets, and transcripts at both client and server boundaries.
