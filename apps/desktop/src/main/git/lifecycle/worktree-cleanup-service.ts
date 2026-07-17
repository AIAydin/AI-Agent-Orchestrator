import { randomUUID } from 'node:crypto';

import {
  WorktreeService,
  type CleanupApproval,
  type CleanupImpact,
  type CleanupResult,
  type RepositoryService,
} from '@forgeboard/git-engine';
import type { BrowserWindow, Dialog } from 'electron';

import {
  GIT_WORKTREE_CLEANUP_MAX_DIRTY_PATH_CHARACTERS,
  GIT_WORKTREE_CLEANUP_MAX_DIRTY_PATHS,
  GitWorktreeCleanupPlanViewSchema,
  GitWorktreeCleanupReconciledViewSchema,
  GitWorktreeCleanupRelativePathSchema,
  GitWorktreeCleanupResultViewSchema,
  GitWorktreeCleanupTargetInputSchema,
  type GitWorktreeCleanupPlanView,
  type GitWorktreeCleanupPrepareOutcome,
  type GitWorktreeCleanupResultView,
  type GitWorktreeCleanupTargetInput,
} from '../../../shared/git/lifecycle/contracts.js';
import { GitTargetResolutionError, type GitTargetResolver } from '../git-target-resolver.js';
import {
  ProcessActivityPresentError,
  ProcessAdmissionRestoreError,
} from '../../lifecycle/process-quiescence.js';
import type { LocalStore } from '../../storage.js';
import { cleanupConfirmation } from './worktree-cleanup-confirmation.js';
import {
  WorktreeCleanupRecoveryResolutionError,
  WorktreeCleanupRecoveryResolver,
  type ResolvedWorktreeCleanupRecovery,
  type WorktreeCleanupRecoveryAuthority,
} from './worktree-cleanup-recovery.js';

const DEFAULT_PLAN_TTL_MS = 5 * 60_000;
const MAX_PENDING_PLANS_PER_OWNER = 32;

export interface WorktreeCleanupConfirmationAuthority {
  readonly ownerId: number;
  readonly parent: BrowserWindow;
  assertCurrent(): void;
}

/**
 * The injected admission boundary must pause every process-producing service, reject while any
 * run/check/preview/workflow remains live, and keep admissions paused until `operation` settles.
 */
export type WorktreeCleanupAdmission = <Output>(
  operation: () => Promise<Output>,
) => Promise<Output>;

export interface WorktreeCleanupServiceOptions {
  readonly now?: () => Date;
  readonly planTtlMs?: number;
  readonly worktrees?: WorktreeService;
  readonly recovery?: WorktreeCleanupRecoveryAuthority;
  readonly withCleanupAdmission?: WorktreeCleanupAdmission;
}

interface PendingCleanupPlan {
  readonly id: string;
  readonly ownerId: number;
  readonly input: GitWorktreeCleanupTargetInput;
  readonly impact: CleanupImpact;
  readonly expiresAtMs: number;
  readonly view: GitWorktreeCleanupPlanView;
}

type CleanupAuditStore = Pick<
  LocalStore,
  'appendAudit' | 'getProject' | 'getRun' | 'transitionRunWorktreeState'
>;

/** Main-process-only approval and execution boundary for destructive managed-worktree cleanup. */
export class WorktreeCleanupService {
  readonly #plans = new Map<string, PendingCleanupPlan>();
  readonly #now: () => Date;
  readonly #planTtlMs: number;
  readonly #recovery: WorktreeCleanupRecoveryAuthority;
  readonly #worktrees: WorktreeService;
  readonly #withCleanupAdmission: WorktreeCleanupAdmission;
  #operationTail: Promise<void> = Promise.resolve();
  #disposed = false;

