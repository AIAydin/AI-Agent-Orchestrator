import path from 'node:path';

import {
  WorktreeService,
  type ManagedWorktreeState,
  type RepositoryService,
  type WorktreeOwnership,
} from '@forgeboard/git-engine';
import { z } from 'zod';

import type { AppSettings, Project } from '../../shared/application/contracts.js';
import type { LocalStore, StoredRunRecord } from '../storage.js';
import { effectiveRunWorktreeState } from '../storage-schemas.js';

const ResolveInputSchema = z.object({
  projectId: z.string().uuid(),
  runId: z.string().uuid(),
});

const TERMINAL_RUN_STATUSES: ReadonlySet<StoredRunRecord['status']> = new Set([
  'succeeded',
  'failed',
  'interrupted',
  'terminated',
  'lost',
]);

export type GitTargetResolutionErrorCode =
  | 'INVALID_TARGET'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_MISSING'
  | 'PRIMARY_REPOSITORY_MISMATCH'
  | 'RUN_NOT_FOUND'
  | 'RUN_PROJECT_MISMATCH'
  | 'RUN_NOT_TERMINAL'
  | 'WORKTREE_LIFECYCLE_INACTIVE'
  | 'RUN_HAS_NO_WORKTREE'
  | 'LEGACY_RUN_BINDING'
  | 'OWNERSHIP_UNAVAILABLE'
  | 'OWNERSHIP_MISMATCH'
  | 'WORKTREE_INACTIVE'
  | 'WORKTREE_MISSING'
  | 'BRANCH_MISSING'
  | 'REPOSITORY_IDENTITY_MISMATCH';

export class GitTargetResolutionError extends Error {
  public constructor(
    public readonly code: GitTargetResolutionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'GitTargetResolutionError';
  }
}

export interface ResolvedGitTarget {
  readonly project: Project;
  readonly run: StoredRunRecord;
  readonly ownership: WorktreeOwnership;
  readonly state: ManagedWorktreeState;
  readonly primaryRepositoryRoot: string;
  readonly worktreeRepositoryPath: string;
  readonly commonDirectory: string;
  readonly configuredManagedRoot: string;
  readonly usesConfiguredManagedRoot: boolean;
}

export type GitTargetResolverStore = Pick<LocalStore, 'getProject' | 'getRun'>;

interface CompleteRunBinding {
  readonly repositoryRoot: string;
  readonly managedRoot: string;
  readonly worktreeId: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseRef: string;
  readonly baseCommit: string;
  readonly agentId: string;
  readonly taskId: string;
}

/** Resolves a persisted agent run to an actively owned Git worktree for main-process use. */
export class GitTargetResolver {
  readonly #worktrees: WorktreeService;

  public constructor(
    private readonly store: GitTargetResolverStore,
    private readonly repositories: RepositoryService,
    private readonly getSettings: () => Pick<AppSettings, 'worktreeRoot'>,
  ) {
    this.#worktrees = new WorktreeService(repositories);
  }

  public async resolve(input: { projectId: string; runId: string }): Promise<ResolvedGitTarget> {
    const parsed = ResolveInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new GitTargetResolutionError(
        'INVALID_TARGET',
        'The requested agent worktree target is invalid.',
      );
    }

    const project = this.store.getProject(parsed.data.projectId);
    if (project === undefined) {
      throw new GitTargetResolutionError(
        'PROJECT_NOT_FOUND',
        'The selected project no longer exists.',
      );
    }
    if (project.missing) {
      throw new GitTargetResolutionError(
        'PROJECT_MISSING',
        'The selected project is marked as missing.',
      );
    }

    const primaryRepositoryRoot = await this.repositories.resolveRepositoryRoot(project.path);
    if (primaryRepositoryRoot !== project.path) {
      throw new GitTargetResolutionError(
        'PRIMARY_REPOSITORY_MISMATCH',
        'Reopen the project from its canonical Git repository root before reviewing agent changes.',
      );
    }

    const run = this.store.getRun(parsed.data.runId);
    if (run === undefined) {
      throw new GitTargetResolutionError(
        'RUN_NOT_FOUND',
        'The selected agent run no longer exists.',
      );
    }
    if (run.projectId !== project.id) {
      throw new GitTargetResolutionError(
        'RUN_PROJECT_MISMATCH',
        'The selected agent run does not belong to this project.',
      );
    }
    if (!TERMINAL_RUN_STATUSES.has(run.status) || run.endedAt === null) {
      throw new GitTargetResolutionError(
        'RUN_NOT_TERMINAL',
        'Wait for the agent run to finish before reviewing its worktree.',
      );
    }
    const worktreeState = effectiveRunWorktreeState(run);
    if (worktreeState !== 'active') {
      throw new GitTargetResolutionError(
        'WORKTREE_LIFECYCLE_INACTIVE',
        worktreeState === 'cleaned'
          ? 'This agent worktree has already been cleaned up.'
          : 'This agent worktree cleanup is incomplete and cannot be used safely.',
      );
    }

