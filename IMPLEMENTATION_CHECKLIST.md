# Forgeboard implementation checklist

This file is the authoritative completion ledger for the build goal. A checked item means the
behavior exists in current source and has direct verification evidence. Required unchecked items may
not be reclassified as future work.

## Foundation and repository

- [x] Initialize an isolated Git repository in the requested empty workspace.
- [x] Create the required strict TypeScript `pnpm` monorepo layout.
- [x] Centralize the temporary product name and identity in `@forgeboard/core`.
- [x] Add MIT license and initial architecture, security, privacy, and contribution documents.
- [x] Pin all production/development dependencies and commit a verified lockfile.
- [x] Enforce the 2,000-line hard ceiling and keep source, tests, styles, scripts, services, and UI
      organized into coherent feature/domain modules well below that limit.
- [x] Add Dependabot and complete GitHub Actions verification/build workflows.
- [x] Document a one-command fresh-clone install and prove it in a clean checkout.
- [ ] Publish GitHub Release installers/artifacts so a user can download, install, and enter solo
      mode without cloning the repository, installing developer tools, or editing code/config files.
- [ ] Make every required setup and runtime option configurable in the UI; text manifests, env files,
      and config-file import/export remain optional advanced paths only.

## Core models, persistence, and recovery

- [x] Versioned schemas for projects, canvases, all node types, typed edges, groups, and view state.
- [x] Task, acceptance-criteria, session, run, event, transcript, worktree, check, snapshot, settings,
      audit, and collaboration records.
- [x] Deterministic DAG planning, dependency ordering, concurrency/resource limits, cancellation,
      approvals, and bounded review/revision loops.
- [x] SQLite migrations/repositories with transactions, WAL, retention, integrity checks, backups,
      JSON import/export, and interrupted-run recovery.
- [ ] Persistent undo/redo checkpoints, autosave, recoverable snapshots, and moved-project recovery.

## Security, permissions, and privacy

- [x] Canonical path/root policy, traversal/symlink escape protection, ignore evaluation, sensitive
      denylist, redaction, and high-friction per-file override.
- [x] Explicit context manifest showing receiving agent/provider and exact attached files.
- [ ] Permission profiles: Plan/read-only, Worktree write, Docker isolated, and Custom.
- [ ] Scoped/revocable approvals and impact-specific confirmations for external/destructive actions.
- [ ] Append-only redacted audit log for all required security and outbound events.
- [x] Renderer isolation, narrow validated IPC, strict CSP, and navigation/window/download controls.
- [ ] Sandboxed preview surface and sanitized Markdown, Mermaid, SVG, and imports.
- [x] Data & Privacy screen with locations, integrations, retention, export, and deletion.
- [ ] No telemetry or Forgeboard-owned outbound requests in default solo mode, proven by tests.

## Agent adapters and execution

- [x] Stable validated adapter/manifest API with detection, capabilities, launch, input, streaming,
      interrupt, terminate, supported resume, permissions, context, cwd, and result metadata.
- [x] Honest Codex CLI adapter and capability/version detection.
- [x] Honest Claude Code adapter and capability/version detection.
- [x] Honest Gemini CLI adapter and capability/version detection.
- [x] Honest OpenCode adapter and capability/version detection.
- [x] Generic custom CLI adapter with validated local manifests.
- [x] Deterministic fake-agent executable and full demo repository.
- [x] Launch disclosure for executable, args, cwd, environment names, permissions, and context.
- [x] Interactive ANSI-preserving PTY streams, input, permission prompts, interruption, and recovery.
- [x] Constrained non-root Docker runner with optional network denial and no implicit credentials.

## Git and change management

- [ ] Repository open/clone/create/init, health scan, recent list, and missing-path recovery.
- [x] Collision-safe per-writable-run branches/worktrees outside the checkout with ownership records.
- [ ] Dirty-primary protection and worktree branch/ahead/behind/dirty UI.
- [ ] Diff parsing, file navigation, unified/split views, whitespace controls, line comments, and stats.
- [x] Predictable accept/reject individual hunks while preserving unselected changes.
- [ ] Commit, compare agents/base, rename, archive, external editor, and safe cleanup.
- [ ] Merge, squash, rebase, cherry-pick, and visual conflict resolution with explicit approvals.
- [ ] Optional `gh` auth/repository/PR/CI integration with push and PR impact confirmation.

## Desktop shell and onboarding

- [x] Secure Electron main/preload/renderer production shell and signed-build documentation.
- [x] Welcome actions: open local, clone, create empty, and recent project.
- [x] Setup wizard for default agent, permission profile, Docker, development-preview command, and
      Git worktree defaults.
