import { randomUUID } from 'node:crypto';

import type { ChangeService, RepositoryService } from '@forgeboard/git-engine';
import type { BrowserWindow, Dialog } from 'electron';

import type {
  GitIdentityView,
  GitReviewView,
  GitTargetInput,
} from '../../../shared/git/contracts.js';
import type {
  GitConflictRecoveryPlanView,
  GitConflictRecoveryPrepareInput,
  GitConflictRecoveryResultView,
  GitConflictRecoveryStateView,
  GitShippingPlanInput,
  GitShippingPlanView,
  GitShippingResultView,
} from '../../../shared/git/shipping-contracts.js';
import type {
  GitConflictInspectionInput,
  GitConflictInspectionView,
  GitConflictResolutionPlanView,
  GitConflictResolutionPrepareInput,
  GitConflictResolutionResultView,
} from '../../../shared/git/conflict-resolution/contracts.js';
import type { GitTargetResolver } from '../git-target-resolver.js';
import {
  ConflictRecoveryService,
  type ConflictRecoveryTarget,
} from './conflict-recovery-service.js';
import {
  GitShippingService,
  type GitShippingReadinessAuthority,
  type PendingGitShippingPlan,
} from './git-shipping-service.js';
import { ShippingConfirmationService } from './shipping-confirmation-service.js';
import { ConflictFileService } from './conflict-file-service.js';
import { GitApprovalAuthority } from './approval-authority.js';

const PLAN_TTL_MS = 5 * 60_000;

export const denyShippingWithoutReadiness: GitShippingReadinessAuthority = {
  bind: () =>
    Promise.reject(
      new Error(
        'Run at least one required delivery check and record human quality approval before delivery.',
      ),
    ),
  revalidate: () =>
    Promise.reject(
      new Error('The delivery readiness authority is unavailable. Prepare a new delivery review.'),
    ),
};

interface GitShippingIpcDependencies {
  readonly dialog: Pick<Dialog, 'showMessageBox'>;
  readonly targets: GitTargetResolver;
  readonly repositories: RepositoryService;
  readonly changes: ChangeService;
  readonly readiness: GitShippingReadinessAuthority;
  readonly resolveIdentity: (repositoryRoot: string) => Promise<GitIdentityView>;
  readonly resolveTarget: (input: GitTargetInput) => Promise<ConflictRecoveryTarget>;
  readonly review: (target: ConflictRecoveryTarget) => Promise<GitReviewView>;
  readonly audit: (
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ) => void;
}

export class GitShippingIpcController {
  readonly #plans = new Map<string, PendingGitShippingPlan>();
  readonly #shipping: GitShippingService;
  readonly #confirmation: ShippingConfirmationService;
  readonly #recovery: ConflictRecoveryService;
  readonly #conflictFiles: ConflictFileService;
  readonly #approvalAuthority = new GitApprovalAuthority();

