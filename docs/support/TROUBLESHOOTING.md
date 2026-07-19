# Troubleshooting Forgeboard

Start with the exact message shown in the app. Forgeboard intentionally blocks stale, ambiguous, or
unverified actions instead of showing success. The same problem-first guides are available offline in
**Settings → Help & shortcuts**.

This page never asks you to edit application source or a configuration file. Contributor diagnostics
appear at the end.

## An agent or command is missing

Symptoms include **Unavailable**, **Selected executable needs attention**, a missing-CLI message, or a
disabled Continue/Save/Review button.

1. Open **Settings → Agents & runtime** for agent CLIs, **Settings → Checks** for project checks, or
   **Settings → Git & previews** for preview commands.
2. Select **Browse** and choose the executable, or install it using the provider/runtime's official
   instructions and select **Check again**.
3. For Codex or Claude Code, use **Connect with OpenAI** or **Connect with Anthropic** and complete the
   provider CLI's browser sign-in. **Needs refresh** is not connected.
4. Review literal arguments. An argument without an executable is rejected rather than guessed.
5. Use **Deterministic test agent** to continue locally without an account or external CLI.

A readiness check inspects the selected command; it does not silently save the draft or approve a
later launch.

## A project folder moved or disappeared

Forgeboard marks the project **Missing folder** and will not redirect its saved canvas to a similar
folder automatically.

1. Choose **Locate moved repository** from the recent-project entry.
2. Select the new folder in the native chooser.
3. Review the old and new locations and any identity warnings.
4. Confirm only if it is the same project.

Cancel leaves the original record unchanged. A successful relink retains canvases, snapshots, and
run history.

## A preview reports a port collision or never becomes ready

Forgeboard allocates loopback ports from the range under **Settings → Git & previews**. A collision
means another process acquired a candidate port, or the preview command ignored the allocated port.

1. Stop stale preview nodes from the app. Do not kill an unrelated process unless you recognize it.
2. Expand or move the configured preview port range if another local tool owns it.
3. Check that the command accepts the displayed host/port arguments or placeholders and listens on
   loopback, not a different hard-coded port.
4. Verify the project-relative working directory and readiness path.
5. Read the preview logs and browser console. Fix the underlying command, then request a fresh
   reviewed start.

Forgeboard does not claim a preview is running until readiness succeeds, and failed reservations are
cleaned up rather than reused as live sessions.

## Git delivery stops on a conflict

Fast-forward delivery is available only when primary has not diverged. Cherry-pick can copy reviewed
commits onto an advanced primary, but Git may stop when both sides changed the same content.

- Forgeboard reports the conflicting paths and leaves Git's real conflict state visible. It does not
  choose a side or fabricate a completed merge.
- Open **Changes** and inspect every conflicted file. Resolve deliberately in the project editor or an
  explicitly opened external application, then stage and commit the resolution through reviewed Git
  actions.
- Choose or reset that application under **Settings → Git & previews → External application**. If a
  selected executable or macOS `.app` bundle was moved, replaced, or lost execute permission, choose
  it again. Forgeboard fingerprints the reviewed executable; for a macOS bundle it also verifies the
  bundle metadata and internal executable files, and refuses to launch an identity that changes
  after the native review. Exact executables are supported on every platform; `.app` selection uses
  macOS Launch Services without shell interpolation.
- If you do not want to continue the conflicted operation, use Git recovery outside Forgeboard only
  if you understand the repository state. Forgeboard currently has no visual abort/resolution wizard.
- Re-run delivery checks and human approval after any changed source. Earlier evidence no longer
  describes the current tree.

Squash and rebase delivery are not currently implemented. Do not treat cherry-pick as either one.

## A push or GitHub action is rejected

- **No remote:** configure a credential-free HTTPS/SSH remote or choose a local Git repository under
  **Settings → Git & previews → Git connections**.
- **Non-fast-forward:** the remote has work you do not have. Forgeboard will not force-push. Bring the
  remote changes into a new reviewed state, then prepare another normal push.
- **Expired or changed plan:** refresh the Git / PR node and prepare the action again. Plans are
  intentionally short-lived and exact-state-bound.
- **GitHub CLI unavailable or signed out:** select or install `gh`, authenticate it through GitHub,
  then refresh its status in Settings. Normal Git delivery can still use the computer's existing Git
  credentials.
- **Head mismatch:** push the exact approved commits if appropriate, then run the GitHub check again.

See [Remote Git and GitHub delivery](../git/GITHUB_DELIVERY.md) for supported transports and limits.

