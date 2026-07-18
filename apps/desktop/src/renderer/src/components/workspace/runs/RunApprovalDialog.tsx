import { Play, ShieldCheck } from 'lucide-react';

import type { RunApprovalView } from '../../../../../shared/application/contracts.js';
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
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="modal run-approval-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-approval-title"
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
          <button className="button" type="button" disabled={busy} onClick={onCancel}>
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
