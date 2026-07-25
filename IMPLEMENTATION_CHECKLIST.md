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
- [x] Make every required setup and runtime option configurable in the UI; text manifests, env files,
      and config-file import/export remain optional advanced paths only.

## Core models, persistence, and recovery

- [x] Versioned schemas for projects, canvases, all node types, typed edges, groups, and view state.
- [x] Task, acceptance-criteria, session, run, event, transcript, worktree, check, snapshot, settings,
      audit, and collaboration records.
- [x] Deterministic DAG planning, dependency ordering, concurrency/resource limits, cancellation,
      approvals, and bounded review/revision loops.
- [x] SQLite migrations/repositories with transactions, WAL, retention, integrity checks, backups,
      JSON import/export, and interrupted-run recovery.
- [x] UI-configured manual, scheduled, and changed-data-on-quit SQLite backups with per-folder
      retention targets and persisted health; owner-bound canvas snapshot recovery; and reviewed,
      transactional portable JSON merge/replace import.
- [x] Persistent undo/redo checkpoints, autosave, recoverable snapshots, and moved-project recovery.

## Security, permissions, and privacy

- [x] Canonical path/root policy, traversal/symlink escape protection, ignore evaluation, sensitive
      denylist, redaction, and high-friction per-file override.
- [x] Explicit context manifest showing receiving agent/provider and exact attached files.
- [x] Permission profiles: Plan/read-only, Worktree write, Docker isolated, and Custom.
- [x] Scoped/revocable approvals and impact-specific confirmations for external/destructive actions.
- [x] Append-only redacted audit log for all required security and outbound events.
- [x] Renderer isolation, narrow validated IPC, strict CSP, and navigation/window/download controls.
- [x] Sandboxed preview surface and sanitized Markdown, Mermaid, SVG, and imports.
- [x] Data & Privacy screen with locations, integrations, retention, backup configuration/health,
      portable export/import, canvas recovery, and deletion.
- [x] No telemetry or Forgeboard-owned outbound requests in default solo mode, proven by tests.

## Agent adapters and execution

- [x] Stable validated adapter/manifest API with detection, capabilities, launch, input, streaming,
      interrupt, terminate, supported resume, permissions, context, cwd, and result metadata.
- [x] Honest Codex CLI adapter and capability/version detection.
- [x] Honest Claude Code adapter and capability/version detection.
- [x] Honest Gemini CLI adapter and capability/version detection.
- [x] Honest OpenCode adapter and capability/version detection.
- [x] Generic custom CLI adapter with validated local manifests.
- [x] Launch disclosure for executable, args, cwd, environment names, permissions, and context.
- [x] Interactive ANSI-preserving PTY streams, input, permission prompts, interruption, and recovery.
- [x] Constrained non-root Docker runner with optional network denial and no implicit credentials.

## Git and change management

- [x] Repository open/clone/create/init, health scan, recent list, and missing-path recovery.
- [x] Collision-safe per-writable-run branches/worktrees outside the checkout with ownership records.
- [x] Dirty-primary protection and worktree branch/ahead/behind/dirty UI.
- [x] Diff parsing, file navigation, unified/split views, whitespace controls, line comments, and stats.
- [x] Predictable accept/reject individual hunks while preserving unselected changes.
- [x] Commit, compare agents/base, rename, archive, external editor, and safe cleanup.
- [x] Merge, squash, rebase, cherry-pick, and visual conflict resolution with explicit approvals.
- [x] Optional `gh` auth/repository/PR/CI integration with push and PR impact confirmation.

## Desktop shell and onboarding

- [x] Secure Electron main/preload/renderer production shell and signed-build documentation.
- [x] Welcome actions: open local, clone, create empty, and recent project.
- [x] Setup wizard for default agent, permission profile, Docker, development-preview command, and
      Git worktree defaults.
- [x] Zero-code first run: sensible defaults, UI executable pickers/detection, UI command builders,
      UI permission/environment controls, and actionable missing-dependency guidance.
- [x] Repository health scan and installed CLI/version detection.
- [x] Responsive top command bar, left project rail, canvas, right inspector, and activity drawer.
- [x] Light/dark/system themes, density/motion controls, contrast, focus, labels, and reduced motion.
- [x] Guided first-run tour, searchable local documentation, shortcuts, privacy, and troubleshooting.
- [x] Command palette, notifications, contextual menus, tooltips, and robust empty/error/loading states.
- [x] Opt-in local voice commands with UI-managed model install/removal, main-window audio-only
      permission, bounded non-persistent recording, offline transcription, deterministic registered
      action matching, and confirmation for workflow/project actions.

## Infinite canvas and nodes

- [x] Pan/zoom, minimap, search, fit, box/multi-select, snap/guides, groups/frames, locking,
      comments, copy/paste/duplicate, autosave, and keyboard navigation.
- [x] Extensible registry and shared title/color/icon/resize/collapse/lock/duplicate/delete/group/comment/
      status/run-history/inspector behavior.
- [x] Agent node.
- [x] Product brief node with Markdown, checklists, attachments, criteria, versions, and variables.
- [x] Task node with priority, assignee, dependencies, criteria, files, status, and execution.
- [x] Live Monaco file node with history, dirty state, reveal, and context drag.
- [x] Diff/review node with hunk decisions, comments, revision requests, and approval gate.
- [x] Interactive terminal node with UI-only literal process configuration, two-step native-reviewed
      PTY launch, ANSI/raw input/resize, bounded private replay/history, and honest
      interrupt/terminate/lost recovery.
- [x] Isolated web preview node with logs/console/errors/navigation/viewports/screenshots.
- [x] Mobile preview node with device frames, rotation, touch, and side-by-side screens.
- [x] Test node with cancel, streaming, parsed summary, history, and artifacts.
- [x] Review gate node with human/deterministic/agent checks and bounded retries.
- [x] Git/PR node with commits, divergence, remote, readiness, CI, and approved actions.
- [x] Mermaid diagram node with synchronized source/render/export.
- [x] Excalidraw-compatible whiteboard/mockup node with annotations/export/context.
- [x] Note/image node with safe local references.
- [x] Group/frame node with real containment behavior.
- [x] Recoverable missing-local-reference warnings.

## Typed workflows

- [x] Context, Execute, Output, Review, Revision, and Dependency edges have tested semantics.
- [x] Cycle validation and explicit bounded loop configuration with escape hatch.
- [x] Run node/selection/group/workflow controls and all lifecycle states on nodes and edges.
- [x] Persistent run recovery never presents dead child processes as alive.
- [x] Human and deterministic quality gates govern merge/push regardless of AI-review outcome.

## Editors, previews, tests, and feedback

- [x] Ignore-aware tree, quick open, tabs, breadcrumbs, search, diagnostics, save/revert, and external
      editor handoff with write protection outside the selected root.
- [x] Rich Markdown, Mermaid, and Excalidraw editing.
- [x] Safe argument-array command configuration and common package script detection.
- [x] Port allocation, readiness, multiple worktree dev servers, logs, cleanup, and collisions.
- [x] Side-by-side desktop/tablet/phone previews bound to competing worktrees.
- [x] Lint/typecheck/test/build/custom checks with raw output and best-effort parsing.
- [x] Review gates enforce selected passing commands before merge/push.

## Optional multiplayer

- [x] Optional Hocuspocus/Yjs server; solo mode has no server dependency.
- [x] Offline/reconnect, shared graph, cursors, selection, presence, comments, and avatars.
- [x] Owner/editor/reviewer/viewer authorization.
- [x] Signed expiring invites, revocation, room authorization, rate limits, TLS, and audit trail.
- [x] UI invite redemption plus owner-only creation, paginated durable token-free history,
      restart-safe revocation, and native clipboard copy only for current-session links, without
      exposing raw invite links or access tokens to the renderer.
- [x] UI room creation, owner recovery/renewal, paginated membership administration, and room audit
      access with volatile administrator input, main-only owner credentials, native reviews,
      idempotency, and version conflicts.
- [x] Schema/test proof that source, file contents, diffs, prompts, terminals, env, secrets, and
      transcripts never enter collaboration documents.
- [x] Metadata-only state when a collaborator cannot resolve an authorized local file.
- [x] Dockerfile, local server, deployment, health, persistence, backups, and two-client tests.

## Settings, extensions, and polish

- [x] All appearance, agent, Git, terminal, preview, Docker, storage, collaboration, and update
      settings listed in the build goal.
- [x] Every ordinary setting and integration can be configured, validated, tested, and reset through
      the UI without editing a file; portable non-secret settings can be exported/imported, while
      secret-, device-, and project-bound authority follows the manifest's safe reconnect/reset and
      never-export policy.
- [x] Documented validated extension API for local agent adapters and canvas node types, with
      explicit install/permissions and no renderer execution.
- [x] Drag/drop from the project tree and node-to-agent context linking.
- [x] Notifications, autosave/offline indicators, provider disclosure, and branch/worktree badges.

## Automated verification

- [x] Required graph/workflow/recovery unit tests.
- [x] Required path/ignore/sensitive/symlink/redaction unit tests.
- [x] Required IPC/adapter-manifest/Git/persistence unit tests.
- [x] Interrupt/fail/retry/restart restoration integration test.
- [x] Two-worktree preview integration test.
- [x] Test/review gate and bounded revision integration tests.
- [x] Sensitive-context and zero-Forgeboard-outbound integration tests.
- [x] Collaboration allowlist/two-client privacy integration tests.
- [x] Complete onboarding-to-merge Electron E2E flow.
- [x] Keyboard-only, themes/reduced-motion, permissions/cancel, and multiplayer E2E flows.
- [x] Failure E2E coverage for missing CLI, moved repo, collision, conflict, offline server, malformed
      import, and database recovery.
- [x] Lint, formatting, typecheck, unit, integration, and E2E suites pass.
- [x] Production build succeeds.
- [ ] Native installers are generated and install successfully on macOS, Windows, and Linux.
- [ ] GitHub Release workflow produces installable macOS, Windows, and Linux artifacts with
      checksums; signing/notarization activates when repository secrets are configured and otherwise
      produces clearly identified unsigned development artifacts.
- [x] Packaged desktop smoke test passes.
- [x] No required TODOs, placeholders, fake success states, dead controls, or known critical/high
      vulnerabilities remain.

## Final documentation and audit

- [x] Complete README commands and user documentation.
- [x] Complete architecture, security/threat model, privacy, adapter/extension, collaboration,
      signing, and troubleshooting documentation.