  public constructor(
    private readonly dialog: Pick<Dialog, 'showMessageBox'>,
    private readonly store: CleanupAuditStore,
    private readonly targets: GitTargetResolver,
    repositories: RepositoryService,
    options: WorktreeCleanupServiceOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#planTtlMs = boundedPlanTtl(options.planTtlMs ?? DEFAULT_PLAN_TTL_MS);
    this.#worktrees = options.worktrees ?? new WorktreeService(repositories);
    this.#recovery =
      options.recovery ?? new WorktreeCleanupRecoveryResolver(store, repositories, this.#worktrees);
    this.#withCleanupAdmission = options.withCleanupAdmission ?? missingCleanupAdmission;
  }

  public prepare(
    ownerId: number,
    untrustedInput: GitWorktreeCleanupTargetInput,
  ): Promise<GitWorktreeCleanupPrepareOutcome> {
    return this.#withOperation(async () => {
      const parsed = GitWorktreeCleanupTargetInputSchema.safeParse(untrustedInput);
      const input = parsed.success ? parsed.data : null;
      if (input === null) {
        this.#auditPrepareFailure(undefined, 'INVALID_TARGET');
        throw new WorktreeCleanupPublicError('The selected agent worktree target is invalid.');
      }
      try {
        return await this.#prepareCurrentState(ownerId, input);
      } catch (error) {
        this.#auditPrepareFailure(input, errorCode(error), operationCompletionMetadata(error));
        throw publicCleanupError(error, 'prepare');
      }
    });
  }

  async #prepareCurrentState(
    ownerId: number,
    input: GitWorktreeCleanupTargetInput,
  ): Promise<GitWorktreeCleanupPrepareOutcome> {
    assertLiveOwner(ownerId);
    try {
      return await this.#prepareActiveTarget(ownerId, input);
    } catch (error) {
      if (
        !(error instanceof GitTargetResolutionError) ||
        error.code !== 'WORKTREE_LIFECYCLE_INACTIVE'
      ) {
        throw error;
      }
    }
    return await this.#prepareRecoveryTarget(ownerId, input);
  }

  async #prepareActiveTarget(
    ownerId: number,
    input: GitWorktreeCleanupTargetInput,
  ): Promise<GitWorktreeCleanupPlanView> {
    const resolved = await this.targets.resolve(input);
    const impact = await this.#worktrees.cleanupImpact(resolved.ownership);
    assertActiveExactTarget(resolved, impact);
    const plan = this.#createPlan(ownerId, input, impact, false);
    this.#storePlan(plan);
    this.#auditPreparedPlan(plan);
    return plan.view;
  }

  async #prepareRecoveryTarget(
    ownerId: number,
    input: GitWorktreeCleanupTargetInput,
  ): Promise<GitWorktreeCleanupPrepareOutcome> {
    const recovery = await this.#recovery.resolvePending(input);
    switch (recovery.inspection.kind) {
      case 'active-intact': {
        const immediatelyCurrent = await this.#recovery.resolvePending(input);
        if (
          immediatelyCurrent.binding.worktreeId !== recovery.binding.worktreeId ||
          immediatelyCurrent.inspection.kind !== 'active-intact' ||
          !sameCleanupImpact(recovery.inspection.impact, immediatelyCurrent.inspection.impact)
        ) {
          throw new WorktreeCleanupPublicError(
            'The interrupted cleanup state changed while Forgeboard was reviewing it. Try again.',
            'RECOVERY_STATE_CHANGED',
          );
        }
        this.store.transitionRunWorktreeState(
          {
            runId: input.runId,
            expectedWorktreeId: recovery.binding.worktreeId,
            expectedState: 'cleanup-pending',
            nextState: 'active',
          },
          this.#now(),
        );
        return await this.#prepareActiveTarget(ownerId, input);
      }
      case 'cleanup-pending': {
        const plan = this.#createPlan(ownerId, input, recovery.inspection.impact, true);
        this.#storePlan(plan);
        this.#auditPreparedPlan(plan);
        return plan.view;
      }
      case 'fully-removed':
        return await this.#reconcileFullyRemoved(input, recovery);
      case 'unsafe':
        throw new WorktreeCleanupPublicError(
          'Forgeboard could not prove the interrupted cleanup state. The target remains hidden; no files or branches were changed.',
          recoveryUnsafeCode(recovery.inspection.reason),
        );
    }
  }

  async #reconcileFullyRemoved(
    input: GitWorktreeCleanupTargetInput,
    recovery: ResolvedWorktreeCleanupRecovery,
  ): Promise<GitWorktreeCleanupPrepareOutcome> {
    const immediatelyCurrent = await this.#recovery.resolvePending(input);
    if (
      immediatelyCurrent.binding.worktreeId !== recovery.binding.worktreeId ||
      immediatelyCurrent.inspection.kind !== 'fully-removed'
    ) {
      throw new WorktreeCleanupPublicError(
        'The interrupted cleanup state changed while Forgeboard was reviewing it. Try again.',
        'RECOVERY_STATE_CHANGED',
      );
    }
    try {
      this.store.transitionRunWorktreeState(
        {
          runId: input.runId,
          expectedWorktreeId: recovery.binding.worktreeId,
          expectedState: 'cleanup-pending',
          nextState: 'cleaned',
        },
        this.#now(),
      );
    } catch (error) {
      throw new WorktreeCleanupStateError(
        'Cleanup was already complete, but Forgeboard could not finalize its run-history state. The target remains hidden.',
        'RECOVERY_FINAL_PERSISTENCE_FAILED',
        { operationCompleted: true, cause: error },
      );
    }
    const reconciled = GitWorktreeCleanupReconciledViewSchema.parse({
      kind: 'cleanup-reconciled',
      worktreeRemoved: true,
      branchDeleted: true,
      metadataRemoved: true,
    });
    try {
      this.store.appendAudit('git', 'cleanup-worktree-reconcile', 'allowed', {
        projectId: input.projectId,
        runId: input.runId,
        worktreeId: recovery.binding.worktreeId,
        recovery: true,
        operationCompleted: true,
        ...reconciled,
      });
      this.store.appendAudit('git', 'cleanup-worktree-prepare', 'allowed', {
        projectId: input.projectId,
        runId: input.runId,
        worktreeId: recovery.binding.worktreeId,
        recovery: true,
        reconciled: true,
        policy: safeCleanupPolicy(),
      });
    } catch (error) {
      throw new WorktreeCleanupStateError(
        'Cleanup was already complete and run history was reconciled, but Forgeboard could not record the final audit. The target is cleaned.',
        'RECOVERY_SUCCESS_AUDIT_FAILED',
        { operationCompleted: true, cause: error },
      );
    }
    return reconciled;
  }

  #auditPreparedPlan(plan: PendingCleanupPlan): void {
    this.store.appendAudit('git', 'cleanup-worktree-prepare', 'allowed', {
      ...auditTarget(plan),
      recovery: plan.view.recovery,
      dirtyPathCount: plan.impact.dirtyPaths.length,
      mergedIntoBase: plan.impact.mergedIntoBase,
      policy: safeCleanupPolicy(),
    });
  }

  public confirm(
    authority: WorktreeCleanupConfirmationAuthority,
    planId: string,
  ): Promise<GitWorktreeCleanupResultView | null> {
    return this.#withOperation(async () => {
      let plan: PendingCleanupPlan;
      try {
        plan = this.#takePlan(authority.ownerId, planId);
      } catch (error) {
        this.#appendFailureAudit('cleanup-worktree', {
          planId,
          reason: errorCode(error),
          policy: safeCleanupPolicy(),
        });
        throw error;
      }
      try {
        authority.assertCurrent();
        const current = await this.#resolveCurrentImpact(plan);
        assertSafeCleanupImpact(current);
        const decision = await this.dialog.showMessageBox(
          authority.parent,
          cleanupConfirmation(plan.view, current),
        );
        authority.assertCurrent();
        if (decision.response !== 1) {
          this.store.appendAudit('git', 'cleanup-worktree', 'denied', {
            ...auditTarget(plan),
            reason: 'native-confirmation-cancelled',
            dirtyPathCount: current.dirtyPaths.length,
            mergedIntoBase: current.mergedIntoBase,
            policy: safeCleanupPolicy(),
          });
          return null;
        }
        if (plan.expiresAtMs <= this.#now().getTime()) {
          this.store.appendAudit('git', 'cleanup-worktree', 'denied', {
            ...auditTarget(plan),
            reason: 'approval-expired-after-confirmation',
            policy: safeCleanupPolicy(),
          });
          return null;
        }

        const result = await this.#withCleanupAdmission(async () => {
          authority.assertCurrent();
          this.#assertPlanUnexpired(plan);
          const immediatelyCurrent = await this.#resolveCurrentImpact(plan);
          assertSafeCleanupImpact(immediatelyCurrent);
          authority.assertCurrent();
          this.#assertPlanUnexpired(plan);
          if (!plan.view.recovery) {
            this.store.transitionRunWorktreeState(
              {
                runId: plan.input.runId,
                expectedWorktreeId: immediatelyCurrent.ownership.id,
                expectedState: 'active',
                nextState: 'cleanup-pending',
              },
              this.#now(),
            );
          }
          let cleanupResult: CleanupResult;
          try {
            cleanupResult = await this.#worktrees.cleanup(
              immediatelyCurrent.ownership,
              cleanupApproval(plan.id, this.#now(), immediatelyCurrent),
            );
          } catch (error) {
            if (!plan.view.recovery && (await this.#isExactActiveImpact(plan))) {
              try {
                this.store.transitionRunWorktreeState(
                  {
                    runId: plan.input.runId,
                    expectedWorktreeId: immediatelyCurrent.ownership.id,
                    expectedState: 'cleanup-pending',
                    nextState: 'active',
                  },
                  this.#now(),
                );
              } catch (rollbackError) {
                throw new WorktreeCleanupStateError(
                  'Cleanup did not remove the worktree, but Forgeboard could not restore its run-history state. Restart Forgeboard before retrying.',
                  'CLEANUP_ROLLBACK_PERSISTENCE_FAILED',
                  { cause: new AggregateError([error, rollbackError]) },
                );
              }
              throw error;
            }
            throw new WorktreeCleanupStateError(
              'Cleanup may have partially completed. Forgeboard hid this worktree target until its exact state is reviewed again.',
              'CLEANUP_MUTATION_STATE_UNCERTAIN',
              { mutationMayHaveCompleted: true, cause: error },
            );
          }
          if (!isCompleteCleanupResult(cleanupResult)) {
            throw new WorktreeCleanupStateError(
              'Cleanup returned an incomplete result. Forgeboard hid this worktree target until its exact state is reviewed again.',
              'CLEANUP_RESULT_INCOMPLETE',
              { mutationMayHaveCompleted: true },
            );
          }
          try {
            this.store.transitionRunWorktreeState(
              {
                runId: plan.input.runId,
                expectedWorktreeId: immediatelyCurrent.ownership.id,
                expectedState: 'cleanup-pending',
                nextState: 'cleaned',
              },
              this.#now(),
            );
          } catch (error) {
            throw new WorktreeCleanupStateError(
              'Cleanup completed, but Forgeboard could not finalize its run-history state. The worktree target remains hidden.',
              'CLEANUP_FINAL_PERSISTENCE_FAILED',
              { operationCompleted: true, cause: error },
            );
          }
          return cleanupResult;
        });
        const view = GitWorktreeCleanupResultViewSchema.parse(result);
        try {
          this.store.appendAudit('git', 'cleanup-worktree', 'allowed', {
            ...auditTarget(plan),
            dirtyPathCount: plan.impact.dirtyPaths.length,
            mergedIntoBase: plan.impact.mergedIntoBase,
            policy: safeCleanupPolicy(),
            ...view,
          });
        } catch (error) {
          throw new WorktreeCleanupStateError(
            'Cleanup completed and run history was finalized, but Forgeboard could not record the final audit. The target is cleaned.',
            'CLEANUP_SUCCESS_AUDIT_FAILED',
            { operationCompleted: true, cause: error },
          );
        }
        return view;
      } catch (error) {
        this.#appendFailureAudit('cleanup-worktree', {
          ...auditTarget(plan),
          reason: errorCode(error),
          ...operationCompletionMetadata(error),
          policy: safeCleanupPolicy(),
        });
        throw publicCleanupError(error, 'confirm');
      }
    });
  }

  public discardOwner(ownerId: number): void {
    for (const [id, plan] of this.#plans) {
      if (plan.ownerId === ownerId) this.#plans.delete(id);
    }
  }

  public clearPlans(): void {
    this.#plans.clear();
  }

  public async dispose(): Promise<void> {
    if (!this.#disposed) {
      this.#disposed = true;
      this.#plans.clear();
    }
    await this.#operationTail;
  }

  async #resolveCurrentImpact(plan: PendingCleanupPlan): Promise<CleanupImpact> {
    if (plan.view.recovery) {
      const recovery = await this.#recovery.resolvePending(plan.input);
      if (
        recovery.inspection.kind !== 'cleanup-pending' ||
        !sameCleanupImpact(plan.impact, recovery.inspection.impact)
      ) {
        throw new WorktreeCleanupPublicError(
          'The interrupted cleanup state changed after review. Prepare a new recovery plan.',
          'STALE_PLAN',
        );
      }
      return recovery.inspection.impact;
    }
    const resolved = await this.targets.resolve(plan.input);
    const impact = await this.#worktrees.cleanupImpact(resolved.ownership);
    assertActiveExactTarget(resolved, impact);
    if (!sameCleanupImpact(plan.impact, impact)) {
      throw new WorktreeCleanupPublicError(
        'The agent worktree changed after review. Prepare a new cleanup plan.',
        'STALE_PLAN',
      );
    }
    return impact;
  }

  async #isExactActiveImpact(plan: PendingCleanupPlan): Promise<boolean> {
    try {
      const impact = await this.#worktrees.cleanupImpact(plan.impact.ownership);
      return impact.ownership.status === 'active' && sameCleanupImpact(plan.impact, impact);
    } catch {
      return false;
    }
  }

  #createPlan(
    ownerId: number,
    input: GitWorktreeCleanupTargetInput,
    impact: CleanupImpact,
    recovery: boolean,
  ): PendingCleanupPlan {
    assertLiveOwner(ownerId);
    const id = randomUUID();
    const expiresAtMs = this.#now().getTime() + this.#planTtlMs;
    const dirtyPaths = disclosedDirtyPaths(impact.dirtyPaths);
    const view = GitWorktreeCleanupPlanViewSchema.parse({
      kind: 'cleanup-worktree',
      recovery,
      planId: id,
      expiresAt: new Date(expiresAtMs).toISOString(),
      branch: impact.ownership.branch,
      baseRef: impact.ownership.baseRef,
      clean: impact.dirtyPaths.length === 0,
      mergedIntoBase: impact.mergedIntoBase,
      dirtyPaths,
      dirtyPathCount: impact.dirtyPaths.length,
      dirtyPathsTruncated: dirtyPaths.length < impact.dirtyPaths.length,
      force: false,
      deleteBranch: true,
      allowDirty: false,
      allowUnmergedBranch: false,
    });
    return {
      id,
      ownerId,
      input: { ...input },
      impact: copyImpact(impact),
      expiresAtMs,
      view,
    };
  }

  #storePlan(plan: PendingCleanupPlan): void {
    this.#discardExpiredPlans();
    for (const [id, candidate] of this.#plans) {
      if (
        candidate.ownerId === plan.ownerId &&
        candidate.input.projectId === plan.input.projectId &&
        candidate.input.runId === plan.input.runId
      ) {
        this.#plans.delete(id);
      }
    }
    const ownerPlans = [...this.#plans.values()]
      .filter((candidate) => candidate.ownerId === plan.ownerId)
      .sort((left, right) => left.expiresAtMs - right.expiresAtMs);
    while (ownerPlans.length >= MAX_PENDING_PLANS_PER_OWNER) {
      const oldest = ownerPlans.shift();
      if (oldest !== undefined) this.#plans.delete(oldest.id);
    }
    this.#plans.set(plan.id, plan);
  }

  #takePlan(ownerId: number, planId: string): PendingCleanupPlan {
    this.#assertAvailable();
    this.#discardExpiredPlans();
    const plan = this.#plans.get(planId);
    if (plan === undefined || plan.ownerId !== ownerId) {
      throw new WorktreeCleanupPublicError(
        'The cleanup plan is missing, expired, or belongs to another window.',
        'PLAN_UNAVAILABLE',
      );
    }
    this.#plans.delete(planId);
    return plan;
  }

  #discardExpiredPlans(): void {
    const now = this.#now().getTime();
    for (const [id, plan] of this.#plans) {
      if (plan.expiresAtMs <= now) this.#plans.delete(id);
    }
  }

  #assertPlanUnexpired(plan: PendingCleanupPlan): void {
    if (plan.expiresAtMs <= this.#now().getTime()) {
      throw new WorktreeCleanupPublicError(
        'The cleanup approval expired. Prepare and review a new cleanup plan.',
        'PLAN_EXPIRED',
      );
    }
  }

  #auditPrepareFailure(
    input: GitWorktreeCleanupTargetInput | undefined,
    reason: string,
    completion: Record<string, boolean> = {},
  ): void {
    this.#appendFailureAudit('cleanup-worktree-prepare', {
      ...(input === undefined ? {} : input),
      reason,
      ...completion,
      policy: safeCleanupPolicy(),
    });
  }

  #appendFailureAudit(action: string, metadata: Record<string, unknown>): void {
    try {
      this.store.appendAudit('git', action, 'failed', metadata);
    } catch {
      // A secondary audit-storage failure must never hide the primary lifecycle outcome.
    }
  }

  #assertAvailable(): void {
    if (this.#disposed) {
      throw new WorktreeCleanupPublicError('The Git cleanup service has been disposed.');
    }
  }

  async #withOperation<Output>(operation: () => Promise<Output>): Promise<Output> {
    let release: () => void = () => undefined;
    const previous = this.#operationTail;
    this.#operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.#assertAvailable();
      return await operation();
    } finally {
      release();
    }
  }
}

