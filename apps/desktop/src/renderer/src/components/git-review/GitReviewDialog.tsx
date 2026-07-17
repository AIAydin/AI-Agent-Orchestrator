import {
  CheckCircle2,
  CircleDashed,
  GitCompareArrows,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { CheckId } from '../../../../shared/checks/contracts.js';
import type {
  GitCommitPlanView,
  GitDiscardPlanView,
  GitTargetInput,
} from '../../../../shared/git/contracts.js';
import type {
  GitShippingPlanView,
  GitShippingResultView,
  GitShippingStrategy,
} from '../../../../shared/git/shipping-contracts.js';
import type { GitWorktreeCleanupPlanView } from '../../../../shared/git/lifecycle/contracts.js';
import { GitBaseComparisonPanel } from './GitBaseComparisonPanel.js';
import { GitCommitDisclosure, GitDiscardDisclosure } from './actions/GitActionDisclosure.js';
import { GitCommitPanel } from './actions/GitCommitPanel.js';
import { GitDiffViewer, type GitDiffDisplayPreferences } from './diff/GitDiffViewer.js';
import { GitFileSidebar } from './diff/GitFileSidebar.js';
import {
  allReviewFiles,
  buildReviewGroups,
  findReviewFile,
  firstReviewSelection,
  type GitFileSelection,
} from './git-review-model.js';
import { GitReviewSummary } from './GitReviewSummary.js';
import { GitWorktreeCleanupDisclosure } from './lifecycle/GitWorktreeCleanupDisclosure.js';
import { GitWorktreeCleanupPanel } from './lifecycle/GitWorktreeCleanupPanel.js';
import { useGitWorktreeCleanup } from './lifecycle/useGitWorktreeCleanup.js';
import { GitDeliveryReadinessPanel } from './readiness/GitDeliveryReadinessPanel.js';
import {
  useGitDeliveryReadiness,
  type GitDeliveryReadinessBusy,
  type GitDeliveryReadinessNotice,
} from './readiness/useGitDeliveryReadiness.js';
import { GitStaleReviewNotes } from './review-notes/GitStaleReviewNotes.js';
import { useGitReviewNotes } from './review-notes/useGitReviewNotes.js';
import {
  GIT_WORKING_TREE_PANEL_ID,
  GIT_WORKING_TREE_TAB_ID,
  GitReviewModeTabs,
  type GitReviewMode,
} from './GitReviewModeTabs.js';
import { useGitReview } from './useGitReview.js';
import { GitShippingDisclosure } from './shipping/GitShippingDisclosure.js';
import { GitShippingPanel } from './shipping/GitShippingPanel.js';

export interface GitReviewDialogProps {
  target: GitTargetInput;
  projectName: string;
  cleanupRecovery?: boolean;
  displayPreferences?: GitDiffDisplayPreferences;
  onDisplayPreferencesChange?: (preferences: GitDiffDisplayPreferences) => void;
  onClose: () => void;
  onError?: (message: string) => void;
  onCleanupSuccess?: (message: string) => void;
  onCleanupTargetReactivated?: (target: GitTargetInput, message: string) => void;
  onCleanupStateUncertain?: () => void;
}

type GitReviewNoticeTone = 'neutral' | 'success' | 'warning';

interface GitReviewNotice {
  readonly message: string;
  readonly tone: GitReviewNoticeTone;
}

export function GitReviewDialog({
  target,
  projectName,
  cleanupRecovery = false,
  displayPreferences,
  onDisplayPreferencesChange,
  onClose,
  onError,
  onCleanupSuccess,
  onCleanupTargetReactivated,
  onCleanupStateUncertain,
}: GitReviewDialogProps) {
  const controller = useGitReview(target, onError);
  const cleanupController = useGitWorktreeCleanup(
    target.kind === 'agent-worktree' ? { projectId: target.projectId, runId: target.runId } : null,
    onError,
  );
  const deliveryReadiness = useGitDeliveryReadiness(
    target.kind === 'agent-worktree'
      ? { kind: 'agent-worktree', projectId: target.projectId, runId: target.runId }
      : null,
  );
  const reviewNotes = useGitReviewNotes(target, controller.review?.refreshedAt ?? null, onError);
  const [selection, setSelection] = useState<GitFileSelection | null>(null);
  const [discardPlan, setDiscardPlan] = useState<GitDiscardPlanView | null>(null);
  const [commitPlan, setCommitPlan] = useState<GitCommitPlanView | null>(null);
  const [shippingPlan, setShippingPlan] = useState<GitShippingPlanView | null>(null);
  const [shippingResult, setShippingResult] = useState<GitShippingResultView | null>(null);
  const [cleanupPlan, setCleanupPlan] = useState<GitWorktreeCleanupPlanView | null>(null);
  const [notice, setNotice] = useState<GitReviewNotice | null>(null);
  const [reviewMode, setReviewMode] = useState<GitReviewMode>(
    target.kind === 'agent-worktree' ? 'base-comparison' : 'working-tree',
  );
  const closeButton = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const groups = useMemo(
    () => (controller.review === null ? null : buildReviewGroups(controller.review)),
    [controller.review],
  );
  const selectedFile = groups === null ? null : findReviewFile(groups, selection);
  const reviewFiles = useMemo(() => (groups === null ? [] : allReviewFiles(groups)), [groups]);
  const selectedFileIndex = reviewFiles.findIndex(
    (file) => file.area === selection?.area && file.path === selection.path,
  );
  const staleReviewNotes =
    reviewNotes.context?.notes.filter((note) => note.anchorState !== 'current') ?? [];
  const readinessBusyLabel = deliveryReadinessBusyLabel(deliveryReadiness.busy);
  const busy =
    controller.busyLabel !== null ||
    cleanupController.busyLabel !== null ||
    deliveryReadiness.busy !== null;
  const busyLabel = controller.busyLabel ?? cleanupController.busyLabel ?? readinessBusyLabel;
  const actionError = controller.error ?? cleanupController.error ?? deliveryReadiness.error;
  const cleanupRecoveryOnly = target.kind === 'agent-worktree' && cleanupRecovery;
  const deliveryReady =
    deliveryReadiness.ready &&
    controller.review?.target.kind === 'agent-worktree' &&
    controller.review.baseComparison?.headCommit === deliveryReadiness.view?.source.sourceHead;
  const actionStatusTone: GitReviewNoticeTone =
    actionError !== null ? 'warning' : busy ? 'neutral' : (notice?.tone ?? 'neutral');
  const cleanupStatusTone: GitReviewNoticeTone =
    cleanupController.error !== null
      ? 'warning'
      : cleanupController.busyLabel !== null
        ? 'neutral'
        : (notice?.tone ?? 'neutral');

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (document.querySelector('.git-action-disclosure') !== null) return;
      event.preventDefault();
      closeRef.current();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    if (groups === null) return;
    setSelection((current) =>
      findReviewFile(groups, current) === null ? firstReviewSelection(groups) : current,
    );
  }, [groups]);

  useEffect(() => {
    setReviewMode(target.kind === 'agent-worktree' ? 'base-comparison' : 'working-tree');
  }, [target.kind, target.projectId, target.kind === 'agent-worktree' ? target.runId : null]);

  const prepareDiscard = (hunkId: string) => {
    setNotice(null);
    void controller.prepareDiscard([hunkId]).then((plan) => {
      if (plan !== undefined) setDiscardPlan(plan);
    });
  };

  const confirmDiscard = () => {
    if (discardPlan === null) return;
    void controller.confirmDiscard(discardPlan.planId).then((result) => {
      setDiscardPlan(null);
      if (result === null)
        setNotice(
          gitReviewNotice(
            'Discard cancelled in the system confirmation. No content changed.',
            'neutral',
          ),
        );
      else if (result !== undefined) {
        setNotice(gitReviewNotice('Selected working-tree content was discarded.', 'success'));
        void deliveryReadiness.refresh();
      }
    });
  };

  const prepareCommit = (message: string) => {
    setNotice(null);
    void controller.prepareCommit(message).then((plan) => {
      if (plan !== undefined) setCommitPlan(plan);
    });
  };

  const confirmCommit = () => {
    if (commitPlan === null) return;
    void controller.confirmCommit(commitPlan.planId).then((result) => {
      setCommitPlan(null);
      if (result === null)
        setNotice(
          gitReviewNotice(
            'Commit cancelled in the system confirmation. Nothing was committed.',
            'neutral',
          ),
        );
      else if (result !== undefined) {
        setNotice(
          gitReviewNotice(`Created local commit ${result.headAfter.slice(0, 12)}.`, 'success'),
        );
        void deliveryReadiness.refresh();
      }
    });
  };

  const prepareShipping = (strategy: GitShippingStrategy) => {
    setNotice(null);
    setShippingResult(null);
    if (!deliveryReady) {
      setNotice(
        gitReviewNotice(
          'Delivery readiness is not current. Complete the exact checks and human quality approval first.',
          'warning',
        ),
      );
      return;
    }
    void controller.prepareShipping(strategy).then((plan) => {
      if (plan !== undefined) setShippingPlan(plan);
    });
  };

  const prepareReadinessRequirements = (checkIds: readonly CheckId[]) => {
    setNotice(null);
    void deliveryReadiness.prepareRequirements(checkIds).then((saved) => {
      if (saved) {
        setNotice(
          gitReviewNotice('Saved the required checks for this exact delivery source.', 'success'),
        );
      }
    });
  };

  const runReadinessCheck = (checkId: CheckId) => {
    setNotice(null);
    void deliveryReadiness.runCheck(checkId).then((nextNotice) => {
      if (nextNotice !== undefined) setNotice(deliveryReadinessNoticeMessage(nextNotice));
    });
  };

  const approveReadinessQuality = () => {
    setNotice(null);
    void deliveryReadiness.approveQuality().then((nextNotice) => {
      if (nextNotice !== undefined) setNotice(deliveryReadinessNoticeMessage(nextNotice));
    });
  };

  const refreshReview = () => {
    void controller.refresh();
    void deliveryReadiness.refresh();
  };

  const confirmShipping = () => {
    if (shippingPlan === null) return;
    void controller.confirmShipping(shippingPlan.planId).then((result) => {
      setShippingPlan(null);
      if (result === null) {
        setNotice(
          gitReviewNotice(
            'Delivery cancelled in the system confirmation. Primary was not changed.',
            'neutral',
          ),
        );
      } else if (result !== undefined) {
        setShippingResult(result);
        setNotice(
          gitReviewNotice(
            result.state === 'completed'
              ? `Delivered reviewed commits to primary at ${result.headAfter.slice(0, 12)}.`
              : 'Git stopped at conflicts. Primary was left in a reviewable conflict state.',
            result.state === 'completed' ? 'success' : 'warning',
          ),
        );
      }
    });
  };

  const prepareCleanup = () => {
    setNotice(null);
    void cleanupController.prepare(cleanupRecoveryOnly).then((outcome) => {
      if (outcome === undefined) {
        onCleanupStateUncertain?.();
        return;
      }
      if (outcome.kind === 'cleanup-reconciled') {
        onCleanupSuccess?.(
          'Reconciled the interrupted cleanup and marked the exact agent worktree as cleaned.',
        );
        onClose();
      } else {
        setCleanupPlan(outcome);
        if (cleanupRecoveryOnly && !outcome.recovery) {
          onCleanupTargetReactivated?.(
            target,
            'Verified the agent worktree is intact and restored its active lifecycle state.',
          );
          void controller.refresh();
        }
      }
    });
  };

  const confirmCleanup = () => {
    if (cleanupPlan === null) return;
    void cleanupController.confirm(cleanupPlan.planId).then((result) => {
      if (result === null) {
        setCleanupPlan(null);
        setNotice(
          gitReviewNotice(
            'Cleanup cancelled in the system confirmation. The worktree was preserved.',
            'neutral',
          ),
        );
      } else if (result === undefined) {
        setCleanupPlan(null);
        onCleanupStateUncertain?.();
      } else {
        setCleanupPlan(null);
        onCleanupSuccess?.(
          'Cleaned up the exact merged agent worktree and deleted its managed branch.',
        );
        onClose();
      }
    });
  };

  return (
    <div className="modal-backdrop git-review-backdrop" role="presentation">
      <section
        className="modal git-review-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="git-review-title"
        aria-busy={busy || reviewNotes.busy || deliveryReadiness.loading}
      >
        <header className="git-review-header">
          <span className="modal-title-icon">
            <GitCompareArrows size={19} aria-hidden="true" />
          </span>
          <span>
            <small>
              {cleanupRecoveryOnly
                ? 'Recovery-only agent target'
                : target.kind === 'primary'
                  ? 'Authoritative primary checkout'
                  : 'Authoritative agent worktree'}
            </small>
            <h2 id="git-review-title">
              {cleanupRecoveryOnly
                ? `Recover interrupted cleanup in ${projectName}`
                : `Review changes in ${projectName}`}
            </h2>
          </span>
          <button
            className="icon-button"
            type="button"
            disabled={busy}
            aria-label="Refresh Git changes"
            onClick={refreshReview}
          >
            <RefreshCw className={busy ? 'spin' : ''} size={16} />
          </button>
          <button
            ref={closeButton}
            className="icon-button"
            type="button"
            aria-label="Close Git review"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>

        {controller.loading ? (
          <GitReviewState icon={<LoaderCircle className="spin" />} title="Reading local Git state">
            Forgeboard is loading status and diffs from the selected repository.
          </GitReviewState>
        ) : cleanupRecoveryOnly || controller.review === null ? (
          <>
            <GitReviewState
              icon={<TriangleAlert />}
              title={
                cleanupRecoveryOnly
                  ? 'Git review is unavailable during cleanup recovery'
                  : 'Git review is unavailable'
              }
            >
              {controller.error ?? 'Forgeboard could not read this repository.'}
              {!cleanupRecoveryOnly && (
                <button
                  className="button"
                  type="button"
                  disabled={busy}
                  onClick={() => void controller.refresh()}
                >
                  Try again
                </button>
              )}
            </GitReviewState>
            {target.kind === 'agent-worktree' && (
              <section className="git-cleanup-recovery" aria-label="Agent cleanup recovery">
                {(cleanupController.error !== null ||
                  cleanupController.busyLabel !== null ||
                  notice !== null) && (
                  <div
                    className={`git-review-status ${cleanupStatusTone === 'warning' ? 'error' : ''}`}
                    data-tone={cleanupStatusTone}
                    role={cleanupStatusTone === 'warning' ? 'alert' : 'status'}
                  >
                    {cleanupController.busyLabel !== null ? (
                      <LoaderCircle className="spin" size={13} aria-hidden="true" />
                    ) : cleanupStatusTone === 'warning' ? (
                      <TriangleAlert size={13} aria-hidden="true" />
                    ) : cleanupStatusTone === 'success' ? (
                      <CheckCircle2 size={13} aria-hidden="true" />
                    ) : (
                      <CircleDashed size={13} aria-hidden="true" />
                    )}
                    {cleanupController.busyLabel ?? cleanupController.error ?? notice?.message}
                  </div>
                )}
                <GitWorktreeCleanupPanel
                  recovery={cleanupRecoveryOnly}
                  busy={busy}
                  onPrepare={prepareCleanup}
                />
              </section>
            )}
          </>
        ) : (
          <>
            {controller.review.target.kind === 'agent-worktree' && (
              <section className="git-worktree-target" aria-label="Agent worktree target">
                <strong>Isolated run {controller.review.target.runId.slice(0, 12)}</strong>
                <span>
                  Agent {controller.review.target.agentId} · base {controller.review.target.baseRef}{' '}
                  @ <code>{controller.review.target.baseCommit.slice(0, 12)}</code>
                </span>
                <small>
                  Stage, discard, and commit actions apply only to this managed worktree. The
                  primary checkout remains untouched.
                </small>
              </section>
            )}
            {controller.review.target.kind === 'agent-worktree' && (
              <GitReviewModeTabs mode={reviewMode} onChange={setReviewMode} />
            )}
            <GitReviewSummary review={controller.review} />
            {controller.review.conflicted && (
              <p className="git-conflict-banner" role="alert">
                <TriangleAlert size={14} /> Resolve unmerged files before creating a commit.
              </p>
            )}
            {(actionError !== null || notice !== null || busy) && (
              <div
                className={`git-review-status ${actionStatusTone === 'warning' ? 'error' : ''}`}
                data-tone={actionStatusTone}
                role={actionStatusTone === 'warning' ? 'alert' : 'status'}
              >
                {busy ? (
                  <LoaderCircle className="spin" size={13} aria-hidden="true" />
                ) : actionStatusTone === 'warning' ? (
                  <TriangleAlert size={13} aria-hidden="true" />
                ) : actionStatusTone === 'success' ? (
                  <CheckCircle2 size={13} aria-hidden="true" />
                ) : (
                  <CircleDashed size={13} aria-hidden="true" />
                )}
                {busyLabel ?? actionError ?? notice?.message}
              </div>
            )}
            {reviewNotes.error !== null && (
              <p className="git-review-note-error" role="alert">
                Review feedback unavailable: {reviewNotes.error}
              </p>
            )}
            {reviewNotes.context?.truncated === true && (
              <p className="git-review-note-error" role="status">
                This target has more than 500 review notes. Resolve or delete older feedback to see
                every note here.
              </p>
            )}
            <GitStaleReviewNotes
              notes={staleReviewNotes}
              actions={{
                busy: reviewNotes.busy,
                onUpdate: reviewNotes.update,
                onDelete: reviewNotes.remove,
              }}
            />
            {controller.review.target.kind === 'agent-worktree' &&
            reviewMode === 'base-comparison' ? (
              controller.review.baseComparison === undefined ? (
                <GitReviewState icon={<TriangleAlert />} title="Base comparison is unavailable">
                  Refresh this review. Forgeboard will not infer a base or HEAD in the renderer.
                </GitReviewState>
              ) : (
                <GitBaseComparisonPanel
                  comparison={controller.review.baseComparison}
                  reviewNotes={reviewNotes}
                  {...(displayPreferences === undefined ? {} : { displayPreferences })}
                  {...(onDisplayPreferencesChange === undefined
                    ? {}
                    : { onDisplayPreferencesChange })}
                  footer={
                    <>
                      {deliveryReadiness.view === null ? (
                        <section className="git-delivery-readiness" aria-label="Delivery readiness">
                          <strong>Delivery readiness</strong>
                          <p role={deliveryReadiness.error === null ? 'status' : 'alert'}>
                            {deliveryReadiness.loading
                              ? 'Loading exact delivery checks and approval evidence…'
                              : (deliveryReadiness.error ??
                                'Delivery readiness is unavailable. Refresh before delivery.')}
                          </p>
                        </section>
                      ) : (
                        <GitDeliveryReadinessPanel
                          view={deliveryReadiness.view}
                          selectedCheckIds={deliveryReadiness.selectedCheckIds}
                          disabled={busy || deliveryReadiness.loading}
                          runningCheckId={
                            deliveryReadiness.busy?.kind === 'run-check'
                              ? deliveryReadiness.busy.checkId
                              : null
                          }
                          requirementsBusy={deliveryReadiness.busy?.kind === 'prepare-requirements'}
                          approvalBusy={deliveryReadiness.busy?.kind === 'approve-quality'}
                          onRunCheck={runReadinessCheck}
                          onSelectedCheckIdsChange={deliveryReadiness.setSelectedCheckIds}
                          onPrepareRequirements={prepareReadinessRequirements}
                          onApproveQuality={approveReadinessQuality}
                        />
                      )}
                      <GitShippingPanel
                        review={controller.review}
                        busy={busy || deliveryReadiness.loading}
                        deliveryReady={deliveryReady}
                        result={shippingResult}
                        onPrepare={prepareShipping}
                      />
                      <GitWorktreeCleanupPanel busy={busy} onPrepare={prepareCleanup} />
                    </>
                  }
                />
              )
            ) : (
              <section
                id={
                  controller.review.target.kind === 'agent-worktree'
                    ? GIT_WORKING_TREE_PANEL_ID
                    : undefined
                }
                className="git-review-working-tree"
                role={controller.review.target.kind === 'agent-worktree' ? 'tabpanel' : undefined}
                aria-labelledby={
                  controller.review.target.kind === 'agent-worktree'
                    ? GIT_WORKING_TREE_TAB_ID
                    : undefined
                }
              >
                {groups &&
                  groups.staged.length + groups.unstaged.length + groups.untracked.length === 0 && (
                    <p className="git-clean-state">
                      <CheckCircle2 size={15} /> Working tree clean. There are no local changes to
                      review.
                    </p>
                  )}
                <div className="git-review-workspace">
                  <GitFileSidebar
                    groups={groups!}
                    selection={selection}
                    busy={busy}
                    onSelect={setSelection}
                    onStagePath={(path) => void controller.stagePaths([path])}
                    onUnstagePath={(path) => void controller.unstagePaths([path])}
                  />
                  <GitDiffViewer
                    file={selectedFile}
                    busy={busy}
                    reviewNotes={reviewNotes}
                    {...(displayPreferences === undefined ? {} : { displayPreferences })}
                    {...(onDisplayPreferencesChange === undefined
                      ? {}
                      : { onDisplayPreferencesChange })}
                    {...(selectedFileIndex < 0
                      ? {}
                      : {
                          navigation: {
                            index: selectedFileIndex,
                            count: reviewFiles.length,
                            onPrevious: () => {
                              const previous = reviewFiles[selectedFileIndex - 1];
                              if (previous !== undefined)
                                setSelection({ area: previous.area, path: previous.path });
                            },
                            onNext: () => {
                              const next = reviewFiles[selectedFileIndex + 1];
                              if (next !== undefined)
                                setSelection({ area: next.area, path: next.path });
                            },
                          },
                        })}
                    onStageHunk={(hunkId) => void controller.stageHunks([hunkId])}
                    onUnstageHunk={(hunkId) => void controller.unstageHunks([hunkId])}
                    onPrepareDiscard={prepareDiscard}
                  />
                </div>
                <GitCommitPanel
                  key={controller.review.headOid ?? 'unborn'}
                  review={controller.review}
                  busy={busy}
                  onPrepare={prepareCommit}
                />
              </section>
            )}
          </>
        )}

        {discardPlan && (
          <GitDiscardDisclosure
            plan={discardPlan}
            busy={busy}
            onCancel={() => setDiscardPlan(null)}
            onConfirm={confirmDiscard}
          />
        )}
        {commitPlan && (
          <GitCommitDisclosure
            plan={commitPlan}
            busy={busy}
            onCancel={() => setCommitPlan(null)}
            onConfirm={confirmCommit}
          />
        )}
        {shippingPlan && (
          <GitShippingDisclosure
            plan={shippingPlan}
            busy={busy}
            onCancel={() => setShippingPlan(null)}
            onConfirm={confirmShipping}
          />
        )}
        {cleanupPlan && (
          <GitWorktreeCleanupDisclosure
            plan={cleanupPlan}
            busy={busy}
            onCancel={() => setCleanupPlan(null)}
            onConfirm={confirmCleanup}
          />
        )}
      </section>
    </div>
  );
}

