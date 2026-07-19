import { randomUUID } from 'node:crypto';

import type {
  AbortGitOperationApproval,
  ChangeService,
  ContinueGitOperationApproval,
  InProgressGitOperation,
} from '@forgeboard/git-engine';
import type { BrowserWindow, Dialog } from 'electron';

import type { GitReviewTargetView, GitReviewView } from '../../../shared/git/contracts.js';
import {
  GitConflictRecoveryPlanViewSchema,
  GitConflictRecoveryStateViewSchema,
  type GitConflictRecoveryAction,
  type GitConflictRecoveryPlanView,
  type GitConflictRecoveryPrepareInput,
  type GitConflictRecoveryResultView,
  type GitConflictRecoveryStateView,
} from '../../../shared/git/shipping-contracts.js';
import { conflictRecoveryConfirmation } from './conflict-recovery-confirmation.js';

const PLAN_TTL_MS = 5 * 60_000;

export interface ConflictRecoveryTarget {
  readonly view: GitReviewTargetView;
  readonly repositoryRoot: string;
}

export interface PendingConflictRecoveryPlan {
  readonly id: string;
  readonly ownerId: number;
  readonly target: GitReviewTargetView;
  readonly repositoryRoot: string;
  readonly expiresAtMs: number;
  readonly action: GitConflictRecoveryAction;
  readonly operation: InProgressGitOperation;
  readonly expectedHead: string;
  readonly conflictedPaths: readonly string[];
  readonly stagedPaths: readonly string[];
  readonly stagedPatchSha256: string;
  readonly unstagedPatchSha256: string;
}

interface ConflictRecoveryDependencies {
  readonly changes: ChangeService;
  readonly dialog: Pick<Dialog, 'showMessageBox'>;
  readonly resolveTarget: (
    input: GitConflictRecoveryPrepareInput['target'],
  ) => Promise<ConflictRecoveryTarget>;
  readonly review: (target: ConflictRecoveryTarget) => Promise<GitReviewView>;
  readonly audit: (
    action: string,
    outcome: 'allowed' | 'denied',
    metadata: Record<string, unknown>,
  ) => void;
}

export class ConflictRecoveryService {
  readonly #plans = new Map<string, PendingConflictRecoveryPlan>();

  public constructor(private readonly dependencies: ConflictRecoveryDependencies) {}

  public async state(
    input: GitConflictRecoveryPrepareInput['target'],
  ): Promise<GitConflictRecoveryStateView | null> {
    const target = await this.dependencies.resolveTarget(input);
    const state = await this.dependencies.changes.continuationState(target.repositoryRoot);
    if (state.operation === null) return null;
    return GitConflictRecoveryStateViewSchema.parse({
      target: targetInput(target.view),
      operation: state.operation,
      conflictedPaths: state.conflictedPaths,
      stagedPaths: state.stagedPaths,
      canContinue: state.canContinue,
      canAbort: state.canAbort,
    });
  }

  public async prepare(
    ownerId: number,
    input: GitConflictRecoveryPrepareInput,
  ): Promise<GitConflictRecoveryPlanView> {
    const target = await this.dependencies.resolveTarget(input.target);
    const state = await this.dependencies.changes.continuationState(target.repositoryRoot);
    if (state.operation === null) throw new Error('There is no Git operation to recover.');
    if (input.action === 'continue' && !state.canContinue) {
      throw new Error('Resolve and stage every conflicted file before continuing.');
    }
    const plan: PendingConflictRecoveryPlan = {
      id: randomUUID(),
      ownerId,
      target: target.view,
      repositoryRoot: target.repositoryRoot,
      expiresAtMs: Date.now() + PLAN_TTL_MS,
      action: input.action,
      operation: state.operation,
      expectedHead: state.expectedHead,
      conflictedPaths: state.conflictedPaths,
      stagedPaths: state.stagedPaths,
      stagedPatchSha256: state.stagedPatchSha256,
      unstagedPatchSha256: state.unstagedPatchSha256,
    };
    this.#plans.set(plan.id, plan);
    return GitConflictRecoveryPlanViewSchema.parse({
      planId: plan.id,
      expiresAt: new Date(plan.expiresAtMs).toISOString(),
      target: plan.target,
      action: plan.action,
      operation: plan.operation,
      expectedHead: plan.expectedHead,
      conflictedPaths: plan.conflictedPaths,
      stagedPaths: plan.stagedPaths,
      stagedPatchSha256: plan.stagedPatchSha256,
      unstagedPatchSha256: plan.unstagedPatchSha256,
      canContinue: state.canContinue,
    });
  }

