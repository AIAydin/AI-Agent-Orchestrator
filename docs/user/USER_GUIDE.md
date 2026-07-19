# Forgeboard user guide

Forgeboard is a local-first desktop workspace for planning software work, running coding-agent CLIs,
reviewing their output, and delivering approved changes. A normal installation is configured through
the app. Source edits, environment files, and hand-written manifests are optional contributor paths,
not end-user setup requirements.

This guide describes the current product. For a problem-first index, see
[Troubleshooting](../support/TROUBLESHOOTING.md). Security-sensitive details are documented in
[Permission profiles](../PERMISSIONS.md), [Privacy](../policies/PRIVACY.md), and the
[security and threat model](../../.github/SECURITY.md).

## Install and first launch

There is not yet a published end-user release. When one is available, follow the
[installation guide](../install/README.md) and verify its checksum and `RELEASE-INFO` record. Until
then, contributors can run a source checkout with:

```bash
corepack pnpm start
```

On first launch, either select **Use safe defaults** or complete the setup wizard. Safe defaults use
the bundled deterministic test agent, require no account, and keep collaboration and update checks
inactive. The full wizard configures the default agent, permission profile, Docker option, preview
command, and managed-worktree location entirely in the UI.

## Connect an agent

Open **Settings → Agents & runtime**.

- For Codex, select **Connect with OpenAI**. For Claude Code, select **Connect with Anthropic**.
  Review the native confirmation, then complete the provider CLI's official browser sign-in.
  Forgeboard does not receive or store the OAuth token.
- For another installed CLI, use its readiness card. **Browse** can select an executable without
  editing `PATH` or a config file.
- Use **Deterministic test agent** for a local, offline workflow that exercises real launch,
  worktree, output, and review behavior without a provider account.
- Expand **Advanced** only when you need an executable override or model. Saving Settings is what
  persists an override; checking a draft does not silently save it.

The UI reports **Connected** or **Ready** only after main-process evidence succeeds. **Needs
refresh**, **Unavailable**, and failed checks do not grant launch authority.

## Open or create a project

The welcome screen supports four ordinary paths:

1. **Open a project folder** selects an existing local folder.
2. **Clone a repository** reviews the credential-free remote and destination before Git connects.
3. **Create a project** makes a new folder and can initialize Git.
4. **Explore the safe demo** creates a local practice project.

An existing non-Git folder remains usable. Select **Initialize Git** in the project rail if you want
Git tracking; a cancel-default native dialog identifies the exact folder before `.git` metadata is
created. Forgeboard does not make an initial commit or alter existing file contents.

If a saved project moves, use **Locate moved repository**, review the old and new locations, and
confirm the replacement. Its canvas, snapshots, and run records remain associated with the project.

## Build a canvas

Use the project rail to add a node or insert a first-party workflow template. The canvas supports
pan, zoom, fit, minimap navigation, multi-selection, keyboard movement, copy, paste, duplicate,
groups, comments, locking, collapse, and resize.

- Select a node to edit its inspector.
- Right-click a node, press the Context Menu key, or press **Shift+F10** for node actions.
- Open the command palette with **Ctrl/Command+K** in the Standard preset. The VS Code preset uses
  **F1** or **Ctrl/Command+Shift+P**.
- Use **Ctrl/Command+Z** and **Ctrl/Command+Shift+Z** for canvas undo and redo.
- Watch the top bar for **Saving…**, **Saved locally**, or **Save failed** before closing.

File nodes reference policy-approved project-relative files. Ignored, sensitive, linked, binary,
oversized, missing, and outside-root content fails closed. Project files can be opened in the built-in
editor; an explicit external handoff uses the operating system's registered application.

For whole-workspace handoff, open **Settings → Git & previews → External application** and choose an
exact application executable. On macOS, the chooser also accepts a normal `.app` bundle, so you do
not have to find its internal `Contents/MacOS` binary. **Use system default** resets the selection.
From **Changes**, **Open externally…** shows the exact executable or application bundle and literal
workspace in a native confirmation before anything launches. Forgeboard revalidates the reviewed
identity after approval. Executables receive the workspace as their sole argument; macOS bundles are
opened through `/usr/bin/open -a` with exact argument-array values. Neither path uses a shell.

## Run an Agent node

1. Add and select an **Agent** node.
2. Choose the installed adapter, optional supported model, permission profile, and prompt.
3. Attach context by linking an existing File node or using the context picker. Forgeboard shows the
   receiving provider and exact attached files.
4. Select **Review & run**. Review the executable, literal arguments, working directory, environment
   variable names, context manifest, permission profile, worktree, and network disclosure.
5. Approve only the exact current plan. A changed canvas, context file, executable, setting, owner,
   or expired approval requires a fresh review.

