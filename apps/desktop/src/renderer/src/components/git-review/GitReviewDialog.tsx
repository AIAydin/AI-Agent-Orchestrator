import {
  CheckCircle2,
  GitCompareArrows,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

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
  displayPreferences?: GitDiffDisplayPreferences;
  onDisplayPreferencesChange?: (preferences: GitDiffDisplayPreferences) => void;
  onClose: () => void;
  onError?: (message: string) => void;
}

export function GitReviewDialog({
  target,
  projectName,
  displayPreferences,
  onDisplayPreferencesChange,
  onClose,
  onError,
}: GitReviewDialogProps) {
  const controller = useGitReview(target, onError);
  const reviewNotes = useGitReviewNotes(target, controller.review?.refreshedAt ?? null, onError);
  const [selection, setSelection] = useState<GitFileSelection | null>(null);
  const [discardPlan, setDiscardPlan] = useState<GitDiscardPlanView | null>(null);
  const [commitPlan, setCommitPlan] = useState<GitCommitPlanView | null>(null);
  const [shippingPlan, setShippingPlan] = useState<GitShippingPlanView | null>(null);
  const [shippingResult, setShippingResult] = useState<GitShippingResultView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
  const busy = controller.busyLabel !== null;

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
        setNotice('Discard cancelled in the system confirmation. No content changed.');
      else if (result !== undefined) setNotice('Selected working-tree content was discarded.');
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
        setNotice('Commit cancelled in the system confirmation. Nothing was committed.');
      else if (result !== undefined)
        setNotice(`Created local commit ${result.headAfter.slice(0, 12)}.`);
    });
  };

  const prepareShipping = (strategy: GitShippingStrategy) => {
    setNotice(null);
    setShippingResult(null);
    void controller.prepareShipping(strategy).then((plan) => {
      if (plan !== undefined) setShippingPlan(plan);
    });
  };

  const confirmShipping = () => {
    if (shippingPlan === null) return;
    void controller.confirmShipping(shippingPlan.planId).then((result) => {
      setShippingPlan(null);
      if (result === null) {
        setNotice('Delivery cancelled in the system confirmation. Primary was not changed.');
      } else if (result !== undefined) {
        setShippingResult(result);
        setNotice(
          result.state === 'completed'
            ? `Delivered reviewed commits to primary at ${result.headAfter.slice(0, 12)}.`
            : 'Git stopped at conflicts. Primary was left in a reviewable conflict state.',
        );
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
        aria-busy={busy || reviewNotes.busy}
      >
        <header className="git-review-header">
          <span className="modal-title-icon">
            <GitCompareArrows size={19} aria-hidden="true" />
          </span>
          <span>
            <small>
              {target.kind === 'primary'
                ? 'Authoritative primary checkout'
                : 'Authoritative agent worktree'}
            </small>
            <h2 id="git-review-title">Review changes in {projectName}</h2>
          </span>
          <button
            className="icon-button"
            type="button"
            disabled={busy}
            aria-label="Refresh Git changes"
            onClick={() => void controller.refresh()}
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
        ) : controller.review === null ? (
          <GitReviewState icon={<TriangleAlert />} title="Git review is unavailable">
            {controller.error ?? 'Forgeboard could not read this repository.'}
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() => void controller.refresh()}
            >
              Try again
            </button>
          </GitReviewState>
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
            {(controller.error !== null || notice !== null || busy) && (
              <div
                className={`git-review-status ${controller.error ? 'error' : ''}`}
                aria-live="polite"
              >
                {busy ? (
                  <LoaderCircle className="spin" size={13} />
                ) : controller.error ? (
                  <TriangleAlert size={13} />
                ) : (
                  <CheckCircle2 size={13} />
                )}
                {controller.busyLabel ?? controller.error ?? notice}
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
                    <GitShippingPanel
                      review={controller.review}
                      busy={busy}
                      result={shippingResult}
                      onPrepare={prepareShipping}
                    />
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
      </section>
    </div>
  );
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
