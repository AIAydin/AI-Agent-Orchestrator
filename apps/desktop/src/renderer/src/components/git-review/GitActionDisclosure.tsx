import { GitCommitHorizontal, ShieldAlert, Trash2 } from 'lucide-react';
import { useEffect, useRef } from 'react';

import type {
  GitCommitPlanView,
  GitDiscardPlanView,
  GitReviewTargetView,
} from '../../../../shared/git-contracts.js';

const MAX_VISIBLE_PATHS = 100;

function targetLabel(target: GitReviewTargetView): string {
  return target.kind === 'primary'
    ? 'Primary checkout'
    : `Isolated agent worktree · run ${target.runId.slice(0, 12)}`;
}

function PathList({ paths }: { paths: readonly string[] }) {
  const remaining = Math.max(0, paths.length - MAX_VISIBLE_PATHS);
  return (
    <div className="git-disclosure-paths">
      {paths.slice(0, MAX_VISIBLE_PATHS).map((path) => (
        <code key={path}>{path}</code>
      ))}
      {remaining > 0 && <small>+ {remaining} additional paths in this exact plan</small>}
    </div>
  );
}

function DisclosureFrame({
  titleId,
  title,
  description,
  busy,
  danger,
  children,
  onCancel,
  onConfirm,
}: {
  titleId: string;
  title: string;
  description: string;
  busy: boolean;
  danger: boolean;
  children: React.ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelButton.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
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

  return (
    <div className="git-disclosure-backdrop" role="presentation">
      <section
        className="git-action-disclosure"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${titleId}-description`}
      >
        <header>
          <ShieldAlert size={20} aria-hidden="true" />
          <span>
            <h3 id={titleId}>{title}</h3>
            <p id={`${titleId}-description`}>{description}</p>
          </span>
        </header>
        <div className="git-disclosure-body">{children}</div>
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
            className={`button ${danger ? 'danger' : 'primary'}`}
            type="button"
            disabled={busy}
            onClick={onConfirm}
          >
            {danger ? (
              <Trash2 size={14} aria-hidden="true" />
            ) : (
              <GitCommitHorizontal size={14} aria-hidden="true" />
            )}
            Continue to system confirmation
          </button>
        </footer>
      </section>
    </div>
  );
}

export function GitDiscardDisclosure({
  plan,
  busy,
  onCancel,
  onConfirm,
}: {
  plan: GitDiscardPlanView;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <DisclosureFrame
      titleId="git-discard-review-title"
      title="Review permanent hunk discard"
      description="This removes the selected unstaged content from your working tree. Forgeboard will ask again in a native system dialog."
      busy={busy}
      danger
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <dl>
        <div className="wide">
          <dt>Target</dt>
          <dd>{targetLabel(plan.target)}</dd>
        </div>
        <div>
          <dt>Scope</dt>
          <dd>
            {plan.hunkIds.length} hunk{plan.hunkIds.length === 1 ? '' : 's'} across{' '}
            {plan.paths.length} path{plan.paths.length === 1 ? '' : 's'}
          </dd>
        </div>
        <div>
          <dt>Lines removed from working changes</dt>
          <dd>
            +{plan.additions} additions · −{plan.deletions} deletions
          </dd>
        </div>
      </dl>
      <PathList paths={plan.paths} />
    </DisclosureFrame>
  );
}

export function GitCommitDisclosure({
  plan,
  busy,
  onCancel,
  onConfirm,
}: {
  plan: GitCommitPlanView;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <DisclosureFrame
      titleId="git-commit-review-title"
      title="Review the exact local commit"
      description="No commit exists yet. Continuing opens a native system confirmation bound to this staged snapshot."
      busy={busy}
      danger={false}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <dl>
        <div className="wide">
          <dt>Target</dt>
          <dd>{targetLabel(plan.target)}</dd>
        </div>
        <div>
          <dt>Branch</dt>
          <dd>{plan.branch ?? 'Unborn branch'}</dd>
        </div>
        <div>
          <dt>Staged snapshot</dt>
          <dd>
            {plan.stagedPaths.length} paths · +{plan.additions} −{plan.deletions}
          </dd>
        </div>
        <div className="wide">
          <dt>Author</dt>
          <dd>
            {plan.identity.name} &lt;{plan.identity.email}&gt;
          </dd>
        </div>
        <div className="wide">
          <dt>Message</dt>
          <dd className="git-disclosure-message">{plan.message}</dd>
        </div>
      </dl>
      <PathList paths={plan.stagedPaths} />
      <small>
        Plan expires at{' '}
        <time dateTime={plan.expiresAt}>{new Date(plan.expiresAt).toLocaleTimeString()}</time>.
      </small>
    </DisclosureFrame>
  );
}
