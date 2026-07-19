import { randomUUID } from 'node:crypto';

import {
  ChangeService,
  patchSha256,
  selectDiffHunks,
  WorktreeService,
  type ArchiveImpact,
  type ArchiveWorktreeApproval,
  type BranchRenameImpact,
  type CommitApproval,
  type DiscardHunksApproval,
  type ParsedDiff,
  type RenameManagedBranchApproval,
  type RestoreArchivedWorktreeApproval,
  type RepositoryService,
} from '@forgeboard/git-engine';
import { BrowserWindow, ipcMain, type Dialog, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';

import type { AppSettings, IpcResult } from '../../shared/application/contracts.js';
import { IPC_CHANNELS, ipcResultSchema } from '../../shared/application/contracts.js';
import {
  GitCommitPlanInputSchema,
  GitCommitPlanViewSchema,
  GitCommitResultViewSchema,
  GitDiscardPlanViewSchema,
  GitHunkSelectionInputSchema,
  GitIdentityViewSchema,
  GitPathSelectionInputSchema,
  GitPlanConfirmationInputSchema,
  GitReviewTargetViewSchema,
  GitReviewViewSchema,
  GitTargetInputSchema,
  type GitCommitPlanInput,
  type GitCommitPlanView,
  type GitCommitResultView,
  type GitDiffView,
  type GitDiscardPlanView,
  type GitHunkSelectionInput,
  type GitIdentityView,
  type GitPathSelectionInput,
  type GitReviewTargetView,
  type GitReviewView,
  type GitTargetInput,
} from '../../shared/git/contracts.js';
import {
  GitShippingPlanInputSchema,
  GitShippingPlanViewSchema,
  GitShippingResultViewSchema,
  type GitShippingPlanInput,
  type GitShippingPlanView,
  type GitShippingResultView,
} from '../../shared/git/shipping-contracts.js';
import {
  GIT_AGENT_COMPARISON_IPC_CHANNELS,
  GitAgentComparisonInputSchema,
  GitAgentComparisonViewSchema,
  type GitAgentComparisonInput,
  type GitAgentComparisonView,
} from '../../shared/git/comparison/contracts.js';
import {
  GIT_LIFECYCLE_IPC_CHANNELS,
  GitWorkspaceExternalOpenResultSchema,
  GitWorktreeCleanupConfirmationInputSchema,
  GitWorktreeCleanupPrepareOutcomeSchema,
  GitWorktreeCleanupResultViewSchema,
  GitWorktreeCleanupTargetInputSchema,
  GitWorktreeArchivePlanViewSchema,
  GitWorktreeMetadataConfirmationInputSchema,
  GitWorktreeMetadataResultViewSchema,
  GitWorktreeRenamePlanViewSchema,
  GitWorktreeRenamePrepareInputSchema,
  GitWorktreeRestorePlanViewSchema,
  type GitWorktreeMetadataResultView,
  type GitWorktreeRenamePrepareInput,
  type GitWorktreeCleanupPrepareOutcome,
  type GitWorktreeCleanupResultView,
  type GitWorktreeCleanupTargetInput,
  type GitWorkspaceExternalOpenResult,
} from '../../shared/git/lifecycle/contracts.js';
import {
  GIT_REVIEW_NOTE_IPC_CHANNELS,
  GitReviewNoteCreateInputSchema,
  GitReviewNoteDeleteInputSchema,
  GitReviewNotesListInputSchema,
  GitReviewNotesViewSchema,
  GitReviewNoteUpdateInputSchema,
  type GitReviewNoteCreateInput,
  type GitReviewNoteDeleteInput,
  type GitReviewNotesListInput,
  type GitReviewNotesView,
  type GitReviewNoteUpdateInput,
} from '../../shared/git/reviews/contracts.js';
import { GitTargetResolver } from './git-target-resolver.js';
import type { LocalStore } from '../storage.js';
import { createAgentBaseComparison } from './git-base-comparison.js';
import { createNativeGitDelegateAuthorizer } from './delegates/native-confirmation.js';
import {
  WorktreeCleanupService,
  type WorktreeCleanupAdmission,
} from './lifecycle/worktree-cleanup-service.js';
import { worktreeMetadataConfirmation } from './lifecycle/worktree-metadata-confirmation.js';
import { reconcileFailedWorktreeMetadataEffect } from './lifecycle/metadata-intent-recovery.js';
import {
  GitShippingService,
  type GitShippingReadinessAuthority,
  type PendingGitShippingPlan,
} from './shipping/git-shipping-service.js';
import { shippingConfirmation } from './shipping/native-confirmation.js';
import { GitReviewNotesService } from './reviews/review-notes-service.js';
import { reviewNoteDeleteConfirmation } from './reviews/native-confirmation.js';
import {
  commitConfirmation,
  discardConfirmation,
  externalOpenConfirmation,
} from './reviews/native-action-confirmations.js';
import { normalizeGitIdentityValue, repositoryGitIdentity } from './identity/values.js';
import { GitAgentComparisonService } from './comparison/service.js';
import {
  auditInputTargetMetadata,
  auditTargetMetadata,
  targetInput,
  targetKey,
} from './targets/view-metadata.js';

const PLAN_TTL_MS = 5 * 60_000;
const MAX_PENDING_PLANS_PER_OWNER = 32;
const denyShippingWithoutReadiness: GitShippingReadinessAuthority = {
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

interface PendingPlanBase {
  readonly id: string;
  readonly ownerId: number;
  readonly target: GitReviewTargetView;
  readonly repositoryRoot: string;
  readonly expiresAtMs: number;
}

export interface PendingCommitPlan extends PendingPlanBase {
  readonly kind: 'commit';
  readonly message: string;
  readonly branch: string | null;
  readonly expectedHead: string;
  readonly stagedPaths: readonly string[];
  readonly stagedPatchSha256: string;
  readonly additions: number;
  readonly deletions: number;
  readonly identity: GitIdentityView;
}

export interface PendingDiscardPlan extends PendingPlanBase {
  readonly kind: 'discard-hunks';
  readonly branch: string | null;
  readonly expectedHead: string;
  readonly hunkIds: readonly string[];
  readonly patchSha256: string;
  readonly paths: readonly string[];
  readonly additions: number;
  readonly deletions: number;
}

interface PendingRenamePlan extends PendingPlanBase {
  readonly kind: 'rename-worktree-branch';
  readonly input: GitWorktreeRenamePrepareInput;
  readonly impact: BranchRenameImpact;
  readonly branch: string;
  readonly newBranch: string;
  readonly expectedBranchOid: string;
  readonly dirtyPaths: readonly string[];
}

interface PendingArchivePlan extends PendingPlanBase {
  readonly kind: 'archive-worktree' | 'restore-worktree';
  readonly input: GitWorktreeCleanupTargetInput;
  readonly impact: ArchiveImpact;
  readonly branch: string;
  readonly expectedBranchOid: string | null;
  readonly dirtyPaths: readonly string[];
}

export type PendingWorktreeMetadataPlan = PendingRenamePlan | PendingArchivePlan;

type PendingPlan =
  | PendingCommitPlan
  | PendingDiscardPlan
  | PendingGitShippingPlan
  | PendingWorktreeMetadataPlan;

interface GitTarget {
  readonly view: GitReviewTargetView;
  readonly repositoryRoot: string;
  readonly comparisonBinding?: {
    readonly projectId: string;
    readonly runId: string;
    readonly worktreeId: string;
    readonly branch: string;
    readonly baseCommit: string;
    readonly headCommit: string;
  };
}

type WindowResolver = (event: IpcMainInvokeEvent) => BrowserWindow | null;

export interface GitIpcServiceOptions {
  readonly withCleanupAdmission?: WorktreeCleanupAdmission;
  readonly shippingReadiness?: GitShippingReadinessAuthority;
  readonly openExternalPath?: (path: string) => Promise<string>;
}

export class GitIpcService {
  readonly #changes: ChangeService;
  readonly #registeredChannels: string[] = [];
  readonly #plans = new Map<string, PendingPlan>();
  readonly #trackedOwners = new Set<number>();
  readonly #operationParents = new WeakMap<IpcMainInvokeEvent, BrowserWindow>();
  readonly #targets: GitTargetResolver;
  readonly #shipping: GitShippingService;
  readonly #reviewNotes: GitReviewNotesService;
  readonly #cleanup: WorktreeCleanupService;
  readonly #comparison: GitAgentComparisonService;
  readonly #worktrees: WorktreeService;
  readonly #openExternalPath: (path: string) => Promise<string>;
  #disposed = false;
  #disposePromise: Promise<void> | null = null;
  #privacyResetting = false;
  #operationTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly dialog: Pick<Dialog, 'showMessageBox'>,
    private readonly store: Pick<
      LocalStore,
      | 'appendAudit'
      | 'beginGitWorktreeMetadataIntent'
      | 'createReviewNote'
      | 'deleteReviewNote'
      | 'getGitWorktreeMetadataIntent'
      | 'getProject'
      | 'getProjectByPath'
      | 'getRun'
      | 'listReviewNotes'
      | 'renameRunWorktreeBranch'
      | 'reconcileGitWorktreeMetadataIntent'
      | 'saveProject'
      | 'transitionRunWorktreeState'
      | 'updateReviewNote'
    >,
    private readonly repositories: RepositoryService,
    private readonly getSettings: () => AppSettings,
    private readonly resolveWindow: WindowResolver = (event) =>
      BrowserWindow.fromWebContents(event.sender),
    options: GitIpcServiceOptions = {},
  ) {
    this.#changes = new ChangeService(repositories);
    this.#targets = new GitTargetResolver(store, repositories, getSettings);
    this.#shipping = new GitShippingService(
      this.#targets,
      repositories,
      this.#changes,
      options.shippingReadiness ?? denyShippingWithoutReadiness,
    );
    this.#reviewNotes = new GitReviewNotesService(store);
    this.#cleanup = new WorktreeCleanupService(this.dialog, store, this.#targets, repositories, {
      ...(options.withCleanupAdmission === undefined
        ? {}
        : { withCleanupAdmission: options.withCleanupAdmission }),
    });
    this.#comparison = new GitAgentComparisonService(this.#targets, repositories);
    this.#worktrees = new WorktreeService(repositories);
    this.#openExternalPath = options.openExternalPath ?? unavailableExternalOpen;
  }

  public registerIpcHandlers(): void {
    this.#handle(
      IPC_CHANNELS.gitReview,
      z.tuple([GitTargetInputSchema]),
      GitReviewViewSchema,
      (event, input) => {
        this.#trackOwner(event);
        return this.review(input);
      },
    );
    this.#handle(
      GIT_AGENT_COMPARISON_IPC_CHANNELS.compare,
      z.tuple([GitAgentComparisonInputSchema]),
      GitAgentComparisonViewSchema,
      (event, input) => {
        this.#trackOwner(event);
        return this.compareAgents(input);
      },
    );
    this.#handle(
      IPC_CHANNELS.gitStagePaths,
      z.tuple([GitPathSelectionInputSchema]),
      GitReviewViewSchema,
      (event, input) => {
        this.#trackOwner(event);
        return this.stagePaths(input);
      },
    );
    this.#handle(
      IPC_CHANNELS.gitStageHunks,
      z.tuple([GitHunkSelectionInputSchema]),
      GitReviewViewSchema,
      (event, input) => {
        this.#trackOwner(event);
        return this.stageHunks(input);
      },
    );
    this.#handle(
      IPC_CHANNELS.gitUnstagePaths,
      z.tuple([GitPathSelectionInputSchema]),
      GitReviewViewSchema,
      (event, input) => {
        this.#trackOwner(event);
        return this.unstagePaths(input);
      },
    );
    this.#handle(
      IPC_CHANNELS.gitUnstageHunks,
      z.tuple([GitHunkSelectionInputSchema]),
      GitReviewViewSchema,
      (event, input) => {
        this.#trackOwner(event);
        return this.unstageHunks(input);
      },
    );
    this.#handle(
      IPC_CHANNELS.gitPrepareDiscard,
      z.tuple([GitHunkSelectionInputSchema]),
      GitDiscardPlanViewSchema,
      (event, input) => {
        this.#trackOwner(event);
        return this.prepareDiscard(event.sender.id, input);
      },
    );
    this.#handle(
      IPC_CHANNELS.gitConfirmDiscard,
      z.tuple([GitPlanConfirmationInputSchema]),
      GitReviewViewSchema.nullable(),
      (event, input) => this.confirmDiscard(event, input.planId),
    );
    this.#handle(
      IPC_CHANNELS.gitPrepareCommit,
      z.tuple([GitCommitPlanInputSchema]),
      GitCommitPlanViewSchema,
      (event, input) => {
        this.#trackOwner(event);
        return this.prepareCommit(event.sender.id, input);
      },
    );
    this.#handle(
      IPC_CHANNELS.gitConfirmCommit,
      z.tuple([GitPlanConfirmationInputSchema]),
      GitCommitResultViewSchema.nullable(),
      (event, input) => this.confirmCommit(event, input.planId),
    );
    this.#handle(
      IPC_CHANNELS.gitPrepareShipping,
      z.tuple([GitShippingPlanInputSchema]),
      GitShippingPlanViewSchema,
      (event, input) => {
        this.#trackOwner(event);
        return this.prepareShipping(event.sender.id, input);
      },
    );
    this.#handle(
      IPC_CHANNELS.gitConfirmShipping,
      z.tuple([GitPlanConfirmationInputSchema]),
      GitShippingResultViewSchema.nullable(),
      (event, input) => this.confirmShipping(event, input.planId),
    );
    this.#handle(
      GIT_LIFECYCLE_IPC_CHANNELS.openExternal,
      z.tuple([GitTargetInputSchema]),
      GitWorkspaceExternalOpenResultSchema,
      (event, input) => {
        this.#trackOwner(event);
        return this.openExternal(event, input);
      },
    );
    this.#handle(
      GIT_LIFECYCLE_IPC_CHANNELS.prepareCleanup,
      z.tuple([GitWorktreeCleanupTargetInputSchema]),
      GitWorktreeCleanupPrepareOutcomeSchema,
      (event, input) => {
        this.#trackOwner(event);
        return this.prepareCleanup(event.sender.id, input);
      },
    );
    this.#handle(
      GIT_LIFECYCLE_IPC_CHANNELS.confirmCleanup,
      z.tuple([GitWorktreeCleanupConfirmationInputSchema]),
      GitWorktreeCleanupResultViewSchema.nullable(),
      (event, input) => this.confirmCleanup(event, input.planId),
    );
    this.#handle(
      GIT_LIFECYCLE_IPC_CHANNELS.prepareRename,
      z.tuple([GitWorktreeRenamePrepareInputSchema]),
      GitWorktreeRenamePlanViewSchema,
      (event, input) => {
        this.#trackOwner(event);
        return this.prepareWorktreeRename(event.sender.id, input);
      },
    );
    this.#handle(
      GIT_LIFECYCLE_IPC_CHANNELS.confirmRename,
      z.tuple([GitWorktreeMetadataConfirmationInputSchema]),
      GitWorktreeMetadataResultViewSchema.nullable(),
      (event, input) => this.confirmWorktreeMetadata(event, input.planId, 'rename-worktree-branch'),
    );
    this.#handle(
      GIT_LIFECYCLE_IPC_CHANNELS.prepareArchive,
      z.tuple([GitWorktreeCleanupTargetInputSchema]),
      GitWorktreeArchivePlanViewSchema,
      (event, input) => {
        this.#trackOwner(event);
        return this.prepareWorktreeArchive(event.sender.id, input);
      },
    );
    this.#handle(
      GIT_LIFECYCLE_IPC_CHANNELS.confirmArchive,
      z.tuple([GitWorktreeMetadataConfirmationInputSchema]),
      GitWorktreeMetadataResultViewSchema.nullable(),
      (event, input) => this.confirmWorktreeMetadata(event, input.planId, 'archive-worktree'),
    );
    this.#handle(
      GIT_LIFECYCLE_IPC_CHANNELS.prepareRestore,
      z.tuple([GitWorktreeCleanupTargetInputSchema]),
      GitWorktreeRestorePlanViewSchema,
      (event, input) => {
        this.#trackOwner(event);
        return this.prepareWorktreeRestore(event.sender.id, input);
      },
    );
    this.#handle(
      GIT_LIFECYCLE_IPC_CHANNELS.confirmRestore,
      z.tuple([GitWorktreeMetadataConfirmationInputSchema]),
      GitWorktreeMetadataResultViewSchema.nullable(),
      (event, input) => this.confirmWorktreeMetadata(event, input.planId, 'restore-worktree'),
    );
    this.#handle(
      GIT_REVIEW_NOTE_IPC_CHANNELS.list,
      z.tuple([GitReviewNotesListInputSchema]),
      GitReviewNotesViewSchema,
      (event, input) => {
        this.#trackOwner(event);
        return this.listReviewNotes(input);
      },
    );
    this.#handle(
      GIT_REVIEW_NOTE_IPC_CHANNELS.create,
      z.tuple([GitReviewNoteCreateInputSchema]),
      GitReviewNotesViewSchema,
      (event, input) => {
        this.#trackOwner(event);
        return this.createReviewNote(input);
      },
    );
    this.#handle(
      GIT_REVIEW_NOTE_IPC_CHANNELS.update,
      z.tuple([GitReviewNoteUpdateInputSchema]),
      GitReviewNotesViewSchema,
      (event, input) => {
        this.#trackOwner(event);
        return this.updateReviewNote(input);
      },
    );
    this.#handle(
      GIT_REVIEW_NOTE_IPC_CHANNELS.delete,
      z.tuple([GitReviewNoteDeleteInputSchema]),
      GitReviewNotesViewSchema,
      (event, input) => {
        this.#trackOwner(event);
        return this.deleteReviewNote(event, input);
      },
    );
  }

  public dispose(): Promise<void> {
    if (!this.#disposed) {
      this.#disposed = true;
      this.#privacyResetting = true;
      for (const channel of this.#registeredChannels) ipcMain.removeHandler(channel);
      this.#registeredChannels.length = 0;
      this.#plans.clear();
      this.#cleanup.clearPlans();
      this.#trackedOwners.clear();
    }
    this.#disposePromise ??= this.#operationTail.then(async () => await this.#cleanup.dispose());
    return this.#disposePromise;
  }

  public async resetForPrivacy(): Promise<void> {
    if (this.#disposed) throw new Error('The Git review service has been disposed.');
    this.#privacyResetting = true;
    this.#plans.clear();
    this.#cleanup.clearPlans();
    await this.#operationTail;
  }

  public async pauseForShutdown(): Promise<void> {
    if (this.#disposed) throw new Error('The Git review service has been disposed.');
    this.#privacyResetting = true;
    this.#cleanup.clearPlans();
    await this.#operationTail;
  }

  public resumeAfterPrivacyReset(): void {
    if (!this.#disposed) this.#privacyResetting = false;
  }

  public review(input: GitTargetInput): Promise<GitReviewView> {
    return this.#withOperation(async () => {
      const target = await this.#resolveTarget(input);
      return await this.#reviewUnlocked(target);
    });
  }

  public listReviewNotes(input: GitReviewNotesListInput): Promise<GitReviewNotesView> {
    return this.#withOperation(async () => {
      const target = await this.#resolveTarget(input.target);
      const review = await this.#reviewUnlocked(target);
      return this.#reviewNotes.list(input.target, review);
    });
  }

  public createReviewNote(input: GitReviewNoteCreateInput): Promise<GitReviewNotesView> {
    return this.#mutateReviewNotes(input.target, 'create-review-note', (review) => {
      this.store.appendAudit(
        'git-review',
        input.kind === 'revision-request' ? 'record-revision-request' : 'record-line-comment',
        'allowed',
        {
          ...auditInputTargetMetadata(input.target),
          area: input.anchor.area,
          side: input.anchor.side,
          line: input.anchor.line,
          noteKind: input.kind,
          phase: 'authorized-before-mutation',
        },
      );
      return this.#reviewNotes.create(input, review);
    });
  }

  public updateReviewNote(input: GitReviewNoteUpdateInput): Promise<GitReviewNotesView> {
    return this.#mutateReviewNotes(input.target, 'update-review-note', (review) => {
      this.store.appendAudit('git-review', 'update-review-note', 'allowed', {
        ...auditInputTargetMetadata(input.target),
        noteId: input.noteId,
        bodyChanged: input.body !== undefined,
        ...(input.status === undefined ? {} : { status: input.status }),
        phase: 'authorized-before-mutation',
      });
      return this.#reviewNotes.update(input, review);
    });
  }

  public deleteReviewNote(
    event: IpcMainInvokeEvent,
    input: GitReviewNoteDeleteInput,
  ): Promise<GitReviewNotesView> {
    return this.#mutateReviewNotes(input.target, 'delete-review-note', async (review) => {
      const current = this.#reviewNotes.list(input.target, review);
      const note = current.notes.find(
        (candidate) =>
          candidate.id === input.noteId && candidate.updatedAt === input.expectedUpdatedAt,
      );
      if (note === undefined) {
        throw new Error('The review note changed or no longer exists. Refresh before deleting it.');
      }
      const parent = this.#requireLiveWindow(event);
      const decision = await this.dialog.showMessageBox(parent, reviewNoteDeleteConfirmation(note));
      this.#requireLiveWindow(event);
      if (decision.response !== 1) {
        this.store.appendAudit('git-review', 'delete-review-note', 'denied', {
          ...auditInputTargetMetadata(input.target),
          noteId: input.noteId,
          reason: 'native-confirmation-cancelled',
        });
        return current;
      }
      this.store.appendAudit('git-review', 'delete-review-note', 'allowed', {
        ...auditInputTargetMetadata(input.target),
        noteId: input.noteId,
        expectedUpdatedAt: input.expectedUpdatedAt,
        phase: 'authorized-before-mutation',
      });
      return this.#reviewNotes.delete(input, review);
    });
  }

  public stagePaths(input: GitPathSelectionInput): Promise<GitReviewView> {
    return this.#mutate(input.target, 'stage-paths', async (target) => {
      await this.#changes.stagePaths(target.repositoryRoot, input.paths);
    });
  }

  public stageHunks(input: GitHunkSelectionInput): Promise<GitReviewView> {
    return this.#mutate(input.target, 'stage-hunks', async (target) => {
      await this.#changes.stageHunks(target.repositoryRoot, input.hunkIds);
    });
  }

  public unstagePaths(input: GitPathSelectionInput): Promise<GitReviewView> {
    return this.#mutate(input.target, 'unstage-paths', async (target) => {
      await this.#changes.unstagePaths(target.repositoryRoot, input.paths);
    });
  }

  public unstageHunks(input: GitHunkSelectionInput): Promise<GitReviewView> {
    return this.#mutate(input.target, 'unstage-hunks', async (target) => {
      await this.#changes.unstageHunks(target.repositoryRoot, input.hunkIds);
    });
  }

  public prepareCommit(ownerId: number, input: GitCommitPlanInput): Promise<GitCommitPlanView> {
    return this.#withOperation(async () => {
      const target = await this.#resolveTarget(input.target);
      const [snapshot, staged, identity] = await Promise.all([
        this.#changes.approvalSnapshot(target.repositoryRoot),
        this.#changes.diff(target.repositoryRoot, 'staged'),
        this.#resolveIdentity(target.repositoryRoot),
      ]);
      if (snapshot.stagedPaths.length === 0) {
        throw new Error('Stage at least one change before preparing a commit.');
      }
      if (!identity.ready) {
        throw new Error(
          'Set a Git author name and email in Settings, or configure them for the primary checkout, before committing.',
        );
      }
      const plan: PendingCommitPlan = {
        kind: 'commit',
        id: randomUUID(),
        ownerId,
        target: target.view,
        repositoryRoot: target.repositoryRoot,
        expiresAtMs: Date.now() + PLAN_TTL_MS,
        message: input.message.trim(),
        branch: snapshot.branch,
        expectedHead: snapshot.expectedHead,
        stagedPaths: [...snapshot.stagedPaths],
        stagedPatchSha256: snapshot.stagedPatchSha256,
        additions: staged.additions,
        deletions: staged.deletions,
        identity,
      };
      this.#storePlan(plan);
      return commitPlanView(plan);
    });
  }

  public prepareDiscard(
    ownerId: number,
    input: GitHunkSelectionInput,
  ): Promise<GitDiscardPlanView> {
    return this.#withOperation(async () => {
      const target = await this.#resolveTarget(input.target);
      const [snapshot, unstaged] = await Promise.all([
        this.#changes.approvalSnapshot(target.repositoryRoot),
        this.#changes.diff(target.repositoryRoot, 'unstaged'),
      ]);
      const selectedPatch = selectDiffHunks(unstaged, input.hunkIds);
      const selected = selectedHunkSummary(unstaged, input.hunkIds);
      const plan: PendingDiscardPlan = {
        kind: 'discard-hunks',
        id: randomUUID(),
        ownerId,
        target: target.view,
        repositoryRoot: target.repositoryRoot,
        expiresAtMs: Date.now() + PLAN_TTL_MS,
        branch: snapshot.branch,
        expectedHead: snapshot.expectedHead,
        hunkIds: [...input.hunkIds],
        patchSha256: patchSha256(selectedPatch),
        paths: selected.paths,
        additions: selected.additions,
        deletions: selected.deletions,
      };
      this.#storePlan(plan);
      return discardPlanView(plan);
    });
  }

  public prepareShipping(
    ownerId: number,
    input: GitShippingPlanInput,
  ): Promise<GitShippingPlanView> {
    return this.#withOperation(async () => {
      try {
        if (input.target.kind !== 'agent-worktree') {
          throw new Error(
            'Only a managed agent worktree can be delivered to the primary checkout.',
          );
        }
        const plan = await this.#shipping.prepare({
          id: randomUUID(),
          ownerId,
          expiresAtMs: Date.now() + PLAN_TTL_MS,
          input,
          resolveIdentity: async (primaryRepositoryRoot) =>
            await this.#resolveIdentity(primaryRepositoryRoot),
        });
        const view = this.#shipping.view(plan);
        this.#storePlan(plan);
        return view;
      } catch (error) {
        this.store.appendAudit('git', 'ship-agent-commits', 'failed', {
          projectId: input.target.projectId,
          targetKind: input.target.kind,
          ...(input.target.kind === 'agent-worktree' ? { runId: input.target.runId } : {}),
          strategy: input.strategy,
          stage: 'prepare',
          reason: error instanceof Error ? error.message.slice(0, 4_096) : 'unknown failure',
        });
        throw error;
      }
    });
  }

  public prepareCleanup(
    ownerId: number,
    input: GitWorktreeCleanupTargetInput,
  ): Promise<GitWorktreeCleanupPrepareOutcome> {
    return this.#withOperation(async () => await this.#cleanup.prepare(ownerId, input));
  }

  public prepareWorktreeRename(ownerId: number, input: GitWorktreeRenamePrepareInput) {
    return this.#withOperation(async () => {
      const resolved = await this.#targets.resolve(input);
      const impact = await this.#worktrees.branchRenameImpact(resolved.ownership, input.newBranch);
      const target = await this.#resolveTarget({
        kind: 'agent-worktree',
        projectId: input.projectId,
        runId: input.runId,
      });
      if (impact.branchOid === null) throw new Error('The managed branch no longer exists.');
      const plan: PendingRenamePlan = {
        kind: 'rename-worktree-branch',
        id: randomUUID(),
        ownerId,
        target: target.view,
        repositoryRoot: impact.ownership.repositoryRoot,
        expiresAtMs: Date.now() + PLAN_TTL_MS,
        input,
        impact,
        branch: impact.oldBranch,
        newBranch: impact.newBranch,
        expectedBranchOid: impact.branchOid,
        dirtyPaths: [...impact.dirtyPaths],
      };
      this.#storePlan(plan);
      return GitWorktreeRenamePlanViewSchema.parse({
        kind: plan.kind,
        planId: plan.id,
        expiresAt: new Date(plan.expiresAtMs).toISOString(),
        branch: plan.branch,
        newBranch: plan.newBranch,
        clean: plan.dirtyPaths.length === 0,
        dirtyPathCount: plan.dirtyPaths.length,
      });
    });
  }

  public prepareWorktreeArchive(ownerId: number, input: GitWorktreeCleanupTargetInput) {
    return this.#withOperation(async () => {
      const resolved = await this.#targets.resolve(input);
      const impact = await this.#worktrees.archiveImpact(resolved.ownership);
      const target = await this.#resolveTarget({
        kind: 'agent-worktree',
        projectId: input.projectId,
        runId: input.runId,
      });
      const plan: PendingArchivePlan = {
        kind: 'archive-worktree',
        id: randomUUID(),
        ownerId,
        target: target.view,
        repositoryRoot: impact.ownership.repositoryRoot,
        expiresAtMs: Date.now() + PLAN_TTL_MS,
        input,
        impact,
        branch: impact.ownership.branch,
        expectedBranchOid: impact.branchOid,
        dirtyPaths: [...impact.dirtyPaths],
      };
      this.#storePlan(plan);
      return GitWorktreeArchivePlanViewSchema.parse({
        kind: plan.kind,
        planId: plan.id,
        expiresAt: new Date(plan.expiresAtMs).toISOString(),
        branch: plan.branch,
        clean: plan.dirtyPaths.length === 0,
        dirtyPathCount: plan.dirtyPaths.length,
        retainsWorktree: true,
        retainsBranch: true,
      });
    });
  }

  public prepareWorktreeRestore(ownerId: number, input: GitWorktreeCleanupTargetInput) {
    return this.#withOperation(async () => {
      const resolved = await this.#targets.resolveArchived(input);
      const impact = await this.#worktrees.archiveImpact(resolved.ownership);
      const plan: PendingArchivePlan = {
        kind: 'restore-worktree',
        id: randomUUID(),
        ownerId,
        target: GitReviewTargetViewSchema.parse({
          kind: 'agent-worktree',
          projectId: input.projectId,
          runId: input.runId,
          nodeId: resolved.run.nodeId,
          worktreeId: resolved.ownership.id,
          agentId: resolved.ownership.agentId,
          baseRef: resolved.ownership.baseRef,
          baseCommit: resolved.ownership.baseCommit,
        }),
        repositoryRoot: impact.ownership.repositoryRoot,
        expiresAtMs: Date.now() + PLAN_TTL_MS,
        input,
        impact,
        branch: impact.ownership.branch,
        expectedBranchOid: impact.branchOid,
        dirtyPaths: [...impact.dirtyPaths],
      };
      this.#storePlan(plan);
      return GitWorktreeRestorePlanViewSchema.parse({
        kind: plan.kind,
        planId: plan.id,
        expiresAt: new Date(plan.expiresAtMs).toISOString(),
        branch: plan.branch,
        clean: plan.dirtyPaths.length === 0,
        dirtyPathCount: plan.dirtyPaths.length,
        retainsWorktree: true,
        retainsBranch: true,
      });
    });
  }

  public confirmWorktreeMetadata(
    event: IpcMainInvokeEvent,
    planId: string,
    kind: PendingWorktreeMetadataPlan['kind'],
  ): Promise<GitWorktreeMetadataResultView | null> {
    return this.#withOperation(async () => {
      const plan = this.#takePlan(event, planId, kind);
      const parent = this.#requireLiveWindow(event);
      const decision = await this.dialog.showMessageBox(parent, worktreeMetadataConfirmation(plan));
      this.#assertLiveSender(event);
      if (decision.response !== 1) {
        this.store.appendAudit('git', plan.kind, 'denied', {
          ...auditTargetMetadata(plan.target),
          reason: 'native-confirmation-cancelled',
        });
        return null;
      }
      try {
        const resolved =
          plan.kind === 'restore-worktree'
            ? await this.#targets.resolveArchived(plan.input)
            : await this.#targets.resolve(plan.input);
        const current =
          plan.kind === 'rename-worktree-branch'
            ? await this.#worktrees.branchRenameImpact(resolved.ownership, plan.newBranch)
            : await this.#worktrees.archiveImpact(resolved.ownership);
        if (!sameWorktreeMetadataImpact(plan, current)) {
          throw new Error('The managed worktree changed after review. Prepare a new plan.');
        }
        this.#requireLiveWindow(event);
        this.store.appendAudit('git', plan.kind, 'allowed', {
          ...auditTargetMetadata(plan.target),
          stage: 'authorized-before-effect',
          branch: plan.branch,
          ...(plan.kind === 'rename-worktree-branch' ? { newBranch: plan.newBranch } : {}),
          dirtyPathCount: plan.dirtyPaths.length,
        });
        this.store.beginGitWorktreeMetadataIntent(worktreeMetadataIntent(plan));
        if (plan.kind === 'rename-worktree-branch') {
          const approval: RenameManagedBranchApproval = {
            action: 'rename-managed-branch',
            approved: true,
            approvalId: plan.id,
            approvedAt: new Date().toISOString(),
            repositoryRoot: plan.impact.ownership.repositoryRoot,
            expectedHead: plan.impact.expectedHead,
            worktreeId: plan.impact.ownership.id,
            worktreePath: plan.impact.ownership.worktreePath,
            oldBranch: plan.branch,
            newBranch: plan.newBranch,
            expectedBranchOid: plan.expectedBranchOid,
            dirtyPaths: plan.dirtyPaths,
          };
          const renamed = await this.#worktrees.renameBranch(plan.impact.ownership, approval).catch(
            async (error: unknown) =>
              await reconcileFailedWorktreeMetadataEffect({
                worktrees: this.#worktrees,
                store: this.store,
                intentId: plan.id,
                runId: plan.input.runId,
                kind: plan.kind,
                managedRoot: plan.impact.ownership.managedRoot,
                worktreeId: plan.impact.ownership.id,
                auditMetadata: auditTargetMetadata(plan.target),
                operationError: error,
              }),
          );
          this.store.reconcileGitWorktreeMetadataIntent({
            intentId: plan.id,
            worktreeId: renamed.id,
            branch: renamed.branch,
            state: 'active',
            auditStage: 'effect-reconciled',
            auditMetadata: auditTargetMetadata(plan.target),
          });
          return { action: 'renamed', branch: plan.newBranch };
        }
        if (plan.kind === 'restore-worktree') {
          const approval: RestoreArchivedWorktreeApproval = {
            action: 'restore-archived-worktree',
            approved: true,
            approvalId: plan.id,
            approvedAt: new Date().toISOString(),
            repositoryRoot: plan.impact.ownership.repositoryRoot,
            expectedHead: plan.impact.expectedHead,
            worktreeId: plan.impact.ownership.id,
            worktreePath: plan.impact.ownership.worktreePath,
            branch: plan.branch,
            expectedBranchOid: plan.expectedBranchOid,
            dirtyPaths: plan.dirtyPaths,
          };
          const restored = await this.#worktrees
            .restoreArchived(plan.impact.ownership, approval)
            .catch(
              async (error: unknown) =>
                await reconcileFailedWorktreeMetadataEffect({
                  worktrees: this.#worktrees,
                  store: this.store,
                  intentId: plan.id,
                  runId: plan.input.runId,
                  kind: plan.kind,
                  managedRoot: plan.impact.ownership.managedRoot,
                  worktreeId: plan.impact.ownership.id,
                  auditMetadata: auditTargetMetadata(plan.target),
                  operationError: error,
                }),
            );
          this.store.reconcileGitWorktreeMetadataIntent({
            intentId: plan.id,
            worktreeId: restored.id,
            branch: restored.branch,
            state: 'active',
            auditStage: 'effect-reconciled',
            auditMetadata: auditTargetMetadata(plan.target),
          });
          return { action: 'restored', branch: plan.branch };
        }
        const approval: ArchiveWorktreeApproval = {
          action: 'archive-worktree',
          approved: true,
          approvalId: plan.id,
          approvedAt: new Date().toISOString(),
          repositoryRoot: plan.impact.ownership.repositoryRoot,
          expectedHead: plan.impact.expectedHead,
          worktreeId: plan.impact.ownership.id,
          worktreePath: plan.impact.ownership.worktreePath,
          branch: plan.branch,
          expectedBranchOid: plan.expectedBranchOid,
          dirtyPaths: plan.dirtyPaths,
        };
        const archived = await this.#worktrees.archive(plan.impact.ownership, approval).catch(
          async (error: unknown) =>
            await reconcileFailedWorktreeMetadataEffect({
              worktrees: this.#worktrees,
              store: this.store,
              intentId: plan.id,
              runId: plan.input.runId,
              kind: plan.kind,
              managedRoot: plan.impact.ownership.managedRoot,
              worktreeId: plan.impact.ownership.id,
              auditMetadata: auditTargetMetadata(plan.target),
              operationError: error,
            }),
        );
        this.store.reconcileGitWorktreeMetadataIntent({
          intentId: plan.id,
          worktreeId: archived.id,
          branch: archived.branch,
          state: 'archived',
          auditStage: 'effect-reconciled',
          auditMetadata: auditTargetMetadata(plan.target),
        });
        return { action: 'archived', branch: plan.branch };
      } catch (error) {
        this.#auditFailure(plan.kind, plan.target, error);
        throw error;
      }
    });
  }

  public compareAgents(input: GitAgentComparisonInput): Promise<GitAgentComparisonView> {
    return this.#withOperation(async () => {
      try {
        const view = await this.#comparison.compare(input);
        this.store.appendAudit('git', 'compare-agent-worktrees', 'allowed', {
          projectId: input.left.projectId,
          leftRunId: input.left.runId,
          rightRunId: input.right.runId,
          changedFileCount: view.comparison.diff.files.length,
          commitCount: view.comparison.commitCount,
        });
        return view;
      } catch (error) {
        this.store.appendAudit('git', 'compare-agent-worktrees', 'failed', {
          projectId: input.left.projectId,
          leftRunId: input.left.runId,
          rightRunId: input.right.runId,
          reason: 'comparison-unavailable',
        });
        throw error;
      }
    });
  }

  public openExternal(
    event: IpcMainInvokeEvent,
    input: GitTargetInput,
  ): Promise<GitWorkspaceExternalOpenResult> {
    return this.#withOperation(async () => {
      const target = await this.#resolveTarget(input);
      const status = await this.repositories.status(target.repositoryRoot);
      const parent = this.#requireLiveWindow(event);
      const decision = await this.dialog.showMessageBox(
        parent,
        externalOpenConfirmation(target.view, status.branch),
      );
      this.#assertLiveSender(event);
      if (decision.response !== 1) {
        this.store.appendAudit('git', 'open-workspace-external', 'denied', {
          ...auditTargetMetadata(target.view),
          reason: 'native-confirmation-cancelled',
        });
        return {
          opened: false,
          targetKind: target.view.kind,
          branch: status.branch,
        };
      }
      try {
        const current = await this.#resolveTarget(input);
        if (
          current.repositoryRoot !== target.repositoryRoot ||
          JSON.stringify(current.view) !== JSON.stringify(target.view)
        ) {
          throw new Error('The selected workspace changed after review. Open it again.');
        }
        this.#requireLiveWindow(event);
        this.store.appendAudit('git', 'open-workspace-external', 'allowed', {
          ...auditTargetMetadata(current.view),
          application: 'system-registered',
        });
        const error = await this.#openExternalPath(current.repositoryRoot);
        if (error !== '') throw new Error('The system could not open the selected workspace.');
        const currentStatus = await this.repositories.status(current.repositoryRoot);
        return {
          opened: true,
          targetKind: current.view.kind,
          branch: currentStatus.branch,
        };
      } catch (error) {
        this.#auditFailure('open-workspace-external', target.view, error);
        throw error;
      }
    });
  }

  public confirmCommit(
    event: IpcMainInvokeEvent,
    planId: string,
  ): Promise<GitCommitResultView | null> {
    return this.#withOperation(async () => {
      const plan = this.#takePlan(event, planId, 'commit');
      await this.#assertPlanTarget(plan);
      const parent = this.#requireLiveWindow(event);
      const decision = await this.dialog.showMessageBox(parent, commitConfirmation(plan));
      this.#assertLiveSender(event);
      if (decision.response !== 1) {
        this.store.appendAudit('git', 'commit', 'denied', {
          ...auditTargetMetadata(plan.target),
          reason: 'native-confirmation-cancelled',
          stagedPathCount: plan.stagedPaths.length,
        });
        return null;
      }
      try {
        const approval: CommitApproval = {
          action: 'commit',
          approved: true,
          approvalId: plan.id,
          approvedAt: new Date().toISOString(),
          repositoryRoot: plan.repositoryRoot,
          expectedHead: plan.expectedHead,
          message: plan.message,
          stagedPaths: plan.stagedPaths,
          stagedPatchSha256: plan.stagedPatchSha256,
          authorName: plan.identity.name,
          authorEmail: plan.identity.email,
        };
        const committed = await this.#changes.commit(plan.repositoryRoot, approval, {
          beforeApply: () => {
            this.#assertLiveSender(event);
            this.store.appendAudit('git', 'commit', 'allowed', {
              ...auditTargetMetadata(plan.target),
              branch: plan.branch,
              stagedPathCount: plan.stagedPaths.length,
              headBefore: plan.expectedHead,
              phase: 'authorized-before-apply',
            });
          },
        });
        const review = await this.#reviewUnlocked(
          await this.#resolveTarget(targetInput(plan.target)),
        );
        return {
          headBefore: committed.headBefore,
          headAfter: committed.headAfter,
          review,
        };
      } catch (error) {
        this.#auditFailure('commit', plan.target, error);
        throw error;
      }
    });
  }

  public confirmDiscard(event: IpcMainInvokeEvent, planId: string): Promise<GitReviewView | null> {
    return this.#withOperation(async () => {
      const plan = this.#takePlan(event, planId, 'discard-hunks');
      await this.#assertPlanTarget(plan);
      const parent = this.#requireLiveWindow(event);
      const decision = await this.dialog.showMessageBox(parent, discardConfirmation(plan));
      this.#assertLiveSender(event);
      if (decision.response !== 1) {
        this.store.appendAudit('git', 'discard-hunks', 'denied', {
          ...auditTargetMetadata(plan.target),
          reason: 'native-confirmation-cancelled',
          pathCount: plan.paths.length,
          hunkCount: plan.hunkIds.length,
        });
        return null;
      }
      try {
        const approval: DiscardHunksApproval = {
          action: 'discard-hunks',
          approved: true,
          approvalId: plan.id,
          approvedAt: new Date().toISOString(),
          repositoryRoot: plan.repositoryRoot,
          expectedHead: plan.expectedHead,
          patchSha256: plan.patchSha256,
          hunkIds: plan.hunkIds,
        };
        await this.#changes.discardHunks(plan.repositoryRoot, plan.hunkIds, approval, {
          beforeApply: () => {
            this.#assertLiveSender(event);
            this.store.appendAudit('git', 'discard-hunks', 'allowed', {
              ...auditTargetMetadata(plan.target),
              pathCount: plan.paths.length,
              hunkCount: plan.hunkIds.length,
              phase: 'authorized-before-apply',
            });
          },
        });
        const review = await this.#reviewUnlocked(
          await this.#resolveTarget(targetInput(plan.target)),
        );
        return review;
      } catch (error) {
        this.#auditFailure('discard-hunks', plan.target, error);
        throw error;
      }
    });
  }

  public confirmShipping(
    event: IpcMainInvokeEvent,
    planId: string,
  ): Promise<GitShippingResultView | null> {
    return this.#withOperation(async () => {
      const plan = this.#takePlan(event, planId, 'ship-agent-commits');
      try {
        await this.#shipping.assertCurrent(plan);
        const parent = this.#requireLiveWindow(event);
        const decision = await this.dialog.showMessageBox(parent, shippingConfirmation(plan));
        this.#assertLiveSender(event);
        if (decision.response !== 1) {
          this.store.appendAudit('git', 'ship-agent-commits', 'denied', {
            ...auditTargetMetadata(plan.target),
            strategy: plan.strategy,
            reason: 'native-confirmation-cancelled',
            commitCount: plan.commits.length,
            affectedPathCount: plan.affectedPaths.length,
          });
          return null;
        }
        const result = await this.#shipping.apply(plan, () => {
          this.#assertLiveSender(event);
          this.store.appendAudit('git', 'ship-agent-commits', 'allowed', {
            ...auditTargetMetadata(plan.target),
            strategy: plan.strategy,
            commitCount: plan.commits.length,
            affectedPathCount: plan.affectedPaths.length,
            headBefore: plan.targetHead,
            sourceHead: plan.sourceHead,
            phase: 'authorized-before-apply',
          });
        });
        const review = await this.#reviewUnlocked(
          await this.#resolveTarget({
            kind: 'primary',
            projectId: plan.target.projectId,
          }),
        );
        const conflictedPaths = result.status.entries
          .filter((entry) => entry.kind === 'unmerged')
          .map((entry) => entry.path)
          .sort();
        if (result.state === 'conflicted') {
          this.store.appendAudit('git', 'ship-agent-commits', 'failed', {
            ...auditTargetMetadata(plan.target),
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
          review,
        };
      } catch (error) {
        this.#auditFailure('ship-agent-commits', plan.target, error);
        throw error;
      }
    });
  }

  public confirmCleanup(
    event: IpcMainInvokeEvent,
    planId: string,
  ): Promise<GitWorktreeCleanupResultView | null> {
    return this.#withOperation(async () => {
      const parent = this.#requireLiveWindow(event);
      return await this.#cleanup.confirm(
        {
          ownerId: event.sender.id,
          parent,
          assertCurrent: () => {
            const current = this.#requireLiveWindow(event);
            if (current !== parent) {
              throw new Error('The originating Forgeboard window changed during worktree cleanup.');
            }
          },
        },
        planId,
      );
    });
  }

  async #mutate(
    targetInput: GitTargetInput,
    action: string,
    operation: (target: GitTarget) => Promise<void>,
  ): Promise<GitReviewView> {
    return this.#withOperation(async () => {
      const target = await this.#resolveTarget(targetInput);
      try {
        await operation(target);
        const review = await this.#reviewUnlocked(target);
        this.store.appendAudit('git', action, 'allowed', {
          ...auditTargetMetadata(target.view),
          changedPathCount: review.entries.length,
        });
        return review;
      } catch (error) {
        this.#auditFailure(action, target.view, error);
        throw error;
      }
    });
  }

  async #mutateReviewNotes(
    targetInput: GitTargetInput,
    action: string,
    operation: (review: GitReviewView) => GitReviewNotesView | Promise<GitReviewNotesView>,
  ): Promise<GitReviewNotesView> {
    return this.#withOperation(async () => {
      const target = await this.#resolveTarget(targetInput);
      try {
        const review = await this.#reviewUnlocked(target);
        return await operation(review);
      } catch (error) {
        this.store.appendAudit('git-review', action, 'failed', {
          ...auditInputTargetMetadata(targetInput),
          reason: error instanceof Error ? error.message.slice(0, 4_096) : 'unknown failure',
        });
        throw error;
      }
    });
  }

  async #reviewUnlocked(target: GitTarget): Promise<GitReviewView> {
    const [status, staged, unstaged, identity, baseComparison] = await Promise.all([
      this.repositories.status(target.repositoryRoot),
      this.#changes.diff(target.repositoryRoot, 'staged'),
      this.#changes.diff(target.repositoryRoot, 'unstaged'),
      this.#resolveIdentity(target.repositoryRoot),
      target.comparisonBinding === undefined
        ? Promise.resolve(undefined)
        : createAgentBaseComparison(this.repositories, {
            repositoryRoot: target.repositoryRoot,
            baseCommit: target.comparisonBinding.baseCommit,
            headCommit: target.comparisonBinding.headCommit,
          }),
    ]);
    if (target.comparisonBinding !== undefined) {
      if (
        status.branch !== target.comparisonBinding.branch ||
        status.headOid !== target.comparisonBinding.headCommit
      ) {
        throw new Error(
          'The agent worktree branch or its latest commit changed during the review.',
        );
      }
      await this.#assertComparisonTargetCurrent(target);
    }
    const project = this.store.getProject(target.view.projectId);
    if (target.view.kind === 'primary' && project !== undefined) {
      this.store.saveProject({
        ...project,
        health: {
          ...project.health,
          branch: status.branch,
          dirty: status.dirty,
        },
      });
    }
    return GitReviewViewSchema.parse({
      target: target.view,
      branch: status.branch,
      detached: status.detached,
      headOid: status.headOid,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      dirty: status.dirty,
      conflicted: status.conflicted,
      entries: status.entries
        .filter(
          (entry) => entry.kind !== 'ignored' && entry.index !== '!' && entry.worktree !== '!',
        )
        .map(({ kind, path, originalPath, index, worktree, score }) => ({
          kind,
          path,
          ...(originalPath === undefined ? {} : { originalPath }),
          index,
          worktree,
          ...(score === undefined ? {} : { score }),
        })),
      staged: diffView(staged),
      unstaged: diffView(unstaged),
      ...(baseComparison === undefined ? {} : { baseComparison }),
      identity,
      refreshedAt: new Date().toISOString(),
    });
  }

  async #resolveIdentity(repositoryRoot: string): Promise<GitIdentityView> {
    const settings = this.getSettings();
    const configuredName = normalizeGitIdentityValue(settings.gitIdentityName);
    const configuredEmail = normalizeGitIdentityValue(settings.gitIdentityEmail);
    if (configuredName !== '' || configuredEmail !== '') {
      return GitIdentityViewSchema.parse({
        name: configuredName,
        email: configuredEmail,
        nameSource: configuredName ? 'settings' : 'missing',
        emailSource: configuredEmail ? 'settings' : 'missing',
        ready: configuredName !== '' && configuredEmail !== '',
      });
    }
    const [gitName, gitEmail] = await Promise.all([
      this.#readGitConfig(repositoryRoot, 'user.name'),
      this.#readGitConfig(repositoryRoot, 'user.email'),
    ]);
    return repositoryGitIdentity(gitName, gitEmail);
  }

  async #readGitConfig(repositoryRoot: string, key: string): Promise<string> {
    const result = await this.repositories.git.run(['-C', repositoryRoot, 'config', '--get', key], {
      allowNonZeroExit: true,
      maxOutputBytes: 4_096,
    });
    return result.exitCode === 0 ? result.stdout.trim() : '';
  }

  async #resolveTarget(input: GitTargetInput): Promise<GitTarget> {
    this.#assertAvailable();
    if (input.kind === 'agent-worktree') {
      const resolved = await this.#targets.resolve(input);
      const headCommit = resolved.state.branchOid;
      if (headCommit === null) {
        throw new Error('The agent worktree has no current branch commit.');
      }
      const view = GitReviewTargetViewSchema.parse({
        kind: 'agent-worktree',
        projectId: input.projectId,
        runId: input.runId,
        nodeId: resolved.run.nodeId,
        worktreeId: resolved.ownership.id,
        agentId: resolved.ownership.agentId,
        baseRef: resolved.ownership.baseRef,
        baseCommit: resolved.ownership.baseCommit,
      });
      return {
        view,
        repositoryRoot: resolved.worktreeRepositoryPath,
        comparisonBinding: {
          projectId: input.projectId,
          runId: input.runId,
          worktreeId: resolved.ownership.id,
          branch: resolved.ownership.branch,
          baseCommit: resolved.ownership.baseCommit,
          headCommit,
        },
      };
    }
    const project = this.store.getProject(input.projectId);
    if (project === undefined || project.missing) {
      throw new Error('The selected project is no longer available.');
    }
    if (!project.health.isGitRepository) {
      throw new Error('Set up Git for this project before reviewing changes.');
    }
    const repositoryRoot = await this.repositories.resolveRepositoryRoot(project.path);
    if (
      repositoryRoot !== project.path ||
      this.store.getProjectByPath(repositoryRoot)?.id !== input.projectId
    ) {
      throw new Error('Reopen this project from its main repository folder.');
    }
    return { view: input, repositoryRoot };
  }

  async #assertComparisonTargetCurrent(target: GitTarget): Promise<void> {
    const binding = target.comparisonBinding;
    if (binding === undefined) return;
    const current = await this.#targets.resolve({
      projectId: binding.projectId,
      runId: binding.runId,
    });
    const currentStatus = current.state.status;
    if (
      current.worktreeRepositoryPath !== target.repositoryRoot ||
      current.ownership.id !== binding.worktreeId ||
      current.ownership.branch !== binding.branch ||
      current.ownership.baseCommit !== binding.baseCommit ||
      current.state.branchOid !== binding.headCommit ||
      currentStatus === null ||
      currentStatus.branch !== binding.branch ||
      currentStatus.headOid !== binding.headCommit
    ) {
      throw new Error('The agent worktree changed during the base comparison.');
    }
  }

  async #assertPlanTarget(plan: PendingCommitPlan | PendingDiscardPlan): Promise<void> {
    const target = await this.#resolveTarget(targetInput(plan.target));
    if (
      target.repositoryRoot !== plan.repositoryRoot ||
      JSON.stringify(target.view) !== JSON.stringify(plan.target)
    ) {
      throw new Error('The project repository changed after Git review. Prepare a new plan.');
    }
  }

  #storePlan(plan: PendingPlan): void {
    this.#discardExpiredPlans();
    const ownerPlans = [...this.#plans.values()]
      .filter((candidate) => candidate.ownerId === plan.ownerId)
      .sort((left, right) => left.expiresAtMs - right.expiresAtMs);
    while (ownerPlans.length >= MAX_PENDING_PLANS_PER_OWNER) {
      const oldest = ownerPlans.shift();
      if (oldest) this.#plans.delete(oldest.id);
    }
    for (const [id, candidate] of this.#plans) {
      if (
        candidate.ownerId === plan.ownerId &&
        targetKey(candidate.target) === targetKey(plan.target) &&
        candidate.kind === plan.kind
      ) {
        this.#plans.delete(id);
      }
    }
    this.#plans.set(plan.id, plan);
  }

  #takePlan<Kind extends PendingPlan['kind']>(
    event: IpcMainInvokeEvent,
    planId: string,
    kind: Kind,
  ): Extract<PendingPlan, { kind: Kind }> {
    this.#assertAvailable();
    this.#assertLiveSender(event);
    this.#discardExpiredPlans();
    const plan = this.#plans.get(planId);
    this.#plans.delete(planId);
    if (plan === undefined || plan.kind !== kind || plan.ownerId !== event.sender.id) {
      throw new Error('The Git approval plan is missing, expired, or belongs to another window.');
    }
    return plan as Extract<PendingPlan, { kind: Kind }>;
  }

  #discardExpiredPlans(): void {
    const now = Date.now();
    for (const [id, plan] of this.#plans) {
      if (plan.expiresAtMs <= now) this.#plans.delete(id);
    }
  }

  #trackOwner(event: IpcMainInvokeEvent): void {
    this.#assertLiveSender(event);
    const ownerId = event.sender.id;
    if (this.#trackedOwners.has(ownerId)) return;
    this.#trackedOwners.add(ownerId);
    event.sender.once('destroyed', () => {
      this.#trackedOwners.delete(ownerId);
      for (const [id, plan] of this.#plans) {
        if (plan.ownerId === ownerId) this.#plans.delete(id);
      }
      this.#cleanup.discardOwner(ownerId);
    });
  }

  #requireLiveWindow(event: IpcMainInvokeEvent): BrowserWindow {
    this.#assertLiveSender(event);
    const current = this.resolveWindow(event);
    const bound = this.#operationParents.get(event);
    if (bound !== undefined && current !== bound) {
      throw new Error('The originating Forgeboard window changed during the Git operation.');
    }
    const parent = bound ?? current;
    if (parent === null || parent.isDestroyed()) {
      throw new Error('A live Forgeboard window is required for Git confirmation.');
    }
    return parent;
  }

  #assertLiveSender(event: IpcMainInvokeEvent): void {
    if (event.sender.isDestroyed()) throw new Error('The originating Forgeboard window is closed.');
    if (event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Git operations are allowed only from the main Forgeboard frame.');
    }
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error('The Git review service has been disposed.');
    if (this.#privacyResetting) {
      throw new Error('Git review is paused while Forgeboard deletes local data.');
    }
  }

  async #withOperation<T>(operation: () => Promise<T>): Promise<T> {
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

  #auditFailure(action: string, target: GitReviewTargetView, error: unknown): void {
    this.store.appendAudit('git', action, 'failed', {
      ...auditTargetMetadata(target),
      reason: error instanceof Error ? error.message.slice(0, 4_096) : 'unknown failure',
    });
  }

  #handle<Args extends unknown[], Output>(
    channel: string,
    inputSchema: z.ZodType<Args>,
    outputSchema: z.ZodType<Output>,
    operation: (event: IpcMainInvokeEvent, ...args: Args) => Output | Promise<Output>,
  ): void {
    this.#registeredChannels.push(channel);
    ipcMain.handle(channel, async (event, ...rawArgs: unknown[]): Promise<IpcResult<Output>> => {
      try {
        const parent = this.#requireLiveWindow(event);
        const assertCurrent = (): void => {
          this.#assertLiveSender(event);
          if (parent.isDestroyed() || this.resolveWindow(event) !== parent) {
            throw new Error('The originating Forgeboard window changed during the Git operation.');
          }
        };
        this.#operationParents.set(event, parent);
        const rawValue = await (async (): Promise<Output> => {
          try {
            const args = inputSchema.parse(rawArgs);
            const authorize = createNativeGitDelegateAuthorizer({
              assertCurrent,
              show: async (options) => {
                assertCurrent();
                return (await this.dialog.showMessageBox(parent, options)).response;
              },
            });
            const value = await this.repositories.git.withDelegateAuthorization(
              authorize,
              async () => await operation(event, ...args),
            );
            assertCurrent();
            return value;
          } finally {
            this.#operationParents.delete(event);
          }
        })();
        const value = outputSchema.parse(rawValue);
        const result: IpcResult<Output> = { ok: true, value };
        ipcResultSchema(outputSchema).parse(result);
        return result;
      } catch (error) {
        const validation = error instanceof z.ZodError;
        const result = {
          ok: false as const,
          error: {
            code: validation ? 'INVALID_REQUEST' : 'OPERATION_FAILED',
            message: validation
              ? 'Forgeboard rejected an invalid Git request.'
              : error instanceof Error
                ? error.message
                : 'The Git operation failed.',
          },
        };
        ipcResultSchema(outputSchema).parse(result);
        return result;
      }
    });
  }
}

