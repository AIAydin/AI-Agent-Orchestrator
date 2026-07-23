import { Play, ShieldAlert, X } from 'lucide-react';
import { useEffect, useRef } from 'react';

import type { TerminalLaunchPlanView } from '../../../../../../shared/terminal/index.js';
import { trapModalFocus } from '../../../../lib/modal-focus.js';
import { WorkspaceTooltip } from '../../shell/tooltips/WorkspaceTooltip.js';

interface TerminalLaunchReviewDialogProps {
  readonly plan: TerminalLaunchPlanView;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onContinue: () => void;
}

export function TerminalLaunchReviewDialog({
  plan,
  busy,
  onCancel,
  onContinue,
}: TerminalLaunchReviewDialogProps) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const onCancelRef = useRef(onCancel);
  const busyRef = useRef(busy);
  onCancelRef.current = onCancel;
  busyRef.current = busy;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelButtonRef.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      const openDialogs = [
        ...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'),
      ];
      if (openDialogs.at(-1) !== dialogRef.current) return;
      trapModalFocus(event, dialogRef.current);
      if (event.key !== 'Escape' || busyRef.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onCancelRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    if (busy) dialogRef.current?.focus();
  }, [busy]);

  return (
    <div className="modal-backdrop terminal-launch-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="modal terminal-launch-review"
        role="dialog"
        aria-modal="true"
        aria-labelledby="terminal-launch-review-title"
        aria-describedby="terminal-launch-review-description"
        aria-busy={busy}
        tabIndex={-1}
      >
        <header>
          <span className="modal-title-icon warning">
            <ShieldAlert size={19} aria-hidden="true" />
          </span>
          <div>
            <span className="eyebrow">Terminal safety review</span>
            <h2 id="terminal-launch-review-title">Review this terminal command</h2>
            <p id="terminal-launch-review-description">
              Nothing has run yet. If this command and its access look right, continue — your
              computer will then ask you to confirm once more.
            </p>
          </div>
          <WorkspaceTooltip
            content={busy ? 'Wait for terminal confirmation to finish' : 'Cancel terminal review'}
          >
            <button
              ref={cancelButtonRef}
              type="button"
              className="icon-button"
              aria-label="Cancel review"
              disabled={busy}
              onClick={onCancel}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </WorkspaceTooltip>
        </header>

        <div className="terminal-launch-review-scroll">
          <div className="terminal-permission-warning" role="alert">
            <strong>{plan.permission.label}</strong>
            <p>{plan.permission.detail}</p>
            <small>
              Files: {plan.permission.filesystem} · Network: {plan.permission.network} · Sandboxed:{' '}
              {plan.permission.sandboxed ? 'yes' : 'no'}
            </small>
          </div>
          <dl className="terminal-launch-disclosure">
            <div>
              <dt>Project</dt>
              <dd>{plan.projectName}</dd>
            </div>
            <div>
              <dt>Program</dt>
              <dd>
                <code>{plan.executable}</code>
              </dd>
            </div>
            <div>
              <dt>Arguments</dt>
              <dd>
                <code>{JSON.stringify(plan.arguments)}</code>
              </dd>
            </div>
            <div>
              <dt>Folder to run in</dt>
              <dd>
                <code>{plan.cwdRelative}</code>
              </dd>
            </div>
            <div>
              <dt>Environment variables</dt>
              <dd>
                <code>
                  {plan.environmentVariableNames.length === 0
                    ? 'None'
                    : plan.environmentVariableNames.join(', ')}
                </code>
              </dd>
            </div>
            <div>
              <dt>Window size</dt>
              <dd>
                {plan.columns} columns × {plan.rows} rows
              </dd>
            </div>
            <div>
              <dt>Review expires</dt>
              <dd>
                <time dateTime={plan.expiresAt}>{plan.expiresAt}</time>
              </dd>
            </div>
          </dl>
          <p className="terminal-launch-boundary">
            Arguments run exactly as listed — no shell rewrites them. The terminal gets standard
            system variables (PATH, HOME, TERM) plus your allowlisted settings values — values are
            never shown or stored here.
          </p>
        </div>

        <footer>
          <button type="button" className="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="button primary" disabled={busy} onClick={onContinue}>
            <Play size={14} aria-hidden="true" />
            {busy ? 'Waiting for confirmation…' : 'Continue'}
          </button>
        </footer>
      </section>
    </div>
  );
}