  public async confirm(options: {
    ownerId: number;
    planId: string;
    parent: BrowserWindow;
    assertCurrent: () => void;
  }): Promise<GitConflictRecoveryResultView | null> {
    const plan = this.#plans.get(options.planId);
    this.#plans.delete(options.planId);
    if (plan === undefined || plan.ownerId !== options.ownerId || plan.expiresAtMs <= Date.now()) {
      throw new Error(
        'The conflict recovery plan is missing, expired, or belongs to another window.',
      );
    }
    const decision = await this.dependencies.dialog.showMessageBox(
      options.parent,
      conflictRecoveryConfirmation(plan),
    );
    options.assertCurrent();
    const auditAction = `${plan.action}-git-operation`;
    const metadata = {
      targetKind: plan.target.kind,
      projectId: plan.target.projectId,
      ...(plan.target.kind === 'agent-worktree' ? { runId: plan.target.runId } : {}),
      operation: plan.operation,
    };
    if (decision.response !== 1) {
      this.dependencies.audit(auditAction, 'denied', {
        ...metadata,
        reason: 'native-confirmation-cancelled',
      });
      return null;
    }
    const currentTarget = await this.dependencies.resolveTarget(targetInput(plan.target));
    if (
      currentTarget.repositoryRoot !== plan.repositoryRoot ||
      JSON.stringify(currentTarget.view) !== JSON.stringify(plan.target)
    ) {
      throw new Error('The conflict recovery workspace changed after review. Review it again.');
    }
    const approval = {
      approved: true as const,
      approvalId: plan.id,
      approvedAt: new Date().toISOString(),
      repositoryRoot: plan.repositoryRoot,
      expectedHead: plan.expectedHead,
      operation: plan.operation,
      conflictedPaths: plan.conflictedPaths,
      stagedPaths: plan.stagedPaths,
      stagedPatchSha256: plan.stagedPatchSha256,
      unstagedPatchSha256: plan.unstagedPatchSha256,
    };
    const authorizeApply = () => {
      options.assertCurrent();
      this.dependencies.audit(auditAction, 'allowed', {
        ...metadata,
        conflictedPathCount: plan.conflictedPaths.length,
        stagedPathCount: plan.stagedPaths.length,
        phase: 'authorized-before-apply',
      });
    };
    const result =
      plan.action === 'continue'
        ? await this.dependencies.changes.continueOperation(
            plan.repositoryRoot,
            {
              ...approval,
              action: 'continue-git-operation',
            } satisfies ContinueGitOperationApproval,
            { beforeApply: authorizeApply },
          )
        : await this.dependencies.changes.abortOperation(
            plan.repositoryRoot,
            {
              ...approval,
              action: 'abort-git-operation',
            } satisfies AbortGitOperationApproval,
            { beforeApply: authorizeApply },
          );
    const conflictedPaths = result.status.entries
      .filter((entry) => entry.kind === 'unmerged')
      .map((entry) => entry.path)
      .sort();
    return {
      state: result.state,
      conflictedPaths,
      review: await this.dependencies.review(currentTarget),
    };
  }

  public clearOwner(ownerId: number): void {
    for (const [id, plan] of this.#plans) if (plan.ownerId === ownerId) this.#plans.delete(id);
  }

  public clear(): void {
    this.#plans.clear();
  }
}

function targetInput(target: GitReviewTargetView): GitConflictRecoveryPrepareInput['target'] {
  return target.kind === 'primary'
    ? { kind: 'primary', projectId: target.projectId }
    : {
        kind: 'agent-worktree',
        projectId: target.projectId,
        runId: target.runId,
      };
}