function deliveryReadinessBusyLabel(busy: GitDeliveryReadinessBusy | null): string | null {
  if (busy === null) return null;
  if (busy.kind === 'prepare-requirements') return 'Saving required delivery checks';
  if (busy.kind === 'run-check') return 'Waiting for check confirmation and exact completion';
  return 'Waiting for human quality approval confirmation';
}

function deliveryReadinessNoticeMessage(notice: GitDeliveryReadinessNotice): GitReviewNotice {
  if (notice.kind === 'check-run-result') {
    if (notice.state === 'passed') {
      return gitReviewNotice(
        'The exact delivery check passed. Readiness was refreshed.',
        'success',
      );
    }
    if (notice.state === 'failed') {
      return gitReviewNotice(
        'The delivery check finished unsuccessfully. Delivery remains blocked.',
        'warning',
      );
    }
    if (notice.state === 'cancelled') {
      return gitReviewNotice(
        'The delivery check was cancelled before passing evidence was recorded.',
        'neutral',
      );
    }
    if (notice.state === 'lost') {
      return gitReviewNotice(
        'Forgeboard lost the terminal delivery-check evidence. Delivery remains blocked; run the check again.',
        'warning',
      );
    }
    if (notice.state === 'stale') {
      return gitReviewNotice(
        'The delivery-check evidence is stale for the current binding. Run the check again.',
        'warning',
      );
    }
    if (notice.state === 'running') {
      return gitReviewNotice(
        'The delivery check is still running. Refresh to load its latest state.',
        'neutral',
      );
    }
    if (notice.state === 'queued') {
      return gitReviewNotice(
        'The delivery check is queued. Refresh to load its latest state.',
        'neutral',
      );
    }
    return gitReviewNotice(
      'No current delivery-check evidence was recorded. Delivery remains blocked.',
      'warning',
    );
  }
  if (notice.kind === 'check-run-cancelled') {
    return gitReviewNotice(
      'Check run cancelled in the system confirmation. No check was started.',
      'neutral',
    );
  }
  if (notice.kind === 'quality-approved') {
    return gitReviewNotice(
      'Human quality approval was recorded for the exact current evidence.',
      'success',
    );
  }
  return gitReviewNotice(
    'Quality approval cancelled in the system confirmation. No approval was recorded.',
    'neutral',
  );
}

function gitReviewNotice(message: string, tone: GitReviewNoticeTone): GitReviewNotice {
  return { message, tone };
}

function GitReviewState({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="git-review-state">
      {icon}
      <strong>{title}</strong>
      <div>{children}</div>
    </div>
  );
}
