import { Play, ShieldAlert, X } from 'lucide-react';
import { useEffect, useRef } from 'react';

import type { TerminalLaunchPlanView } from '../../../../../shared/terminal/index.js';
import { trapModalFocus } from '../../../lib/modal-focus.js';

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
            <span className="eyebrow">Local process review</span>
            <h2 id="terminal-launch-review-title">Review the exact terminal launch</h2>
            <p id="terminal-launch-review-description">
              Nothing has launched. Continue only if this exact command and host access are
              expected; Forgeboard will then show a separate native confirmation.
            </p>
          </div>
          <button
            ref={cancelButtonRef}
            type="button"
            className="icon-button"
            aria-label="Cancel terminal launch review"
            disabled={busy}
            onClick={onCancel}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </header>

        <div className="terminal-launch-review-scroll">
          <div className="terminal-permission-warning" role="alert">
            <strong>{plan.permission.label}</strong>
            <p>{plan.permission.detail}</p>
            <small>
              Filesystem: {plan.permission.filesystem} · Network: {plan.permission.network} · OS
              sandbox: {plan.permission.sandboxed ? 'yes' : 'no'}
            </small>
          </div>
          <dl className="terminal-launch-disclosure">
            <div>
              <dt>Project</dt>
              <dd>{plan.projectName}</dd>
            </div>
            <div>
              <dt>Executable</dt>
              <dd>
                <code>{plan.executable}</code>
              </dd>
            </div>
            <div>
              <dt>Literal argument array</dt>
              <dd>
                <code>{JSON.stringify(plan.arguments)}</code>
              </dd>
            </div>
            <div>
              <dt>Project-relative working directory</dt>
              <dd>
                <code>{plan.cwdRelative}</code>
              </dd>
            </div>
            <div>
              <dt>Environment variable names</dt>
              <dd>
                <code>
                  {plan.environmentVariableNames.length === 0
                    ? 'None'
                    : plan.environmentVariableNames.join(', ')}
                </code>
              </dd>
            </div>
            <div>
              <dt>PTY dimensions</dt>
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
            Arguments are passed as an array without shell interpolation. Environment values are
            resolved by the main process from the named allowlist and are never shown or saved in
            this node.
          </p>
        </div>

        <footer>
          <button type="button" className="button" disabled={busy} onClick={onCancel}>
            Cancel before launch
          </button>
          <button type="button" className="button primary" disabled={busy} onClick={onContinue}>
            <Play size={14} aria-hidden="true" />
            {busy ? 'Waiting for confirmation…' : 'Continue to native confirmation'}
          </button>
        </footer>
      </section>
    </div>
  );
}