  public constructor(private readonly dependencies: GitShippingIpcDependencies) {
    this.#shipping = new GitShippingService(
      dependencies.targets,
      dependencies.repositories,
      dependencies.changes,
      dependencies.readiness,
    );
    this.#confirmation = new ShippingConfirmationService({
      dialog: dependencies.dialog,
      shipping: this.#shipping,
      resolveReview: async (input) => dependencies.review(await dependencies.resolveTarget(input)),
      audit: (outcome, metadata) => dependencies.audit('ship-agent-commits', outcome, metadata),
    });
    this.#recovery = new ConflictRecoveryService({
      changes: dependencies.changes,
      dialog: dependencies.dialog,
      resolveTarget: dependencies.resolveTarget,
      review: dependencies.review,
      audit: (action, outcome, metadata) => dependencies.audit(action, outcome, metadata),
    });
    this.#conflictFiles = new ConflictFileService({
      changes: dependencies.changes,
      repositories: dependencies.repositories,
      dialog: dependencies.dialog,
      resolveTarget: dependencies.resolveTarget,
      audit: (action, outcome, metadata) => dependencies.audit(action, outcome, metadata),
    });
  }

  public async prepareShipping(
    ownerId: number,
    input: GitShippingPlanInput,
  ): Promise<GitShippingPlanView> {
    try {
      const plan = await this.#shipping.prepare({
        id: randomUUID(),
        ownerId,
        expiresAtMs: Date.now() + PLAN_TTL_MS,
        input,
        resolveIdentity: this.dependencies.resolveIdentity,
      });
      this.#discardExpired();
      this.#plans.set(plan.id, plan);
      return this.#shipping.view(plan);
    } catch (error) {
      this.dependencies.audit('ship-agent-commits', 'failed', {
        projectId: input.target.projectId,
        targetKind: input.target.kind,
        ...(input.target.kind === 'agent-worktree' ? { runId: input.target.runId } : {}),
        strategy: input.strategy,
        stage: 'prepare',
        reason: error instanceof Error ? error.message.slice(0, 4_096) : 'unknown failure',
      });
      throw error;
    }
  }

  public async confirmShipping(options: {
    ownerId: number;
    planId: string;
    parent: BrowserWindow;
    assertCurrent: () => void;
  }): Promise<GitShippingResultView | null> {
    this.#discardExpired();
    const plan = this.#plans.get(options.planId);
    this.#plans.delete(options.planId);
    if (plan === undefined || plan.ownerId !== options.ownerId) {
      throw new Error('The Git approval plan is missing, expired, or belongs to another window.');
    }
    const assertCurrent = this.#approvalAuthority.bind(options.assertCurrent);
    return await this.#confirmation.confirm({
      plan,
      parent: options.parent,
      assertCurrent,
    });
  }

  public prepareConflictRecovery(
    ownerId: number,
    input: GitConflictRecoveryPrepareInput,
  ): Promise<GitConflictRecoveryPlanView> {
    return this.#recovery.prepare(ownerId, input);
  }

  public conflictRecoveryState(
    input: GitTargetInput,
  ): Promise<GitConflictRecoveryStateView | null> {
    return this.#recovery.state(input);
  }

  public confirmConflictRecovery(options: {
    ownerId: number;
    planId: string;
    parent: BrowserWindow;
    assertCurrent: () => void;
  }): Promise<GitConflictRecoveryResultView | null> {
    return this.#recovery.confirm({
      ...options,
      assertCurrent: this.#approvalAuthority.bind(options.assertCurrent),
    });
  }

  public inspectConflicts(input: GitConflictInspectionInput): Promise<GitConflictInspectionView> {
    return this.#conflictFiles.inspect(input);
  }

  public prepareConflictFile(
    ownerId: number,
    input: GitConflictResolutionPrepareInput,
  ): Promise<GitConflictResolutionPlanView> {
    return this.#conflictFiles.prepare(ownerId, input);
  }

  public confirmConflictFile(options: {
    ownerId: number;
    planId: string;
    parent: BrowserWindow;
    assertCurrent: () => void;
  }): Promise<GitConflictResolutionResultView | null> {
    return this.#conflictFiles.confirm({
      ...options,
      assertCurrent: this.#approvalAuthority.bind(options.assertCurrent),
    });
  }

  public clearOwner(ownerId: number): void {
    for (const [id, plan] of this.#plans) if (plan.ownerId === ownerId) this.#plans.delete(id);
    this.#recovery.clearOwner(ownerId);
    this.#conflictFiles.clearOwner(ownerId);
  }

  public clear(): void {
    this.#approvalAuthority.revokeAll();
    this.#plans.clear();
    this.#recovery.clear();
    this.#conflictFiles.clear();
  }

  #discardExpired(): void {
    const now = Date.now();
    for (const [id, plan] of this.#plans) if (plan.expiresAtMs <= now) this.#plans.delete(id);
  }
}
