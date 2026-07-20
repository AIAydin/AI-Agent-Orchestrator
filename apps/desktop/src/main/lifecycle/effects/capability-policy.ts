export type LocalEffectPolicy =
  | 'audited-authority'
  | 'durable-internal-state'
  | 'journaled-startup-recovery'
  | 'ordinary-project-save'
  | 'reviewed-domain-operation'
  | 'reviewed-package-capability'
  | 'reviewed-runtime'
  | 'test-and-packaging';

export interface LocalEffectCapabilityEntry {
  readonly capabilities: readonly string[];
  readonly policy: LocalEffectPolicy;
}

export interface LocalEffectProductionRoot {
  readonly inventoryPrefix: string;
  readonly relativeRoot: string;
}

/**
 * Exact production TypeScript roots whose platform effects are reachable by Electron main.
 *
 * The desktop-main inventory predates workspace scanning and therefore retains its main-relative
 * keys. Workspace-package entries use repository-relative prefixes so similarly named modules can
 * never collide. Adding another main-loaded package requires an explicit reviewed root here.
 */
export const LOCAL_EFFECT_PRODUCTION_ROOTS: readonly LocalEffectProductionRoot[] = Object.freeze([
  { relativeRoot: 'apps/desktop/src/main', inventoryPrefix: '' },
  {
    relativeRoot: 'packages/agent-adapters/src',
    inventoryPrefix: 'packages/agent-adapters/src/',
  },
  { relativeRoot: 'packages/git-engine/src', inventoryPrefix: 'packages/git-engine/src/' },
]);

/** Normative review meaning for every policy value accepted by the architecture gate. */
export const LOCAL_EFFECT_POLICY_REQUIREMENTS: Readonly<Record<LocalEffectPolicy, string>> = {
  'audited-authority':
    'The effect requires current main-owned authority and a redacted allowed audit before it runs.',
  'durable-internal-state':
    'The capability maintains Forgeboard-owned state inside an already-authorized operation and does not create a separate external or destructive user action.',
  'journaled-startup-recovery':
    'The capability repairs Forgeboard-owned startup data before an audit database is available; a private durable journal must precede primary-file replacement and recovery must fail closed.',
  'ordinary-project-save':
    'The direct Save command writes the exact user-authored text only after canonical-path, file-identity, and expected-content-hash comparison; it is not a privileged security or outbound action.',
  'reviewed-domain-operation':
    'The workspace package exposes an approval-bearing domain operation; Electron main owns user authority and persists any required redacted audit before invoking its effect.',
  'reviewed-package-capability':
    "The main-process module owns a capability-bearing workspace-package entry point; its reviewed calls remain inside the module's declared authority, and mutation methods require their operation-specific approval and audit boundary.",
  'reviewed-runtime':
    'The capability belongs to a supervised runtime whose exact launch or control authority and required audit are enforced by its main-owned caller before process effects.',
  'test-and-packaging':
    'The capability is unreachable from the installed production application and exists only for packaged smoke or build tooling.',
};

/**
 * Review ledger for direct main-process access to mutation-capable platform APIs.
 *
 * This deliberately records capabilities rather than call-site text. The architecture test parses
 * TypeScript imports, so aliases, formatting, and refactors cannot hide a newly acquired effect.
 * Adding a module or capability requires choosing its authority policy here during review.
 */
export const LOCAL_EFFECT_CAPABILITY_INVENTORY: Readonly<
  Record<string, LocalEffectCapabilityEntry>
