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
- [x] UI-configured manual, scheduled, and changed-data-on-quit SQLite backups with per-folder
      retention targets and persisted health; owner-bound canvas snapshot recovery; and reviewed,
      transactional portable JSON merge/replace import.
- [ ] Persistent undo/redo checkpoints, autosave, recoverable snapshots, and moved-project recovery.

## Security, permissions, and privacy

- [x] Canonical path/root policy, traversal/symlink escape protection, ignore evaluation, sensitive
      denylist, redaction, and high-friction per-file override.
- [x] Explicit context manifest showing receiving agent/provider and exact attached files.
- [x] Permission profiles: Plan/read-only, Worktree write, Docker isolated, and Custom.
- [ ] Scoped/revocable approvals and impact-specific confirmations for external/destructive actions.
- [ ] Append-only redacted audit log for all required security and outbound events.
- [x] Renderer isolation, narrow validated IPC, strict CSP, and navigation/window/download controls.
- [ ] Sandboxed preview surface and sanitized Markdown, Mermaid, SVG, and imports.
- [x] Data & Privacy screen with locations, integrations, retention, backup configuration/health,
      portable export/import, canvas recovery, and deletion.
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

- [x] Repository open/clone/create/init, health scan, recent list, and missing-path recovery.
- [x] Collision-safe per-writable-run branches/worktrees outside the checkout with ownership records.
- [x] Dirty-primary protection and worktree branch/ahead/behind/dirty UI.
- [x] Diff parsing, file navigation, unified/split views, whitespace controls, line comments, and stats.
- [x] Predictable accept/reject individual hunks while preserving unselected changes.
- [ ] Commit, compare agents/base, rename, archive, external editor, and safe cleanup.
- [ ] Merge, squash, rebase, cherry-pick, and visual conflict resolution with explicit approvals.
- [ ] Optional `gh` auth/repository/PR/CI integration with push and PR impact confirmation.

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
- [ ] Command palette, notifications, contextual menus, tooltips, and robust empty/error/loading states.

## Infinite canvas and nodes

- [ ] Pan/zoom, minimap, search, fit, box/multi-select, snap/guides, groups/frames, locking,
      comments, copy/paste/duplicate, autosave, and keyboard navigation.
- [ ] Extensible registry and shared title/color/icon/resize/collapse/lock/duplicate/delete/group/comment/
      status/run-history/inspector behavior.
- [ ] Agent node.
- [ ] Product brief node with Markdown, checklists, attachments, criteria, versions, and variables.
- [ ] Task node with priority, assignee, dependencies, criteria, files, status, and execution.
- [x] Live Monaco file node with history, dirty state, reveal, and context drag.
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

- [x] Ignore-aware tree, quick open, tabs, breadcrumbs, search, diagnostics, save/revert, and external
      editor handoff with write protection outside the selected root.
- [ ] Rich Markdown, Mermaid, and Excalidraw editing.
- [x] Safe argument-array command configuration and common package script detection.
- [x] Port allocation, readiness, multiple worktree dev servers, logs, cleanup, and collisions.
- [ ] Side-by-side desktop/tablet/phone previews bound to competing worktrees.
- [x] Lint/typecheck/test/build/custom checks with raw output and best-effort parsing.
- [ ] Review gates enforce selected passing commands before merge/push.

## Optional multiplayer

- [x] Optional Hocuspocus/Yjs server; solo mode has no server dependency.
- [x] Offline/reconnect, shared graph, cursors, selection, presence, comments, and avatars.
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
- [x] Drag/drop from tree/templates and node-to-agent context linking.
- [ ] Templates: single agent, parallel implementations, implement/review loop, bug investigation,
      and multi-screen product build.
- [ ] Notifications, autosave/offline indicators, provider disclosure, and branch/worktree badges.

## Automated verification

