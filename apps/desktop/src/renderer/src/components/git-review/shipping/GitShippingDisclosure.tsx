import { GitMerge, ShieldAlert } from 'lucide-react';
import { useEffect, useRef } from 'react';

import type { GitShippingPlanView } from '../../../../../shared/git/shipping-contracts.js';
import { displayEscapedText } from '../../../../../shared/text/display-literal.js';
import { trapModalFocus } from '../../../lib/modal-focus.js';

export function GitShippingDisclosure({
  plan,
  busy,
  onCancel,
  onConfirm,
}: {
  plan: GitShippingPlanView;
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

  const strategy =
    plan.strategy === 'fast-forward-only' ? 'Fast-forward-only merge' : 'Ordered cherry-pick';
  const qualityApproval = plan.readiness.approvals.find(
    (approval) => approval.approvalId === plan.readinessApprovalId,
  );
  return (
    <div className="git-disclosure-backdrop" role="presentation">
      <section
        ref={dialog}
        className="git-action-disclosure"
        role="alertdialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="git-shipping-review-title"
        aria-describedby="git-shipping-review-description"
      >
        <header>
          <ShieldAlert size={20} aria-hidden="true" />
          <span>
            <h3 id="git-shipping-review-title">Review exact primary delivery</h3>
            <p id="git-shipping-review-description">
              No primary history has changed. Continuing opens a cancel-default native system
              confirmation bound to this plan.
            </p>
          </span>
        </header>
        <div className="git-disclosure-body">
          <dl>
            <div className="wide">
              <dt>Source</dt>
              <dd>
                {displayEscapedText(plan.sourceBranch)} · run {plan.runId}
              </dd>
            </div>
            <div className="wide">
              <dt>Target</dt>
              <dd>
                {displayEscapedText(plan.projectName)} · primary branch{' '}
                {displayEscapedText(plan.targetBranch)}
              </dd>
            </div>
            <div>
              <dt>Strategy</dt>
              <dd>{strategy}</dd>
            </div>
            <div>
              <dt>Commit range</dt>
              <dd>
                <code>
                  {plan.baseCommit}..{plan.sourceHead}
                </code>
              </dd>
            </div>
            <div className="wide">
              <dt>Git identity supplied to delivery</dt>
              <dd>
                {displayEscapedText(plan.identity.name)} &lt;
                {displayEscapedText(plan.identity.email)}&gt; · name from{' '}
                {identitySource(plan.identity.nameSource)}, email from{' '}
                {identitySource(plan.identity.emailSource)}
              </dd>
            </div>
          </dl>
          <h4>Commits ({plan.commits.length}, oldest first)</h4>
          <div className="git-disclosure-paths">
            {plan.commits.map((commit) => (
              <code key={commit}>{commit}</code>
            ))}
          </div>
          <h4>Affected files ({plan.affectedPaths.length})</h4>
          <div className="git-disclosure-paths">
            {plan.affectedPaths.map((path) => (
              <code key={path}>{displayEscapedText(path)}</code>
            ))}
          </div>
          <h4>Content-bound delivery readiness</h4>
          <div className="git-disclosure-paths">
            {plan.readiness.requiredChecks.map((check) => (
              <span key={check.checkId}>
                {displayEscapedText(check.label)} · passed{' '}
                {check.endedAt === null
                  ? 'without a reported finish time'
                  : formatTime(check.endedAt)}
              </span>
            ))}
          </div>
          <small>
            {qualityApproval === undefined
              ? 'Exact human quality approval is unavailable.'
              : `${displayEscapedText(qualityApproval.actorLabel)} approved this exact check evidence ${formatTime(qualityApproval.approvedAt)}.`}{' '}
            Evidence <code>{plan.readiness.evidenceFingerprint.slice(0, 12)}</code> is revalidated
            before the system confirmation and again before Git changes primary.
          </small>
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
          <button className="button primary" type="button" disabled={busy} onClick={onConfirm}>
            <GitMerge size={14} aria-hidden="true" /> Continue to system confirmation
          </button>
        </footer>
      </section>
    </div>
  );
}

function formatTime(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : 'at an unknown time';
}

function identitySource(source: GitShippingPlanView['identity']['nameSource']): string {
  if (source === 'settings') return 'Forgeboard Settings';
  if (source === 'git-config') return 'primary checkout Git configuration';
  return 'unavailable source';
}