    const binding = completeBinding(run);
    if (binding.repositoryRoot !== primaryRepositoryRoot) {
      throw new GitTargetResolutionError(
        'PRIMARY_REPOSITORY_MISMATCH',
        'The agent run was created for a different primary repository.',
      );
    }

    let ownership: WorktreeOwnership;
    try {
      ownership = await this.#worktrees.readOwnership(binding.managedRoot, binding.worktreeId);
    } catch (error) {
      throw new GitTargetResolutionError(
        'OWNERSHIP_UNAVAILABLE',
        'The managed worktree ownership record is unavailable or invalid.',
        { cause: error },
      );
    }
    assertOwnershipBinding(binding, ownership);

    let state: ManagedWorktreeState;
    try {
      state = await this.#worktrees.inspect(ownership);
    } catch (error) {
      throw new GitTargetResolutionError(
        'OWNERSHIP_MISMATCH',
        'The managed worktree no longer matches its ownership record.',
        { cause: error },
      );
    }
    assertOwnershipBinding(binding, state.ownership);
    if (state.ownership.status !== 'active') {
      throw new GitTargetResolutionError(
        'WORKTREE_INACTIVE',
        'The selected agent worktree is no longer active.',
      );
    }
    if (state.missing || state.status === null) {
      throw new GitTargetResolutionError(
        'WORKTREE_MISSING',
        'The selected agent worktree is missing from disk.',
      );
    }
    if (!state.branchExists || state.branchOid === null) {
      throw new GitTargetResolutionError(
        'BRANCH_MISSING',
        'The selected agent worktree branch no longer exists.',
      );
    }
    if (state.status.branch !== ownership.branch || state.status.headOid !== state.branchOid) {
      throw new GitTargetResolutionError(
        'OWNERSHIP_MISMATCH',
        'The selected worktree is no longer checked out on its owned branch.',
      );
    }

    const [
      canonicalPrimaryRoot,
      worktreeRepositoryPath,
      primaryCommon,
      worktreeCommon,
      baseCommit,
    ] = await Promise.all([
      this.repositories.resolveRepositoryRoot(ownership.repositoryRoot),
      this.repositories.resolveRepositoryRoot(ownership.worktreePath),
      this.repositories.commonDirectory(primaryRepositoryRoot),
      this.repositories.commonDirectory(ownership.worktreePath),
      this.repositories.resolveRef(primaryRepositoryRoot, ownership.baseCommit),
    ]);
    if (
      canonicalPrimaryRoot !== primaryRepositoryRoot ||
      worktreeRepositoryPath !== ownership.worktreePath ||
      baseCommit !== ownership.baseCommit
    ) {
      throw new GitTargetResolutionError(
        'OWNERSHIP_MISMATCH',
        'The selected agent worktree no longer matches its persisted repository binding.',
      );
    }
    if (primaryCommon !== worktreeCommon) {
      throw new GitTargetResolutionError(
        'REPOSITORY_IDENTITY_MISMATCH',
        'The selected agent worktree does not share Git history with its project.',
      );
    }

    const configuredManagedRoot = path.resolve(this.getSettings().worktreeRoot);
    return {
      project,
      run,
      ownership: state.ownership,
      state,
      primaryRepositoryRoot,
      worktreeRepositoryPath,
      commonDirectory: primaryCommon,
      configuredManagedRoot,
      usesConfiguredManagedRoot: configuredManagedRoot === state.ownership.managedRoot,
    };
  }
}

function completeBinding(run: StoredRunRecord): CompleteRunBinding {
  if (run.worktreeId === null) {
    throw new GitTargetResolutionError(
      'RUN_HAS_NO_WORKTREE',
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
    throw new GitTargetResolutionError(
      'LEGACY_RUN_BINDING',
      'This older run does not contain the durable worktree ownership metadata required for safe review.',
    );
  }
  return {
    repositoryRoot: run.repositoryRoot,
    managedRoot: run.managedRoot,
    worktreeId: run.worktreeId,
    worktreePath: run.cwd,
    branch: run.branch,
    baseRef: run.baseRef,
    baseCommit: run.baseCommit,
    agentId: run.adapterId,
    taskId: run.nodeId,
  };
}

function assertOwnershipBinding(binding: CompleteRunBinding, ownership: WorktreeOwnership): void {
  const fields: ReadonlyArray<readonly [string, string | null, string | null]> = [
    ['worktree id', binding.worktreeId, ownership.id],
    ['primary repository', binding.repositoryRoot, ownership.repositoryRoot],
    ['managed root', binding.managedRoot, ownership.managedRoot],
    ['worktree path', binding.worktreePath, ownership.worktreePath],
    ['branch', binding.branch, ownership.branch],
    ['base ref', binding.baseRef, ownership.baseRef],
    ['base commit', binding.baseCommit, ownership.baseCommit],
    ['agent', binding.agentId, ownership.agentId],
    ['task', binding.taskId, ownership.taskId],
  ];
  const mismatch = fields.find(([, expected, actual]) => expected !== actual);
  if (mismatch !== undefined) {
    throw new GitTargetResolutionError(
      'OWNERSHIP_MISMATCH',
      `The persisted run does not match the managed worktree ${mismatch[0]} binding.`,
    );
  }
}
