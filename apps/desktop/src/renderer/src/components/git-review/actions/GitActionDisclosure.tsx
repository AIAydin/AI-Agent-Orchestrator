import { GitCommitHorizontal, ShieldAlert, Trash2 } from 'lucide-react';
import { useEffect, useRef } from 'react';

import type {
  GitCommitPlanView,
  GitDiscardPlanView,
  GitReviewTargetView,
} from '../../../../../shared/git/contracts.js';
import { displayEscapedText } from '../../../../../shared/text/display-literal.js';
import { trapModalFocus } from '../../../lib/modal-focus.js';

const MAX_VISIBLE_PATHS = 100;

function targetLabel(target: GitReviewTargetView): string {
  return target.kind === 'primary'
    ? 'Main project files'
    : `Agent workspace · run ${target.runId.slice(0, 12)}`;
}

function PathList({ paths }: { paths: readonly string[] }) {
  const remaining = Math.max(0, paths.length - MAX_VISIBLE_PATHS);
  return (
    <div className="git-disclosure-paths">
      {paths.slice(0, MAX_VISIBLE_PATHS).map((path) => (
        <code key={path}>{displayEscapedText(path)}</code>
      ))}
      {remaining > 0 && <small>+ {remaining} more files</small>}
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
      if (event.key !== 'Escape') return;
      if (busyRef.current) return;
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
        ref={dialog}
        className="git-action-disclosure"
        role="alertdialog"
        tabIndex={-1}
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
            Continue
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
      title="Discard these changes?"
      description="Permanently removes these uncommitted changes from this workspace. You'll confirm once more."
      busy={busy}
      danger
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <dl>
        <div className="wide">
          <dt>Applies to</dt>
          <dd>{targetLabel(plan.target)}</dd>
        </div>
        <div>
          <dt>Changes</dt>
          <dd>
            {plan.hunkIds.length} changed section{plan.hunkIds.length === 1 ? '' : 's'} across{' '}
            {plan.paths.length} file{plan.paths.length === 1 ? '' : 's'}
          </dd>
        </div>
        <div>
          <dt>Lines affected</dt>
          <dd>
            +{plan.additions} added · −{plan.deletions} removed
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
      title="Review your commit"
      description="Nothing is committed yet — one final confirmation for exactly these changes comes next."
      busy={busy}
      danger={false}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <dl>
        <div className="wide">
          <dt>Applies to</dt>
          <dd>{targetLabel(plan.target)}</dd>
        </div>
        <div>
          <dt>Branch</dt>
          <dd>{plan.branch === null ? 'New branch' : displayEscapedText(plan.branch)}</dd>
        </div>
        <div>
          <dt>Ready to commit</dt>
          <dd>
            {plan.stagedPaths.length} files · +{plan.additions} −{plan.deletions}
          </dd>
        </div>
        <div className="wide">
          <dt>Author</dt>
          <dd>
            {displayEscapedText(plan.identity.name)} &lt;
            {displayEscapedText(plan.identity.email)}&gt;
          </dd>
        </div>
        <div className="wide">
          <dt>Message</dt>
          <dd className="git-disclosure-message">{displayEscapedText(plan.message)}</dd>
        </div>
      </dl>
      <PathList paths={plan.stagedPaths} />
      <small>
        This review expires at{' '}
        <time dateTime={plan.expiresAt}>{new Date(plan.expiresAt).toLocaleTimeString()}</time>.
      </small>
    </DisclosureFrame>
  );
}