class WorktreeCleanupPublicError extends Error {
  public constructor(
    message: string,
    public readonly code = 'CLEANUP_REFUSED',
  ) {
    super(message);
    this.name = 'WorktreeCleanupPublicError';
  }
}

class WorktreeCleanupStateError extends Error {
  public readonly operationCompleted: boolean | undefined;
  public readonly mutationMayHaveCompleted: boolean | undefined;

  public constructor(
    message: string,
    public readonly code: string,
    options: ErrorOptions & {
      readonly operationCompleted?: boolean;
      readonly mutationMayHaveCompleted?: boolean;
    } = {},
  ) {
    super(message, options);
    this.name = 'WorktreeCleanupStateError';
    this.operationCompleted = options.operationCompleted;
    this.mutationMayHaveCompleted = options.mutationMayHaveCompleted;
  }
}

function assertActiveExactTarget(
  resolved: Awaited<ReturnType<GitTargetResolver['resolve']>>,
  impact: CleanupImpact,
): void {
  const currentStatus = impact.status;
  if (
    impact.ownership.status !== 'active' ||
    impact.ownership.id !== resolved.ownership.id ||
    impact.ownership.repositoryRoot !== resolved.ownership.repositoryRoot ||
    impact.ownership.managedRoot !== resolved.ownership.managedRoot ||
    impact.ownership.worktreePath !== resolved.ownership.worktreePath ||
    impact.ownership.branch !== resolved.ownership.branch ||
    impact.ownership.baseRef !== resolved.ownership.baseRef ||
    impact.ownership.baseCommit !== resolved.ownership.baseCommit ||
    impact.missing ||
    !impact.branchExists ||
    impact.branchOid === null ||
    currentStatus === null ||
    currentStatus.branch !== impact.ownership.branch ||
    currentStatus.headOid !== impact.branchOid
  ) {
    throw new WorktreeCleanupPublicError(
      'The selected agent worktree is no longer an active exact target.',
      'TARGET_CHANGED',
    );
  }
}

