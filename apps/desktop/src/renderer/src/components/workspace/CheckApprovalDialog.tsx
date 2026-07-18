import { Play, ShieldCheck } from 'lucide-react';
import { useEffect, useRef } from 'react';

import type { CheckPlanView } from '../../../../shared/checks/contracts.js';
import { formatCommand } from './model/helpers.js';
import './checks/project-checks.css';

interface CheckApprovalDialogProps {
  plan: CheckPlanView;
  busy: boolean;
  onCancel: () => void;
  onContinue: () => void;
}

export function CheckApprovalDialog({
  plan,
  busy,
  onCancel,
  onContinue,
}: CheckApprovalDialogProps) {
  const dialog = useRef<HTMLElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const continueButton = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef(onCancel);
  const busyRef = useRef(busy);
  cancelRef.current = onCancel;
  busyRef.current = busy;

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelButton.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (busyRef.current) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        cancelRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = dialog.current
        ? [
            ...dialog.current.querySelectorAll<HTMLElement>(
              'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
            ),
          ]
        : [];
      if (!focusable.length) {
        event.preventDefault();
        dialog.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      } else if (!dialog.current?.contains(document.activeElement)) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    if (busy) dialog.current?.focus();
  }, [busy]);

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        ref={dialog}
        className="modal check-approval-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="check-approval-title"
        aria-describedby="check-approval-description check-approval-warning"
        aria-busy={busy}
        tabIndex={-1}
      >
        <header>
          <span className="modal-title-icon">
            <ShieldCheck size={19} aria-hidden="true" />
          </span>
          <div>
            <span className="eyebrow">Check command approval</span>
            <h2 id="check-approval-title">Review the {plan.label} command</h2>
            <p id="check-approval-description">
              Nothing has run yet. Continue only if everything below is what you expect. If you
              saved an approval for this exact command, Forgeboard checks that it matches; otherwise
              it asks you to confirm.
            </p>
          </div>
        </header>
        <p id="check-approval-warning" className="check-approval-warning">
          Project checks run code from this project on your computer, with your account’s
          permissions. Package scripts can run other commands during install or build. Review recent
          project changes before running a check. Output is saved in full, so do not run a check
          that prints passwords or other secrets.
        </p>
        <dl className="check-disclosure-grid" tabIndex={0} aria-label="Check command details">
          <div className="wide">
            <dt>Command and its arguments</dt>
            <dd>
              <code>{formatCommand(plan.executable, plan.arguments)}</code>
            </dd>
          </div>
          <div className="wide">
            <dt>Folder it runs in</dt>
            <dd>
              <code>{plan.cwd}</code>
            </dd>
          </div>
          <div>
            <dt>Check type</dt>
            <dd>{plan.kind}</dd>
          </div>
          <div>
            <dt>Approval expires</dt>
            <dd>
              <time dateTime={plan.expiresAt}>{new Date(plan.expiresAt).toLocaleTimeString()}</time>
            </dd>
          </div>
          <div className="wide">
            <dt>Environment variables passed to it</dt>
            <dd>
              {plan.environmentVariableNames.length
                ? plan.environmentVariableNames.join(', ')
                : 'None'}
            </dd>
          </div>
          <div className="wide">
            <dt>Approval fingerprint</dt>
            <dd>
              <code>{plan.approvalFingerprint}</code>
            </dd>
          </div>
        </dl>
        <footer>
          <button
            ref={cancelButton}
            className="button"
            type="button"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            ref={continueButton}
            className="button primary"
            type="button"
            disabled={busy}
            onClick={onContinue}
          >
            <Play size={14} aria-hidden="true" /> {busy ? 'Approving…' : 'Approve and run'}
          </button>
        </footer>
      </section>
    </div>
  );
}
