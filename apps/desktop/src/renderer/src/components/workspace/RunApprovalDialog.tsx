import { Play, ShieldCheck } from 'lucide-react';

import type { RunDisclosure } from '../../../../shared/contracts.js';
import { formatCommand } from './helpers.js';

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
            <p>Forgeboard has prepared this run, but no agent process has started.</p>
          </div>
        </header>
        <div className="run-disclosure-scroll">
          {disclosure.primaryWasDirty && (
            <div className="run-warning">
              The primary checkout already has changes. This run uses the disclosed location and
              does not silently overwrite them.
            </div>
          )}
          {disclosure.warnings.map((warning) => (
            <div className="run-warning" key={warning}>
              {warning}
            </div>
          ))}
          <dl className="run-disclosure-grid">
            <div>
              <dt>Provider</dt>
              <dd>{disclosure.provider}</dd>
            </div>
            <div>
              <dt>Runtime</dt>
              <dd>{disclosure.runtime.toUpperCase()}</dd>
            </div>
            <div className="wide">
              <dt>Executable and arguments</dt>
              <dd>
                <code>{formatCommand(disclosure.executable, disclosure.arguments)}</code>
              </dd>
            </div>
            <div className="wide">
              <dt>Working directory</dt>
              <dd>
                <code>{disclosure.cwd}</code>
              </dd>
            </div>
            <div>
              <dt>Branch</dt>
              <dd>{disclosure.branch ?? 'Current checkout'}</dd>
            </div>
            <div>
              <dt>Base commit</dt>
              <dd>
                <code>{disclosure.baseCommit?.slice(0, 12) ?? 'Not available'}</code>
              </dd>
            </div>
            <div className="wide">
              <dt>Prompt</dt>
              <dd className="prompt-preview">{prompt}</dd>
            </div>
            <div className="wide">
              <dt>Permission enforcement</dt>
              <dd>
                <strong>{disclosure.permissionProfile.name}</strong> ·{' '}
                {disclosure.permissionProfile.mode} · {disclosure.permissionProfile.enforcement}
                <br />
                Read: {disclosure.permissionProfile.readRoots.join(', ') || 'none'}
                <br />
                Write: {disclosure.permissionProfile.writeRoots.join(', ') || 'none'}
                <br />
                Network: {disclosure.permissionProfile.network}
              </dd>
            </div>
            <div className="wide">
              <dt>Environment variable names</dt>
              <dd>
                {disclosure.environmentVariableNames.length
                  ? disclosure.environmentVariableNames.join(', ')
                  : 'No inherited variables'}
              </dd>
            </div>
            <div className="wide">
              <dt>Context attachments</dt>
              <dd>
                {disclosure.contextAttachments.length
                  ? disclosure.contextAttachments
                      .map((attachment) => `${attachment.kind}: ${attachment.path}`)
                      .join(', ')
                  : 'None'}
              </dd>
            </div>
          </dl>
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
