import {
  WorktreeService,
  type RepositoryService,
  type WorktreeCleanupRecoveryBinding,
  type WorktreeCleanupRecoveryInspection,
} from '@forgeboard/git-engine';

import {
  GitWorktreeCleanupTargetInputSchema,
  type GitWorktreeCleanupTargetInput,
} from '../../../shared/git/lifecycle/contracts.js';
import type { LocalStore, StoredRunRecord } from '../../storage.js';
import { effectiveRunWorktreeState } from '../../storage-schemas.js';

const TERMINAL_RUN_STATUSES: ReadonlySet<StoredRunRecord['status']> = new Set([
  'succeeded',
  'failed',
  'interrupted',
  'terminated',
  'lost',
]);

export type WorktreeCleanupRecoveryResolutionErrorCode =
  | 'RECOVERY_INVALID_TARGET'
  | 'RECOVERY_PROJECT_NOT_FOUND'
  | 'RECOVERY_PROJECT_MISSING'
  | 'RECOVERY_PRIMARY_REPOSITORY_MISMATCH'
  | 'RECOVERY_RUN_NOT_FOUND'
  | 'RECOVERY_RUN_PROJECT_MISMATCH'
  | 'RECOVERY_RUN_NOT_TERMINAL'
  | 'RECOVERY_ALREADY_CLEANED'
  | 'RECOVERY_STATE_CHANGED'
  | 'RECOVERY_RUN_HAS_NO_WORKTREE'
  | 'RECOVERY_LEGACY_RUN_BINDING';

export class WorktreeCleanupRecoveryResolutionError extends Error {
  public constructor(
    public readonly code: WorktreeCleanupRecoveryResolutionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorktreeCleanupRecoveryResolutionError';
  }
}

export interface ResolvedWorktreeCleanupRecovery {
  readonly run: StoredRunRecord;
  readonly binding: WorktreeCleanupRecoveryBinding;
  readonly inspection: WorktreeCleanupRecoveryInspection;
}

export interface WorktreeCleanupRecoveryAuthority {
  resolvePending(input: GitWorktreeCleanupTargetInput): Promise<ResolvedWorktreeCleanupRecovery>;
}

type WorktreeCleanupRecoveryStore = Pick<LocalStore, 'getProject' | 'getRun'>;

/** Main-only resolver for a durable pending cleanup; it never grants ordinary review authority. */
export class WorktreeCleanupRecoveryResolver implements WorktreeCleanupRecoveryAuthority {
  readonly #worktrees: WorktreeService;

  public constructor(
    private readonly store: WorktreeCleanupRecoveryStore,
    private readonly repositories: RepositoryService,
    worktrees?: WorktreeService,
  ) {
    this.#worktrees = worktrees ?? new WorktreeService(repositories);
  }

  public async resolvePending(
    untrustedInput: GitWorktreeCleanupTargetInput,
  ): Promise<ResolvedWorktreeCleanupRecovery> {
    const parsed = GitWorktreeCleanupTargetInputSchema.safeParse(untrustedInput);
    if (!parsed.success) {
      throw new WorktreeCleanupRecoveryResolutionError(
        'RECOVERY_INVALID_TARGET',
        'The selected cleanup-recovery target is invalid.',
      );
    }
    const project = this.store.getProject(parsed.data.projectId);
    if (project === undefined) {
      throw new WorktreeCleanupRecoveryResolutionError(
        'RECOVERY_PROJECT_NOT_FOUND',
        'The selected project no longer exists.',
      );
    }
    if (project.missing) {
      throw new WorktreeCleanupRecoveryResolutionError(
        'RECOVERY_PROJECT_MISSING',
        'The selected project is marked as missing.',
      );
    }

    let primaryRepositoryRoot: string;
    try {
      primaryRepositoryRoot = await this.repositories.resolveRepositoryRoot(project.path);
    } catch (error) {
      throw new WorktreeCleanupRecoveryResolutionError(
        'RECOVERY_PRIMARY_REPOSITORY_MISMATCH',
        'Reopen the project from its main repository folder before recovering cleanup.',
        { cause: error },
      );
    }
    if (primaryRepositoryRoot !== project.path) {
      throw new WorktreeCleanupRecoveryResolutionError(
        'RECOVERY_PRIMARY_REPOSITORY_MISMATCH',
        'Reopen the project from its main repository folder before recovering cleanup.',
      );
    }

    const run = this.store.getRun(parsed.data.runId);
    if (run === undefined) {
      throw new WorktreeCleanupRecoveryResolutionError(
        'RECOVERY_RUN_NOT_FOUND',
        'The selected agent run no longer exists.',
      );
    }
    if (run.projectId !== project.id) {
      throw new WorktreeCleanupRecoveryResolutionError(
        'RECOVERY_RUN_PROJECT_MISMATCH',
        'The selected agent run does not belong to this project.',
      );
    }
    if (!TERMINAL_RUN_STATUSES.has(run.status) || run.endedAt === null) {
      throw new WorktreeCleanupRecoveryResolutionError(
        'RECOVERY_RUN_NOT_TERMINAL',
        'Wait for the agent run to finish before recovering cleanup.',
      );
    }
    const lifecycleState = effectiveRunWorktreeState(run);
    if (lifecycleState === 'cleaned') {
      throw new WorktreeCleanupRecoveryResolutionError(
        'RECOVERY_ALREADY_CLEANED',
        'This agent worktree has already been cleaned up.',
      );
    }
    if (lifecycleState !== 'cleanup-pending') {
      throw new WorktreeCleanupRecoveryResolutionError(
        'RECOVERY_STATE_CHANGED',
        'This agent worktree no longer has an interrupted cleanup to recover.',
      );
    }

    const binding = completeRecoveryBinding(run);
    if (binding.repositoryRoot !== primaryRepositoryRoot) {
      throw new WorktreeCleanupRecoveryResolutionError(
        'RECOVERY_PRIMARY_REPOSITORY_MISMATCH',
        'The agent run was created for a different primary repository.',
      );
    }
    return {
      run,
      binding,
      inspection: await this.#worktrees.inspectCleanupRecovery(binding),
    };
  }
}

function completeRecoveryBinding(run: StoredRunRecord): WorktreeCleanupRecoveryBinding {
  if (run.worktreeId === null) {
    throw new WorktreeCleanupRecoveryResolutionError(
      'RECOVERY_RUN_HAS_NO_WORKTREE',
      'The selected agent run did not use a managed writable worktree.',
    );
  }
  if (
    run.repositoryRoot === null ||
    run.managedRoot === null ||
    run.branch === null ||
    run.baseRef === null ||
    run.baseCommit === null
  ) {
    throw new WorktreeCleanupRecoveryResolutionError(
      'RECOVERY_LEGACY_RUN_BINDING',
      'This older run is missing the saved workspace records Forgeboard needs for safe cleanup recovery.',
    );
  }
  return {
    worktreeId: run.worktreeId,
    repositoryRoot: run.repositoryRoot,
    managedRoot: run.managedRoot,
    worktreePath: run.cwd,
    branch: run.branch,
    baseRef: run.baseRef,
    baseCommit: run.baseCommit,
    agentId: run.adapterId,
    taskId: run.nodeId,
  };
}
