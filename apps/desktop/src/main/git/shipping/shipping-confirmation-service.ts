import type { BrowserWindow, Dialog } from 'electron';

import type {
  GitReviewTargetView,
  GitReviewView,
  GitTargetInput,
} from '../../../shared/git/contracts.js';
import type { GitShippingResultView } from '../../../shared/git/shipping-contracts.js';
import { shippingConfirmation } from './native-confirmation.js';
import type { GitShippingService, PendingGitShippingPlan } from './git-shipping-service.js';

interface ShippingConfirmationDependencies {
  readonly dialog: Pick<Dialog, 'showMessageBox'>;
  readonly shipping: GitShippingService;
  readonly resolveReview: (input: GitTargetInput) => Promise<GitReviewView>;
  readonly audit: (
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ) => void;
}

export class ShippingConfirmationService {
  public constructor(private readonly dependencies: ShippingConfirmationDependencies) {}

  public async confirm(options: {
    plan: PendingGitShippingPlan;
    parent: BrowserWindow;
    assertCurrent: () => void;
  }): Promise<GitShippingResultView | null> {
    const { plan } = options;
    const targetMetadata = auditTargetMetadata(plan.target);
    try {
      await this.dependencies.shipping.assertCurrent(plan);
      const decision = await this.dependencies.dialog.showMessageBox(
        options.parent,
        shippingConfirmation(plan),
      );
      options.assertCurrent();
      if (decision.response !== 1) {
        this.dependencies.audit('denied', {
          ...targetMetadata,
          strategy: plan.strategy,
          reason: 'native-confirmation-cancelled',
          commitCount: plan.commits.length,
          affectedPathCount: plan.affectedPaths.length,
        });
        return null;
      }
      const result = await this.dependencies.shipping.apply(plan, () => {
        options.assertCurrent();
        this.dependencies.audit('allowed', {
          ...targetMetadata,
          strategy: plan.strategy,
          commitCount: plan.commits.length,
          affectedPathCount: plan.affectedPaths.length,
          headBefore: plan.targetHead,
          sourceHead: plan.sourceHead,
          phase: 'authorized-before-apply',
        });
      });
      const conflictTarget =
        result.state === 'conflicted'
          ? plan.strategy === 'rebase'
            ? targetInput(plan.target)
            : { kind: 'primary' as const, projectId: plan.target.projectId }
          : null;
      const review = await this.dependencies.resolveReview(
        conflictTarget ?? { kind: 'primary', projectId: plan.target.projectId },
      );
      const conflictedPaths = result.status.entries
        .filter((entry) => entry.kind === 'unmerged')
        .map((entry) => entry.path)
        .sort();
      if (result.state === 'conflicted') {
        this.dependencies.audit('failed', {
          ...targetMetadata,
          strategy: plan.strategy,
          commitCount: plan.commits.length,
          affectedPathCount: plan.affectedPaths.length,
          conflictedPathCount: conflictedPaths.length,
          headBefore: result.headBefore,
          headAfter: result.headAfter,
          reason: 'git-conflicts',
        });
      }
      return {
        state: result.state,
        strategy: plan.strategy,
        headBefore: result.headBefore,
        headAfter: result.headAfter,
        conflictedPaths,
        conflictTarget,
        review,
      };
    } catch (error) {
      this.dependencies.audit('failed', {
        ...targetMetadata,
        reason: error instanceof Error ? error.message.slice(0, 4_096) : 'unknown failure',
      });
      throw error;
    }
  }
}

function targetInput(target: GitReviewTargetView): GitTargetInput {
  return target.kind === 'primary'
    ? target
    : {
        kind: 'agent-worktree',
        projectId: target.projectId,
        runId: target.runId,
      };
}

function auditTargetMetadata(target: GitReviewTargetView): Record<string, unknown> {
  return {
    targetKind: target.kind,
    projectId: target.projectId,
    ...(target.kind === 'agent-worktree'
      ? { runId: target.runId, worktreeId: target.worktreeId }
      : {}),
  };
}
