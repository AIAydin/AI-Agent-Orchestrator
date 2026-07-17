import type {
  RepositoryService,
  WorktreeService,
  GitStatus,
  ManagedWorktreeState,
  WorktreeOwnership,
} from '@forgeboard/git-engine';

import {
  effectiveRunWorktreeAuthority,
  effectiveRunWorktreeState,
  type StoredRunRecord,
} from '../../storage-schemas.js';
import type { AgentExecutionRequest, AgentExecutionStore, PreparedRunState } from '../contracts.js';

export interface AttemptContinuation {
  readonly action: 'resume' | 'retry';
  readonly parentRunId: string;
}

export function requireContinuationParent(
  store: AgentExecutionStore,
  continuation: AttemptContinuation,
  input: AgentExecutionRequest,
): StoredRunRecord {
  const parent = store.getRun?.(continuation.parentRunId);
  if (parent === undefined) throw new Error('The selected parent attempt no longer exists.');
  if (
    parent.projectId !== input.projectId ||
    parent.nodeId !== input.nodeId ||
    parent.adapterId !== input.adapterId ||
    (parent.model ?? null) !== (input.model ?? null) ||
    parent.permissionProfile !== input.permissionProfile
  ) {
    throw new Error(
      'The saved Agent adapter, model, or permission authority does not match the selected attempt.',
    );
  }
  if (parent.status === 'prepared' || parent.status === 'running') {
    throw new Error('Wait for the selected parent attempt to finish before continuing it.');
  }
  if (continuation.action === 'retry' && parent.status === 'succeeded') {
    throw new Error('A succeeded attempt should be started as a fresh Run, not retried.');
  }
  if (parent.supersededByRunId != null) {
    throw new Error('A newer resumed attempt already owns this target. Select that attempt.');
  }
  if (effectiveRunWorktreeAuthority(parent) !== 'owned') {
    throw new Error('The selected attempt does not own its persisted continuation target.');
  }
  if (continuation.action === 'resume') {
    if (parent.status !== 'interrupted') {
      throw new Error('Only an interrupted provider attempt can be resumed.');
    }
    if (parent.providerSessionId == null || parent.resumeSupported !== true) {
      throw new Error(
        'This attempt did not expose both a provider session ID and declared or probed resume capability.',
      );
    }
    if (parent.worktreeId !== null && effectiveRunWorktreeState(parent) !== 'active') {
      throw new Error('The interrupted attempt worktree is no longer active.');
    }
  }
  return parent;
}

export async function readResumeWorktree(
  worktrees: WorktreeService,
  parent: StoredRunRecord,
  repositoryPath: string,
): Promise<WorktreeOwnership> {
  if (
    parent.worktreeId === null ||
    parent.managedRoot === null ||
    parent.repositoryRoot === null ||
    parent.branch === null ||
    parent.baseRef === null ||
    parent.baseCommit === null
  ) {
    throw new Error('The interrupted attempt has no complete managed-worktree authority.');
  }
  const ownership = await worktrees.readOwnership(parent.managedRoot, parent.worktreeId);
  if (
    ownership.repositoryRoot !== repositoryPath ||
    ownership.repositoryRoot !== parent.repositoryRoot ||
    ownership.worktreePath !== parent.cwd ||
    ownership.managedRoot !== parent.managedRoot ||
    ownership.branch !== parent.branch ||
    ownership.baseRef !== parent.baseRef ||
    ownership.baseCommit !== parent.baseCommit ||
    ownership.agentId !== parent.adapterId ||
    ownership.taskId !== parent.nodeId ||
    ownership.status !== 'active'
  ) {
    throw new Error('The managed worktree no longer matches the saved resume authority.');
  }
  return ownership;
}

export function assertPrimaryResumeAuthority(
  parent: StoredRunRecord,
  repositoryPath: string,
  status: GitStatus,
): void {
  if (
    parent.permissionProfile !== 'plan-read-only' ||
    parent.repositoryRoot !== repositoryPath ||
    parent.cwd !== repositoryPath ||
    parent.managedRoot !== null ||
    parent.branch === null ||
    parent.baseRef !== parent.branch ||
    parent.baseCommit === null ||
    status.branch !== parent.branch ||
    status.headOid !== parent.baseCommit
  ) {
    throw new Error(
      'The primary repository branch or base commit no longer matches the saved read-only resume authority.',
    );
  }
}

export function assertContinuationNotInUse(
  attempts: Iterable<PreparedRunState>,
  parentRunId: string,
  worktreeId: string | null,
): void {
  for (const attempt of attempts) {
    if (attempt.authorityParentRunId === parentRunId) {
      throw new Error('Another prepared or running attempt already continues this parent attempt.');
    }
    if (worktreeId !== null && attempt.worktree?.id === worktreeId) {
      throw new Error('Another prepared or running attempt already uses this managed worktree.');
    }
  }
}

export async function assertManagedWorktreeState(
  repositories: RepositoryService,
  expected: WorktreeOwnership,
  state: ManagedWorktreeState,
): Promise<void> {
  if (!sameWorktreeBinding(expected, state.ownership)) {
    throw new Error('The managed worktree ownership changed after disclosure.');
  }
  if (
    state.ownership.status !== 'active' ||
    state.missing ||
    !state.branchExists ||
    state.branchOid === null ||
    state.status === null ||
    state.status.branch !== expected.branch
  ) {
    throw new Error('The managed worktree is no longer active on its approved branch.');
  }
  const [primaryCommon, worktreeCommon] = await Promise.all([
    repositories.commonDirectory(expected.repositoryRoot),
    repositories.commonDirectory(expected.worktreePath),
  ]);
  if (primaryCommon !== worktreeCommon) {
    throw new Error('The managed worktree no longer belongs to the approved repository.');
  }
}

function sameWorktreeBinding(left: WorktreeOwnership, right: WorktreeOwnership): boolean {
  return isDeepStrictEqual(left, right);
}
import { isDeepStrictEqual } from 'node:util';
