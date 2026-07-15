import { Play, ShieldCheck } from 'lucide-react';

import type { RunDisclosure } from '../../../../shared/contracts.js';
import { RunDisclosureDetails, RunDisclosureWarnings } from './RunDisclosureDetails.js';

interface RunApprovalDialogProps {
  disclosure: RunDisclosure;
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
            <span className="eyebrow">Human approval gate</span>
            <h2 id="run-approval-title">Review the exact agent launch</h2>
            <p>Forgeboard has prepared this run, but no approved agent run has started.</p>
          </div>
        </header>
        <div className="run-disclosure-scroll">
          <RunDisclosureWarnings disclosure={disclosure} />
          <RunDisclosureDetails disclosure={disclosure} prompt={prompt} />
        </div>
        <footer>
          <button className="button" type="button" disabled={busy} onClick={onCancel}>
            Cancel before launch
          </button>
          <button className="button primary" type="button" disabled={busy} onClick={onApprove}>
            <Play size={14} /> {busy ? 'Launching…' : 'Approve & launch'}
          </button>
        </footer>
      </section>
    </div>
  );
}