function assertSafeCleanupImpact(impact: CleanupImpact): void {
  if (impact.dirtyPaths.length > 0 || impact.status?.dirty === true) {
    throw new WorktreeCleanupPublicError(
      'Commit or discard every agent-worktree change before cleanup.',
      'DIRTY_WORKTREE',
    );
  }
  if (!impact.mergedIntoBase) {
    throw new WorktreeCleanupPublicError(
      'Deliver or merge the agent branch before cleanup.',
      'NOT_MERGED',
    );
  }
}

function sameCleanupImpact(left: CleanupImpact, right: CleanupImpact): boolean {
  return (
    left.ownership.id === right.ownership.id &&
    left.ownership.repositoryRoot === right.ownership.repositoryRoot &&
    left.ownership.managedRoot === right.ownership.managedRoot &&
    left.ownership.worktreePath === right.ownership.worktreePath &&
    left.ownership.branch === right.ownership.branch &&
    left.ownership.baseRef === right.ownership.baseRef &&
    left.ownership.baseCommit === right.ownership.baseCommit &&
    left.ownership.agentId === right.ownership.agentId &&
    left.ownership.taskId === right.ownership.taskId &&
    left.ownership.status === right.ownership.status &&
    left.expectedHead === right.expectedHead &&
    left.branchExists === right.branchExists &&
    left.branchOid === right.branchOid &&
    left.mergedIntoBase === right.mergedIntoBase &&
    left.missing === right.missing &&
    left.status?.branch === right.status?.branch &&
    left.status?.headOid === right.status?.headOid &&
    left.status?.dirty === right.status?.dirty &&
    left.status?.conflicted === right.status?.conflicted &&
    sameStrings(left.dirtyPaths, right.dirtyPaths)
  );
}