- [ ] Zero-code first run: sensible defaults, UI executable pickers/detection, UI command builders,
      UI permission/environment controls, and actionable missing-dependency guidance.
- [x] Repository health scan and installed CLI/version detection.
- [x] Responsive top command bar, left project rail, canvas, right inspector, and activity drawer.
- [x] Light/dark/system themes, density/motion controls, contrast, focus, labels, and reduced motion.
- [ ] Guided first-run tour, searchable local documentation, shortcuts, privacy, and troubleshooting.
- [ ] Command palette, notifications, contextual menus, tooltips, and robust empty/error/loading states.

## Infinite canvas and nodes

- [ ] Pan/zoom, minimap, search, fit, box/multi-select, snap/guides, groups/frames, locking,
      comments, copy/paste/duplicate, autosave, and keyboard navigation.
- [ ] Extensible registry and shared title/color/icon/resize/collapse/lock/duplicate/delete/group/comment/
      status/run-history/inspector behavior.
- [ ] Agent node.
- [ ] Product brief node with Markdown, checklists, attachments, criteria, versions, and variables.
- [ ] Task node with priority, assignee, dependencies, criteria, files, status, and execution.
- [ ] Live Monaco file node with history, dirty state, reveal, and context drag.
- [ ] Diff/review node with hunk decisions, comments, revision requests, and approval gate.
- [ ] Interactive terminal node.
- [ ] Isolated web preview node with logs/console/errors/navigation/viewports/screenshots.
- [ ] Mobile preview node with device frames, rotation, touch, and side-by-side screens.
- [ ] Test node with cancel, streaming, parsed summary, history, and artifacts.
- [ ] Review gate node with human/deterministic/agent checks and bounded retries.
- [ ] Git/PR node with commits, divergence, remote, readiness, CI, and approved actions.
- [ ] Mermaid diagram node with synchronized source/render/export.
- [ ] Excalidraw-compatible whiteboard/mockup node with annotations/export/context.
- [ ] Note/image node with safe local references.
- [ ] Group/frame node with real containment behavior.
- [ ] Recoverable missing-local-reference warnings.

## Typed workflows

- [ ] Context, Execute, Output, Review, Revision, and Dependency edges have tested semantics.
- [x] Cycle validation and explicit bounded loop configuration with escape hatch.
- [ ] Run node/selection/group/workflow controls and all lifecycle states on nodes and edges.
- [x] Persistent run recovery never presents dead child processes as alive.
- [ ] Human and deterministic quality gates govern merge/push regardless of AI-review outcome.

## Editors, previews, tests, and feedback

- [ ] Ignore-aware tree, quick open, tabs, breadcrumbs, search, diagnostics, save/revert, and external
      editor handoff with write protection outside the selected root.
- [ ] Rich Markdown, Mermaid, and Excalidraw editing.
- [x] Safe argument-array command configuration and common package script detection.
- [x] Port allocation, readiness, multiple worktree dev servers, logs, cleanup, and collisions.
- [ ] Side-by-side desktop/tablet/phone previews bound to competing worktrees.
- [ ] Lint/typecheck/test/build/custom checks with raw output and best-effort parsing.
- [ ] Review gates enforce selected passing commands before merge/push.

## Optional multiplayer

- [x] Optional Hocuspocus/Yjs server; solo mode has no server dependency.
- [ ] Offline/reconnect, shared graph, cursors, selection, presence, comments, and avatars.
- [x] Owner/editor/reviewer/viewer authorization.
- [x] Signed expiring invites, revocation, room authorization, rate limits, TLS, and audit trail.
- [x] Schema/test proof that source, file contents, diffs, prompts, terminals, env, secrets, and
      transcripts never enter collaboration documents.
- [x] Metadata-only state when a collaborator cannot resolve an authorized local file.
- [x] Dockerfile, local server, deployment, health, persistence, backups, and two-client tests.

## Settings, extensions, and polish

- [ ] All appearance, agent, Git, terminal, preview, Docker, storage, collaboration, and update
      settings listed in the build goal.
- [ ] Every ordinary setting and integration can be configured, validated, tested, reset, exported,
      and imported through the UI without editing a file.
- [ ] Documented validated extension API for local agent adapters and canvas node types, with
      explicit install/permissions and no renderer execution.
- [ ] Drag/drop from tree/templates and node-to-agent context linking.
- [ ] Templates: single agent, parallel implementations, implement/review loop, bug investigation,
      and multi-screen product build.
- [ ] Notifications, autosave/offline indicators, provider disclosure, and branch/worktree badges.

## Automated verification