## The collaboration server is offline

The top bar and Connectivity settings show **Reconnecting**, **Offline**, or **Error**.

1. Continue local work and confirm the top bar returns to **Saved locally**. Solo persistence does not
   depend on the collaboration server.
2. Check the configured WebSocket/management URLs and the server health endpoint.
3. If you operate the server, verify TLS/reverse-proxy WebSocket upgrades, its persistent database,
   signing key, administrator secret, and allowed origins.
4. Wait for automatic reconnect or explicitly leave and rejoin after correcting configuration.

Forgeboard preserves bounded pending metadata intent. A same-field conflict can pause for review;
local or remote work is not silently declared the winner. See
[Optional self-hosted collaboration](../COLLABORATION.md).

## An import is malformed or rejected

Portable import accepts a bounded Forgeboard JSON export, not an arbitrary project archive.

- A malformed, oversized, structurally complex, newer-version, or schema-invalid file is rejected
  before the confirmation stage and does not partially mutate local data.
- Select the file again if it changed after review. Forgeboard binds approval to its exact bytes,
  digest, size, and summary.
- Review **merge** versus **replace**. Replace clears replace-scoped local records; it does not import
  repository files, extensions, credentials, OAuth sessions, or collaboration tokens.
- Keep the existing data until a valid import completes, and create a current backup first.

## Forgeboard cannot open its database

Startup database recovery appears before the ordinary application window and is cancel-default.

1. Do not rename, overwrite, or edit the damaged database or candidate backup.
2. Choose a known Forgeboard SQLite backup from the configured backup location.
3. Review its source identity, schema compatibility, size, and digest in the native dialog.
4. Approve recovery and allow startup to finish. The selected backup is copied into private staging,
   verified again, and installed with rollback/quarantine evidence.

Forgeboard refuses a malformed, foreign, newer-schema, changed, linked, or unsafe backup. If no
verified backup is available, cancel and preserve the files for diagnosis; startup will not silently
replace them with an empty database.

## A backup is unhealthy or missing

Open **Settings → Data & privacy** and inspect **Backup health**.

- Reconnect a removable destination and refresh before relying on it.
- Choose a new folder in the UI if the destination is unavailable or unsafe.
- On Windows, the directory must have a private ACL; on macOS/Linux it must satisfy the local private
  storage checks. Forgeboard fails closed rather than publishing a readable backup.
- If complete local-data deletion reports missing recorded backup files, cancel and reconnect their
  folders to check them. Choosing to forget missing copies means they may still exist outside
  Forgeboard and will no longer be tracked.

## A run is waiting, cancelled, lost, or will not start

- **Waiting for approval:** finish or cancel the exact review. Nothing should have started yet.
- **Cancelled:** the requested stop or denied approval was recorded; start a fresh review if needed.
- **Lost:** Forgeboard cannot prove the child process is alive or that termination completed. It does
  not present the process as running after restart.
- **Capacity reached:** stop an owned active run or wait for it to finish.
- **Stale plan:** configuration, context, worktree, owner, role, or executable evidence changed.
  Prepare and review again.

**Send “continue”** is ordinary literal input. Forgeboard currently has no portable same-process
Agent pause/continue backend. Provider-session **Resume review** is a separate, newly approved launch
available only for supported interrupted attempts.

## A save, restore, or native confirmation is cancelled

Cancel is the default for sensitive native dialogs. A cancellation should report that nothing was
started, sent, overwritten, or deleted. If the UI remains busy after cancellation, preserve the
message and follow the contributor diagnostics below; do not repeat the action blindly.

## Contributor diagnostics

From a source checkout, install the pinned dependencies and run the complete local verification:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm verify
corepack pnpm test:e2e
```

Packaging checks are separate:

```bash
corepack pnpm package
corepack pnpm smoke:packaged
corepack pnpm smoke:installer
```

`verify` includes the structure gate, formatting, lint, strict typechecking, unit and integration
tests, documentation consistency, and production builds. Installer success on one operating system
does not prove another platform.

When reporting a reproducible problem, include:

- Forgeboard version and operating system
- the visible error text and lifecycle state
- the action you reviewed and whether native confirmation was cancelled or approved
- whether the project is primary or a managed worktree, without publishing a sensitive absolute path
- the smallest safe reproduction and relevant redacted audit entries

Do not publish prompts, source, terminal transcripts, environment values, credentials, invite links,
OAuth tokens, or raw provider output. Follow the vulnerability-reporting route in the
[security policy](../../.github/SECURITY.md) for security issues.