function cleanupApproval(
  approvalId: string,
  approvedAt: Date,
  impact: CleanupImpact,
): CleanupApproval {
  return {
    action: 'cleanup-worktree',
    approved: true,
    approvalId,
    approvedAt: approvedAt.toISOString(),
    repositoryRoot: impact.ownership.repositoryRoot,
    expectedHead: impact.expectedHead,
    worktreeId: impact.ownership.id,
    worktreePath: impact.ownership.worktreePath,
    branch: impact.ownership.branch,
    expectedBranchOid: impact.branchOid,
    dirtyPaths: [...impact.dirtyPaths],
    deleteBranch: true,
    allowDirty: false,
    allowUnmergedBranch: false,
  };
}

function copyImpact(impact: CleanupImpact): CleanupImpact {
  return {
    ...impact,
    ownership: { ...impact.ownership },
    status:
      impact.status === null
        ? null
        : {
            ...impact.status,
            entries: impact.status.entries.map((entry) => ({ ...entry })),
          },
    dirtyPaths: [...impact.dirtyPaths],
  };
}

function disclosedDirtyPaths(paths: readonly string[]): string[] {
  const disclosed: string[] = [];
  let characters = 0;
  for (const candidate of [...paths].sort(codeUnitCompare)) {
    if (!GitWorktreeCleanupRelativePathSchema.safeParse(candidate).success) continue;
    if (disclosed.includes(candidate)) continue;
    if (disclosed.length >= GIT_WORKTREE_CLEANUP_MAX_DIRTY_PATHS) break;
    if (characters + candidate.length > GIT_WORKTREE_CLEANUP_MAX_DIRTY_PATH_CHARACTERS) break;
    disclosed.push(candidate);
    characters += candidate.length;
  }
  return disclosed;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeCleanupPolicy(): Record<string, boolean> {
  return {
    deleteBranch: true,
    allowDirty: false,
    allowUnmergedBranch: false,
    force: false,
  };
}

function auditTarget(plan: PendingCleanupPlan): Record<string, unknown> {
  return {
    projectId: plan.input.projectId,
    runId: plan.input.runId,
    worktreeId: plan.impact.ownership.id,
    recovery: plan.view.recovery,
  };
}

function errorCode(error: unknown): string {
  if (error instanceof WorktreeCleanupPublicError) return error.code;
  if (error instanceof GitTargetResolutionError) return error.code;
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code)) return code;
  }
  return 'OPERATION_FAILED';
}

