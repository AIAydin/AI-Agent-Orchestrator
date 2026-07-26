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
                ? 'Review the interrupted cleanup recovery'
                : "Review safe cleanup of the agent's workspace"}
            </h3>
            <p id="git-cleanup-review-description">
              {plan.recovery
                ? 'Artemis prepared a fresh plan for the interrupted cleanup. Your computer will ask you to confirm — you can still cancel there.'
                : 'Nothing has been removed yet. Your computer will ask you to confirm this exact plan — you can still cancel there.'}
            </p>
          </span>
        </header>
        <div className="git-disclosure-body">
          <p className="git-cleanup-policy">
            {plan.recovery
              ? 'Recovery continues only after Artemis re-checks the workspace: no unsaved changes, branch merged into the recorded base. The branch must be deleted — there is no way to force cleanup.'
              : 'Cleanup runs only when the workspace has no unsaved changes and its branch is merged into the recorded base. The branch is always deleted with it — there is no way to force cleanup.'}
          </p>
          <dl>
            <div className="wide">
              <dt>Mode</dt>
              <dd>
                {plan.recovery ? 'Recovery after an interrupted cleanup' : 'New safe cleanup'}
              </dd>
            </div>
            <div className="wide">
              <dt>Agent branch</dt>
              <dd>{displayEscapedText(plan.branch)}</dd>
            </div>
            <div className="wide">
              <dt>Recorded base branch</dt>
              <dd>{displayEscapedText(plan.baseRef)}</dd>
            </div>
            <div>
              <dt>Workspace</dt>
              <dd>{plan.clean ? 'No unsaved changes — verified' : 'Has unsaved changes'}</dd>
            </div>
            <div>
              <dt>Merged into the base branch</dt>
              <dd>{plan.mergedIntoBase ? 'Yes — verified' : 'No'}</dd>
            </div>
            <div>
              <dt>Files with unsaved changes</dt>
              <dd>{plan.dirtyPathCount}</dd>
            </div>
            <div>
              <dt>Branch deletion</dt>
              <dd>Required</dd>
            </div>
          </dl>
          {plan.dirtyPathCount > 0 && (
            <section className="git-cleanup-dirty-paths" aria-labelledby="git-cleanup-paths-title">
              <h4 id="git-cleanup-paths-title">
                Files with unsaved changes ({plan.dirtyPathCount})
              </h4>
              <div>
                {plan.dirtyPaths.map((path) => (
                  <code key={path}>{displayEscapedText(path)}</code>
                ))}
              </div>
              {plan.dirtyPathsTruncated && (
                <small>{plan.dirtyPathCount - plan.dirtyPaths.length} more files not shown.</small>
              )}
            </section>
          )}
          {!eligible && (
            <p className="git-cleanup-ineligible" role="alert">
              <TriangleAlert size={14} aria-hidden="true" /> This plan no longer qualifies for a
              safe cleanup. Go back and refresh the review.
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
            <Trash2 size={14} aria-hidden="true" /> Continue to the “Clean up” confirmation
          </button>
        </footer>
      </section>
    </div>
  );
}
