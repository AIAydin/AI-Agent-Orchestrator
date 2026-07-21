import { Play, ShieldCheck } from 'lucide-react';
import { useEffect, useRef } from 'react';

import type { RunApprovalView } from '../../../../../shared/application/contracts.js';
import { trapModalFocus } from '../../../lib/modal-focus.js';
import { RunDisclosureDetails, RunDisclosureWarnings } from './RunDisclosureDetails.js';

interface RunApprovalDialogProps {
  disclosure: RunApprovalView;
  prompt: string;
  busy: boolean;
  onCancel: () => void;
  onApprove: () => void;
}

export function RunApprovalDialog({
  disclosure,
  prompt,
  busy,
  onCancel,
  onApprove,
}: RunApprovalDialogProps) {
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
    <div className="modal-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="modal run-approval-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-approval-title"
        aria-busy={busy}
        tabIndex={-1}
      >
        <header>
          <span className="modal-title-icon">
            <ShieldCheck size={19} />
          </span>
          <div>
            <span className="eyebrow">Approval needed</span>
            <h2 id="run-approval-title">Review this run before it starts</h2>
            <p>This run is ready. The agent won&apos;t start until you approve it.</p>
          </div>
        </header>
        <div className="run-disclosure-scroll">
          <RunDisclosureWarnings disclosure={disclosure} />
          <RunDisclosureDetails disclosure={disclosure} prompt={prompt} />
          <dl className="run-disclosure-grid">
            <div className="wide">
              <dt>Security fingerprint (SHA-256)</dt>
              <dd>
                <code aria-label="Security fingerprint (SHA-256)">
                  {disclosure.disclosureFingerprint}
                </code>
              </dd>
            </div>
            <div className="wide">
              <dt>Approval expires at</dt>
              <dd>
                <time aria-label="Approval expires at" dateTime={disclosure.expiresAt}>
                  {disclosure.expiresAt}
                </time>
              </dd>
            </div>
          </dl>
        </div>
        <footer>
          <button
            ref={cancelButtonRef}
            className="button"
            type="button"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel run
          </button>
          <button className="button primary" type="button" disabled={busy} onClick={onApprove}>
            <Play size={14} /> {busy ? 'Starting…' : 'Approve and start'}
          </button>
        </footer>
      </section>
    </div>
  );
}