- [x] Audit every definition-of-done item against authoritative current-state evidence in
      `docs/audits/DEFINITION_OF_DONE.md`.
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
  approval while asserting zero external requests. At that checkpoint, agent-worktree targeting
  and broader compare, merge, push, PR, comments, split-diff, and conflict-resolution work remained
  unchecked.
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
- 2026-07-14: manual Release installers run
  [29376937527](https://github.com/AIAydin/AI-Agent-Orchestrator/actions/runs/29376937527)
  generated unsigned native macOS arm64 and Intel DMGs; both jobs passed verification, Electron E2E,
  packaging, packaged smoke, native installation/launch smoke, checksums, and artifact upload. The
  Windows job exposed test portability failures and the Ubuntu job exposed a DEB path issue; those
  fixes landed in `4623472ea64d344b2477f944f49e5013af7570dd`. Follow-up Verify run
  [29377515034](https://github.com/AIAydin/AI-Agent-Orchestrator/actions/runs/29377515034)
  and Release run
  [29377517055](https://github.com/AIAydin/AI-Agent-Orchestrator/actions/runs/29377517055)
  could not start any runner because GitHub reported failed account payments or a spending-limit
  restriction. Windows/Linux native-installer proof and GitHub Release publication therefore remain
  unchecked.
- 2026-07-15: `corepack pnpm verify` passed: the structure gate kept all 286 checked files at or
  below 2,000 lines; formatting, lint, strict typecheck, 301 unit tests across 56 files, 55
  integration tests across 8 files, and all workspace production builds succeeded.
- 2026-07-15: all 5 Electron Playwright E2E tests passed. The added project-check flow configured
  lint, test, and build commands entirely in Settings; exercised exact renderer disclosure and
  cancel-default native approval; verified raw and parsed output, terminal-state persistence across
  relaunch, full-tree cancellation, graceful shutdown cleanup, and zero Forgeboard external
  requests.
- 2026-07-15: focused project-check coverage proved strict IPC and settings schemas, owner-bound
  expiring single-use plans, concurrent prepare/launch reservations, stale executable/root/settings
  rejection, package-script content binding, literal metacharacter handling, bounded output,
  monotonic persisted state, retention/import/export/delete/recovery behavior, and cleanup after
  storage or audit failures.
- 2026-07-15: `corepack pnpm verify` passed on the agent-worktree checkpoint: the structure gate
  kept all 298 checked files at or below 2,000 lines; formatting, lint, strict typecheck, 321 unit
  tests across 61 files, 62 integration tests across 10 files, and all workspace production builds
  succeeded. `corepack pnpm audit --prod --audit-level high` reported no known production
  dependency vulnerabilities.
- 2026-07-15: all 7 Electron Playwright E2E tests passed. The added worktree-review flow configured
  the managed root and commit identity entirely in the UI, ran the deterministic writable agent,
  reviewed and staged its persisted owned worktree, completed renderer and native commit approval,
  relaunched, rediscovered the clean committed worktree, hashed the unchanged primary checkout, and
  observed zero external requests.
- 2026-07-15: agent-worktree resolution rejects renderer paths and requires a terminal run plus an
  immutable persisted repository/root/worktree/branch/base/agent/task binding that matches active
  ownership and Git identity. Focused integration coverage proved restart recovery after the
  configured root changes, cross-project/legacy/nonterminal/missing/mismatched rejection,
  cancel-default discard, target-bound staging and commit, audit identity, and an unchanged primary
  branch. Broader compare, merge, push, PR, comments, split-diff, and conflict-resolution surfaces
  remain unchecked.
- 2026-07-15: immediate-close E2E coverage proved serialized canvas flush before both native
  application close and in-app project close, followed by successful relaunch/reopen recovery. Unit
  coverage also proved latest-revision serialization, stale-response protection, retryable failure,
  owner/request/main-frame-bound close responses, timeout handling, and cancel-default native
  close-without-saving fallback.
- 2026-07-15: `corepack pnpm verify` passed on the recovery checkpoint: the structure gate kept all
  314 checked files at or below 2,000 lines; formatting, lint, strict typecheck, 384 unit tests
  across 67 files, 63 integration tests across 10 files, and all workspace production builds
  succeeded.
- 2026-07-15: all 8 Electron Playwright E2E tests passed. The recovery flow configured backup
  destination, interval, retention, and backup-on-quit entirely in the UI; created and restored an
  exact snapshot with native approval; completed portable export and replace import; verified a
  changed-data-on-quit backup in the selected folder; and observed zero external requests.
- 2026-07-15: focused recovery, lifecycle, and storage coverage proved serialized recovery
  requests; import, privacy-deletion, and quit drain ordering; reversible quit failure; persisted
  backup health; per-destination retention; clock-rollback handling; cleanup-failure visibility;
  exact missing-backup approval and cancellation ordering; merge and replace semantics; and 16 MiB
  plus structural-complexity import bounds.
- 2026-07-15: `corepack pnpm audit --prod --audit-level high` reported no known production
  dependency vulnerabilities on the recovery checkpoint.
- 2026-07-15: existing non-Git folders gained a project-rail initialization flow with cancel-default
  native confirmation, exact-path revalidation after approval, preserved unstaged files, refreshed
  repository health, and allowed/denied/failed audit outcomes. Focused unit/UI coverage passed 17
  tests, and an Electron E2E flow proved cancellation, approval, durable Git metadata, unchanged
  existing content, UI branch refresh, and zero external requests.
- 2026-07-15: `corepack pnpm verify` passed on the existing-folder onboarding checkpoint: the
  structure gate kept all 315 checked files at or below 2,000 lines; formatting, lint, strict
  typecheck, 387 unit tests across 67 files, 63 integration tests across 10 files, and every
  production build succeeded.
- 2026-07-15: all 9 Electron Playwright E2E tests passed, including the new existing-folder Git
  initialization flow and the prior onboarding, canvas persistence, agent, check, preview, recovery,
  primary Git review, and managed-worktree review flows.
- 2026-07-15: the desktop storage boundary now upgrades legacy renderer canvases into a versioned
  canonical `@forgeboard/core` canvas while preserving renderer compatibility. All 15 built-in node
  types plus declarative extension nodes round-trip without fabricated paths, commands, branches,
  or worktrees; newer canonical revisions win deterministically, while newer renderer edits retain
  canonical-only comments, resources, groups, workflow limits, and typed data. Draft operational
  nodes and draft revision edges persist honestly but fail closed when selected for execution
  without required configuration.
- 2026-07-15: all six edge kinds now expose typed UI configuration and persist canonical config:
  explicit Context attachments, Execute triggers and approval gates, Output kinds, Review
  authority, bounded Revision IDs, and succeeded Task dependencies. Focused adapter, persistence,
  accessibility, and inspector interaction tests cover migration, reconciliation, sanitation,
  retention, snapshots, imports, and the visible controls.
- 2026-07-15: `corepack pnpm verify` passed on the canonical-canvas checkpoint: the structure gate
  kept all 325 checked files at or below 2,000 lines; formatting, lint, strict typecheck, 403 unit
  tests across 70 files, 63 integration tests across 10 files, and every workspace production build
  succeeded. All 9 Electron Playwright tests also passed in 1.9 minutes.
- 2026-07-15: the agent Git review now exposes a read-only committed comparison from its persisted
  immutable base commit to the resolver-owned worktree HEAD, with bounded commit IDs, ahead/behind
  counts, diff stats, files, and hunks; the renderer still submits only the opaque project/run
  target. Focused coverage passed 21 contract/renderer tests and 13 real-repository integration
  tests, including an advanced primary branch, ownership/base mismatch rejection, post-commit
  refresh, empty/error/truncated UI states, accessible tab switching, and an unchanged primary
  checkout. The structure gate passed for all 411 checked files; broader merge, push, PR, comments,
  split-diff, archive, and cleanup surfaces remain unchecked.
- 2026-07-15: working-tree and committed-base Git reviews gained previous/next file navigation,
  per-group 100-item sidebar pages, user-controlled unified/split layouts, optional visible whitespace,
  selected-file line totals, and authoritative whole-review tracked-text totals. Focused renderer
  and form-accessibility coverage passed 18 tests, and the structure gate passed. Durable line
  comments and review notes remain unimplemented because this Git review surface has no approved
  persistence contract for target/path/line anchors, so the broad diff-review checklist entry
  remains unchecked.
- 2026-07-15: workflow-owned Agent and assigned Task attempts gained exact-owner ephemeral output,
  bounded live terminal rendering, input, and interrupt controls without renderer-selected owner or
  run IDs. Main-process tests cover wrong-window, stale-attempt, numeric WebContents ID reuse,
  non-JSON and oversized output, NUL and oversized input, restart-without-handle failure, and
  subscription cleanup. The host now validates evidence and external execution identity before
  terminal success, retries one-shot completion persistence failures, preserves retryable prepared
  cleanup, and rejects unsupported agent-review semantics before launch. Focused verification passed
  81 unit tests, 36 integration tests, desktop/core strict typechecks, focused lint, the 411-file
  structure gate, and `git diff --check`.
- 2026-07-15: Settings gained a persisted Standard/VS Code command-palette preset; helper tests
  cover both shortcut sets and a workspace-listener test covers the saved VS Code path. It also
  gained 10 searchable static local help guides.
  Inactive stored or imported collaboration, updater, terminal-shell, Git-remote, automatic cleanup,
  and host-credential-mount preferences remain visible but disabled, safely clearable, or explicitly
  unavailable instead of presenting dead controls as active. Focused verification passed 30 unit/UI
  tests across 5 files, including
  dialog focus, keyboard behavior, accessible help search/shortcut semantics, draft-only
  import/reset, and replacement of an inactive cleanup policy with supported manual cleanup. The
  affected first-run, preview, and project-check Electron E2E flows also passed after their argument
  editors were bound to a stable accessible name and the full literal-argument rule as its
  description. The 412-file structure gate passed; the broader first-run tour, complete
  documentation, all-settings, and keyboard-only E2E checklist items remain unchecked.
- 2026-07-15: adversarial convergence review re-authorized workflow input and interrupt inside the
  serialized host queue, kept failed-input audit metadata content-free, made prepared/active
  resource cleanup durable across expiry, privacy reset, and shutdown, removed an unavailable
  action from binary committed diffs, and hardened Linux installer smoke against replacing or
  purging an existing installation. A live Electron trace also exposed and closed an identical-
  canvas autosave loop; destructive privacy reset now settles admitted canvas writes first.
- 2026-07-15: the final converged `corepack pnpm verify` passed with all 412 authored files below
  2,000 lines, formatting, lint, strict typecheck, 585 unit tests, 112 real integration tests, and
  every workspace production build green. All 9 Electron Playwright scenarios passed in 1.9
  minutes. A fresh unsigned macOS arm64 app, ZIP, and DMG were built; the isolated packaged-app
  smoke and native DMG install/launch smoke both passed. GitHub publication, signing/notarization,
  and fresh Windows/Linux installer proof remain unchecked.
- 2026-07-15: Custom permissions became fully configurable and persistable in the UI for host and
  Docker execution, with no required file or environment configuration. The run review discloses
  effective roots, visibility, executable identity, Docker resources, provider limitations, and
  resolver-supplied context evidence before exact approval. Host execution fails closed on path,
  symlink, executable, and attachment drift; Docker execution performs no in-container agent work
  before approval, pins an immutable image ID, and revalidates client, tag, context, and workspace
  identity immediately before launch. Independent adversarial review found no remaining critical
  or high-severity blocker in this scope.
- 2026-07-15: the Custom-permissions checkpoint passed `corepack pnpm verify`: all 432 authored
  files remained below 2,000 lines; formatting, lint, strict typecheck, 608 unit tests across 104
  files, 112 integration tests across 16 files, and every workspace production build passed. All
  10 Electron Playwright scenarios passed in 1.7 minutes, including complete UI configuration,
  process-restart persistence, cancel-without-launch, read-only enforcement, and one approved
  deterministic write with zero external requests. Fresh unsigned macOS arm64 app, ZIP, and DMG
  artifacts built successfully; packaged-app and native DMG installer launch smokes passed.
  `corepack pnpm audit --prod --audit-level high` reported no known production vulnerabilities.
- 2026-07-15: scoped approvals gained durable SQLite persistence, strict exact-scope lookup,
  expiry, revocation, and atomic single-use consumption. Audit events are redacted before a
  SHA-256 previous/event hash is committed, verified at startup and backup time, protected against
  row updates by validated SQLite triggers, and retained only through chained prefix checkpoints.
  Legacy audit rows upgrade transactionally, while explicit replace/privacy resets discard the
  chain and device-local grants. Focused storage and service verification passed 53 tests; the full
  unit suite passed 667 tests across 120 files, alongside desktop strict typecheck, focused
  lint/format checks, `git diff --check`, and the repository structure gate. The broader
  approval/impact-confirmation and all-required-events audit checklist items remain unchecked
  pending complete consumer and event-coverage evidence.
- 2026-07-15: repository organization now enforces both the 2,000-line ceiling and a maximum of 12
  direct hand-written files per maintained folder, plus an explicit loose-root allowlist. Main,
  renderer, shared contracts, storage, workflow, Git-engine, E2E support, documentation, tooling,
  startup, and release code are grouped by feature/domain. The final gate covered 489 code and
  configuration files. A relocation audit found and fixed an over-broad `release/` basename ignore;
  all six hand-written `scripts/release` files are now tracked and covered by Git, ESLint, Prettier,
  Vitest, and the structure gate. A 453-file relative-import scan and 13-file local-document-link
  scan found no missing targets.
- 2026-07-15: renderer-triggered native operations now retain exact main-frame, WebContents, and
  parent-window authority across asynchronous dialogs and final execution boundaries. Agent launch
  review exposes a strict, non-recursive disclosure SHA-256 and canonical expiry, while the native
  cancel-default confirmation is bound to those exact values. Active Git clean/smudge/process
  filters require an exact owner-bound native approval; aliases, external helpers/diffs, textconv,
  pagers, configured editors, signing, hooks, fsmonitor, custom merge drivers, and filtered hunk
  staging fail closed or are neutralized as appropriate. Workflow recovery persists
  `waiting-delegate-approval` and retries only from a fresh live renderer authorization rather than
  failing terminally or inheriting stale IPC authority.
- 2026-07-15: the final frozen verification passed formatting, full zero-warning lint, recursive
  strict workspace typecheck, explicit strict E2E typecheck, 766 unit tests across 127 files, 137
  integration tests across 17 files, 11 standalone startup/release tests, all 11 Electron Playwright
  scenarios, every workspace production build, the 489-file structure gate, and `git diff --check`.
  Token-scoped E2E native-dialog harnesses validate exact agent and preview disclosures, cancel all
  mismatches, and prove descriptor/token cleanup on success, rejection, timeout, installation
  failure, and later-owner replacement. `corepack pnpm audit --prod --audit-level high` reported no
  known production dependency vulnerabilities.
- 2026-07-15: a fresh unsigned macOS arm64 app, ZIP, and DMG were generated from the final source.
  The packaged-app smoke passed its UI-driven safe-default/demo/real-child-process/durable-SQLite
  proof, and the native DMG mount/install/launch smoke returned `FORGEBOARD_SMOKE_OK`. GitHub Release
  publication, signing/notarization, and fresh Windows/Linux installer proof remain unchecked.
- 2026-07-15: managed completed agent-worktree review gained a minimal local delivery path for
  fast-forward-only merge or ordered cherry-pick into the canonical primary checkout. Renderer
  requests contain only project/run ownership IDs and a strategy; main resolves branches, immutable
  base/source/primary commits, ordered commit range, affected files, clean/conflict state, and the
  exact Settings or canonical-primary Git identity with its source, then revalidates both checkouts
  after an exact cancel-default native disclosure. Dirty,
  detached, conflicted, rewritten, already-integrated, or drifted state fails closed; no force,
  reset, clean, push, automatic resolution, or renderer path/ref/command is available. Cherry-pick
  conflicts remain durable in primary and return its review state. Focused evidence passed 9 UI and
  contract tests, 6 real temporary-repository delivery cases, 13 Git-engine/run integration tests,
  focused lint/typecheck, and the 521-file structure gate. Squash, rebase, visual conflict
  resolution/continuation, push, and PR delivery remain unchecked.
- 2026-07-15: the canvas interaction layer gained keyboard-focusable nodes with visible shortcut
  guidance, accessible movement announcements, 1 px Arrow movement, 10 px Shift+Arrow movement,
  editable-control exclusion, multi-selection movement, hard-lock preservation, and one undo
  checkpoint per keypress/hold. Configured grid snapping now uses a matching visible grid, while
  zoom-aware edge/center alignment guides render in the React Flow viewport only during node drag.
  Eight new focused geometry, keyboard, renderer-interaction, lock, and undo tests passed alongside
  targeted lint/format checks and the structure gate. The broad canvas checklist item remains
  unchecked because comments and complete grouping/containment behavior are not yet proven.
- 2026-07-22: expanded Agent nodes expose their full title bar as an explicit React Flow drag
  handle, with a visible grip, grab/grabbing feedback, and touch-safe movement while the embedded
  terminal remains interactive. Collapsed Agent nodes retain their whole-node drag handle, and the
  existing canvas change/autosave path persists completed positions. Twenty-nine focused Agent and
  canvas-node tests passed with targeted lint, desktop typecheck, and diff validation.
- 2026-07-22: Mobile Preview canvas faces now preserve the selected device's real CSS viewport width
  while fitting their height to the available node body. The page therefore fills the preview node
  at a readable mobile breakpoint instead of shrinking the entire phone into unused black space;
  narrower resized nodes still scale proportionally. Focused layout and face coverage verifies both
  full-size and constrained-node behavior.
- 2026-07-22: the source-development renderer now binds explicitly to port 5174 with strict-port
  enforcement, so Forgeboard fails clearly instead of silently moving to another port when 5174 is
  unavailable. User-configured Web and Mobile Preview ports remain independent.
- 2026-07-22: Web and Mobile Preview address fields accept bare local ports, loopback URLs, and
  public HTTPS addresses. Public sites never mount inside Electron: both renderer selection and the
  main-process webview attachment guard enforce loopback-only guests. External addresses instead
  open in visible Google Chrome with a per-node dedicated profile and private fd-only DevTools pipe,
  so normal Chrome navigation and Google OAuth can work without exposing the user's personal Chrome
  profile or a network debugging port. The node shows bounded screenshots and offers Focus,
  Disconnect, and native-confirmed profile clearing; privacy reset erases every companion profile.
  The Chrome node is interactive: it forwards validated resize, pointer, wheel, keyboard, paste,
  back, forward, and reload events over that private pipe, restores replaced page sessions, and
  returns focus to Forgeboard after launch while retaining a native-Chrome escape hatch for OS-level
  sign-in dialogs. Chrome pushes compressed frames only as page pixels change; Forgeboard
  acknowledges them immediately, transfers each frame sequence once, and maps the resulting image
  edge-to-edge onto the exact node viewport instead of repeatedly polling full PNG screenshots.
  Compact nodes retain that exact aspect ratio but receive at least a 1280-by-720 desktop-class CSS
  viewport before scaling, preventing responsive sites from rendering oversized mobile layouts.
- 2026-07-22: connected-agent browser observation and interaction are separate default-off
  permissions, each reauthorized against a direct, unmuted Context edge on every request. Reads
  expose bounded visible text, an escaped visible-text-only legacy DOM projection, and PNG
  screenshots while excluding hidden DOM, attributes, form state, URL queries/fragments, scripts,
  styles, console output, cookies, and storage. Agents can inspect short-lived opaque element
  handles and request bounded scrolling, clicks, or text entry without receiving selectors,
  coordinates, raw JavaScript, navigation, or DevTools access. Every click and typed entry requires
  a cancel-default native one-time approval; secret, authentication, payment, file, permission, and
  popup controls remain user-only; downloads and agent-created popup targets are denied; action
  audits omit entered text and must persist before execution; and permission, edge, origin,
  page-version, hit-target, and handle checks fail closed before execution. Chrome applies its
  restrictive download policy before navigating the initial blank tab to the site. Changing the
  address revokes both permissions. One hundred thirteen
  focused tests across 12 files pass alongside desktop, core, and peer-MCP strict typechecks,
  zero-warning focused lint, and the 1,475-file structure gate.
- 2026-07-15: release packaging gained deterministic platform-and-architecture installer names,
  exact artifact-set validation, per-run source/signing manifests, tag-only GitHub publication,
  build-job read-only permissions, an assisted per-user Windows installer that preserves local app
  data, and a modular download/checksum/install guide requiring no source or configuration edits.
  Eighteen release/startup tests, ten focused installer tests, metadata verification, lint, and
  the 573-file structure gate passed. A clean unsigned macOS arm64 build emitted the canonical DMG
  and ZIP names, generated four checksums plus an accurate `unsigned-development` manifest, and its
  native DMG mount/install/launch smoke returned `FORGEBOARD_SMOKE_OK`. GitHub Release publication,
  signed/notarized artifacts, and fresh native Windows/Linux CI installer proof remain unchecked.
- 2026-07-15: the production preview runtime was exercised concurrently against two real managed
  Git worktrees registered through LocalStore. Real loopback HTTP children served exact cwd-bound
  worktree content on distinct collision-checked ports while a dirty primary checkout remained
  byte-exact. The proof covers occupied and exhausted port ranges, bounded logs and renderer chunks,
  cross-owner denial, independent restart/stop, PID and port cleanup, durable audit evidence, and
  unchanged worktree ownership. The focused proof, 25 mapped preview tests, 11 Git-engine
  integration tests, typecheck, lint, formatting, and the 576-file structure gate passed. This
  closes only the named two-worktree preview integration test; automatic side-by-side UI binding
  remains unchecked.
- 2026-07-15: a production-composed default-solo workflow integration now proves that `.env*`, Git-
  ignored, Forgeboard-ignored, symlink-escape, and corrupted traversal context is denied before
  planning or process spawn without secret bytes entering audits. For allowed context, the exact
  canonical path, SHA-256, manifest, provider, and `provider-controlled` network status are
  disclosed before approval; only afterward does a local context-recording child receive that one
  file. The fixture traps Forgeboard-owned HTTP, HTTPS, TCP, TLS, DNS, UDP, fetch, and WebSocket
  seams and observes zero attempts and zero `external-send` audits. Two real-process tests and 85
  mapped unit tests passed with typecheck, lint, formatting, structure, and whitespace gates. This
  closes the named integration-test requirement only: it is not packet capture or an OS firewall,
  does not inspect provider-controlled child networking, and does not close the broader all-app-path
  solo outbound claim.
- 2026-07-15: first-run and Settings configuration gained native executable Browse controls, safe
  literal argument arrays, an environment-variable name allowlist that never stores values, and
  actionable dependency guidance for agents, checks, and previews. Ordinary setup is available in
  the UI without source or environment-file editing. The broad first-run readiness entry remains
  unchecked pending proactive generic check/preview validation before save, package-script
  discovery before a project is opened, and installation of external dependencies.
- 2026-07-15: File nodes gained a bounded project-relative browser with recursive navigation,
  breadcrumbs, 100-result quick-open search, honest ignored/sensitive/symlink/missing/binary/
  oversize/read-only states, and UI-only assignment or reassignment into the existing Monaco text
  editor. The broad file-editor entry remains unchecked because tabs, diagnostics, and external-
  editor handoff are not implemented.
- 2026-07-15: collaboration gained owner-scoped current-room snapshot retrieval, strict canvas-ID
  and field allowlists, preservation of local private file bindings and prompts, safe remote graph
  merging, role-enforced read-only graph controls, and bounded peer cursors, selections, presence,
  and avatars. Initial room entry can union unsent local work, while later snapshots preserve remote
  deletions. A changed room after disconnect now pauses instead of overwriting either side because
  the current server contract has no per-update delivery acknowledgement or conflict-resolution UI;
  the broad offline/reconnect collaboration entry therefore remains unchecked.
- 2026-07-15: the UI-first file browser, review, configuration, and collaboration checkpoint passed
  the 599-file modularity gate, repository-wide formatting and zero-warning lint, every workspace
  strict typecheck, 923 unit tests across 158 files, 160 integration tests across 24 files, all 11
  Electron Playwright journeys, all 18 standalone release/startup tests, and every workspace
  production build. The final adversarial fix retains viewer/reviewer read-only authority during
  reconnect/offline transitions and reapplies an unchanged authoritative snapshot before resuming;
  three regressions cover reconnect, confirmed leave, and disabling collaboration. The production
  dependency audit found no known vulnerabilities. A fresh unsigned macOS arm64 app, ZIP, and DMG
  built successfully; packaged-app smoke passed, and the native DMG mount/copy/launch smoke returned
  `FORGEBOARD_SMOKE_OK`. Signing remains inactive because this machine has no Developer ID identity.
- 2026-07-15: the file editor now provides twenty bounded, live Monaco tabs whose buffers survive
  tab switches, explicit dirty indicators, unsaved-close protection, optimistic hash-bound save,
  recoverable revert/history, tree reveal with an exact-parent fallback when the bounded index omits
  a file, and line/column navigation from bounded project-content search. Search runs in the main
  process across at most 2,000 policy-approved UTF-8 files and 32 MiB, skips ignored, sensitive,
  linked, binary, oversized, raced, or unreadable targets, and never returns an absolute path.
  Diagnostics are shown only for Monaco languages with bundled diagnostic workers; unsupported
  languages say they are unavailable. External handoff is an explicit UI action routed through a
  strict project-relative preload contract, canonical main-process root/policy validation, and
  `shell.openPath`; the renderer cannot select an executable or receive the absolute path. Twenty-
  nine mapped unit tests and thirteen real file-domain integration tests passed with desktop strict
  typecheck, zero-warning focused lint, focused formatting, the 637-file structure gate, and
  `git diff --check`. The broader File-node entry remains unchecked because a real drag-to-agent-
  context workflow is still absent; editor tabs do not claim to close that separate behavior.
- 2026-07-15: zero-code setup now passively validates every configured preview, standard check,
  and custom-check executable plus its exact literal argument vector before Continue or Settings
  save; direct form submission fails closed as well. The main process resolves executable identity
  without starting the command, checks the current package script when an authoritative project is
  available, and returns no environment values. First-run setup displays bounded scripts from known
  repositories and adopts likely development/test commands with one UI action. Missing executable,
  missing script, unavailable-project, relative-path, orphaned-argument, stale-evidence, and bridge
  failures all produce actionable in-app remediation. External dependencies remain user-installed;
  Forgeboard gives provider/runtime-specific install-or-Browse guidance and intentionally performs
  no surprise package installation. Fifty-five focused tests across six files, desktop strict
  typecheck, the 637-file structure gate, targeted zero-warning lint/format checks, production build
  with the sandboxed preload policy, `git diff --check`, and the real Electron first-run readiness
  journey passed.
- 2026-07-15: Git review now supports durable comments and explicit revision requests on exact old-
  or new-side diff lines in unified and split views. Main resolves the authoritative primary or
  managed-worktree target and current diff before accepting a bounded anchor; stored notes bind the
  target, area, full revision digest, path, hunk, side, line, and line-content SHA-256. Changed or
  deleted diffs preserve feedback as visibly stale instead of silently remapping it. Editing,
  resolving, optimistic concurrency, two-step deletion, SQLite recovery/integrity, traversal
  rejection, and real-repository IPC behavior are covered without running Git mutations, agents,
  or native approvals. The broader Diff/review canvas-node item remains open because local revision
  feedback is intentionally not an AI approval or execution gate.
- 2026-07-15: collaboration reconnect delivery now uses a strict bounded non-broadcast stateless
  protocol: a renderer receipt is correlated with a UUID, safe-snapshot SHA-256, and canonical Yjs
  state vector; the authenticated server acknowledges only after that vector is present in the
  allowlisted room document, the exact current Yjs state is persisted, and audit evidence is
  appended. A real two-client test disconnects an editor, makes independent offline and remote
  graph changes, reconnects, proves both changes converge, acknowledges, and reopens the persisted
  merged state. Renderer three-way intent verification now detects a losing same-key offline edit,
  while accepting disjoint merges; local Yjs echoes no longer masquerade as remote conflicts. Every
  message revalidates live membership, role, token version, and expiry, and reviewer ownership of
  existing comments and reviews is immutable. The broad entry remains open for restart-safe offline
  intent recovery, ordinary shared-comment authoring, and an idle-collaborator avatar roster.
- 2026-07-15: the zero-code readiness, Monaco editor, durable Git review feedback, and hardened
  collaboration delivery checkpoint passed the 637-file modularity gate, repository-wide formatting
  and zero-warning lint, every workspace strict typecheck, 970 unit tests across 169 files, 167 real
  integration tests across 24 files, all 11 Electron Playwright journeys, all 18 standalone
  release/startup tests, and every workspace production build. The production dependency audit
  found no known vulnerabilities. A fresh unsigned macOS arm64 app, ZIP, and DMG built successfully;
  packaged-app smoke passed, and the native DMG mount/copy/launch smoke returned
  `FORGEBOARD_SMOKE_OK`. Signing remains inactive because this machine has no Developer ID identity.
- 2026-07-15: first-run Ready now includes an optional, non-blocking four-stop Getting started tour
  for project entry, workspace navigation and the active command-palette shortcut, exact-launch and
  local-review safety, and Help/Data & privacy/recovery paths. The same bundled tour is replayable
  from Help & shortcuts; it has no links or configuration controls, explicitly distinguishes the
  networked Clone action, and contacts no service itself. Existing searchable local guides cover
  agent, Git, Docker, preview, keyboard, privacy, backup/recovery, missing-project, permission, and
  run-failure troubleshooting entirely through app UI. Forty-two focused component/accessibility
  tests across five files, desktop strict typecheck, targeted zero-warning lint and formatting, the
  640-file structure gate, production build, `git diff --check`, and the real Electron first-run
  journey with an empty external-request watcher passed. The broader command-palette/notification/
  contextual-menu/tooltip/state entry remains unchecked.
- 2026-07-16: optional multiplayer retains a strict metadata-only baseline, pending intent, and
  exact per-delivery candidate ledger under the saved project/canvas plus authenticated server,
  room, and subject. Receipt binding and staging are one SQLite transaction; highest-sequence
  acknowledgement projection preserves accepted A while later rejected B remains the only recovery
  addition, regardless of settlement order or restart. Migration 12 backfills migration-11 delivery
  rows. Per-scope row and aggregate-byte limits, sliding 30-day inactivity expiry, digest/scope and
  state-to-ledger projection integrity, checkpoints, and privacy cleanup fail closed without evicting
  user work. Domain-aware three-way recovery ignores derived revision noise, reapplies disjoint
  edits, pauses true same-field/entity conflicts, and retains intent after a role downgrade. Shared
  comments stay hidden until their correlated durable acknowledgement; rejection quarantine covers
  early IPC races, replies, review references, settlement-write retry, reconnect receipt reattachment,
  and digest mismatch without losing pending callers. Exact-ledger recovery also restores a rejected
  B quarantine beneath newer unsettled C, clears it only when an acknowledged baseline contains B,
  and applies no room snapshot while a known rejection cannot be persisted. Reviewer comments are
  main-authored with the authenticated identity while viewers remain read-only; live membership,
  role, token version, and expiry are revalidated per message. A bounded idle-avatar roster
  supplements cursors, selection, and presence. Nineteen focused unit files passed 158 tests, 41 additional SQLite migration/recovery
  tests passed, and the real loopback server passed all eight authorization, privacy, receipt,
  revocation, and offline-merge integration tests. Core, collaboration-server, and desktop strict
  typechecks, focused zero-warning lint and formatting, the 695-file structure gate, and
  `git diff --check` also passed.
- 2026-07-16: Settings now fails closed on the exact unsaved draft for blank or invalid numeric
  controls, non-loopback preview hosts, and bounded control-free machine values; restored and
  imported drafts receive the same validation before Save. Every configured built-in provider and
  enabled custom CLI must have evidence bound to its current executable/configuration, and edits
  invalidate earlier evidence. Managed-worktree and enabled-backup destinations receive debounced,
  passive main-process `stat`/`access` preflight through a purpose-bound validated IPC/preload
  contract; it creates and starts nothing, returns no canonical path, and translates filesystem
  errors without leaking OS-resolved paths. The trusted `settings:update` transaction now also
  compares the parsed draft with persisted settings and independently revalidates each newly changed
  agent configuration, configured preview/check command, worktree destination, and newly enabled or
  changed backup destination before any save, retention, audit, or schedule-refresh effect. Agent
  evidence is admitted only after native confirmation, probe completion, audit success, and a final
  owner check; save-time verification re-resolves and re-hashes it without another subprocess. A
  command check is likewise admitted only after its IPC owner survives passive inspection, then is
  recomputed with the same project context. At this checkpoint, changed-only persistence checks did
  not yet migrate unchanged legacy configuration; the later 2026-07-16 upgrade-repair entry
  supersedes that limitation. Thirteen focused UI and contract files passed 71 tests; the follow-up
  persistence-boundary set passed 55 tests across eight files. Desktop strict typecheck, focused
  zero-warning lint and formatting, and the 702-file structure gate passed. The two broad Settings
  completeness entries remain unchecked because this evidence closes only validation, readiness,
  and folder preflight, not every setting or integration in the build goal.
- 2026-07-16: dirty-primary protection is enforced by the real Git engine before integration, while
  Repository status in an agent worktree visibly reports its managed branch, ahead/behind counts,
  and dirty or clean state without changing the primary checkout. Eight focused Git review component
  tests and the real-repository dirty-primary integration target passed; the prior Electron Git
  journey covers the same UI flow.
- 2026-07-16: project-tree files and File nodes can now be linked to an Agent through strict drag/drop
  or keyboard target pickers. A configured File node whose center is moved onto an unlocked Agent
  links that exact existing node; moving it elsewhere remains an ordinary canvas move, and locked,
  read-only, directory, missing-file, and cross-project cases fail closed. Renderer drag data carries
  only project identity, a relative path, and an optional semantic node ID. Before review preparation,
  the renderer writes the current effective permission choice onto the Agent and requires the canvas
  flush to finish. Main reloads the persisted Agent, rejects prompt/adapter/profile mismatches,
  resolves and hashes current same-project File nodes, and verifies the exact disclosure. The renderer
  flushes again before approval, after which main rechecks configuration and the attachment manifest.
  Immediately before spawn it rechecks bytes, ignore and sensitive-file policy, symlinks, and hashes;
  any drift consumes the plan and requires fresh review. Normal terminal and launch-failure paths
  remove the immutable per-run copy. After a crash, startup under the winning Electron instance lock
  scavenges only owner/marker-validated dead or over-age instances from the dedicated host store,
  preserves recent live instances, refuses unknown/symlink children, and completes validated
  interrupted quarantine cleanup. Normal startup now defers a storage warm-up failure while later
  context-bearing launches retry and remain fail-closed. Windows stores Host and Docker snapshots in
  separate SID-hash namespaces under per-user app data, binds the full SID in markers, revalidates
  exact private directory/file DACLs at launch binding, and never puts Docker snapshot bytes in the
  managed root. Marker reads are stable, no-follow, and capped at 4 KiB. Managed-root cleanup is lazy
  and leaves checkout content untouched.
  The earlier context-link checkpoint passed sixteen focused unit files with 141 tests and two
  RunService integration files with 18 tests, alongside desktop strict typecheck, targeted
  zero-warning lint, the 692-file structure gate, and `git diff --check`. Additional focused
  regressions cover the direct File-node drop, profile-before-flush ordering, runtime cleanup, crash
  restart, live-PID preservation, bounded PID-reuse aging, symlink refusal, managed-root isolation,
  and interrupted-quarantine recovery. The broader per-file sensitive override UI remains open;
  ordinary context linking intentionally accepts only files allowed by normal policy.
- 2026-07-16: stored-settings upgrades now run an explicit field-by-field compatibility repair before
  strict startup integrity validation. Known legacy executable, permission, command, preview-host,
  Docker, worktree, terminal, and backup values are normalized, safely disabled, filtered, or
  replaced with injected device defaults while unrelated settings remain intact; unknown corruption
  still fails closed. Migration 13 adds a 20-record device-local immutable evidence ledger with full
  original/repaired JSON, SHA-256 validation, redacted field-path-only audit metadata, complete-data
  deletion, and no ordinary portable import/export participation. A startup disclosure and Data &
  Privacy UI support review plus explicit evidence export without editing source or configuration
  files. Current-version detection closes the crash window after schema migration. Legacy preview
  hosts are deterministically reduced to the first 128 unique loopbacks, and evidence preserves
  legacy settings beyond the previous 4 MiB test boundary. Each original/repaired JSON value now has
  an independent 16 MiB UTF-8 cap in the shared schema, bounded SQLite reads, and BLOB-length table
  constraints. The exact-boundary regression accepts 16 MiB and rejects one additional byte; an
  oversized stored-settings row fails with recovery guidance before any repair-evidence row is
  copied. Persisted Agent canvases retain every pre-existing context link above the 256 execution
  limit without truncation; UI linking, direct runs, and workflow execution still reject overflow.
  Focused planner, pre-current/current-version SQLite restart, evidence integrity/deletion, IPC,
  settings UI, startup notice, and run-boundary regressions passed; final repository-wide
  verification is recorded separately.
- 2026-07-16: the Windows filesystem authority now reads the raw descriptor before trusting projected
  ACL rules, rejects absent DACLs and callback/unsupported raw ACEs, and requires exact protected
  current-SID/LocalSystem DACLs for Forgeboard-created private objects. Managed-worktree readiness
  rejects destination and ancestor aliases; backup readiness checks and warns about the canonical
  target. Backup creation protects a new destination and staging directory before SQLite writes,
  protects the staged file, publishes the same inode by hard link, rechecks the final DACL and
  identity, and does not rewrite a suspect recorded file's ACL before ledger verification. Seven
  focused files passed all 62 tests covering the ACL authority, folder readiness, deferred context
  startup, SID-bound snapshot storage and 4 KiB markers, immutable context, Windows backup creation
  and deletion, and the exact 16 MiB settings-repair boundary. No broader checklist checkbox was
  changed by this hardening evidence.
- 2026-07-16: the complete zero-code editing, collaboration recovery, immutable-context, Settings
  repair, and Windows privacy checkpoint passed the 727-file structure gate, repository-wide
  formatting and zero-warning lint, all eight workspace strict typechecks, 1,224 unit tests across
  206 files, 179 integration tests across 25 files, all 11 Electron Playwright journeys, the
  production dependency audit with no known vulnerabilities, and every workspace production build.
  A fresh unsigned macOS arm64 application, ZIP, and DMG packaged successfully; the packaged-app
  smoke passed, and the native read-only DMG mount/copy/launch smoke returned
  `FORGEBOARD_SMOKE_OK`. Signing remains inactive because this machine has no Developer ID identity.
- 2026-07-16: rejected shared comments now retain an exact value plus rejected-delivery token and
  expose an explicit two-step `Discard local copy` action from both the matching node and a global
  deleted-node-safe notice. Device-local SQLite dismissals are subject-, scope-, digest-, sequence-,
  TTL-, row-, and byte-bound; keep raw delivery evidence immutable; cascade replies and review
  references in the effective view; and allow a later byte-identical rejection to reappear. Fully
  dismissed recovery checkpoints only the stored baseline. A baseline-aware session overlay keeps
  polluted Yjs values out of snapshots and remounts, while publish, comment creation, and replay
  fail before reservation, journaling, mutation, or transport until the user leaves and rejoins a
  stale room. Eleven focused files passed 125 tests, including viewer downgrade, crash recovery,
  acknowledgement beneath a newer unsettled delivery, absent-versus-empty review normalization,
  exact cutoff, cascade, quota, integrity, and no-resurrection cases.
- 2026-07-16: the frozen checkpoint passed the 734-file structure gate, repository-wide Prettier,
  zero-warning ESLint, all eight workspace strict typechecks, 1,248 unit tests across 209 files,
  179 integration tests across 25 files, all 11 Electron Playwright journeys, every production
  build, `git diff --check`, and the production dependency audit with no known vulnerabilities. An
  isolated fresh package produced an unsigned macOS arm64 application, ZIP, DMG, and blockmaps; its
  ASAR contains the declared main, preload, and renderer entries. The packaged-app smoke passed and
  the native read-only DMG mount/copy/launch smoke returned `FORGEBOARD_SMOKE_OK`. Signing remains
  inactive because this machine has no Developer ID identity; GitHub publication and fresh native
  Windows/Linux installer proof remain unchecked.
- 2026-07-16: Diff nodes gained a first-class, zero-code inspector for explicitly pinning either the
  primary checkout or an opaque persisted terminal agent run, choosing unified/split presentation,
  showing whitespace, retrying bounded run history, and opening the existing authoritative Git
  review. The renderer receives no repository, managed-root, worktree-ID, or cwd authority; preload
  validates a path-free summary and main revalidates the selected run through its durable ownership
  resolver. Exact summaries distinguish working-tree changes from committed Agent-vs-base paths and
  line counts. Locked and collaboration-read-only nodes remain inspectable, while target and shared
  preference edits are disabled. Dialog preference persistence stays bound to the node and target
  that opened it, survives selection drift without retargeting, rejects stale writes after retarget,
  lock, deletion, or role downgrade, and records one undo snapshot for both fields. The unsafe idea
  of inferring this target from incomplete workflow decision evidence was removed; the pin is a
  standalone/manual inspection choice and does not make a Diff node workflow-ready. Therefore the
  broad Diff/review node checklist entry remains open for causal workflow binding, hunk decisions,
  revision execution, and an approval gate. This checkpoint passed the 746-file structure gate,
  repository-wide Prettier and zero-warning ESLint, all eight workspace strict typechecks, 1,278 unit
  tests across 213 files, 181 integration tests across 25 files, all 11 Electron Playwright journeys,
  every workspace production build, and `git diff --check`.
- 2026-07-16: terminal managed agent worktrees gained a zero-code, path-free safe-cleanup flow. Main
  binds each one-shot plan to the originating window and persisted project/run, revalidates expiry
  and exact ownership before and after the cancel-default native confirmation and again while
  workflow, run, preview, and check admission is paused, and permits cleanup only for a clean
  worktree whose managed branch is merged into its recorded base. The Git engine proves exact
  worktree-registration removal, rechecks primary HEAD and base, compare-and-deletes only the
  approved branch OID, retains metadata on drift, and exposes no renderer force, dirty, or unmerged
  override. Durable `active`, `cleanup-pending`, and `cleaned` run states support bounded no-follow
  crash recovery: an intact pre-mutation target is reactivated, an exact partial cleanup requires
  fresh consent, a twice-proven completed cleanup is reconciled, and ambiguous residue stays hidden
  and unchanged. Retention preserves active, pending, and legacy owned-worktree bindings; cleanup
  refreshes run and Git state without retargeting the pinned Diff node or claiming success for
  uncertain outcomes. The broad combined Git-management checklist item remains open because rename,
  archive, external-editor, and its other unfinished requirements are outside this cleanup slice.
  This checkpoint passed the 766-file structure gate, repository-wide Prettier and zero-warning
  ESLint, all eight workspace strict typechecks, 1,348 unit tests across 219 files, 202 integration
  tests across 27 files, all 11 Electron Playwright journeys, every workspace production build,
  `git diff --check`, and the production dependency audit with no known vulnerabilities. The macOS
  arm64 application, ZIP, DMG, and blockmaps packaged successfully; both packaged-app and native
  installer-artifact smoke tests passed, with the latter returning `FORGEBOARD_SMOKE_OK`. Signing
  remains inactive because this machine has no Developer ID identity.
- 2026-07-16: Group/frame nodes gained real persistent containment configured entirely in the UI:
  inspector and drag assignment, deterministic single-owner resolution, member-aware movement,
  auto-fit plus explicit fit/arrange, collapse, manual resize, inherited locking and deletion
  protection, copy/duplicate, undo/redo, autosave/reload, and privacy-bounded collaboration
  round-trips. Shared logical/rendered dimension floors keep new, legacy, remote, and restored nodes
  consistent; viewport-aware drops keep full nodes reachable through pan, zoom, and snap-to-grid.
  Adversarial tests cover ownership transfer between auto-fit frames, locked descendants, stale
  collaboration undo history, malformed legacy claims, collapsed frames, and local-only extension
  data. The final checkpoint passed the 784-file structure gate, repository-wide Prettier and
  zero-warning ESLint, all eight participating strict typechecks, 1,429 unit tests across 227 files,
  202 integration tests across 27 files, all 12 Electron Playwright journeys, every workspace
  production build, `git diff --check`, and the production dependency audit with no known
  vulnerabilities. A fresh macOS arm64 app, ZIP, DMG, and blockmaps packaged successfully; both the
  packaged-app smoke and read-only DMG mount/copy/launch smoke passed, with the latter returning
  `FORGEBOARD_SMOKE_OK`. Signing remains inactive because this machine has no Developer ID identity.
- 2026-07-16: managed terminal-agent worktree delivery gained a separate UI-configured,
  content-bound readiness gate. Main resolves the clean committed HEAD and tree, durable ownership,
  selected configured commands, executable and working-directory identities, private environment
  and relevant-file identities, and exact terminal results. Every selected exact execution must
  pass before a local human can approve the same evidence; AI and reviewer outcomes cannot satisfy
  the gate. Check launch and human approval use cancel-default native disclosures. The approval is
  revalidated before delivery confirmation and immediately before primary mutation. Source,
  command, environment, executable, file, result, lifecycle, window, rerun, and superseding
  requirement drift all fail closed; interrupted nonterminal evidence becomes honestly `lost` after
  restart. Readiness generations are transactionally capped at 32 per target, while exact human
  approvals are immutable while retained and preserve the current decision within a physical cap
  of 64. Device-local evidence survives portable merge and is cleared by replace or full deletion.
  This closes only the implemented local fast-forward/cherry-pick readiness slice, not remote
  push/PR, generic workflow merge/push governance, or the broad Git/PR, Test, and Review Gate node
  entries, so no broader checkbox changed. The focused mapping passed 134 unit tests across 10 files
  and 32 real integration tests across 3 files. The frozen checkpoint passed the 810-file structure
  gate, repository-wide Prettier and zero-warning ESLint, all eight workspace strict typechecks,
  1,527 unit tests across 234 files, 216 integration tests across 28 files, all 12 Electron
  Playwright journeys, every workspace production build, `git diff --check`, and the production
  dependency audit with no known vulnerabilities. A fresh macOS arm64 app, ZIP, DMG, and blockmaps
  packaged successfully; both packaged-app and read-only DMG mount/copy/launch smokes passed, with
  the latter returning `FORGEBOARD_SMOKE_OK`. The DMG SHA-256 is
  `d2e28ae86006227f47ce0944373afb2e7e17701e68759f05b0a164c80ba95dbe`; the ZIP SHA-256 is
  `e20fc2e7701364493fa42a865fd6729327e781e6e900cc94fe5105a8457e4458`. Signing and notarization
  remain inactive because this machine has no Developer ID identity.
- 2026-07-17: completed managed terminal-agent worktrees gained a separate operational Git / PR
  canvas node. The renderer selects only an opaque persisted run and ordinary delivery fields;
  Electron main resolves ownership, repositories, branches, object IDs, the exact effective push
  URL, committed impact, deterministic readiness evidence, and human approval. A push plan sends
  one approved object ID to one full branch ref with normal non-force semantics after an expiring,
  owner-bound UI review and cancel-default native confirmation. Main revalidates source, remote,
  readiness, and complete object availability before destination contact; disallowed hooks,
  rewrites, ambiguous destinations, shallow history, and Git LFS pointer history fail closed. Local
  merge/cherry-pick and remote push now share the same rule that selected deterministic checks and
  exact human quality approval govern delivery; AI and reviewer results remain non-authoritative.
  Optional, explicit `gh` actions pin the resolved local executable, confirm each network read or
  mutation natively, verify GitHub host/repository/base/head identity, send the disclosed PR body
  through standard input, validate returned URLs, and show only CI runs matching the complete source
  SHA. The UI explicitly warns that GitHub pull requests follow a branch and can race or move after
  the point-in-time recheck. Automated remote coverage used local deterministic `gh` and SSH
  fixtures and made no real GitHub mutation.
- 2026-07-17: the frozen remote-delivery checkpoint passed the 850-file structure gate, keeping
  every checked source/config file at or below 2,000 lines, every maintained folder at 12 or fewer
  direct hand-written files, and the root allowlist clean. Repository-wide Prettier, zero-warning
  ESLint, all eight workspace strict typechecks, `git diff --check`, 1,622 unit tests across 246
  files, 242 integration tests across 29 files, all 13 Electron Playwright journeys, every
  production build, and the production dependency audit passed. The focused Electron journey
  proves cancel and approve paths for exact push and PR actions plus exact-head CI without external
  web traffic. A fresh macOS arm64 application, ZIP, DMG, and blockmaps packaged successfully; both
  the packaged-app smoke and read-only DMG mount/copy/launch smoke passed, with the latter returning
  `FORGEBOARD_SMOKE_OK`. The DMG SHA-256 is
  `ced0aacd6ad94703c25953f18b1ffa145e0582d928d483efb3ec87c301eb68d6`; the ZIP SHA-256 is
  `7fb04d112991bb0dc30d9bbefc2abc08e7695b8b413c04575a43524f253505b9`. Electron Builder found no
  Developer ID, and strict code-signing/Gatekeeper verification fails for this ad-hoc executable,
  so signing, notarization, GitHub Release publication, and fresh Windows/Linux installer proof
  remain unchecked. Adding/editing remote URLs and choosing a custom `gh` executable also remain
  unfinished UI configuration. Hosted Actions are not counted as evidence because the repository's
  billing/payment gate currently stops jobs before any workflow step executes.
- 2026-07-17: **Settings → Git & previews → Git connections** gained complete UI-managed
  configuration for ordinary project remotes and the optional GitHub CLI. Users can inspect
  path-free remote identities; add credential-free HTTPS/SSH or natively selected local Git targets;
  replace a simple managed remote URL; and remove an exactly reviewed repository-local remote
  section and its disclosed tracking refs. Each action uses an owner-bound, expiring, single-use
  renderer review plus a separate cancel-default native confirmation and applies independently of
  **Save settings**. Main rechecks the live window, project, repository, configuration, selected local
  destination, and final mutation authority. Add, replace, and remove share Git-compatible config
  locking, exact-byte preservation, async and final synchronous compare-and-swap checks, safe
  rollback when ownership is provable, and explicit uncertain-outcome recovery when it is not;
  removal also uses one exact-OID ref transaction. Concurrent remote and GitHub CLI changes share one
  main-owned admission so neither can reopen delivery while the other is active. Settings can select
  automatic discovery or a custom `gh`; the device-local binding survives restart, never enters
  portable export, and is content-bound with bounded SHA-256 hashing. Passive automatic discovery is
  unverified after restart or privacy reset and cannot run authentication/API commands until an
  explicitly confirmed, credential-free literal `--version` validation succeeds for that exact path
  and digest. GitHub status, PR, and CI then use the selected identity-guarded runner. Native
  filesystem/executable paths remain outside renderer views, and failure/cancellation never produces
  a fake success state. This supersedes only the preceding checkpoint's unfinished remote/custom
  `gh` UI limitation; broad unchecked product, release, signing, and cross-platform items remain open.
- 2026-07-17: the frozen Git-connections source checkpoint
  `4b09b9f4efef079e9a05c856928a5fd2b71c934d` passed the 899-file structure gate,
  repository-wide formatting, zero-warning lint, all eight workspace strict typechecks,
  `git diff --check`, 1,743 unit tests across 258 files, 270 real-process integration tests across 31
  files, all 15 Electron Playwright journeys, every production build, all 15 release-script tests,
  and the production dependency audit with no known vulnerabilities. The UI journeys prove Enter in
  Git connection inputs cannot submit the outer Settings form; cancel/approve add, exact replace and
  removal, native-only local-path disclosure, custom-CLI validation and restart persistence, reviewed
  return to automatic discovery, and UI-configured remote delivery through the selected CLI without
  unintended external web traffic. Fresh packaging from that clean commit produced the macOS arm64
  application, ZIP, DMG, and both blockmaps. The packaged-app smoke and read-only DMG
  mount/copy/launch smoke passed, the latter with `FORGEBOARD_SMOKE_OK`; `RELEASE-INFO` records the
  exact source commit and unsigned-development state. All four checksummed files passed independent
  SHA-256 verification, and `hdiutil` validated the DMG. The DMG SHA-256 is
  `d716aac8f71097ac02acd591e6ed27e76583689eb0e2e56c53ab7f3d7ad61f3c`; the ZIP SHA-256 is
  `fad932874c77e0ba0bd89827ee94a2d53860c7014d027622517ae9b665b57d6a`. Electron Builder skipped
  Developer ID signing; the executable is ad-hoc/linker-signed, strict code-signing and Gatekeeper
  assessment fail, and neither the app nor DMG has a notarization ticket. Fresh Windows, Linux, and
  macOS Intel proof remains open. Forgeboard validates and uses `gh` but does not install it or
  authenticate the user. An operating-system or process interruption inside the remote config
  transaction can leave its Git lock/recovery staging artifact, and UI repair for that state is not
  implemented. At this checkpoint the repository was private with no tags or GitHub Release, so
  there was not yet a public download. Hosted Actions remained excluded because the billing/payment
  gate stopped jobs before any workflow step executed.
- 2026-07-17: Interactive Terminal nodes gained complete ordinary-user configuration in the
  inspector: native executable selection, literal argument rows, project-relative cwd, and
  Settings-allowlisted environment names. Every launch uses an expiring single-use renderer review
  and a separate cancel-default native confirmation showing the exact canonical executable,
  arguments, working directory, environment names, and unsandboxed host boundary. Main rechecks
  project/cwd containment, symlinks, executable identity, settings authority, collaboration
  owner/editor role, plan expiry, and the originating window immediately before a real `node-pty`
  spawn. Reviewer and viewer roles cannot pick, prepare, confirm, type, or resize through IPC;
  owner-bound interrupt and terminate remain available as local safety controls after a role
  downgrade. The xterm surface supports ANSI, raw input, responsive resize, search, clear-display,
  history selection, replay, restart, interrupt, and terminate. UI-authored configuration persists
  across a real app restart; path-free and argument-redacted history rows point to private JSON-lines
  transcripts bounded to 16 MiB per session, 256 MiB and 10,000 files globally, with bounded replay,
  retention pruning, privacy deletion, honest missing-history disclosure, 1 MiB coalesced live-output
  admission, and restart/shutdown recovery to `lost` rather than fictional live processes.
  Persistence failures, post-spawn checkpoint failures, unconfirmed stop attempts, fast PTY exit,
  and output floods keep lifecycle cleanup deterministic and never fabricate success. This closes
  only the Interactive Terminal node entry; broader preview, node-registry, workflow, and release
  requirements remain open.
- 2026-07-17: the frozen Interactive Terminal source checkpoint
  `495030d8073b36f227152920723d8d6804710308` passed the 934-file structure gate, repository-wide
  formatting and zero-warning lint, all eight workspace strict typechecks, 1,799 unit tests across
  268 files, 271 real-process integration tests across 32 files, every workspace production build,
  and `git diff --check`. Direct Terminal IPC coverage proves reviewer/viewer denial,
  owner/editor admission, role downgrade during native confirmation and immediately before spawn,
  read-only history access, and the owner-bound stop-control exception. The focused Electron journey
  proves UI-only configuration, renderer cancellation, exact native review, real ANSI/raw PTY I/O,
  exit/history, a full app close and restart with configuration persistence, reviewed restart, and
  confirmed termination without external web traffic. Fresh packaging from that commit rebuilt the
  native `node-pty` dependency and produced the macOS arm64 application, ZIP, DMG, and both blockmaps.
  Packaged-app and read-only DMG mount/copy/launch smokes passed, the latter with
  `FORGEBOARD_SMOKE_OK`; release metadata records the exact source commit and
  `unsigned-development` status, all four distributables passed independent SHA-256 generation, and
  `hdiutil` validated the DMG. The DMG SHA-256 is
  `17cd2c054b1ed0d054f8b96dc4fdd88334941e6633d69c890b7f04b89c93637a`; the ZIP SHA-256 is
  `09681a91fd0b956d08ae33ee012838da39d67810646648e32380620bad14ce8e`. Electron Builder found no
  Developer ID identity, so the executable remains ad-hoc/linker-signed and Gatekeeper assessment
  fails. The full multi-journey Electron suite was not rerun for this checkpoint; the dedicated
  Terminal journey passed. Fresh Windows/Linux/macOS Intel artifacts, signing/notarization, public
  repository visibility, a tag, and GitHub Release publication remain open.
- 2026-07-17: Web Preview and Mobile Preview nodes gained durable UI-only target, command, working
  directory, readiness/initial-path, device, rotation, and side-by-side configuration. Targets are
  either the primary checkout or an opaque, application-owned active agent run; renderer views never
  receive a worktree path. Main launches only exact argument arrays in the resolved checkout after a
  cancel-default native review, owns the loopback server lifecycle, and exposes a sandboxed
  `WebContentsView` with Node and preload access disabled. Surface policy denies permissions, popups,
  downloads, webviews, non-loopback traffic, and cross-origin/port navigation; bounds are intersected
  with the visible renderer stage so native content cannot cover trusted controls. Browser console
  capture is redacted, memory-bounded, and notification-coalesced. Navigation, history, reload,
  native-reviewed PNG screenshots, and exact-URL external opening are audited without filesystem
  paths or raw URLs. Phone/tablet frames enable real Chromium touch emulation after the approved page
  loads; collaboration reviewer/viewer mode blocks configuration and surface mutation while retaining
  Stop and Close safety controls. The dedicated Electron journey proves UI configuration, exact
  native launch review, real native page content and navigation, blocked outbound navigation, browser
  console capture, screenshot output, restart/stop, two simultaneous mobile surfaces, touch-confirmed
  UI state, and no unintended external request. A real integration uses one project with two durable
  owned worktrees to prove distinct roots/content/ports, independent restart, preservation, cleanup,
  and restart persistence. The 967-file structure gate, repository formatting, zero-warning lint,
  eight strict workspace typechecks, 1,843 unit tests across 277 files, 273 real-process integration
  tests across 32 files, all workspace production builds, and `git diff --check` passed. This closes
  the isolated web/mobile preview entries only; one simultaneous comparison surface bound to multiple
  competing worktrees, exact fixed device-metric scaling inside a clipped stage, broader product
  items, cross-platform installers, signing/notarization, and public release remain open.
- 2026-07-17: the frozen preview source checkpoint
  `9e9ce8193ea7a4d46377d2fbc1356d59b01cf8a3` produced a fresh macOS arm64 application, ZIP, DMG,
  and both blockmaps after rebuilding the native `node-pty` dependency. The packaged-application
  smoke and read-only DMG mount/copy/launch smoke passed, the latter with `FORGEBOARD_SMOKE_OK`;
  release metadata records the exact source commit and `unsigned-development` status. All four
  distributables received fresh independent SHA-256 entries, and `hdiutil` validated the DMG. The
  DMG SHA-256 is `b76d145af597e94a738b13c6ccd8af127cf54395152fb3950ae29e1de35f7967`;
  the ZIP SHA-256 is `428dadf5d49c3aa03efeca71108e5418d49b061342bdf6010f23e633194ecbc9`.
  Electron Builder found no Developer ID identity, so the executable is ad-hoc/linker-signed;
  strict code-signing and Gatekeeper assessment fail. Fresh Windows/Linux/macOS Intel artifacts,
  signing/notarization, repository visibility, a tag, and GitHub Release publication remain open.
  Hosted Actions remain excluded because the billing/payment gate stops jobs before workflow steps.
- 2026-07-17: the Infinite Canvas now persists pure pan/zoom changes through the existing bounded
  autosave path and explicitly restores the saved finite viewport without mount-time `fitView`
  overriding it. Reviewer/viewer navigation remains usable but cannot mutate shared graph state.
  Every node also has private on-device comments in solo and multiplayer sessions; historical
  unscoped comments fail closed as private, only explicitly shared comments enter collaboration
  metadata, and room merges preserve local comments without publishing their text. Shared comment
  authoring remains role-authorized and clearly separated in the inspector. Focused coverage passed
  174 tests across 25 files, including viewport bounds/restore, editable versus read-only movement,
  local/shared projection and merge behavior, solo/reviewer/viewer UI, failure truthfulness, and a
  real SQLite restart. The modular Electron journey passed in 18.8 seconds and proves search/center,
  minimap/fit, modifier multi-select, two-node keyboard movement, copy/paste/duplicate, locked-node
  immobility, private comment creation, pure viewport autosave, full app relaunch with exact
  normalized viewport/comment/graph restoration, and zero external requests. The 980-file structure
  gate, desktop strict typecheck, configured formatting, zero-warning focused lint, and
  `git diff --check` passed. This closes the broad Infinite Canvas interaction entry only; the unified
  extensible renderer registry and universal run-history behavior remain open.
- 2026-07-17: the Test node now has complete UI-only exact-process configuration for saved or custom
  commands, literal arguments, checkout-relative working directory, allowlisted environment names,
  check kind, and up to 32 expected artifact paths. The main-owned workflow runtime streams bounded
  stdout, stderr, and lifecycle events; parses consistent Vitest, Jest, pytest, TAP, and generic
  summaries; stores every workflow-bound attempt beyond the project recency window; restores results
  after database and application restart; and exposes exact queued, running, waiting-for-approval,
  paused, cancelling, failed, succeeded, cancelled, and lost states without lossy projection.
  Owner/editor authorization is rechecked after native confirmation and again inside serialized
  per-node cancellation, while reviewer/viewer roles retain read-only history. Artifact collection
  accepts only configured, regular, no-follow, non-sensitive files inside the exact assigned checkout,
  records size and SHA-256, revalidates identity before every action, and opens an application-owned
  verified copy so source-path replacement cannot race the operating-system open. Current and older
  attempts expose complete raw output, parsed counts, and verified Reveal/Open actions. Real-process
  integration proves two genuine attempts, stdout/stderr streaming, summary persistence, regular-file
  hashing, sensitive and symlink exclusion, host/database restart projection, and exact subprocess
  cancellation. The dedicated Electron journey passed in 4.0 seconds and proves UI configuration,
  exact renderer and native disclosure, live output and summary while Running, native-confirmed
  cancellation, retained Cancelled history, passing rerun, verified artifact actions, full Electron
  restart restoration, and zero external renderer requests. Repository gates passed the 998-file
  structure check, formatting, zero-warning lint, all eight strict workspace typechecks, 1,879 unit
  tests across 286 files, 275 real-process integration tests across 32 files, every workspace
  production build, and `git diff --check`. Integration was scheduled with two workers because the
  host was simultaneously CPU-constrained; assertions and timeouts were unchanged. This closes only
  the Test node entry; the broader Review gate, workflow controls, and release requirements remain
  open.
- 2026-07-17: the frozen Test-node source checkpoint
  `cec6bdb722808206d2e88cb2e5dfb847ecc71b91` produced a fresh macOS arm64 application, ZIP, DMG,
  and both blockmaps after rebuilding the native `node-pty` dependency. The packaged-application
  smoke and read-only DMG mount/copy/launch smoke passed, the latter with `FORGEBOARD_SMOKE_OK`;
  release metadata was regenerated and independently verified against the exact source commit.
  All four distributables received fresh SHA-256 entries, and `hdiutil` validated the DMG. The DMG
  SHA-256 is `4cd0dd2a1460cfc94e58a2c4d9bbd2aaf23a4ccda9650d824457c73ca365d2f3`; the ZIP SHA-256 is
  `908748178b006f7f0c10e9c0437e8fe704ebea147f9c1c56763ab0267e306125`. Electron Builder found no
  Developer ID identity, so the executable remains an unsigned development artifact. Fresh
  Windows/Linux/macOS Intel artifacts, signing/notarization, a tag, and GitHub Release publication
  remain open; hosted Actions are still blocked before workflow steps by the account billing gate.
- 2026-07-17: Codex CLI and Claude Code gained OAuth-first, UI-only provider connections in
  onboarding and Settings. Forgeboard invokes each official CLI's browser sign-in, status, and
  logout commands only after a cancel-default native review bound to the exact executable path,
  SHA-256, literal arguments, working directory, environment names, provider, and network
  disclosure. The provider CLI owns OAuth credentials; Forgeboard neither receives nor stores
  tokens, reads provider auth stores, proxies model traffic, nor exposes raw status output or account
  identity across IPC. Connection plans are owner-bound, single-use, expiring, cancellable, and
  revalidate executable identity before launch. Restart restores only an honest Needs refresh state;
  explicit reviewed Refresh, Disconnect, and Reconnect actions produce normalized status and
  redacted audit evidence. Optional executable/model/readiness controls remain under Advanced. The
  Electron journey passed repeatedly and proves native cancellation without a subprocess, exact Codex and
  Claude argument sequences, connected state, unsaved executable binding, passive restart with zero
  automatic commands, explicit refresh/disconnect/reconnect, redacted audit UI, and zero external
  renderer requests. Focused provider contracts, main, preload, UI, and fixture coverage passed
  23 tests; the production desktop build and strict typecheck passed.
- 2026-07-17: the Agent-node milestone gained UI model selection, exact capability disclosure, live
  output/input/interrupt controls, durable per-node attempt history, structured token/cost evidence,
  and renderer-redacted provider identifiers. Retry always creates a fresh reviewed worktree; resume
  is limited to interrupted attempts with an exact persisted provider session and revalidated
  repository/worktree/base/branch authority. Continuation transfers worktree ownership atomically,
  supersedes the parent, preserves primary-checkout isolation, and requires a fresh native approval.
  The deterministic test adapter supports exact bounded resume-session arguments, and malformed or
  duplicate identifiers fail closed. A production Electron journey passed and proves streaming,
  input, interrupt, automatic terminal history refresh, same-worktree resume, fresh-worktree retry,
  full application restart restoration, lineage, output, usage/cost, an unchanged primary checkout,
  and zero external requests. Focused Agent runtime, authority, history, renderer, continuation,
  storage, and compatibility coverage passed. The broad Agent node checklist item remains open
  because real pause support is still unavailable and the UI says so rather than presenting a fake
  control.
- 2026-07-17: Agent execution now enforces persisted lock/group protection and collaboration mutation
  authority in both renderer and main for configuration, launch, retry, resume, input, and interrupt,
  while retaining owner-scoped emergency termination. Exact run lookup prevents older superseded
  attempts from receiving input; approval revalidates the saved node, context, window, and role before
  native review, after native review, and again at the immediate process-spawn boundary. Restart-stale
  canvas activity reconciles against the exact durable attempt with stale-response guards and bounded
  retry, so a dead child is not presented as alive. Provider token metadata preserves input, cached
  input, output, and total-only reports without manufacturing missing values, remains finite JSON, and
  Agent-specific configuration edits create undo checkpoints. Context edges can now supply ordered,
  digest-bound Product Brief, Task, Mermaid Diagram, and Note snapshots alongside explicit File nodes.
  Generated context is size-bounded before approval, omits unselected referenced paths/hashes, works
  through host and Docker private read-only snapshots, is revalidated immediately before launch, and
  is removed from active runtime memory after binding. The rebuilt offline Electron journey passed in
  16.8 seconds and proves UI lock enforcement, streaming, input, interruption, resume, retry, restart
  restoration, primary-checkout isolation, and zero external requests. Repository verification passed
  the 1,058-file structure gate, formatting, zero-warning lint, all eight strict typechecks, all
  workspace builds, 1,987 unit tests across 307 files, and 280 real-process integration tests across
  32 files. The broad Agent node item remains open solely because a real pause/continue backend is not
  yet available; Forgeboard continues to expose that limitation honestly.
- 2026-07-17: agent-authored Review edges and reviewer-backed Review Gates now use a strict,
  main-composed assessment protocol instead of user-authored identifiers or prose parsing. Reviewer
  runs switch only Codex and Claude into their official headless JSON event modes while ordinary
  Agent runs retain interactive PTY behavior. Forgeboard accepts one exact current-attempt final
  record only after the matching
  provider terminal and successful process result, and rejects stderr lookalikes, prose/fences,
  duplicate or later assistant output, mixed Claude tool content, and failed or incomplete runs.
  Reviewed changes are captured as bounded, digest-bound UTF-8 snapshots, persisted with the exact
  source run/attempt, and injected through the existing private immutable context pipeline rather
  than command-line prompt content. Sensitive, binary, deleted-without-prior-content, aliased,
  truncated, oversized, and over-count artifacts fail closed; persisted review artifacts have a
  32 MiB aggregate cap. Gate evaluation and renderer state now project the same current causal check,
  reviewer, human, finding, and blocker evidence from main, with saved renderer gate state treated as
  non-authoritative. Verification passed the 1,059-file structure gate, formatting, zero-warning
  lint, all eight strict typechecks, 1,998 unit tests across 308 files, 280 real-process integration
  tests across 32 files, and every workspace production build. Review Gate delivery binding and the
  end-to-end reviewer/revision Electron journey remain open, so the broad checklist entry is not yet
  marked complete.
- 2026-07-17: Git delivery readiness is now bound to one exact succeeded workflow execution, source
  node attempt, output digest, and the complete current set of relevant Review Gates. Main derives
  mandatory lint/test/custom check IDs from gate configuration; the renderer can select only bounded
  main-authored compatible executions, cannot remove gate-required checks, and may add only optional
  configured checks. Failed, ambiguous, stale, or mixed-source gates fail closed even when another
  relevant gate passed. Workflow and Git source authority are revalidated before and after
  asynchronous discovery, and the immutable binding participates in readiness persistence, human
  approval evidence, push/PR, merge, and cherry-pick revalidation. The append-only SQLite migration
  removes only obsolete pre-binding readiness and approvals while preserving projects, runs, and
  strict corruption detection. Verification passed the 1,061-file structure gate, formatting,
  zero-warning lint, all eight strict typechecks, 2,012 unit tests across 309 files, 282 real-process
  integration tests across 32 files, every workspace production build, and `git diff --check`. The
  broad Review Gate node and typed-workflow entries remain open pending the dedicated
  reviewer/revision Electron journey and the remaining lifecycle controls.
- 2026-07-17: release metadata now derives signing status from post-package platform verification
  instead of credential presence. macOS requires a valid Developer ID signature, strict/deep
  verification, exact configured Apple team identity, and a stapled DMG ticket before claiming
  notarization; Windows requires a valid Authenticode signature and signer certificate. Configured
  signing that lacks the expected proof fails closed, while unsigned development output remains
  labeled honestly. Twenty-six release/startup tests, the structure gate, lint, formatting, and diff
  validation passed. Public GitHub Release publication, repository visibility, account billing,
  production signing secrets, and fresh hosted cross-platform artifacts remain external/open work.
- 2026-07-17: native installer smoke now fails before installation unless the exact platform and
  architecture release metadata binds the artifact set to the expected 40-character source commit,
  uses an allowed platform signing status, and every top-level distributable and blockmap has an
  exact SHA-256 entry whose bytes still match. Caller-resolved installer paths must be the declared
  files under the release root. The Release workflow generates checksums before packaged and native
  smoke, and treats both `v0.*` and hyphenated version tags as prereleases. Ten focused integrity
  tests and all six standalone release-artifact tests passed. Hosted publication, signing and
  notarization, and fresh native Windows/Linux installer proof remain unchecked.
- 2026-07-17: **Settings → Connectivity → Application updates** now exposes persisted
  stable/prerelease/disabled channels and an explicit Check for updates action. A native disclosure
  gates the fixed official GitHub Releases API request; the main process enforces a one-MiB response
  limit, ten-second deadline, no redirects or compressed responses, strict release contracts and
  version ordering, cancellation, per-window concurrency, five-minute release authority, and a
  second native review before opening the exact release page. Forgeboard never downloads or installs
  an update automatically, and any imported legacy automatic-download preference is labeled inactive
  and can be cleared in the UI. Twenty-seven focused transport, service, preload, shared-contract,
  renderer, and installer-integrity tests passed. The broad Settings requirements and public release
  lifecycle remain unchecked.
- 2026-07-17: **Settings → Agents & runtime → Process launching** now exposes the required default
  Terminal executable as an ordinary UI setting with direct editing and a native executable picker.
  Save is blocked until passive evidence for the exact current value is ready; main uses the same
  direct PTY executable-resolution rules as reviewed Terminal launches without starting a process or
  depending on the open project. Empty legacy values repair to the safe platform default, and new
  Terminal nodes inherit the saved executable while existing nodes retain their own reviewed command.
  Seventy-four focused shared-schema, repair, import, readiness-service, Settings, and node-default
  tests across eight files passed. This closes only the terminal-default slice; the broad Settings
  and zero-code configuration entries remain unchecked.
- 2026-07-17: canvas nodes gained a real context menu backed by the existing explicit-node graph
  mutations for Inspect, collapse/expand, lock/unlock, duplicate, and delete. It opens by right-click,
  the Context Menu key, or Shift+F10; clamps within the canvas; supports Arrow, Home, End, Escape, and
  Tab behavior; restores focus; and preserves undo, read-only collaboration authority, inherited
  group locks, protected deletion, preview cleanup, membership reconciliation, and automatic frame
  fitting. Forty-one focused component, canvas-action, and shell-persistence tests across five files
  passed, including real target binding, preview cleanup, authority rejection, protected-group, and
  duplicate/delete undo proof. Context actions were also split into feature modules, reducing the
  main Workspace component from 1,996 to 1,781 lines. The broad contextual-menu/polish and
  shared-node behavior entries remain unchecked.
- 2026-07-17: README, release guidance, security documentation, privacy disclosure, and prepared
  v0.1.0 notes now describe the existing explicit check-only updater consistently: fixed official
  GitHub endpoint, native review, no background polling, no automatic download/install, second review
  before opening a validated release page, and no assumption that a public release exists. The
  broad documentation and release-publication entries remain unchecked. Across the terminal-default
  and context-menu slices, all 146 focused tests in fourteen files passed. Repository verification
  passed the 1,088-file structure gate, formatting, lint, all eight workspace typechecks, 2,089 unit
  tests across 319 files, and every workspace build. The parallel integration run passed 282 of 286
  tests; four unchanged long-running Git tests timed out under contention, then all three affected
  files passed sequentially (43 of 43 tests). `git diff --check` also passed.
- 2026-07-17: startup database recovery now fails closed instead of silently creating a replacement
  database when an initialized profile loses, corrupts, or receives a foreign primary database.
  The native cancel-default flow can choose one verified SQLite backup; Forgeboard stages and hashes
  it without modifying the source, proves an exact migration-aware schema and audit-trigger
  provenance, then installs it through a durable journal with byte-exact rollback, interrupted-startup
  reconciliation, and path-free audit evidence. A private durable initialized-profile marker
  distinguishes genuine first run from missing data, cleanup failures cannot turn a committed restore
  into false failure, and bounded deferred cleanup retries safely on the next startup. Windows uses a
  bundled Node-API authority for write-through directory publication and moves, with real Node and
  Electron execution wired into hosted Windows CI; local macOS verification correctly skips those
  Windows-only native calls. The focused recovery suites passed 115 tests; the complete unit suite
  passed 2,203 tests across 329 files; the complete integration suite passed 304 tests across 34
  files; and formatting, zero-warning lint, all workspace typechecks, every production build, and the
  1,117-file structure gate passed. A fresh packaged macOS application and its production startup
  smoke passed, and the startup/product and adversarial security audits returned GO. The broad
  database-failure Electron E2E checklist item remains open pending its dedicated visible chooser,
  rejection, cancellation, rollback, and interrupted-recovery journey.
- 2026-07-19: startup provenance now recognizes only the exact historical audit schema that is
  missing both controlled-delete triggers while every other normalized schema object, migration
  ledger entry, and SQLite integrity check remains exact. The writable startup connection rechecks
  the complete audit chain and that precise two-trigger gap before installing both guards inside a
  savepoint; one missing trigger, any other schema drift, or any audit-chain damage still fails
  closed. The real startup adapter regression proves the local database opens without offering
  destructive recovery, preserves audit evidence, and restores both append-only protections. The
  focused provenance, audit-integrity, and startup-composition suites passed all 36 tests. This is a
  narrow development-schema compatibility repair and does not close the broader visible recovery
  E2E checklist item.
- 2026-07-17: every authoritative node context menu now includes **Run with dependencies** using the
  same workflow eligibility and scope resolution as the toolbar. The action targets the exact
  context-clicked Agent, runnable Task, Test, Review Gate, human Diff, or Group even when another
  node was selected; includes upstream dependencies; and preserves the existing workflow controller
  as the only execution authority. Ineligible Tasks and node kinds expose the exact eligibility
  reason, while workflow activity, graph read-only state, and workflow-specific collaboration
  authority disable the action without emitting a run or graph mutation. Keyboard navigation,
  menu dismissal, focus restoration, and undo state remain unchanged. Forty-three focused menu,
  canvas, and shell-persistence tests passed alongside desktop typecheck, focused zero-warning lint,
  formatting, and the 1,117-file structure gate. The broader lifecycle-controls item remains open
  for real Agent pause/continue and complete node/edge lifecycle coverage.
- 2026-07-17: **Settings → Connectivity** now persists an explicit validated collaboration
  management API URL and supports two deliberate join paths: invite-link redemption and the advanced
  direct access-token flow. Invite redemption, owner-only role/lifetime/use-limited creation,
  cancel-default native clipboard copy, and revocation are bound to the exact live window, connected
  room, role, server, and management endpoint. Invite links and access credentials stay in volatile
  main-process authority; preload rejects token-bearing management responses, renderer rows contain
  only safe session metadata, pasted credentials clear after every attempt, and leave/reset/quit
  clear the session authority. One hundred fifty-four focused shared-contract, main-operation,
  preload-bridge, Settings, renderer, import/export, and legacy-repair tests passed across fifteen
  files. The repository-wide 337-file/2,266-test unit suite and 34-file/304-test integration suite
  also passed alongside strict workspace typecheck, zero-warning lint, formatting, production build,
  `git diff --check`, and the 1,144-file structure gate. A dedicated Electron journey now builds and
  launches the production
  collaboration server on an ephemeral loopback port, covers direct owner join, cancel-default
  create/copy/revoke disclosures, rejected redemption of a revoked invite, valid second-profile
  viewer redemption, role enforcement, credential clearing, and absence of external requests; its
  focused Playwright run passed alongside the 1,144-file structure gate. The broad Settings entries
  remain unchecked, as do desktop room bootstrap, membership administration, room audit UI, and
  durable server-wide invite listing.
- 2026-07-18: **Settings → Connectivity → Room administration** now creates or recovers an owner
  room, renews the live owner credential without replacing the Yjs document, pages members and audit
  events, changes roles with version-safe conflict handling, and revokes members entirely through
  visible controls. Every management request has a cancel-default native outbound review; returned
  owner credentials and retry authority remain main-process-only, administrator input is volatile,
  token-bearing responses are rejected at preload, and server replay records contain no bearer
  secrets. Durable UUID idempotency is room/server scoped and cleared on session replacement;
  destroyed windows cannot retain an in-flight owner response; refreshed JWT claims must exactly
  match the active room and response metadata; and awareness client IDs are socket-bound so a member
  cannot publish an empty identity, spoof another identity, or remove another client's presence.
  The complete unit suite passed 2,316 tests across 343 files, the complete sequential integration
  suite passed 310 tests across 35 files, and both real two-profile Electron collaboration journeys
  passed. Formatting, zero-warning lint, all workspace typechecks, every production build including
  the built collaboration-server startup smoke, `git diff --check`, and the 1,168-file structure gate
  also passed. Broad Settings coverage and durable server-wide invite listing remain unchecked.
- 2026-07-18: ordinary configuration is now exhaustively inventoried: every one of the 57 persisted
  application settings is compile-time classified as UI-controlled, first-run-controlled, or a
  visible clear-only legacy preference, so adding an unplaced setting fails a test. A fresh-profile
  Electron journey configures every Settings category without editing source, env, or config files;
  proves validation; saves and survives restart; exports through a native chooser; persists restored
  defaults; rejects an imported machine path until it is valid; and imports the prior configuration
  back through the UI. This establishes a regression baseline for the broad zero-code and Settings
  requirements while keeping their exhaustive integration-action checkboxes open pending direct
  control/action mapping evidence. Provider CLI, `gh`, Docker-engine, hosted-collaboration, and
  signing installation remain honest optional external prerequisites. The Settings inventory unit
  test and focused Electron journey passed.
- 2026-07-18: default solo networking now has both static capability inventory and a pre-main
  Electron tripwire. Before the production main entry imports, the fixture guards main-process
  `fetch`, HTTP(S), sockets, WebSockets, and Electron session requests, then proves first launch,
  safe defaults, safe demo, idle time, shutdown, and relaunch attempt none of those network paths,
  including loopback destinations. The
  architecture gate also enumerates indirect collaboration fetch injection and Hocuspocus transport
  construction behind reviewed outbound authority. Its four focused architecture tests, desktop
  typecheck, and the first-launch/relaunch Electron journey passed.
- 2026-07-18: collaboration awareness now accepts harmless strictly stale foreign echoes while
  rejecting equal-clock identity spoofing and removal. A real three-provider server integration
  regression exercises rapid awareness updates, verifies convergence for every participant, and
  proves cleanup after disconnect; it passed in the full ten-test collaboration-server integration
  suite and five additional isolated repetitions. The broad multiplayer E2E requirement remains
  open pending a combined user-interface journey.
- 2026-07-18: canvas undo and redo now survive full desktop-process restarts through a dedicated,
  local SQLite history record saved atomically with the current canvas. The record is bound to the
  exact project, canvas, and current-content digest; stale, malformed, restored, imported, or deleted
  state fails closed instead of replaying against the wrong graph. History keeps the nearest 50 undo
  and redo checkpoints, deterministically sheds distant checkpoints at its 16 MiB storage bound,
  participates in extension sanitation and transcript retention, and remains separate from user
  recovery snapshots and portable exports. Fourteen focused contract, storage, controller, and
  workspace tests, 28 existing recovery tests, desktop typecheck, focused zero-warning lint,
  formatting, production build, `git diff --check`, and the 1,181-file structure gate passed. A
  production Electron journey also proved Undo after one full restart, Redo after another, and zero
  external requests. The aggregate checklist item remains open pending dedicated moved-project
  recovery journey evidence.
- 2026-07-18: a direct moved-project Electron journey now completes the aggregate persistence
  requirement. It opens a real temporary project through the UI, creates and deletes a node to leave
  a durable undo checkpoint, fully closes Forgeboard, moves the folder on disk, and relaunches with
  the same local profile. The welcome screen detects the missing folder; the native Locate chooser
  discloses its exact directory-only options; the in-app review shows canonical old/new paths and
  preservation scope; Cancel leaves the saved location unchanged; and explicit reconfirmation opens
  the relocated project with its current empty canvas and Undo history intact. Undo restores the
  deleted node, proving identity-bound canvas and history preservation through relocation, while the
  journey records zero external requests. The focused Electron journey passed alongside
  `git diff --check` and the 1,182-file structure gate.
- 2026-07-18: malformed replace-import failure now has a full offline Electron regression. A named
  canvas node is flushed before the UI selects damaged JSON through the exact native import chooser;
  parsing fails before an in-app disclosure or native destructive confirmation can appear, and a
  full relaunch proves the original project and node are unchanged. The focused journey passed with
  zero external requests and the 1,183-file structure gate. This closes only the malformed-import
  failure category; the broad failure-E2E checkbox remains open for its other listed cases.
- 2026-07-18: every persisted application setting now has an exported compile-time mapping to its
  Settings tab, real accessible control or safe clear-only action, and validation/readiness class.
  The manifest covers all 57 keys: 54 active Settings controls, first-run completion through the UI,
  and the two inactive legacy preferences that can only be cleared. A real SettingsPanel regression
  renders conditional Docker, collaboration, backup, and legacy states and resolves every mapped
  control through the accessibility surface; the exhaustive inventory and complete 34-test
  SettingsPanel suite passed. Together with the existing save/restart/reset/export/import Electron
  journey, this closes the listed persisted-settings surface. The broader every-integration lifecycle
  checkbox remains open because OAuth sessions, collaboration tokens, extension authority, Git
  remotes, and similar device/project bindings intentionally require separate portability rules and
  direct action evidence rather than being copied into the settings document.
- 2026-07-18: an exported 18-surface integration-action manifest now maps provider OAuth, local CLI
  readiness, Git remotes and GitHub CLI discovery, Docker, collaboration, extensions, updates,
  backups, recovery, integrity, and approvals to their real UI routes, accessible controls,
  executable tests, authority scope, and export policy. Codex and Claude cards have distinct
  heading-bound accessible names and a two-provider lifecycle regression; renderer coverage now
  exercises extension install/update/remove review and update-check cancellation. Fifteen focused
  UI/manifest tests, desktop strict typecheck, zero-warning lint, formatting, and the 1,189-file
  structure gate passed. The broad lifecycle checkbox remains open because collaboration invite
  history is current-session rather than durable server-wide state.
- 2026-07-18: tag publication now fails closed on the complete four-platform `RELEASE-INFO` set and
  derives the visible GitHub Release title, leading warning, and per-platform signing summary from
  post-package Developer ID/notarization and Authenticode evidence. Prepared notes no longer make a
  static unsigned claim that could contradict signed artifacts, and maintainer documentation now
  accurately states that a pushed tag publishes automatically only after all build jobs pass. The
  29 focused release tests, formatting, zero-warning lint, and structure gate passed. Installer and
  GitHub Release checklist items remain open pending hosted Windows/Linux/macOS evidence and actual
  publication after the repository billing/visibility and signing prerequisites are resolved.
- 2026-07-18: full-suite verification exposed and fixed two append-only migration assumptions from
  the persistent-history checkpoint. Startup extension sanitation and transcript retention now
  rewrite only history rows that actually exist, so they never synthesize a child row for a legacy
  canvas without a parent project; readiness migration fixtures locate their intended migration
  instead of assuming it remains last. The complete 2,341-test unit suite passed. The integration
  run passed 308 tests and its three fresh-worktree bootstrap failures passed after the installed
  Electron ABI dependency was exposed, covering all 311 integration cases. Repository-wide
  formatting, zero-warning lint, all workspace typechecks,
  the production build, `git diff --check`, and the 1,189-file structure gate passed.
- 2026-07-18: enabled or changed Docker profiles now fail closed until the exact executable, image,
  and in-container agent executable pass a recent main-process check. Renderer evidence is bound to
  the request that produced it, external draft changes and in-flight races clear or discard it, and
  save-time authority re-resolves and fingerprints the Docker executable before persistence. Failed,
  cancelled, expired, mismatched, and shutdown-invalidated checks cannot authorize a save; disabled
  dormant Docker preferences remain editable without starting Docker. The shared settings contract
  also rejects enabled host-credential mounting. One hundred twenty-two focused main, repair,
  shared-contract,
  onboarding, Settings, and renderer tests passed, including executable drift and stale-result
  regressions. The complete 2,352-test unit suite and production build also passed. The broad
  integration-lifecycle checkbox remains open for the durable collaboration-invite history gap
  recorded above.
- 2026-07-18: Settings now provides a dedicated `Check Git identity` action for the exact unsaved
  name/email draft, with an explicit selected-project Git-config fallback only when both fields are
  blank. The path-free preload contract accepts either exact normalized values or an opaque project
  ID; main-process authority resolves canonical stored project paths and round-trips temporary
  `git -c` overrides through the hardened Git runner without writing configuration or contacting a
  remote. Renderer evidence is session-only, request-bound, and discarded after field or project
  changes and in-flight races. Sixteen focused contract, service, preload, UI, and integration-action
  unit tests passed, and a real-Git integration test proved both draft and repository checks leave
  `.git/config` byte-for-byte unchanged while effective-identity rewriting is rejected. The complete
  2,366-test unit suite, all workspace typechecks, production build, zero-warning lint,
  `git diff --check`, and the 1,202-file structure gate passed. This closes the Git-identity
  integration-action gap; the broad lifecycle checkbox remains open only for durable server-wide
  collaboration invite history.
- 2026-07-18: owner-reviewed Refresh, Previous, and Next actions now page durable, room-isolated,
  token-free collaboration invite history with stable keyset cursors. Active, expired, exhausted,
  revoked, and signing-authority-invalidated rows remain visible across server restarts; legacy or
  rotated-key rows cannot redeem, consume the current-key active quota, expose Copy, or authorize
  revocation. Create, redeem, and active-invite revoke commit atomically with their audit event, and
  forced audit failures roll back every mutation. Owner-only HTTP responses and strict preload IPC
  reject token, link, signing-authority, state-invariant, and pagination leaks. Prior-session active
  rows can be revoked after explicit refresh, while Copy remains available only for an active link
  still held in current-process main authority; the renderer applies the server's exact revoked row
  instead of inventing a timestamp. The complete 2,380-test unit suite and 313-test integration
  suite passed, as did the focused invite-redemption and room-management Electron journeys. All
  workspace typechecks, production builds, zero-warning lint, repository formatting,
  `git diff --check`, and the 1,207-file structure gate also passed. This closes the final ordinary
  integration-lifecycle gap while retaining explicit never-export policies for secret-, device-,
  and project-bound authority.
- 2026-07-18: Mermaid Diagram nodes now provide UI-only Edit, Split, and Preview modes backed by
  the existing persisted `mermaidSource`, with stale asynchronous renders discarded as source
  changes. Mermaid runs with strict security, HTML labels disabled, and security-sensitive options
  locked against init directives; generated output is rebuilt through the inert SVG sanitizer and
  shown only as an encoded image, never injected into the Forgeboard DOM. External links, active
  markup, foreign HTML, event attributes, remote paint resources, and unsafe XML are removed or
  rejected. SVG export uses a cancel-default native save dialog, returns no path to the renderer,
  and is structurally revalidated against the same bounded inert subset in main before a private
  file write. Twenty-eight focused shared-contract, preload, renderer, sanitizer, malicious-directive,
  main-policy, and export tests passed, as did desktop typecheck, focused zero-warning lint, the
  production build, `git diff --check`, and the 1,226-file structure gate. This closes the Mermaid
  Diagram node item; the broad rich-editor item remains open for Excalidraw editing.
- 2026-07-18: saved-approval grant, use, and revoke transitions now own their canonical redacted
  `permission` audit event inside the same SQLite transaction. A failed audit insert rolls back a
  new grant, single-use consumption, and revocation; reusable authorization also fails closed when
  its required use event cannot commit. Caller-side duplicate audit writes were removed, and the
  service emits exact project/action/resource scope without approval reasons or actor identity.
  Focused approval, check IPC, Mermaid, SVG-policy, preload, and export
  tests passed, including forced audit-trigger failures that prove authority and audit-chain state
  remain unchanged together. The broader exhaustive security-event coverage item remains open.
- 2026-07-18: the local extension API is now re-audited as complete against current source and
  documentation. `docs/EXTENSIONS.md` specifies the strict v1 adapter and declarative canvas-node
  contracts, inferred least-privilege permissions, UI folder/manifest installation, native
  cancel-default review, trusted-ledger and snapshot integrity, quarantine/removal behavior, and the
  explicit prohibition on renderer JavaScript, HTML, CSS, Electron, or arbitrary Node entrypoints.
  Main, preload, renderer, and runtime implementations validate both request and response contracts,
  resolve active adapter authority again before launch, and render extension nodes only through
  Forgeboard-owned controls. Thirty-six focused schema, service, manager, IPC, node, and real UI
  integration-action tests passed.
- 2026-07-18: the existing Product Brief, Task, and Diff/Review node implementations were re-audited
  against their complete checklist contracts rather than their earlier partial milestones. Product
  Brief provides safe Markdown authoring/preview, checklists, explicit canvas attachments,
  acceptance criteria, reusable variables, and restorable version history. Task combines generic
  title/description with priority, status, agent assignment, typed dependency edges, criteria,
  local-file references, inherited permission disclosure, and node/selection workflow execution.
  Diff/Review binds the canvas node to the authoritative Git review surface with unified/split
  navigation, exact hunk stage/unstage/discard decisions, line comments, revision requests, and
  quality-gate approval evidence. Sixty-three focused content, workflow-inspector, eligibility,
  context-menu, diff-node, diff-viewer, and Git-review tests passed.
- 2026-07-18: the complete untrusted-content boundary was re-audited after Mermaid rendering landed.
  Preview pages run in a main-owned sandboxed `WebContentsView` with Node/preload disabled and strict
  loopback navigation, popup, permission, download, and bounds policies. Markdown is tokenized into
  Forgeboard-owned React elements; Mermaid runs with locked strict settings; generated/imported SVG
  is rebuilt into an inert allowlisted image document; and canvas JSON import is strictly parsed,
  canonicalized, integrity-checked, and committed transactionally. Eighty-one focused preview,
  URL-policy, Markdown, SVG, Mermaid, canvas-adapter, import, retention, and recovery tests passed.
- 2026-07-18: the top-level zero-code configuration requirement was reconciled with the already
  completed Settings and integration manifests. The renderer exposes all 57 persisted ordinary
  settings and every main-owned integration lifecycle action through validated UI controls,
  including native pickers/readiness checks for paths and executables, OAuth-first provider
  connections, Git/GitHub, Docker, previews, terminals, backups/recovery, extensions, collaboration
  rooms/invites, and updates. Portable non-secret configuration can be imported/exported, while
  secret-, device-, project-, and native approval authority remains intentionally reconnect-only or
  never-export. Text manifests, environment files, and hand-edited configuration remain optional
  advanced paths rather than prerequisites.
- 2026-07-18: Note/Image nodes now provide UI-only native choose, relink, and clear controls for
  project-local PNG, JPEG, GIF, and WebP references, preserve alternative text across recovery, and
  visibly explain that note context excludes image paths and bytes unless a File node is attached
  separately. Main-process path authority canonicalizes every selection beneath the current project,
  applies ignore/sensitive-file policy, rejects symlink escapes and disguised active content, and
  reads through one read-only/no-follow handle with an 8 MiB + 1 byte bound, before/after path and
  handle identity checks, revision stability, and Windows-safe canonical revalidation. The preload
  accepts only signature-matching bounded inline image bytes and binds the response to the requested
  project-relative reference; forgeable MIME, size, and digest metadata is not exposed. Missing or
  moved images persist a recoverable warning and can be reconnected from the same native chooser;
  locked nodes and view-only collaboration sessions cannot mutate references. Agent context includes
  note text, linked-image count, and alternative text only for currently linked images, never stale
  text, paths, or image bytes. Thirty-eight focused reader-race/oversize, shared-contract,
  main-service, IPC, preload, renderer, context, and immutable reference-update tests passed, along
  with desktop strict typecheck and focused zero-warning lint.
- 2026-07-18: Whiteboard/Mockup nodes now provide UI-only rectangle, ellipse, diamond, arrow, and
  text-annotation editing backed by bounded Excalidraw-compatible version-2 JSON. The preview is
  rendered solely with Forgeboard-owned inert React SVG primitives. Image export crosses a strict
  preload contract, opens a cancel-default native save dialog, revalidates the SVG allowlist in the
  main process, writes with private permissions, and returns only the selected basename. An explicit
  Agent picker creates a typed Context edge rather than silently attaching data; workflow evidence
  binds a normalized, bounded visual specification and its annotation/export references before
  creating the disclosed immutable agent-context snapshot while excluding embedded files, data
  URLs, links, bindings, and opaque custom fields. Node, group, and collaboration locks disable every
  graph mutation while leaving safe local export available. Fifty-six focused UI,
  canvas-adapter, context-evidence/resolution, preload, contract, and native-export tests passed,
  alongside desktop strict typecheck and the 1,250-file structure gate.
- 2026-07-18: the editor surface now covers safe Markdown composition/preview, synchronized Mermaid
  source/render/export, and a persisted Excalidraw-compatible whiteboard editor with shapes, text
  annotations, inert preview, native export, and explicit normalized agent context. Competing
  worktree comparison persists two distinct opaque agent-run targets and independent desktop,
  tablet, or phone presets, then launches two separately owned main-process sessions and secured
  native surfaces with independent start/restart/stop and unavailable-target recovery. Snapshots and
  events remain bound to their exact project, node, slot, and opaque target; schema, UI, and an
  atomic main-process reservation reject duplicate targets even under concurrent direct IPC starts.
  Forty focused comparison, canvas, surface, and contract unit tests passed. A production integration
  test proved distinct worktrees, content, processes, ports, restart/stop, duplicate-race rejection,
  and complete cleanup. The full repository suite passed 2,462 unit and 314 integration tests, along
  with formatting, lint, strict typecheck, all production builds, and the 1,255-file structure gate.
- 2026-07-18: workspace status is now visible without opening configuration: the command bar
  distinguishes local-only solo mode from connected, reconnecting, offline, disconnecting, and
  errored collaboration, repeats the approved-context third-party provider boundary, and shows the
  refreshed current Git branch plus dirty state. Agent nodes display assigned branches and show an
  `Worktree assigned` badge only while the main-owned durable run record remains active and owned;
  completed cleanup clears stale branch/worktree claims. Provider disclosures use a
  keyboard-accessible visible disclosure instead of title-only text, autosave retains explicit
  saved/saving/failed states, and the bounded local notification panel has an honest empty state.
  Missing or moved folders visibly become `Git status unavailable`, and generation-safe polling
  prevents late responses from a prior project from overwriting the current status. Thirty-two focused
  status, project-health, canvas-node, and durable-worktree tests passed with desktop strict
  typecheck, focused zero-warning lint, and the 1,265-file structure gate.
- 2026-07-18: node, selection, group, and whole-workflow run controls were re-audited against the
  current eligibility and command paths. Node and edge runtime projections now preserve every
  canonical lifecycle state: queued, running, waiting for approval, paused, cancelling, succeeded,
  failed, cancelled, and lost. Dependency, execute, output, and review evaluation no longer collapse
  cancellation or loss into generic failure, or active waiting states into queued. Agent controls
  distinguish literal interactive `continue` input from provider-session Resume, which always
  launches a newly reviewed continuation of an interrupted attempt. Pause remains visibly
  unavailable because adapter API v1 has no portable same-process pause/continue primitive, so the
  broader Agent-node checklist item remains open rather than claiming fake support. One hundred two
  focused runtime and renderer tests passed, together with core and desktop strict typechecks,
  focused zero-warning lint, and the 1,261-file structure gate.
- 2026-07-18: retained audit events and chain checkpoints now reject ordinary update and delete
  statements through canonical SQLite triggers. Only the private LocalStore connection can reach
  the module-owned retention/privacy-reset path; those operations drop and restore only the delete
  triggers inside the existing savepoint, and rollback tests prove rows, checkpoints, triggers, and
  authority recover together after a forced failure. Selective trigger/drop/delete tampering from a
  separate connection is detected live and after restart. Missing, mismatched, expired, cancelled,
  evicted, and owner-revoked saved/outbound approvals now record redacted denial evidence, while an
  outbound allowed event must persist before the permit-bearing external effect can run. Seventy-five
  focused security tests passed, but the two broad security checklist items remain open pending an
  exhaustive consumer/event coverage audit.
- 2026-07-18: the privacy deletion IPC now treats the renderer's typed phrase only as intent and
  requires a second, cancel-default native confirmation before any service reset or storage
  mutation. The trusted dialog enumerates local projects/canvases, execution history, settings,
  integrations, approvals, audit history, snapshots, and tracked backups; it also distinguishes
  Forgeboard data from untouched source repositories and warns that disconnected backup copies can
  survive. Native cancellation records one redacted denial event. Four focused confirmation tests
  passed. The deletion coordinator also revalidates its scoped authority before and after every
  awaited stage, and a focused race test proves revoked authority cannot reach service reset or
  storage deletion. Checklist items 43 and 44 remain open while the destructive/outbound consumer map is
  completed and privacy deletion's intentionally erased successful audit history is reconciled with
  the product's delete-all-data promise.
- 2026-07-18: Git review gained a path-free `Open externally…` handoff for both the primary project
  and a resolver-owned agent worktree. The renderer supplies only an opaque project/run target;
  main resolves it, presents a cancel-default native warning about leaving Forgeboard's sandbox,
  re-resolves it after approval, persists the redacted allowed audit before calling the operating
  system, and returns no path. It revalidates the live owner window immediately before the allowed
  audit and operating-system handoff; a replacement-window integration test proves a stale approval
  cannot open the resolved workspace. Fifty focused unit tests, ten real-repository integration tests,
  desktop strict typecheck, and the 1,267-file structure gate passed. Checklist item 72 remains open
  because the system-registered application may be a file manager and rename/archive/editor-specific
  selection are not complete.
- 2026-07-18: the real two-profile collaboration-management Electron journey now stops its actual
  loopback server after owner recovery, observes the live reconnecting state, saves the complete
  UI configuration, opens a project with sharing visibly unavailable, creates a Product brief node,
  and observes `Saved locally`. The focused Playwright journey passed in 7.9 seconds with zero
  unintended external requests. Checklist item 179 remains open for its other enumerated failure
  cases.
- 2026-07-18: the integrated checkpoint passed the 1,267-file structure gate, repository formatting,
  zero-warning lint, every workspace strict typecheck, 2,498 unit tests, 317 integration tests, and
  every production build. The changed Git-review keyboard-focus test also passed independently after
  its async focus assertion was made scheduler-safe, and the focused offline-server Electron journey
  passed against the freshly built desktop application.
- 2026-07-18: the complete repository checkpoint passed the 1,265-file structure gate, formatting,
  zero-warning lint, every workspace strict typecheck, 2,490 unit tests, 315 integration tests, and
  all production builds. A fresh unsigned macOS arm64 unpacked app rebuilt against Electron 36.5.0,
  and the packaged first-run/safe-default/demo/real-agent smoke passed after the zero-configuration
  first-run heading was restored. The production dependency audit reported no known vulnerabilities.
- 2026-07-18: extension removal now treats the renderer request only as intent, creates an exact
  owner-bound 15-minute plan, presents a path-free cancel-default native review, and revalidates the
  live owner, extension manifest, installed snapshot, and permissions before a required redacted
  allowed audit is persisted ahead of revocation and deletion. Missing, inactive, mismatched,
  cross-owner, expired, cancelled, replaced-window, privacy-reset, snapshot-drift, native-dialog,
  and audit failures all deny the mutation. External-browser update/preview handoffs and
  diagram/whiteboard SVG export also persist their required allowed audit before the effect, while
  privacy export and manual backup use a shared authority-revalidating audit-before-effect helper.
  Checklist items 43 and 44 remain open for the remaining launch, collaboration, and review-note
  consumers.
- 2026-07-18: Git review gained an agent-to-agent comparison tab with a bounded opaque-target picker.
  Main independently resolves two distinct active run/worktree bindings, proves common-project and
  common-repository ownership, compares immutable heads, and re-resolves the bindings to reject
  stale approvals; neither renderer requests nor responses expose filesystem paths or caller-chosen
  refs. The UI has explicit unavailable, empty, error, and stale-target states. Checklist item 72
  remains open for rename, archive, and user-selected external-editor behavior, while item 73 remains
  open for the remaining merge strategies and visual conflict workflow.
- 2026-07-18: the notification trigger and bounded notification panel now have explicit managed-
  dialog semantics, initial focus, Escape and outside-click dismissal, list semantics, and focus
  restoration. The command palette exposes an announced empty-result state. Checklist item 88
  remains open pending reusable non-title tooltips and exhaustive empty/error/loading coverage across
  the remaining routes.
- 2026-07-18: the README now links complete zero-code user and troubleshooting guides. Searchable
  offline Help covers missing CLI, moved repository, preview collision, Git conflicts, offline
  collaboration, malformed import, and startup database recovery. A documentation consistency suite
  verifies local Markdown links and every documented root pnpm command against `package.json`, and
  runs in the normal test suite. Together with the existing architecture, threat model, security,
  privacy, extension/adapter, collaboration, signing, release, and support documents, this closes
  checklist items 193 and 194.
- 2026-07-18: the integrated checkpoint passed the 1,280-file structure gate, repository formatting,
  zero-warning lint, every workspace strict typecheck, 2,521 unit tests across 384 files, 320
  integration tests across 37 files, all three documentation consistency tests, and every production
  build through `corepack pnpm verify`.
- 2026-07-19: the canvas now constructs one exact-version node registry for all fifteen built-in
  types and every installed declarative extension type. The same registry drives canvas type labels,
  icons, ports, accessible node names, keyboard projections, search, rail templates and results, and
  the inspector type label; persisted definitions remain recoverable when an extension is missing,
  and extension refresh preserves a user-selected accent colour. Every selected node also receives
  the shared local/shared comment surfaces and a bounded, locally restored workflow-run history.
  Group frames now safely nest while retaining flat absolute coordinates: membership reconciliation
  selects one deterministic parent and cuts imported cycles, locks and collapse project through all
  descendants, mouse and keyboard movement shift each descendant exactly once, nested layout carries
  subtrees, and auto-fit propagates from deepest changed frames through automatic ancestors. Deleting
  a frame reparents its direct children without moving them; copy/duplicate and group-run scopes use
  the full descendant closure. The inspector offers frame membership but disables cycle-producing
  ancestors, while typed persistence/import and collaboration metadata preserve and reconcile frame
  parents. Focused canvas, inspector, persistence, collaboration, workflow-model, and runtime suites
  cover these semantics, closing checklist item 94.
- 2026-07-19: audit-before-effect coverage was expanded across Agent, terminal, preview, project-
  check, provider-auth, readiness, and GitHub CLI subprocess launches; collaboration awareness,
  update, resynchronization, and delivery-confirmation transport effects; review-note deletion;
  terminal-retention deletion; and automatic backup pruning. The focused security, collaboration,
  GitHub CLI, and shell runs passed 78, 53, 38, and 8 tests respectively. Checklist items 43 and 44
  remain open pending the exhaustive consumer/event inventory and reconciliation of the successful
  delete-all flow, whose own retained audit history is intentionally erased. The corrected Git
  commit and selected-hunk discard paths persist their required audit before applying the index or
  worktree mutation; twelve Git IPC integration tests passed, including forced audit failures that
  leave both underlying states unchanged.
- 2026-07-19: managed-worktree review now provides opaque-target, native-confirmed branch rename,
  archive, and restore flows. Rename changes the real managed branch and durable ownership lineage;
  archive preserves the branch, commits, files, and dirty work while removing it from active review;
  archived attempts remain visible and can be restored through the UI after exact revalidation.
  Merge-commit delivery creates a real two-parent commit, cancellation leaves Git unchanged, and a
  conflict leaves the authentic index, markers, and operation state available for recovery. Focused
  lifecycle IPC, Git-engine, storage/renderer/tooltip, and shipping runs passed 2, 20, 28, and 11
  tests respectively. Recovery now binds the complete ownership lineage and action-kind invariants,
  commits reconciliation, its audit event, and intent deletion atomically, and durably fsyncs the
  intent before the filesystem commit point. Six intent-recovery tests, the focused lifecycle engine
  test, and both combined worktree IPC tests passed; the two-test lifecycle load run also passed with
  its explicit 90-second load budget. The external handoff now adds an optional UI-selected and
  resettable application executable. Main captures its canonical file identity, presents the exact
  executable and one literal main-owned workspace argument in a cancel-default native disclosure,
  revalidates the application, workspace, and window after approval, persists a path-free allowed
  audit before launching directly without a shell, and refuses stale or unauditable launches. This
  completes checklist item 72; item 73 remains open for the complete UI-backed squash, rebase, and
  visual conflict-resolution journey.
- 2026-07-19: delivery now adds UI-selected squash and rebase alongside fast-forward, merge-commit,
  and cherry-pick. Squash creates one identity-bound commit and retains a durable Git-directory
  recovery marker until commit or abort; rebase binds the managed branch and exact reviewed primary
  OID before replaying and fast-forwarding. Conflict results identify the authentic affected
  workspace, and a dedicated recovery panel prepares content-bound Continue or Abort plans with
  cancel-default native confirmation, stale revalidation, and required audit immediately before the
  Git effect. Focused proof passed 38 renderer/contract/preload unit tests, 13 desktop delivery
  integration tests, 20 Git-engine integration tests, both package typechecks, and the 1,321-file
  structure gate. The visual resolver now loads bounded base, ours, and theirs text from the
  authentic conflicted index, permits an explicit side choice or manual merged result, and binds a
  separately reviewed apply-and-stage plan to the current content hash. Main refuses ignored,
  sensitive, oversized, binary, symlinked, stale, or out-of-root content and persists path-free audit
  authorization immediately before both the atomic write and Git stage. A production-built Electron
  journey passed through provider-owned OAuth connection, a real reviewer-gated workflow, required
  Test evidence, human quality approval, divergent merge delivery, authentic conflict, inline
  resolution, native-confirmed staging and Continue, and a clean primary checkout with the reviewed
  content. This completes checklist item 73.
- 2026-07-19: the command bar now uses one keyboard-accessible managed tooltip primitive for Undo,
  Redo, Fit, Notifications, and Settings, including focus/hover behavior and accessible descriptions.
  Focused tooltip and command-bar tests passed. Checklist item 88 remains open for equivalent
  coverage across the remaining primary controls and an exhaustive empty/error/loading-state audit.
- 2026-07-19: dedicated Electron journeys now exist for a pointer-free first-run-to-agent workflow
  with computed dark/light and reduced-motion presentation, two simultaneous collaboration profiles
  sharing cursors/comments/canvas edits without private prompt or credential projection, occupied
  preview-port collision without a spawned surface, a real unresolved Git conflict that blocks
  delivery, and user-chosen verified-backup startup recovery from a corrupt database. Existing
  journeys cover system-theme persistence, permission disclosure and cancellation, missing CLI,
  moved-repository recovery, offline collaboration with continued local saves, and malformed import
  rollback. The focused two-profile collaboration privacy journey passed while observing real
  WebSocket data frames and proving the private prompt and both access tokens were absent from shared
  data frames and the peer UI. After stabilizing only stale selectors and Electron context/style-
  settlement races, the complete final-tree set passed all twelve named journeys together in 42.6
  seconds. This closes checklist items 178 and 179.
- 2026-07-19: the integrated milestone passed the 1,310-file structure gate, repository formatting,
  zero-warning lint, every workspace strict typecheck, 2,570 unit tests across 394 files, 327
  integration tests across 37 files, all three documentation consistency tests, and every production
  build through `corepack pnpm verify`. The production dependency audit reported no known
  vulnerabilities. A fresh unsigned macOS arm64 ZIP, DMG, and unpacked application were generated;
  the packaged first-run, safe-default, demo-project, and real deterministic-agent smoke passed.
- 2026-07-19: the current main-process effect inventory was repeated across direct subprocess,
  network/browser, filesystem, SQLite, extension-registry, project-creation, export, recovery,
  retention, and privacy-reset consumers. Settings saves now persist redacted authorization before
  any setting or retention mutation; lowering transcript, audit, or snapshot retention requires a
  second cancel-default native warning that enumerates the exact reductions. Settings and repair-
  evidence exports, extension install/update and privacy purge, project creation/demo creation, and
  project Git initialization now also persist their required event before the first external or
  destructive effect, with focused audit-failure tests proving no write, trust transition, registry
  copy/purge, project directory, Git metadata, service reset, or storage deletion occurs. Delete-all
  now records its final authorization immediately before service reset and deliberately erases that
  event with the audit table, reconciling audit-before-effect with the user's promise to erase all
  Forgeboard local data. Checklist items 43 and 44 remain open: startup database restore/quarantine
  can mutate recovery files before the restored audit database is available and currently relies on
  its durable recovery journal, ordinary compare-and-swap project-file saves still need an explicit
  policy decision on security-audit/impact-confirmation scope, and filesystem-effect coverage does
  not yet have a repository-wide architecture gate equivalent to the outbound-network gate.
- 2026-07-19: checklist item 88's renderer inventory was extended across the Welcome and moved-
  project routes, project create/clone dialog, command palette, Settings shell, Git review and agent
  comparison, workspace inspector and attempt history, rail search, and file-tab workspace. Their
  compact primary controls now share the keyboard/hover `WorkspaceTooltip`, including focusable
  explanations for disabled busy actions, while recent-project, file-tab, and rail no-result states
  are explicitly announced and the rail status indicator no longer relies on a mouse-only native
  title. The focused renderer run passed 85 of 86 tests; its sole failure is the concurrently added
  settings-manifest entry changing the existing expected count from 57 to 58, outside this slice.
  Desktop strict typecheck, the 1,311-file structure gate, and diff whitespace validation passed.
  Item 88 remains open: the exhaustive inventory still identifies compact controls in extension
  review, permission root/allowlist editing, Git-connection cards, and terminal launch review, plus
  disabled-action native titles in setup, file editing, Agent nodes, privacy recovery, and whiteboard
  tools that need the same managed tooltip treatment and route-level state verification.
- 2026-07-19: the Agent node gained real same-process Pause and Continue controls backed by
  main-owned POSIX process-group suspension. Host pipe launches create a dedicated group, and both
  pipe and PTY launches advertise pause only after the owned child PID and matching process-group ID
  are signalable; Windows, Docker, extension sessions, and any unverifiable group fail closed with
  an honest unavailable control. Pause and Continue have
  dedicated owner-checked, collaboration-authorized IPC routes, never use stdin or restart a
  provider session, persist exact running/paused transitions, block buffered input while paused, and
  recover a restart-stale paused child as lost. Interrupt and termination first continue a paused
  group and then signal the complete group so descendants cannot escape supervision. Real-process
  coverage proved parent and descendant output both stop, resume on the same PID, and terminate from
  pause; a separate test proved interruption from pause. The focused slice passed 106 unit tests and
  23 Electron compatibility integration tests, desktop and adapter strict typechecks, zero-warning
  focused lint, and the 1,319-file structure gate. This closes checklist item 96.
- 2026-07-19: checklist item 88's second renderer tranche replaced native-title-only explanations
  in extension review, permission root and executable editors, file tabs and external-open actions,
  Agent live and historical attempt controls, terminal launch review and launch admission, privacy
  backup/recovery actions, and whiteboard tools with the shared keyboard/hover tooltip. Disabled
  actions now expose a focusable reason, and extension, permission, file-diagnostic, file-failure,
  recovery, and read-only-file loading/empty/error states use explicit status or alert semantics.
  Ten focused files passed all 37 tests; the subsequent permission/Agent/recovery rerun passed all
  12 tests. Focused zero-warning lint, the 1,319-file structure gate, and diff whitespace validation
  and desktop strict typecheck passed. Item 88 remains open after re-inventory: Git review and
  connection controls were intentionally left to the active delivery tranche, and non-Git
  native-title affordances remain in safe Markdown links, project-tree drag guidance, canvas and
  context-menu status/actions, workflow/status indicators, and several workspace command/inspector
  controls. Setup `ChoiceCard`, Settings `SettingsSection`, file-failure, and test-result `title`
  occurrences were verified as semantic component headings rather than native tooltip attributes.
- 2026-07-19: checklist item 88's final non-Git renderer tranche replaced native-title-only link
  safety states, project-file drag guidance, canvas run/collapse and context-menu reasons, group
  membership locks, collaborator presence, workflow and workspace status, command-bar workflow
  actions, inspector lock/delete controls, Settings save validation, and shortened file hashes with
  the managed keyboard/hover tooltip and explicit status labels. Disabled actions remain focusably
  explained, while safe Markdown links now distinguish blocked and unavailable states without
  pretending they can open. The focused final run passed all 119 tests across 13 files; focused
  zero-warning lint, desktop strict typecheck, the 1,323-file structure gate, and diff whitespace
  validation passed. Item 88 remains open only for the active Git delivery tranche's native-title
  affordances in `GitFileSidebar`, `GitReviewSummary`, `GitBaseComparisonPanel`, and
  `GitDeliveryReadinessPanel`. The remaining renderer `title` occurrences were rechecked as semantic
  component headings/data passed to Settings sections, setup choice cards, workflow decisions and
  terminals, test results, and Git review disclosure/state components rather than HTML tooltip
  attributes.
- 2026-07-19: the security effect inventory is now closed and mechanically enforced. The TypeScript
  AST gate enumerates every mutation-capable Electron, child-process, filesystem, SQLite, and global
  process-signal capability acquired by desktop main, rejects namespace/default/CommonJS/dynamic/
  re-export bypasses, and requires a reviewed policy for each owner module. Its two exceptions are
  exact allowlists rather than open-ended labels: the direct project-editor Save is an ordinary
  user-authored atomic compare-and-swap guarded by canonical containment, file identity, and the
  opened content hash; pre-database startup recovery is restricted to seven database-recovery
  modules whose private fsynced journal precedes primary replacement and whose user-selected restore
  remains cancel-default. The separate outbound architecture gate still enumerates Git clone,
  Docker pull, update, collaboration, and GitHub transports behind owner-bound permits. Together
  with fail-closed pre-effect tests for launches, provider auth, extensions, projects, settings and
  retention, exports/backups, collaboration delivery, Git mutation/shipping, recovery, and privacy
  deletion, plus chained redaction/immutability/retention tests, this closes checklist items 43 and 44. The capability, outbound, approval, audit-integrity, privacy, settings, extension, and project
  suites passed all 101 focused tests across ten files.
- 2026-07-19: the final four Git-owned native-title affordances now use the same managed,
  keyboard-accessible tooltip as the rest of the renderer. Whole-file stage/unstage actions expose
  both their normal purpose and an honest focusable busy reason; tracked-line summary scope, full
  base/head identifiers, and the delivery source fingerprint remain available on hover and keyboard
  focus without relying on native browser titles. Four focused files passed all 28 tests, including
  new description bindings and disabled-state assertions. Desktop strict typecheck, focused
  zero-warning lint and formatting, the 1,327-file structure gate, and diff whitespace validation
  passed. A renderer-wide inventory now finds zero native HTML `title` attributes. Every remaining
  `title` match is a verified semantic component prop for headings, workflow decisions/terminals,
  test results, or Git disclosure/state content. Together with the previously recorded route-level
  command palette, notification, context-menu, empty, error, loading, read-only, and unavailable
  state evidence, this closes checklist item 88.
- 2026-07-19: the integrated final source tree passed the 1,338-file structure gate, formatting,
  zero-warning lint, strict typechecking, 2,634 unit tests across 405 files, 334 integration tests
  across 37 files, three documentation tests, three production-control gate tests, and every
  production build. All 34 production-built Electron journeys passed together in one complete run,
  including UI-only first run,
  OAuth provider connection, Agent pause/input/retry recovery, nested canvas behavior, durable
  restart state, settings/privacy confirmations, reviewed workflow evidence, GitHub delivery, and
  inline conflict resolution. Adversarial review also proved that conflict approvals are revoked
  across privacy/shutdown resets, rebound to the complete current target, and stage only the exact
  reviewed bytes even when the worktree races after approval. The production dependency audit
  reported no known vulnerabilities;
  the production marker/control audit found no required TODO, fake-success, placeholder, stub, or
  inert-button blocker. A fresh unsigned macOS arm64 ZIP, DMG, and unpacked application were built,
  and packaged first-run smoke passed. This closes checklist items 188 and 196. Items 18, 183, and
  184 remain honestly open because, at this checkpoint, the private repository had no published
  GitHub Release and hosted Windows/Linux installation plus signing/notarization evidence required
  restored GitHub Actions billing and the optional platform credentials.
- 2026-07-21: Forgeboard gained an opt-in local voice-command path backed by pinned Transformers.js,
  ONNX Runtime, and the exact `onnx-community/whisper-tiny.en` revision. Settings owns model
  install/removal and safe-action auto-run; the one-time model download uses the main outbound gate
  and cancel-default native disclosure, while subsequent loads force remote models off. Only the
  opted-in main window receives audio-only media permission, recordings are capped at 30 seconds
  and never persisted, IPC validates normalized 16 kHz PCM, and transcripts match only the shared
  command-palette registry. Agent/provider creation, task/brief/template creation, view, review, and
  settings actions can run automatically when enabled; workflow execution and project closing
  remain confirmation-class actions. Privacy deletion removes the downloaded model. The real pinned
  q8 model loaded from cache and transcribed a 16 kHz buffer with remote loading disabled. Desktop
  strict typecheck, production build, dependency audit, and 59 focused Settings, architecture,
  permission, model-state, registry,
  contract, matcher, and audio tests passed.
  `Workspace.tsx` was split below 2,000 lines. The structure gate still reports only three inherited
  direct-file-count failures in `apps/desktop/e2e`, `workspace/shell`, and `workspace/workflows`.
- 2026-07-22: voice-model installation was repaired after a runtime allowlist regression rejected
  the already-declared `voice-model-download` action and `model-registry` destination before native
  approval. Both are now accepted by the outbound gate, with a focused regression test, while the
  Voice settings use the shared aligned switch-row presentation instead of an undefined class.
  Twelve outbound-gate tests, the local voice-state test, desktop strict typecheck, formatting, and
  diff whitespace validation passed.
- 2026-07-22: voice commands gained deterministic parameterized intents without an AI routing
  dependency. `tell`/`ask`/`prompt` binds free-form text to one exact live Agent title, preserves
  casing and punctuation, and requires confirmation before sending input to an active run or
  filling an idle Agent prompt for review. `connect`/`link` binds two exact live node titles and
  requires confirmation before adding a context edge, enabling spoken Agent-to-Agent, tool, preview,
  and Video context wiring. Duplicate names, missing nodes, read-only canvases, locks, and duplicate
  connections fail closed. Seven focused registry and matcher tests passed; the desktop typecheck
  reached only an unrelated concurrent Preview test fixture error in the existing dirty tree.
  Follow-up provider aliases now accept natural `start a Claude Code agent` and
  `start Claude Code agent` phrasing as the safe create-Agent-node action without weakening process
  launch review. The exact transcribed screenshot phrase is covered; four focused matcher/registry
  tests, desktop typecheck, formatting, zero-warning focused lint, whitespace validation, and the
  1,476-file structure gate passed.
- 2026-07-21: native terminal approval gained an explicit UI-managed 30-day trust option for the
  exact project, canonical executable identity, arguments, working-folder identity, and disclosed
  environment-variable names. Unchanged launches reuse the durable main-process approval without a
  second native prompt; any scope change misses the cryptographic fingerprint and requires review
  again. Settings lists the human-readable grant and revokes it immediately. Twenty-three focused
  fingerprint, native-confirmation, IPC-security, and Settings tests passed, as did all 29 terminal
  service tests, desktop strict typecheck, focused zero-warning lint, formatting, production build,
  and diff whitespace validation. The complete 2,901-test unit suite had one unrelated concurrent
  preview-port expectation race; that nine-test preview file passed immediately in isolation. The
  repository-wide structure and production-control gates remain red on pre-existing workspace
  shell/folder limits and an unrelated inert project-tree button, so no false green gate claim is
  recorded here.
- 2026-07-22: the canvas gained a production Video node for project-contained MP4, WebM, and Ogg
  files. Selection validates canonical containment, ignore/sensitive-file policy, symlinks, and file
  signatures in Electron main; renderer playback uses expiring opaque capabilities through a secure
  streaming protocol, so absolute paths never cross preload. Dragging a configured Video node onto
  an Agent explicitly grants a digest-bound context note containing the source-relative path, exact
  size, and SHA-256 while leaving large media in place for video-capable agent tools. The focused
  video transport, persisted context, and context-linking run passed 35 tests, and desktop strict
  typecheck passed. Follow-up chooser verification covers the ordinary external-file path: a video
  selected outside the project is signature-checked and copied without overwrite into the project's
  `forgeboard-videos` folder before playback and agent sharing. All three focused video-service
  tests and desktop strict typecheck passed after that correction.
  Claude and other connected agent sessions now receive a `list_videos` Forgeboard MCP tool plus
  initialization guidance. The authenticated localhost hub returns only configured Video nodes
  explicitly attached to the caller or joined by an unmuted context edge, with project-relative
  path and availability metadata; unrelated videos and absolute paths remain private. Seven MCP
  protocol tests, four stdio runtime tests, all 22 agent-peer hub tests, the rebuilt MCP shim, and
  desktop strict typecheck passed.
- 2026-07-22: **Settings → Connectivity** was simplified around the two ordinary user goals:
  paste one invite to join, or create/recover a room. Identity and live status stay visible, while
  server endpoints, collaborator ID, reconnect policy, direct access tokens, and administrator
  credentials are grouped under clearly labeled advanced disclosures. Newly copied invites now
  carry the exact validated, credential-free management and WebSocket endpoints while keeping the
  secret token in the URL fragment; token-only legacy invites remain valid. Pasting a new invite
  updates the unsaved server draft and joining enables collaboration only after a successful
  connection. Eight focused contract, main-authority, renderer, room-management, and Settings files
  passed 84 tests, focused zero-warning lint and diff whitespace validation passed, the
  collaboration-server typecheck passed, and the production desktop build plus real two-profile
  invite Electron journey passed. The broader room-management journey completed its collaboration
  operations and then hit an unrelated current-tree canvas assertion for a missing Product brief
  node. The later merge-gate pass resolved the concurrent preview fixture, Workspace size, and folder
  count issues; workspace typecheck and the complete structure gate now pass.
- 2026-07-22: the Whiteboard/Mockup node is now an actual drawing surface. Previously its SVG was
  inert — nothing on the canvas handled pointer events, so shapes could only be added from the Tools
  popover at a fixed staircase position and were repositioned by typing numbers. A persistent tool
  strip in the node header now selects a mode (select, rectangle, ellipse, diamond, arrow, text,
  freehand); dragging on the canvas creates a shape at the dragged bounds, dragging an element moves
  it, and four corner handles resize it. A new bounded `freedraw` element type stores freehand
  strokes as points relative to their bounding box, capped at 512 points per stroke with non-finite
  coordinates dropped on write and again on parse. Arrows now carry direction in their `points`
  array instead of the box diagonal, so they can point in all four directions; documents persisted
  before this render unchanged via a `[[0,0],[width,height]]` fallback. Text is typed in place at the
  clicked point and re-edited by double-clicking, still registering in `annotationIds`. Gestures keep
  their geometry in local state and write to the graph exactly once on pointer-up, so a long stroke
  costs one re-render and one undo entry rather than hundreds; history is recorded immediately before
  a commit, so cancelled gestures leave no undo entry. The whiteboard background moved from a CSS
  background to an in-viewBox `<rect>`, making the white area exactly the drawable area. Freehand
  export emits `<path>` with attributes already covered by the main-process SVG allowlist, verified
  by a test that runs renderer output through `assertSafeDiagramSvg`; the agent-context normalizer
  gained `freedraw` with its own point cap and a disclosed `truncatedPointCount`. The dead
  `WhiteboardPreview.tsx` and `whiteboard.css` left behind by the sidebar deletion were removed. The
  full unit suite passed at 2,987 tests (92 added), with desktop strict typecheck and zero-warning
  lint clean. The final structure remediation keeps `content/whiteboard` at 7 files and
  `content/whiteboard/drawing` at 12 while bringing the whole repository within the enforced limits.
- 2026-07-22: final merge-gate remediation split the oversized Workspace runtime and overfull feature
  folders, recorded the Chrome-companion and user-selected video-import capability policies, and
  pinned TypeScript 5.8.3 for every pnpm peer resolution so package declarations cannot silently use
  a different compiler major. The structure gate passed across 1,475 maintained files, the
  production-control audit covered 854 files, formatting, zero-warning lint, workspace typecheck,
  documentation checks, and quality checks passed, and the production build passed including the
  collaboration-server startup smoke and desktop renderer bundle. All 3,092 unit tests passed; the
  complete integration run passed 334 of 335 tests, and its sole fresh-install Electron PTY harness
  failure passed on focused rerun after resolving the desktop-local `node-pty` entry and exercising
  the same spawn-helper permission repair used by production.
- 2026-07-22: collaboration room owners gained a one-action 10-minute invite flow. From the
  disconnected setup card, **Create room + copy 10-minute invite** creates and joins the real room,
  then creates and securely copies an editor invite; connected owners get the matching **Create &
  copy 10-minute invite** action. Both paths enforce exactly 600 seconds and one use through the
  server-backed invite API. The secret remains in main-process protected memory and is written
  directly to the clipboard without entering renderer state or page text. Eleven focused invite
  and room-management tests passed, along with focused formatting, zero-warning lint, whitespace
  validation, and the repository structure gate. The browser-companion implementation was then
  completed and passed the desktop-wide typecheck as recorded below.
- 2026-07-23: **Settings → Connectivity** no longer treats localhost as a share destination. New
  profiles start with no collaboration server, the exact disabled legacy localhost defaults clear
  from the editable draft, and room owners see the hosted server fields in the ordinary setup card.
  Shared invite creation is disabled unless both endpoints are public `wss://` and `https://`
  addresses; loopback, private-network, local-domain, insecure, and single-label destinations are
  rejected again in the main-process invite authority before any server mutation. Localhost remains
  available only through the advanced direct-connection path and can no longer be copied into an
  invite. The collaboration service also bypasses the Hocuspocus address-option mismatch and binds
  Node directly to its configured host instead of silently listening on every interface. Forty-eight
  focused collaboration contract, authority, invite, and renderer tests passed, along with the
  host-binding network integration test, affected strict typechecks, focused formatting and
  zero-warning lint, whitespace validation, and the repository structure gate. The temporary local
  collaboration service used for bind verification was stopped afterward.
- 2026-07-23: the collaboration service is ready for a single-instance hosted deployment. Its
  production image now honors a hosting provider's standard `PORT` while preserving the explicit
  Forgeboard override and safe local fallback, and its container health check follows the same
  resolved port. A Render Blueprint provisions the Docker service with generated signing and admin
  secrets, a durable `/data` disk for SQLite, a public health check, and the native-app origin
  policy; the hosting guide documents the exact owner setup, Forgeboard addresses, backup and
  scaling constraints, and Railway/VPS alternatives. Dedicated configuration and deployment
  contract tests passed, the collaboration-server strict typecheck and production bundle passed,
  and the exact production Docker image built successfully. A real container then ran as the
  non-root `forgeboard` user on platform-style `PORT=10000`, reached healthy status, and returned
  the expected `/healthz` response before the temporary container was removed.
- 2026-07-23: embedded Agent and Terminal sessions received a terminal-quality pass without
  changing their PTY transport or launch controls. Xterm now uses a larger native-first monospace
  stack, explicit regular and bold weights, increased line spacing and contrast, a clearer cursor,
  immediate wheel scrolling, and a refined ANSI palette. The terminal viewport gained consistent
  padding, a quiet scrollbar, and a unified deep background. Agent windows now use sharper
  provider-tinted chrome, stronger selected-state depth, accessible traffic-control focus rings,
  and a compact labeled Access field instead of raw browser controls. Redundant Agent and Model
  controls were then removed from the terminal footer while their configured launch values remained
  intact. The focused Agent-session and Terminal-surface suites passed all 22 tests, including
  assertions over the readability-critical xterm options and the reduced footer; affected desktop
  strict typecheck, zero-warning lint, formatting, whitespace validation, and the complete
  production desktop build passed. The running port-5174 renderer also served the updated agent
  stylesheet through its hot-reload pipeline. A follow-up regression check removed the 90 ms
  smoothing delay after real-use feedback identified it as unwanted scroll latency and now locks
  the terminal to immediate, one-to-one wheel response.
- 2026-07-22: the browser-companion and peer preview controls now separate read access from agent
  interaction, bind every inspected element handle to the current page version, and require a
  native allow-once approval before an agent can click or type. Approval text escapes untrusted
  website and agent control characters, website console content never enters agent-visible output,
  and peer tools expose bounded inspect, scroll, click, and type operations. All 84 focused browser,
  peer-service, renderer, and MCP tests passed, followed by zero-warning lint, workspace typecheck,
  documentation and quality checks, and the full production build.
- 2026-07-23: CI now takes its single pnpm version from the repository `packageManager` declaration,
  preventing action-setup drift across verification, packaging, and release jobs. The collaboration
  image copies the local core package manifest and source before bundling the server, so its Docker
  build no longer depends on source that exists only outside the image context. The exact CI Docker
  build passed locally, including the supply-chain lock policy, collaboration-server declaration
  build, startup smoke, production dependency deploy, and final non-root runtime image. Two
  regression checks guard both configuration contracts; all five quality tests, zero-warning lint,
  formatting, the 1,476-file structure gate, and the 854-file production-control audit passed. The
  release artifact test now supplies an explicitly empty environment for its local-manifest case;
  all 34 release and startup tests pass with a simulated CI `GITHUB_SHA`.
- 2026-07-23: release maintainers gained `corepack pnpm version:bump <new-semver>`. The command
  validates strict SemVer precedence, refuses to repair root/desktop version drift, updates both
  manifests with rollback on a partial write, creates matching prepared release notes without
  overwriting maintainer-written notes, and never tags or publishes automatically. Seven focused
  success, preservation, refusal, precedence, rollback, and package-wiring tests passed, along with
  focused zero-warning lint, formatting, diff whitespace validation, the 1,478-file structure gate,
  and the 854-file production-control audit. The exact package-script route, CLI help, and
  invalid-input refusal also ran without changing the repository version. Pnpm's default
  dependency-state repair still stops before scripts in this checkout because its existing
  `node_modules` is out of sync; package routing was therefore verified with that automatic repair
  disabled rather than presenting the local dependency installation as healthy.
- 2026-07-23: clean-run verification no longer assumes a prebuilt peer-MCP artifact, an interactive
  `TERM`, the host's login shell, or a specific numeric user id. Windows account identity and
  fail-closed ACL authority now use direct Node-API Win32 calls with exact current-user and
  LocalSystem DACL validation. Database swap detection also binds size and change and modification
  times alongside device and inode identity. The isolated full unit suite passed all
  3,110 tests across 455 files; all 335 integration tests, 41 release/startup tests, 3 docs tests,
  and 5 quality tests passed. Typecheck, zero-warning lint, formatting, the 1,478-file structure
  gate, the 854-file production-control audit, the collaboration artifact startup smoke, and the
  complete production build also passed.
- 2026-07-23: embedded Agent sessions now honor **Write in a worktree** instead of starting in the
  primary checkout. The renderer submits only a path-free managed-worktree request; Electron main
  revalidates the persisted Agent adapter and permission profile, creates a distinct owned worktree
  and durable run record per launch, binds native review and PTY spawn to that exact Git root, and
  rechecks project, directory, executable, and worktree ownership immediately before spawn. Native
  denial releases an unused pristine worktree, while changed or committed work remains preserved for
  review. A real-Git integration test proved two Claude Agent nodes received different roots and
  branches, isolated one Agent's uncommitted file from both the other Agent and primary checkout,
  preserved tracked and untracked dirty-primary work byte-for-byte, persisted completion evidence,
  and safely cleaned only the unused worktree. All 99 focused unit tests across nine contract,
  preload, main-service, controller, and renderer files passed, together with that integration test,
  desktop strict typecheck, zero-warning focused lint, formatting, three documentation tests, the
  1,460-file structure gate, the 851-file production-control audit, `git diff --check`, and the
  complete desktop production build.
- 2026-07-23: built-in interactive Agent sessions using **Write in a worktree** now start from one
  explicit click without a second native terminal dialog. Electron main reconstructs executable,
  model, and peer arguments from persisted state, revalidates command/worktree identity before PTY
  spawn, and rejects renderer substitutions or mismatched peer bindings. Ordinary Terminal nodes,
  other profiles, and custom/extension adapters retain native confirmation. All 81 focused unit
  tests, the real-Git managed-worktree integration test, and desktop strict typecheck passed.
- 2026-07-23: the retired bundled test agent and first-party workflow-template feature were removed
  throughout runtime, UI, tests, docs, and the lockfile. Legacy settings and saved Agent nodes discard
  the retired adapter while user workflows and the ordinary palette remain intact. Typecheck, docs,
  quality, controls, build, 3,072 unit assertions, and 324 integration assertions passed; recorded
  exceptions were a partial Electron install and unrelated in-progress files.
- 2026-07-24: the workspace project sidebar closes from an always-visible command-bar control,
  returns its width to the canvas, persists the choice, and passed ten tests and all production gates.
- 2026-07-24: running Agent and Terminal sessions and transcript creation no longer have product
  count caps; byte bounds remain. A 12-session regression and 3,102 unit tests passed. Of 332
  integration tests, both load-sensitive cases passed unchanged in isolation after 330 passed
  together. Docs, quality, typecheck, lint, formatting, structure, controls, and build passed.
  Canvas navigation's idle-bounded lightweight paint mode and terminal/preview containment passed
  final lint, typecheck, formatting, and 55 affected renderer tests.
- 2026-07-24: startup recovery binds complete stable database identity, and packaged smoke defers
  optional Agent-context storage failures while real Agent context stays fail-closed. Nineteen
  focused unit and six integration tests passed.
- 2026-07-24: live Agent and Terminal PTYs now survive renderer and macOS window replacement through
  one application-scoped owner; the next window reconnects and replays persisted output. Explicit
  Stop, node deletion, privacy reset, and application shutdown still terminate. Exit strips now
  distinguish stopped, interrupted, and disconnected sessions and render signal 15 as `SIGTERM`.
  All 3,108 unit and 332 integration tests, docs, quality, workspace typecheck, zero-warning lint,
  formatting, structure and production-control gates, whitespace validation, and build passed.
- 2026-07-24: PR #22 was reconciled with current `main` without discarding managed-worktree,
  hosting, startup, Settings, Terminal, canvas, E2E, invite, or persistent-session behavior.
- 2026-07-24: the post-merge repair persists Agent nodes; fixes canvas input; injects bundled Git
  into Preview; uses native Windows ACLs; and checks Test artifacts by visible Refresh, not IPC.
- 2026-07-25: public-repository hardening enabled GitHub secret scanning, push protection,
  Dependabot alerts/security updates and automated fixes, and private vulnerability reporting.
  Public documentation no longer exposes personal checkout paths or describes the repository as
  private. The one Stripe-shaped redaction fixture now constructs its test value at runtime, and
  GitHub has zero open secret alerts. Electron, Playwright, Vite, Vitest, Sharp, tar, and
  brace-expansion now resolve to patched versions; a pnpm-managed compatibility patch preserves the
  callable CommonJS API required by legacy minimatch consumers. The complete 875-package audit
  reports zero advisories. Structure (1,473 files), controls (858 files), formatting, lint,
  typecheck, all 3,139 unit tests, all 332 integration tests, three docs tests, seven quality tests,
  every production build, and the Electron 39 text-node create/edit/rotate/relaunch E2E scenario
  passed. The wider E2E suite still contains pre-existing stale readiness and canvas expectations;
  its representative keyboard-readiness failure reproduces unchanged on pristine `main`.
- 2026-07-25: editing an external Preview node address now navigates its already-connected managed
  Chrome tab through the existing validated browser-companion open path instead of leaving the tab
  on its previous page. The focused Preview node suite passed all 30 tests, followed by affected
  formatting and zero-warning lint checks, the desktop strict typecheck, whitespace validation, and
  the repository structure gate.
- 2026-07-25: PR #26 was reconciled with current `main` and its runtime verification was repaired.
  E2E cleanup supports both current and earlier Playwright process mappings, canvas multi-selection
  holds the real platform shortcut during its display-scale-safe click, Windows batch shims retain
  quoted executable paths through a validated interactive `cmd.exe` PTY bootstrap, and Git remote
  configuration uses the existing write-through Windows filesystem authority with bounded,
  identity-revalidated sharing retries for atomic commit and rollback replacement. The five
  previously failing E2E scenarios passed locally. Structure (1,477 files), controls (860 files),
  formatting, zero-warning lint, workspace typecheck, all 3,151 unit tests, all 333 integration
  tests, three docs tests, seven
  quality tests, and every production build passed.