> = {
  'agent-execution/adapter-planner.ts': entry('reviewed-runtime', [
    '@forgeboard/agent-adapters#CliAgentAdapter',
    '@forgeboard/agent-adapters#createCustomCliAdapter',
    '@forgeboard/agent-adapters#detectDockerRuntime',
  ]),
  'agent-execution/context/immutable-snapshot.ts': entry('durable-internal-state', [
    'node:fs/promises#chmod',
    'node:fs/promises#open',
  ]),
  'agent-execution/context/snapshot-store/manager.ts': entry('durable-internal-state', [
    'node:fs/promises#chmod',
    'node:fs/promises#mkdir',
    'node:fs/promises#open',
    'node:fs/promises#rename',
    'node:fs/promises#rm',
    'process#kill',
  ]),
  'agent-execution/continuation/authority.ts': entry('reviewed-package-capability', [
    '@forgeboard/git-engine#RepositoryService',
    '@forgeboard/git-engine#WorktreeService',
  ]),
  'agent-execution/contracts.ts': entry('reviewed-runtime', [
    '@forgeboard/agent-adapters#AgentSession',
    '@forgeboard/agent-adapters#CliAgentAdapter',
  ]),
  'agent-execution/control/pause.ts': entry('reviewed-runtime', [
    '@forgeboard/agent-adapters#AgentSession',
  ]),
  'agent-execution/launch-integrity.ts': entry('reviewed-runtime', ['node:fs/promises#open']),
  'agent-execution/runtime.ts': entry('reviewed-runtime', [
    '@forgeboard/agent-adapters#AgentSession',
    '@forgeboard/git-engine#RepositoryService',
    '@forgeboard/git-engine#WorktreeService',
  ]),
  'agent-execution/workspace/snapshot.ts': entry('reviewed-package-capability', [
    '@forgeboard/git-engine#RepositoryService',
  ]),
  'checks/check-process.ts': entry('reviewed-runtime', [
    'node:child_process#spawn',
    'node:fs/promises#open',
    'process#kill',
  ]),
  'command-readiness/service.ts': entry('reviewed-runtime', ['node:fs/promises#open']),
  'diagram/export-service.ts': entry('audited-authority', ['node:fs/promises#writeFile']),
  'docker/docker-runtime.ts': entry('reviewed-runtime', [
    '@forgeboard/agent-adapters#detectDockerRuntime',
    'node:child_process#spawn',
  ]),
  'file-domain/images/reader.ts': entry('durable-internal-state', ['node:fs/promises#open']),
  'file-domain/reader.ts': entry('durable-internal-state', ['node:fs/promises#open']),
  'file-domain/writer.ts': entry('ordinary-project-save', [
    'node:fs/promises#open',
    'node:fs/promises#rename',
    'node:fs/promises#unlink',
  ]),
  'git/comparison/service.ts': entry('reviewed-package-capability', [
    '@forgeboard/git-engine#RepositoryService',
  ]),
  'git/connections/service.ts': entry('reviewed-package-capability', [
    '@forgeboard/git-engine#GitRemoteConfigurationService',
  ]),
  'git/git-base-comparison.ts': entry('reviewed-package-capability', [
    '@forgeboard/git-engine#RepositoryService',
  ]),
  'git/git-ipc.ts': entry('audited-authority', [
    '@forgeboard/git-engine#ChangeService',
    '@forgeboard/git-engine#RepositoryService',
    '@forgeboard/git-engine#WorktreeService',
  ]),
  'git/git-runtime.ts': entry('reviewed-runtime', [
    '@forgeboard/git-engine#GitExecutor',
    '@forgeboard/git-engine#RepositoryService',
  ]),
  'git/git-target-resolver.ts': entry('reviewed-package-capability', [
    '@forgeboard/git-engine#RepositoryService',
    '@forgeboard/git-engine#WorktreeService',
  ]),
  'git/github-cli/runtime.ts': entry('reviewed-runtime', [
    '@forgeboard/git-engine#GitHubCommandRunner',
  ]),
  'git/identity/service.ts': entry('reviewed-package-capability', [
    '@forgeboard/git-engine#RepositoryService',
  ]),
  'git/identity/values.ts': entry('reviewed-package-capability', [
    '@forgeboard/git-engine#RepositoryService',
  ]),
  'git/lifecycle/external-application.ts': entry('audited-authority', [
    'node:child_process#spawn',
    'node:fs/promises#open',
  ]),
  'git/lifecycle/metadata-intent-recovery.ts': entry('reviewed-package-capability', [
    '@forgeboard/git-engine#WorktreeService',
  ]),
  'git/lifecycle/worktree-cleanup-recovery.ts': entry('reviewed-package-capability', [
    '@forgeboard/git-engine#RepositoryService',
    '@forgeboard/git-engine#WorktreeService',
  ]),
  'git/lifecycle/worktree-cleanup-service.ts': entry('audited-authority', [
    '@forgeboard/git-engine#RepositoryService',
    '@forgeboard/git-engine#WorktreeService',
  ]),
  'git/readiness/reviewed-git-identity.ts': entry('reviewed-package-capability', [
    '@forgeboard/git-engine#RepositoryService',
  ]),
  'git/readiness/service.ts': entry('reviewed-package-capability', [
    '@forgeboard/git-engine#RepositoryService',
  ]),
  'git/readiness/workflow-gate-authority.ts': entry('reviewed-package-capability', [
    '@forgeboard/git-engine#RepositoryService',
  ]),
  'git/remote/github-runtime.ts': entry('reviewed-runtime', [
    '@forgeboard/git-engine#GitHubCommandRunner',
  ]),
  'git/remote/lfs-history.ts': entry('reviewed-package-capability', [
    '@forgeboard/git-engine#RepositoryService',
  ]),
  'git/remote/service.ts': entry('audited-authority', [
    '@forgeboard/git-engine#ChangeService',
    '@forgeboard/git-engine#RepositoryService',
    '@forgeboard/git-engine#assertNoMatchingPushUrlRewrites',
    '@forgeboard/git-engine#assertNoRepositoryPushOverrides',
    '@forgeboard/git-engine#readExactRemotePushUrl',
  ]),
  'git/reviews/review-target-service.ts': entry('reviewed-package-capability', [
    '@forgeboard/git-engine#RepositoryService',
  ]),
  'git/shipping/conflict-file-service.ts': entry('audited-authority', [
    '@forgeboard/git-engine#ChangeService',
    '@forgeboard/git-engine#RepositoryService',
  ]),
  'git/shipping/conflict-recovery-service.ts': entry('audited-authority', [
    '@forgeboard/git-engine#ChangeService',
  ]),
  'git/shipping/git-shipping-service.ts': entry('audited-authority', [
    '@forgeboard/git-engine#ChangeService',
    '@forgeboard/git-engine#RepositoryService',
  ]),
  'git/shipping/ipc-controller.ts': entry('audited-authority', [
    '@forgeboard/git-engine#ChangeService',
    '@forgeboard/git-engine#RepositoryService',
  ]),
  'index.ts': entry('audited-authority', ['electron#shell']), // external-open handoff for preview webviews
  'ipc.ts': entry('audited-authority', [
    '@forgeboard/git-engine#GitRemoteConfigurationService',
    'electron#shell',
    'node:fs/promises#writeFile',
  ]),
  'outbound/git/executors.ts': entry('audited-authority', [
    '@forgeboard/git-engine#ChangeService',
    '@forgeboard/git-engine#GitHubCliExecutor',
    '@forgeboard/git-engine#GitHubCommandRunner',
    '@forgeboard/git-engine#GitHubService',
    '@forgeboard/git-engine#RepositoryService',
  ]),
  'outbound/outbound-executors.ts': entry('audited-authority', [
    '@forgeboard/git-engine#RepositoryService',
    'node:fs/promises#rm',
  ]),
  'previews/preview-runtime.ts': entry('reviewed-runtime', [
    '@forgeboard/git-engine#RepositoryService',
  ]),
  'previews/preview-service.ts': entry('reviewed-runtime', [
    'node:child_process#spawn',
    'process#kill',
  ]),
  'previews/targets/resolver.ts': entry('reviewed-runtime', [
    '@forgeboard/git-engine#RepositoryService',
  ]),
  'projects/project-service.ts': entry('audited-authority', [
    '@forgeboard/git-engine#RepositoryService',
    'node:child_process#execFile',
    'node:fs/promises#mkdir',
    'node:fs/promises#writeFile',
  ]),
  'provider-connections/process.ts': entry('reviewed-runtime', [
    'node:child_process#spawn',
    'process#kill',
  ]),
  'readiness/executable-identity.ts': entry('reviewed-runtime', ['node:fs/promises#open']),
  'readiness/service.ts': entry('reviewed-runtime', ['@forgeboard/agent-adapters#detectAgent']),
  'recovery/database/atomic-restore.ts': entry('journaled-startup-recovery', [
    'node:fs/promises#chmod',
    'node:fs/promises#copyFile',
    'node:fs/promises#mkdir',
    'node:fs/promises#open',
    'node:fs/promises#rename',
    'node:fs/promises#rm',
  ]),
  'recovery/database/interrupted-restore.ts': entry('journaled-startup-recovery', [
    'node:fs/promises#chmod',
    'node:fs/promises#open',
    'node:fs/promises#rename',
    'node:fs/promises#rm',
  ]),
  'recovery/database/provenance/inspect.ts': entry('journaled-startup-recovery', [
    'node:sqlite#DatabaseSync',
  ]),
  'recovery/database/selected-backup.ts': entry('journaled-startup-recovery', [
    'node:fs/promises#open',
    'node:fs/promises#unlink',
  ]),
  'recovery/database/startup-adapter/deferred-staging-cleanup.ts': entry(
    'journaled-startup-recovery',
    ['node:fs/promises#open', 'node:fs/promises#rm'],
  ),
  'recovery/database/startup-adapter/initialization-marker.ts': entry(
    'journaled-startup-recovery',
    [
      'node:fs/promises#chmod',
      'node:fs/promises#link',
      'node:fs/promises#open',
      'node:fs/promises#unlink',
    ],
  ),
  'recovery/database/startup-adapter/open-store.ts': entry('journaled-startup-recovery', [
    'node:fs/promises#chmod',
    'node:fs/promises#mkdir',
    'node:fs/promises#mkdtemp',
    'node:fs/promises#rm',
  ]),
  'recovery/import-file.ts': entry('audited-authority', ['node:fs/promises#open']),
  'runs/run-service.ts': entry('reviewed-runtime', ['@forgeboard/git-engine#RepositoryService']),
  'security/windows/filesystem-acl.ts': entry('durable-internal-state', [
    'node:child_process#execFile',
  ]),
  'settings/settings-ipc.ts': entry('audited-authority', ['node:fs/promises#writeFile']),
  'smoke/packaged.ts': entry('test-and-packaging', ['node:fs#unlinkSync']),
  'storage/backup/health.ts': entry('durable-internal-state', ['node:sqlite#DatabaseSync']),
  'storage/backup/operations.ts': entry('audited-authority', [
    'node:fs/promises#chmod',
    'node:fs/promises#link',
    'node:fs/promises#mkdir',
    'node:fs/promises#open',
    'node:fs/promises#rmdir',
    'node:fs/promises#unlink',
    'node:sqlite#DatabaseSync',
    'node:sqlite#backup',
  ]),
  'storage/canvas-history/repository.ts': entry('durable-internal-state', [
    'node:sqlite#DatabaseSync',
  ]),
  'storage/checks.ts': entry('durable-internal-state', ['node:sqlite#DatabaseSync']),
  'storage/collaboration/rejected-comment-dismissals.ts': entry('durable-internal-state', [
    'node:sqlite#DatabaseSync',
  ]),
  'storage/collaboration/sync-state.ts': entry('durable-internal-state', [
    'node:sqlite#DatabaseSync',
  ]),
  'storage/database.ts': entry('durable-internal-state', [
    'node:fs#mkdirSync',
    'node:sqlite#DatabaseSync',
  ]),
  'storage/git-readiness/repository.ts': entry('durable-internal-state', [
    'node:sqlite#DatabaseSync',
  ]),
  'storage/git-worktree/intents.ts': entry('durable-internal-state', ['node:sqlite#DatabaseSync']),
  'storage/github-cli/repository.ts': entry('durable-internal-state', ['node:sqlite#DatabaseSync']),
  'storage/integrity.ts': entry('durable-internal-state', ['node:sqlite#DatabaseSync']),
  'storage/maintenance.ts': entry('audited-authority', ['node:sqlite#DatabaseSync']),
  'storage/projects-canvases.ts': entry('durable-internal-state', ['node:sqlite#DatabaseSync']),
  'storage/reviews/repository.ts': entry('durable-internal-state', ['node:sqlite#DatabaseSync']),
  'storage/runs-audit.ts': entry('durable-internal-state', ['node:sqlite#DatabaseSync']),
  'storage/security/approvals.ts': entry('durable-internal-state', ['node:sqlite#DatabaseSync']),
  'storage/security/audit-integrity.ts': entry('durable-internal-state', [
    'node:sqlite#DatabaseSync',
  ]),
  'storage/settings-repair/repository.ts': entry('durable-internal-state', [
    'node:sqlite#DatabaseSync',
  ]),
  'storage/terminal/repository.ts': entry('durable-internal-state', ['node:sqlite#DatabaseSync']),
  'storage/terminal/transcript-files.ts': entry('audited-authority', [
    'node:fs/promises#chmod',
    'node:fs/promises#mkdir',
    'node:fs/promises#open',
    'node:fs/promises#rm',
    'node:fs/promises#unlink',
  ]),
  'storage/transfers.ts': entry('audited-authority', ['node:sqlite#DatabaseSync']),
  'storage/trusted-extensions.ts': entry('durable-internal-state', ['node:sqlite#DatabaseSync']),
  'storage/workflow/executions.ts': entry('durable-internal-state', ['node:sqlite#DatabaseSync']),
  'storage/writes.ts': entry('durable-internal-state', ['node:sqlite#DatabaseSync']),
  'storage.ts': entry('durable-internal-state', ['node:sqlite#DatabaseSync']),
  'terminal/pty-process.ts': entry('reviewed-runtime', ['node:fs/promises#chmod']),
  'whiteboard/export-service.ts': entry('audited-authority', ['node:fs/promises#writeFile']),
  'workflow/exact-check/runtime/artifact-actions.ts': entry('reviewed-runtime', [
    'node:fs/promises#mkdir',
    'node:fs/promises#open',
    'node:fs/promises#unlink',
  ]),
  'workflow/exact-check/runtime/artifacts.ts': entry('reviewed-runtime', ['node:fs/promises#open']),
  'workflow/host/composition.ts': entry('reviewed-package-capability', [
    '@forgeboard/git-engine#RepositoryService',
  ]),
  'packages/agent-adapters/src/adapter.ts': entry('reviewed-runtime', [
    'node:child_process#spawn',
    'node:fs/promises#chmod',
    'process#kill',
  ]),
  'packages/agent-adapters/src/docker.ts': entry('reviewed-runtime', ['node:child_process#spawn']),
  'packages/git-engine/src/diff/changes.ts': entry('reviewed-domain-operation', [
    'node:fs/promises#unlink',
    'node:fs/promises#writeFile',
  ]),
  'packages/git-engine/src/github/client.ts': entry('reviewed-domain-operation', [
    'node:child_process#spawn',
  ]),
  'packages/git-engine/src/repository/executor.ts': entry('reviewed-domain-operation', [
    'node:child_process#spawn',
  ]),
  'packages/git-engine/src/repository/path-safety.ts': entry('reviewed-domain-operation', [
    'node:fs/promises#mkdir',
  ]),
  'packages/git-engine/src/repository/remotes/config-mutation-transaction.ts': entry(
    'reviewed-domain-operation',
    [
      'node:fs#fsyncSync',
      'node:fs#openSync',
      'node:fs#renameSync',
      'node:fs#unlinkSync',
      'node:fs/promises#open',
      'node:fs/promises#unlink',
    ],
  ),
  'packages/git-engine/src/repository/service.ts': entry('reviewed-domain-operation', [
    'node:fs/promises#open',
  ]),
  'packages/git-engine/src/repository/worktree-recovery/inspection.ts': entry(
    'reviewed-domain-operation',
    ['node:fs/promises#open'],
  ),
  'packages/git-engine/src/repository/worktrees.ts': entry('reviewed-domain-operation', [
    'node:fs/promises#mkdir',
    'node:fs/promises#open',
    'node:fs/promises#rename',
    'node:fs/promises#unlink',
  ]),
  'packages/git-engine/src/testing/helpers.ts': entry('test-and-packaging', [
    'node:child_process#execFile',
    'node:fs/promises#mkdir',
    'node:fs/promises#mkdtemp',
    'node:fs/promises#rm',
    'node:fs/promises#writeFile',
  ]),
};

function entry(
  policy: LocalEffectPolicy,
  capabilities: readonly string[],
): LocalEffectCapabilityEntry {
  return { capabilities, policy };
}
