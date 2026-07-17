import { ShieldAlert, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useRef } from 'react';

import type { GitWorktreeCleanupPlanView } from '../../../../../shared/git/lifecycle/contracts.js';
import { displayEscapedText } from '../../../../../shared/text/display-literal.js';
import { trapModalFocus } from '../../../lib/modal-focus.js';

export function GitWorktreeCleanupDisclosure({
  plan,
  busy,
  onCancel,
  onConfirm,
}: {
  plan: GitWorktreeCleanupPlanView;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const cancelRef = useRef(onCancel);
  const busyRef = useRef(busy);
  cancelRef.current = onCancel;
  busyRef.current = busy;

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelButton.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      trapModalFocus(event, dialog.current);
      if (event.key !== 'Escape' || busyRef.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelRef.current();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, []);

  const eligible =
    plan.clean &&
    plan.mergedIntoBase &&
    plan.dirtyPathCount === 0 &&
    plan.deleteBranch &&
    !plan.force &&
    !plan.allowDirty &&
    !plan.allowUnmergedBranch;

  return (
    <div className="git-disclosure-backdrop" role="presentation">
      <section
        ref={dialog}
        className="git-action-disclosure git-cleanup-disclosure"
        role="alertdialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="git-cleanup-review-title"
        aria-describedby="git-cleanup-review-description"
      >
        <header>
          <ShieldAlert size={20} aria-hidden="true" />
          <span>
            <h3 id="git-cleanup-review-title">
              {plan.recovery
                ? 'Review interrupted cleanup recovery'
                : 'Review safe agent-worktree cleanup'}
            </h3>
            <p id="git-cleanup-review-description">
              {plan.recovery
                ? 'Forgeboard re-resolved the cleanup-pending run. Continuing opens a cancel-default system confirmation for this fresh recovery plan.'
                : 'Nothing has been removed. Continuing opens a cancel-default system confirmation for this exact prepared plan.'}
            </p>
          </span>
        </header>
        <div className="git-disclosure-body">
          <p className="git-cleanup-policy">
            {plan.recovery
              ? 'This recovery can continue only after Forgeboard revalidates the exact remaining managed worktree, clean state, and merge into its recorded base. The managed branch must be deleted; no force option exists.'
              : 'Forgeboard permits cleanup only when this exact managed worktree is clean and its branch is merged into the recorded base. The managed branch must be deleted with the worktree; no force option exists.'}
          </p>
          <dl>
            <div className="wide">
              <dt>Plan mode</dt>
              <dd>{plan.recovery ? 'Interrupted cleanup recovery' : 'New safe cleanup'}</dd>
            </div>
            <div className="wide">
              <dt>Managed branch</dt>
              <dd>{displayEscapedText(plan.branch)}</dd>
            </div>
            <div className="wide">
              <dt>Recorded base</dt>
              <dd>{displayEscapedText(plan.baseRef)}</dd>
            </div>
            <div>
              <dt>Working tree</dt>
              <dd>{plan.clean ? 'Clean — verified' : 'Not clean'}</dd>
            </div>
            <div>
              <dt>Merged into recorded base</dt>
              <dd>{plan.mergedIntoBase ? 'Yes — verified' : 'No'}</dd>
            </div>
            <div>
              <dt>Relative dirty paths</dt>
              <dd>{plan.dirtyPathCount}</dd>
            </div>
            <div>
              <dt>Managed branch deletion</dt>
              <dd>Required</dd>
            </div>
          </dl>
          {plan.dirtyPathCount > 0 && (
            <section className="git-cleanup-dirty-paths" aria-labelledby="git-cleanup-paths-title">
              <h4 id="git-cleanup-paths-title">Relative dirty paths ({plan.dirtyPathCount})</h4>
              <div>
                {plan.dirtyPaths.map((path) => (
                  <code key={path}>{displayEscapedText(path)}</code>
                ))}
              </div>
              {plan.dirtyPathsTruncated && (
                <small>
                  {plan.dirtyPathCount - plan.dirtyPaths.length} additional relative dirty paths are
                  not shown.
                </small>
              )}
            </section>
          )}
          {!eligible && (
            <p className="git-cleanup-ineligible" role="alert">
              <TriangleAlert size={14} aria-hidden="true" /> This plan is not eligible for safe
              cleanup. Go back and refresh the authoritative Git review.
            </p>
          )}
          <small>
            Plan expires at{' '}
            <time dateTime={plan.expiresAt}>{new Date(plan.expiresAt).toLocaleTimeString()}</time>.
          </small>
        </div>
        <footer>
          <button
            ref={cancelButton}
            className="button"
            type="button"
            disabled={busy}
            onClick={onCancel}
          >
            Go back
          </button>
          <button
            className="button danger"
            type="button"
            disabled={busy || !eligible}
            onClick={onConfirm}
          >
            <Trash2 size={14} aria-hidden="true" /> Continue to “Clean up” system confirmation
          </button>
        </footer>
      </section>
    </div>
  );
}
