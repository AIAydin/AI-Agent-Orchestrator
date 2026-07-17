import type { CleanupImpact } from '../../model/types.js';

/** Immutable run-owned fields needed to classify an interrupted cleanup without trusting paths. */
export interface WorktreeCleanupRecoveryBinding {
  readonly worktreeId: string;
  readonly repositoryRoot: string;
  readonly managedRoot: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseRef: string;
  readonly baseCommit: string;
  readonly agentId: string;
  readonly taskId: string | null;
}

export interface WorktreeCleanupRecoveryResidue {
  readonly worktreePathPresent: boolean;
  readonly worktreeRegistered: boolean;
  readonly branchExists: boolean;
}

export type WorktreeCleanupRecoveryUnsafeReason =
  | 'binding-invalid'
  | 'path-authority-mismatch'
  | 'ownership-directory-missing'
  | 'ownership-invalid'
  | 'ownership-mismatch'
  | 'ownership-status-unsupported'
  | 'active-not-intact'
  | 'cleanup-pending-inconsistent'
  | 'metadata-missing-with-residue'
  | 'inspection-failed';

/**
 * Read-only crash-recovery classification. Only `fully-removed` proves all cleanup residue is gone;
 * every unproven or contradictory state is represented as `unsafe` and must remain fail-closed.
 */
export type WorktreeCleanupRecoveryInspection =
  | {
      readonly kind: 'active-intact';
      readonly impact: CleanupImpact;
      readonly residue: WorktreeCleanupRecoveryResidue;
    }
  | {
      readonly kind: 'cleanup-pending';
      readonly impact: CleanupImpact;
      readonly residue: WorktreeCleanupRecoveryResidue;
    }
  | {
      readonly kind: 'fully-removed';
      readonly residue: WorktreeCleanupRecoveryResidue;
    }
  | {
      readonly kind: 'unsafe';
      readonly reason: WorktreeCleanupRecoveryUnsafeReason;
      readonly residue?: WorktreeCleanupRecoveryResidue;
    };
