import { ShieldAlert } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { trapModalFocus } from '../../../lib/modal-focus.js';
import type { GitHubCliPendingPlan } from './types.js';

export function ConnectionPlanDialog({
  plan,
  busy,
  onCancel,
  onConfirm,
}: {
  readonly plan: GitHubCliPendingPlan;
  readonly busy: boolean;
  readonly onCancel: () => Promise<void>;
  readonly onConfirm: () => Promise<void>;
}) {
  const dialog = useRef<HTMLElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef(onCancel);
  const busyRef = useRef(busy);
  cancelRef.current = onCancel;
  busyRef.current = busy;
  const titleId = `git-connections-plan-title-${plan.planId}`;
  const descriptionId = `git-connections-plan-description-${plan.planId}`;

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelButton.current?.focus();
    const handleKeyDown = (event: KeyboardEvent): void => {
      const openDialogs = [
        ...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'),
      ];
      if (openDialogs.at(-1) !== dialog.current) return;
      trapModalFocus(event, dialog.current);
      if (event.key !== 'Escape' || busyRef.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void cancelRef.current();
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
    <div className="modal-backdrop git-connections-plan-backdrop" role="presentation">
      <section
        ref={dialog}
        className="git-connections-plan"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
        tabIndex={-1}
      >
        <header>
          <ShieldAlert size={19} aria-hidden="true" />
          <div>
            <span>Review before applying</span>
            <h2 id={titleId}>GitHub CLI setup</h2>
          </div>
        </header>
        <p id={descriptionId}>
          Nothing has changed yet. Check the summary below — private file paths are not shown. If
          you continue, your computer will ask you to confirm, with Cancel pre-selected.
        </p>
        <dl>
          <PlanFact
            label="Source"
            value={plan.source === 'automatic' ? 'Found automatically' : 'File you choose'}
          />
          <PlanFact label="Program file" value={plan.candidate?.filename ?? 'None found yet'} />
          <PlanFact label="Version" value="Checked after you confirm" />
          <PlanFact
            label="Size"
            value={plan.candidate === null ? 'Not available' : formatBytes(plan.candidate.sizeBytes)}
          />
          <PlanFact
            label="Fingerprint (SHA-256)"
            value={plan.candidate?.sha256 ?? 'Not available'}
            code
          />
        </dl>
        <div className="git-connections-plan-safety">
          <strong>No internet access needed</strong>
          <span>
            This only chooses which GitHub CLI program on this computer Forgeboard uses. It does
            not sign in, contact GitHub, or check access to any project.
          </span>
        </div>
        <small>
          This review expires at <time dateTime={plan.expiresAt}>{formatTime(plan.expiresAt)}</time>
          .
        </small>
        <footer>
          <button
            ref={cancelButton}
            className="button"
            type="button"
            disabled={busy}
            onClick={() => void onCancel()}
          >
            Go back
          </button>
          <button
            className="button primary"
            type="button"
            disabled={busy}
            onClick={() => void onConfirm()}
          >
            Continue to confirmation
          </button>
        </footer>
      </section>
    </div>
  );
}

function PlanFact({
  label,
  value,
  code = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly code?: boolean;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{code ? <code>{value}</code> : value}</dd>
    </div>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${String(value)} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MiB`;
}