- [x] Required graph/workflow/recovery unit tests.
- [x] Required path/ignore/sensitive/symlink/redaction unit tests.
- [x] Required IPC/adapter-manifest/Git/persistence unit tests.
- [x] Two fake agents in parallel worktrees integration flow through diff acceptance/merge/cleanup.
- [ ] Interrupt/fail/retry/restart restoration integration test.
- [ ] Two-worktree preview integration test.
- [ ] Test/review gate and bounded revision integration tests.
- [ ] Sensitive-context and zero-Forgeboard-outbound integration tests.
- [x] Collaboration allowlist/two-client privacy integration tests.
- [ ] Complete onboarding-to-merge Electron E2E flow.
- [ ] Keyboard-only, themes/reduced-motion, permissions/cancel, and multiplayer E2E flows.
- [ ] Failure E2E coverage for missing CLI, moved repo, collision, conflict, offline server, malformed
      import, and database recovery.
- [x] Lint, formatting, typecheck, unit, integration, and E2E suites pass.
- [x] Production build succeeds.
- [ ] Native installers are generated and install successfully on macOS, Windows, and Linux.
- [ ] GitHub Release workflow produces installable macOS, Windows, and Linux artifacts with
      checksums; signing/notarization activates when repository secrets are configured and otherwise
      produces clearly identified unsigned development artifacts.
- [x] Packaged desktop smoke test passes.
- [ ] No required TODOs, placeholders, fake success states, dead controls, or known critical/high
      vulnerabilities remain.

## Final documentation and audit

- [ ] Complete README commands and user documentation.
- [ ] Complete architecture, security/threat model, privacy, adapter/extension, collaboration,
      signing, and troubleshooting documentation.
- [ ] Audit every definition-of-done item against authoritative current-state evidence.
- [ ] Prepare final handoff with feature summary, directory map, exact commands, test counts,
      security/privacy disclosure, optional external setup, and only genuinely non-blocking ideas.

## Verification ledger

The following evidence applies to the current source checkpoint. Broad checklist entries remain
unchecked when only a subset of their required behavior has proof.

- 2026-07-14: a fresh temporary clone at exact commit `08f4dd2bd23c461f1783d6a711aee68d992e5265`
  completed `corepack pnpm install --frozen-lockfile` and `corepack pnpm verify` without modifying
  the checkout: 237 files passed the structure gate, 242 unit tests across 44 files and 36
  integration tests across 6 files passed, and formatting, lint, strict typecheck, and every
  production build succeeded.
- 2026-07-14: the structure gate scanned 257 hand-written source, test, style, script, workflow, and
  configuration files and confirmed that each remains at or below 2,000 lines.
- 2026-07-14: formatting, lint, strict typecheck, 256 unit tests across 47 files, 44 integration
  tests across 7 files, and all workspace production builds passed through `corepack pnpm verify`.
- 2026-07-14: 9 release-tool tests passed, including release tag/version binding, exact bundled-Git
  metadata validation, top-level artifact checksums, and the cross-platform source bootstrap.
- 2026-07-14: all 4 Electron Playwright E2E tests passed: agent run,
  first-run/settings/privacy, authoritative primary-checkout Git review, and preview.
- 2026-07-14: primary-checkout Git review proved authoritative status/diffs, whole-file and hunk
  stage/unstage, exact commit identity, owner-bound single-use stale-checked plans, cancel-default
  native commit/discard confirmation, and exact-hunk discard. The Electron flow configured identity
  entirely in the UI, reviewed a real file, staged/unstaged it, and stopped before native commit
  approval while asserting zero external requests. Agent-worktree targeting and broader compare,
  merge, push, PR, comments, split-diff, and conflict-resolution work remain unchecked.
- 2026-07-14: GitHub Actions Verify run
  [29373978889](https://github.com/AIAydin/AI-Agent-Orchestrator/actions/runs/29373978889)
  passed at exact commit `64ff3905fb08ce6f5346fa88191abc0bdf8acdaf`: verification, the
  collaboration container build, Electron E2E on macOS 15, Ubuntu 22.04, and Windows 2022, and
  unpacked packaged smoke tests on macOS arm64, macOS Intel, Ubuntu, and Windows all succeeded.
  This does not prove native installer generation/installation or GitHub Release publication.
- 2026-07-14: a copied unpacked macOS arm64 application outside the repository passed
  `--smoke-test` with bundled Git 2.53.0 under `PATH=/usr/bin:/bin`, proving that this packaged
  runtime did not fall back to repository files or a user-installed Git.
- 2026-07-14: packaged resources include the project license, third-party notices, Dugite license,
  Git copying terms, and the bundled Git runtime.
- 2026-07-14: `corepack pnpm audit --prod --audit-level high` reported no known production
  dependency vulnerabilities.
