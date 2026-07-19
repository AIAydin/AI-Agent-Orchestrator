import type { WorktreeService } from '@forgeboard/git-engine';

import type { LocalStore } from '../../storage.js';

type RecoveryStore = Pick<
  LocalStore,
  'getGitWorktreeMetadataIntent' | 'reconcileGitWorktreeMetadataIntent'
>;

/** Reconciles a failed effect against its pre-effect durable intent without inventing approval. */
export async function reconcileFailedWorktreeMetadataEffect(input: {
  readonly worktrees: WorktreeService;
  readonly store: RecoveryStore;
  readonly intentId: string;
  readonly runId: string;
  readonly kind: 'rename-worktree-branch' | 'archive-worktree' | 'restore-worktree';
  readonly managedRoot: string;
  readonly worktreeId: string;
  readonly auditMetadata: Record<string, unknown>;
  readonly operationError: unknown;
}): Promise<never> {
  try {
    const intent = input.store.getGitWorktreeMetadataIntent(input.runId);
    if (intent === undefined || intent.intentId !== input.intentId) {
      throw new Error('The durable managed-worktree lifecycle intent is missing.');
    }
    const ownership = await input.worktrees.readOwnership(input.managedRoot, input.worktreeId);
    const recovered = await input.worktrees.reconcileInterruptedMetadata(ownership, intent);
    if (recovered.ownership.status !== 'active' && recovered.ownership.status !== 'archived') {
      throw new Error('Managed-worktree ownership entered an unrecoverable lifecycle state.');
    }
    input.store.reconcileGitWorktreeMetadataIntent({
      intentId: input.intentId,
      worktreeId: recovered.ownership.id,
      branch: recovered.ownership.branch,
      state: recovered.ownership.status,
      auditStage: 'effect-rollback-reconciled',
      auditMetadata: input.auditMetadata,
    });
  } catch (reconciliationError) {
    throw new AggregateError(
      [input.operationError, reconciliationError],
      'The managed-worktree operation failed and its durable lifecycle intent could not be reconciled.',
    );
  }
  throw input.operationError;
}
