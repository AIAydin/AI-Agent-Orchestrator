# Forgeboard

Forgeboard is an open-source, local-first visual workshop for building software with locally
installed coding-agent CLIs. It combines a spatial canvas, isolated Git worktrees, streamed
agent and terminal sessions, reviewable diffs, previews, checks, and human approval gates in a
secure Electron desktop application.

> Forgeboard is under active construction. `IMPLEMENTATION_CHECKLIST.md` is the authoritative
> status ledger; unchecked items are not claimed as complete.

The release experience is download-first: finished GitHub Releases provide native installers for
macOS, Windows, and Linux. A user can install Forgeboard, open a repository, and use the deterministic
demo immediately. Normal setup is completed entirely in the UI—editing source, JSON, environment
files, or command-line configuration is never required. Configuration files remain an optional
advanced import/export mechanism.

## Local-first principles

- Solo mode requires no account, cloud service, model API key, or Forgeboard server.
- Repository contents, paths, prompts, transcripts, terminal output, and diffs stay local by
  default.
- Forgeboard launches the user's installed Codex, Claude Code, Gemini CLI, OpenCode, or custom
  CLI. Those tools may send selected context to their providers under their own terms.
- There is no telemetry, analytics, crash upload, model proxy, or automatic log collection.
- Optional collaboration syncs approved canvas metadata only, never repository files or raw
  transcripts.

## Workspace

```text
apps/
  desktop/          Electron main/preload and React renderer
  collab-server/    Optional self-hosted Hocuspocus/Yjs service
packages/
  core/             Domain models, workflow engine, security and persistence contracts
  agent-adapters/   Local coding-agent process adapters
  git-engine/       Safe Git repository/worktree/change services
  ui/               Accessible shared component system
  test-agent/       Deterministic local agent used by tests and the demo
```

## Development

Prerequisites: Node.js 22.12 or later, Git, and Corepack.

```bash
corepack enable
pnpm install
pnpm dev
```

No external credentials are required for the deterministic demo flow. Real agent CLIs and `gh`
are detected locally and remain optional.

Developers may build from source with the commands below, but end users are not expected to clone the
repository or install Node.js. The first-run wizard detects local tools and offers UI file pickers,
command builders, validation, and safe defaults for anything it cannot detect.

## Verification

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
pnpm package
pnpm smoke:packaged
```

See [Architecture](ARCHITECTURE.md), [Security](SECURITY.md), [Privacy](PRIVACY.md), and
[Contributing](CONTRIBUTING.md) for design and policy details.

## License

MIT