Writable agents run in an application-owned Git worktree, not the primary checkout. Live controls
are capability-dependent. **Send “continue”** sends literal input; it does not unpause a process.
**Pause process** and **Continue process** suspend and continue the exact same process tree only for
a verified host process group on macOS or Linux. The controls remain unavailable on Windows, for
Docker runs, extension-provided sessions, or whenever Forgeboard cannot verify process-group
ownership. **Resume review** is available only for a supported interrupted provider session and
always launches a newly reviewed continuation. **Retry review** starts an eligible failed attempt in
a fresh worktree.

Attempt history retains lineage, terminal status, bounded output, provider-redacted metadata, and
token or cost information only when the adapter reports it. Forgeboard does not invent missing usage
or output.

## Run terminals, previews, and checks

### Terminal

Configure the executable, one literal argument per line, project-relative working directory, and
environment variable names in the Terminal inspector. Renderer review is followed by a separate
native confirmation. A Terminal runs on the host and its working directory is not a security
sandbox. See [Interactive Terminal](../terminal/README.md).

### Web and mobile preview

Choose the primary checkout or one available managed worktree, then configure the command,
project-relative working directory, readiness path, and navigation path. A native-confirmed launch
receives an allocated loopback port. The sandboxed surface provides logs, console errors, reload,
history, viewport controls, screenshots, and a separately confirmed external open.

Comparison mode binds its two sides to distinct completed managed worktrees. It refuses duplicate or
unverified targets rather than presenting the same implementation twice.

### Project checks and Test nodes

Configure lint, typecheck, test, build, and custom commands under **Settings → Checks**. Commands are
an executable plus literal arguments; they are not shell strings. Each check has reviewed launch,
streamed raw output, best-effort parsed status, cancellation, and durable history. A Test node adds
workflow dependencies, attempt history, and verified artifact actions.

## Review and deliver changes

Open **Changes** for the primary checkout or **Review this agent's changes** for a completed managed
run.

1. Review authoritative status and diffs. Use unified or split view, line comments, and revision
   requests as needed.
2. Stage only the intended files or hunks.
3. Enter a commit message, review the exact staged snapshot and Git identity, then confirm the native
   commit dialog.
4. For a managed run, complete selected delivery checks and record the required human quality
   approval against that exact clean committed state.
5. Deliver by fast-forward when possible. When both histories advanced, create one merge commit,
   combine the reviewed range into one squash commit, rebase the managed branch onto the exact
   reviewed primary commit, or copy reviewed commits one by one with cherry-pick. Forgeboard leaves
   authentic conflict state in the affected workspace. For bounded text files, compare Git base,
   ours, and theirs, edit the merged result inline, and separately review applying and staging that
   exact content. Forgeboard offers exact reviewed Continue and Abort controls after every conflict
   is staged; binary, oversized, ignored, and sensitive files stay outside the inline editor.
6. After a fully merged, clean managed branch is reverified, use reviewed cleanup to remove its
   worktree and branch.

A Git / PR node can inspect committed impact, divergence, remote readiness, pull-request status, and
CI. Push, GitHub checks, pull-request creation, and CI reads are explicit, separately confirmed
actions. Forgeboard never force-pushes and never stores a GitHub token. See
[Remote Git and GitHub delivery](../git/GITHUB_DELIVERY.md).

## Recover and protect local data

Open **Settings → Data & privacy** to review locations, retention, backup health, audit history,
snapshots, imports, and deletion.

- **Create backup now** writes to the configured checked destination.
- Canvas snapshots can be created and restored after an exact native review.
- Portable JSON can be exported, then imported in merge or replace mode. The selected file is
  schema-, size-, and digest-checked again before mutation. Repository files, extension sources,
  credentials, and provider tokens are not embedded.
- **Delete all local data** requires the typed phrase and a second cancel-default native warning.
  Source repositories remain untouched. Recorded Forgeboard backup files are deleted when they are
  still verifiable; disconnected copies may survive outside Forgeboard.

If the primary database cannot open safely, startup remains quit-only until you select and approve a
verified Forgeboard backup. The source backup is copied and verified; it is never edited in place.

## Optional collaboration

Collaboration is off by default. Under **Settings → Connectivity**, configure the WebSocket and
management URLs, then create a room, redeem an invite, or use an already provisioned access token.
Every network boundary requires native review. Owner, editor, reviewer, and viewer roles are enforced
in the main process and on the server.

Only allowlisted canvas metadata, presence, and explicitly shared comments enter the collaboration
document. Prompts, source, file contents, diffs, terminal output, environment data, secrets, and
transcripts remain local. If the server goes offline, Forgeboard shows the reconnecting/offline state
and preserves local work; changed shared intent may pause for review instead of silently overwriting
either side. See [Optional self-hosted collaboration](../COLLABORATION.md).

## Appearance, shortcuts, and local help

**Settings → Appearance** controls light/dark/system theme, density, reduced motion, and keyboard
preset. **Settings → Help & shortcuts** contains searchable offline instructions for common workflows
and failures. It does not open websites or require a network connection.

For technical verification and contributor commands, return to the main [README](../../README.md).