function publicCleanupError(error: unknown, stage: 'prepare' | 'confirm'): Error {
  if (
    error instanceof WorktreeCleanupPublicError ||
    error instanceof WorktreeCleanupStateError ||
    error instanceof WorktreeCleanupRecoveryResolutionError ||
    error instanceof GitTargetResolutionError ||
    error instanceof ProcessActivityPresentError ||
    error instanceof ProcessAdmissionRestoreError
  ) {
    return error;
  }
  return new WorktreeCleanupPublicError(
    stage === 'prepare'
      ? 'Forgeboard could not safely inspect this agent worktree for cleanup.'
      : 'Forgeboard could not safely clean up this agent worktree.',
    errorCode(error),
  );
}

function assertLiveOwner(ownerId: number): void {
  if (!Number.isInteger(ownerId) || ownerId <= 0) {
    throw new WorktreeCleanupPublicError('A live Forgeboard window is required for cleanup.');
  }
}

function recoveryUnsafeCode(reason: string): string {
  const suffix = reason.replaceAll('-', '_').toUpperCase();
  const candidate = `RECOVERY_UNSAFE_${suffix}`;
  return /^[A-Z][A-Z0-9_]{0,63}$/u.test(candidate) ? candidate : 'RECOVERY_UNSAFE';
}

function operationCompletionMetadata(error: unknown): Record<string, boolean> {
  if (error instanceof ProcessAdmissionRestoreError) {
    return { operationCompleted: error.operationCompleted };
  }
  if (error instanceof WorktreeCleanupStateError) {
    return {
      ...(error.operationCompleted === undefined
        ? {}
        : { operationCompleted: error.operationCompleted }),
      ...(error.mutationMayHaveCompleted === undefined
        ? {}
        : { mutationMayHaveCompleted: error.mutationMayHaveCompleted }),
    };
  }
  return {};
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isCompleteCleanupResult(result: CleanupResult): boolean {
  return result.worktreeRemoved && result.branchDeleted && result.metadataRemoved;
}

function boundedPlanTtl(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PLAN_TTL_MS;
  return Math.max(1, Math.min(10 * 60_000, Math.trunc(value)));
}

function missingCleanupAdmission<Output>(): Promise<Output> {
  return Promise.reject(
    new WorktreeCleanupPublicError(
      'Worktree cleanup is unavailable until every process admission boundary can be verified.',
      'PROCESS_QUIESCENCE_UNAVAILABLE',
    ),
  );
}