function diffView(diff: ParsedDiff): GitDiffView {
  return {
    files: diff.files.map((file) => ({
      oldPath: file.oldPath,
      newPath: file.newPath,
      status: file.status,
      binary: file.binary,
      hunks: file.hunks.map(({ id, header, oldStart, oldLines, newStart, newLines, lines }) => ({
        id,
        header,
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines: lines.map((line) => ({ ...line })),
      })),
    })),
    additions: diff.additions,
    deletions: diff.deletions,
  };
}

function selectedHunkSummary(
  diff: ParsedDiff,
  hunkIds: readonly string[],
): { paths: string[]; additions: number; deletions: number } {
  const requested = new Set(hunkIds);
  const paths = new Set<string>();
  let additions = 0;
  let deletions = 0;
  for (const file of diff.files) {
    for (const hunk of file.hunks) {
      if (!requested.has(hunk.id)) continue;
      const path = file.newPath ?? file.oldPath;
      if (path) paths.add(path);
      additions += hunk.lines.filter((line) => line.kind === 'addition').length;
      deletions += hunk.lines.filter((line) => line.kind === 'deletion').length;
    }
  }
  return { paths: [...paths].sort(), additions, deletions };
}

function commitPlanView(plan: PendingCommitPlan): GitCommitPlanView {
  return {
    kind: plan.kind,
    planId: plan.id,
    expiresAt: new Date(plan.expiresAtMs).toISOString(),
    target: plan.target,
    message: plan.message,
    branch: plan.branch,
    headOid: plan.expectedHead === 'UNBORN' ? null : plan.expectedHead,
    stagedPaths: [...plan.stagedPaths],
    additions: plan.additions,
    deletions: plan.deletions,
    identity: plan.identity,
  };
}