- [x] Required graph/workflow/recovery unit tests.
- [x] Required path/ignore/sensitive/symlink/redaction unit tests.
- [x] Required IPC/adapter-manifest/Git/persistence unit tests.
- [x] Two fake agents in parallel worktrees integration flow through diff acceptance/merge/cleanup.
- [x] Interrupt/fail/retry/restart restoration integration test.
- [x] Two-worktree preview integration test.
- [x] Test/review gate and bounded revision integration tests.
- [x] Sensitive-context and zero-Forgeboard-outbound integration tests.
- [x] Collaboration allowlist/two-client privacy integration tests.
- [x] Complete onboarding-to-merge Electron E2E flow.
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
- 2026-07-15: the unpacked packaged-app smoke now drives the token-bound renderer to apply
  `Use safe defaults` and open `Explore the safe demo`, then proves the isolated demo project and
  Workshop canvas are usable. It launches the packaged deterministic test agent through the stable
  main-process run seam, requires a real child process and successful durable run, verifies the
  packaged executable/resource/worktree paths, and reopens SQLite after exit to prove settings,
  recent-project, canvas, run, and SHA-256-bound output persistence. A build-time sandbox policy
  rejects `node:crypto`, filesystem, or path resolution from the generated preload, and the fresh
  Node 22 macOS arm64 package plus real packaged smoke passed. Seventeen focused smoke/policy tests,
  core strict typecheck, focused lint/format checks, and the 478-file structure gate passed. This
  evidence does not observe or prove zero outbound traffic, so that broader checklist item remains
  unchecked.
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
- 2026-07-15: a real main-process workflow recovery integration scenario now runs bundled
  deterministic child processes in five production-managed Git worktrees. It proves live SIGINT
  interruption, workflow cancellation with process termination, deliberate exit-code-7 failure,
  exactly two human-review revision attempts with no third launch, and explicit exhausted-loop
  cancellation. The scenario then disposes the host/runtime/store, reopens SQLite with fresh
  production service instances, and restores all four terminal workflows and all five exact run
  records without recovery mutation. Uncommitted tracked and untracked primary-checkout work plus
  partial files from interrupted, terminated, failed, and successful worktrees remain byte-exact
  across the restart. The focused real-process and mapped recovery suites passed 52 tests across
  five files, alongside lint, formatting, and the 567-file structure gate, without fake timers or
  mocked child-process completion.
- 2026-07-15: production workflow composition now has a real Test/Review Gate integration using
  bundled deterministic agent children, exact-check child processes, SQLite, Git, and isolated
  managed worktrees. An independent passing lint producer is deliberately unselected and cannot
  release the gate; the selected Test fails on attempt one and triggers the configured bounded
  revision; attempt-one output and gate evidence are cleared and cannot satisfy attempt two; the
  Test is retargeted to the second owned worktree; and only its selected passing attempt-two
  evidence releases the gate through the `tests-passed` stop condition. Durable events, check rows,
  producer/reviewed attempt bindings, and worktree isolation are asserted. Together with the real
  recovery scenario's two-attempt exhaustion, no-third-run proof, and explicit human escape
  cancellation, this closes the named Test/review-gate and bounded-revision integration
  requirement. The mapped workflow suites passed 29 integration tests, alongside desktop strict
  typecheck, focused lint/format checks, the 574-file structure gate, and `git diff --check`.
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
  disclosed before approval; only afterward does a real deterministic child receive that one file.
  The fixture traps Forgeboard-owned HTTP, HTTPS, TCP, TLS, DNS, UDP, fetch, and WebSocket seams and
  observes zero attempts and zero `external-send` audits. Two real-process tests and 85 mapped unit
  tests passed with typecheck, lint, formatting, structure, and whitespace gates. This closes the
  named integration-test requirement only: it is not packet capture or an OS firewall, does not
  inspect provider-controlled child networking, and does not close the broader all-app-path solo
  outbound claim.
- 2026-07-15: the real Electron worktree journey now covers the complete local onboarding-to-merge
  path without code or environment editing: accept safe defaults, configure the managed worktree
  root and Git identity in Settings, open the demo, add and configure the deterministic agent in the
  UI, review and approve its exact native launch, inspect and stage its isolated change, review and
  approve the commit, restart the app, reopen the durable run, review the exact commit delivery, and
  approve a fast-forward into primary. The test proves primary HEAD and bytes remain unchanged until
  delivery, then proves primary HEAD exactly equals the reviewed agent HEAD, the delivered file is
  byte-identical, status is clean, and no external web requests occurred. The focused Electron run
  passed 1/1 in 13 seconds. This closes local onboarding-to-primary merge only; remote push, pull
  request, and release publication remain separately unchecked.
- 2026-07-15: the combined checkpoint passed the 576-file modularity gate, repository-wide
  formatting, zero-warning ESLint, every workspace strict typecheck, 881 unit tests across 150
  files, 160 real integration tests across 24 files, all 11 Electron Playwright journeys, all 18
  standalone release/startup tests, every workspace production build, and `git diff --check`.
  `corepack pnpm audit --prod --audit-level high` reported no known production dependency
  vulnerabilities. The Electron suite includes the lock-aware first-run canvas journey and the new
  end-to-end reviewed primary-delivery path.
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
  recomputed with the same project context. The bundled deterministic agent uses a passive
  main-owned proof. At this checkpoint, changed-only persistence checks did not yet migrate unchanged
  legacy configuration; the later 2026-07-16 upgrade-repair entry supersedes that limitation.
  Thirteen focused UI and
  contract files passed 71 tests; the follow-up persistence-boundary set passed 55 tests across eight
  files. Desktop strict typecheck, focused zero-warning lint and formatting, and the 702-file
  structure gate passed. The two broad Settings completeness entries remain unchecked because this
  evidence closes only validation, readiness, and folder preflight, not every setting or integration
  in the build goal.
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