function discardPlanView(plan: PendingDiscardPlan): GitDiscardPlanView {
  return {
    kind: plan.kind,
    planId: plan.id,
    expiresAt: new Date(plan.expiresAtMs).toISOString(),
    target: plan.target,
    branch: plan.branch,
    headOid: plan.expectedHead === 'UNBORN' ? null : plan.expectedHead,
    hunkIds: [...plan.hunkIds],
    paths: [...plan.paths],
    additions: plan.additions,
    deletions: plan.deletions,
  };
}

function sameWorktreeMetadataImpact(
  plan: PendingWorktreeMetadataPlan,
  current: BranchRenameImpact | ArchiveImpact,
): boolean {
  return (
    current.ownership.id === plan.impact.ownership.id &&
    current.ownership.worktreePath === plan.impact.ownership.worktreePath &&
    current.ownership.branch === plan.branch &&
    current.expectedHead === plan.impact.expectedHead &&
    current.branchOid === plan.expectedBranchOid &&
    JSON.stringify(current.dirtyPaths) === JSON.stringify(plan.dirtyPaths) &&
    (plan.kind !== 'rename-worktree-branch' ||
      ('newBranch' in current && current.newBranch === plan.newBranch))
  );
}

function worktreeMetadataIntent(plan: PendingWorktreeMetadataPlan) {
  const identity = {
    intentId: plan.id,
    runId: plan.input.runId,
    worktreeId: plan.impact.ownership.id,
    beforeBranch: plan.branch,
    createdAt: new Date().toISOString(),
  };
  if (plan.kind === 'rename-worktree-branch') {
    return {
      ...identity,
      kind: plan.kind,
      afterBranch: plan.newBranch,
      beforeState: 'active' as const,
      afterState: 'active' as const,
    };
  }
  if (plan.kind === 'archive-worktree') {
    return {
      ...identity,
      kind: plan.kind,
      afterBranch: plan.branch,
      beforeState: 'active' as const,
      afterState: 'archived' as const,
    };
  }
  return {
    ...identity,
    kind: plan.kind,
    afterBranch: plan.branch,
    beforeState: 'archived' as const,
    afterState: 'active' as const,
  };
}

function unavailableExternalOpen(): Promise<string> {
  return Promise.reject(new Error('Opening an external workspace is unavailable.'));
}
