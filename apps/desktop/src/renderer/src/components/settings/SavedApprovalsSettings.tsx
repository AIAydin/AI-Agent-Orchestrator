import { RefreshCw, ShieldCheck, ShieldX } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { ApprovalView } from '../../../../shared/approvals/contracts.js';
import type { Project } from '../../../../shared/application/contracts.js';
import { unwrap } from '../../lib/ipc.js';

interface SavedApprovalsSettingsProps {
  readonly activeProject: Project | null;
  readonly busy: boolean;
  readonly onError: (message: string) => void;
}

export function SavedApprovalsSettings({
  activeProject,
  busy,
  onError,
}: SavedApprovalsSettingsProps) {
  const [approvals, setApprovals] = useState<ApprovalView[]>([]);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setApprovals(
        unwrap(
          await window.forgeboard.approvals.list({
            ...(activeProject === null ? {} : { projectId: activeProject.id }),
            includeInactive,
            limit: 200,
          }),
        ),
      );
    } catch (cause) {
      onError(
        cause instanceof Error ? cause.message : 'Saved approvals could not be loaded. Try again.',
      );
    } finally {
      setLoading(false);
    }
  }, [activeProject, includeInactive, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function revoke(approval: ApprovalView): Promise<void> {
    setRevokingId(approval.record.id);
    try {
      unwrap(
        await window.forgeboard.approvals.revoke({
          approvalId: approval.record.id,
          projectId: approval.record.scope.projectId,
        }),
      );
      await refresh();
    } catch (cause) {
      onError(
        cause instanceof Error ? cause.message : 'The approval could not be revoked. Try again.',
      );
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <div className="saved-approvals" aria-busy={loading || revokingId !== null}>
      <header>
        <span>
          <ShieldCheck size={16} aria-hidden="true" />
          <strong>Saved approvals</strong>
        </span>
        <button type="button" disabled={busy || loading} onClick={() => void refresh()}>
          <RefreshCw className={loading ? 'spin' : ''} size={13} aria-hidden="true" /> Refresh
        </button>
      </header>
      <p>
        Only exact check commands you chose to remember appear here. Everything else — starting
        agents, expanding context, pulling Docker images, sending data out, destructive Git actions
        — still requires per-use approval.
      </p>
      <label className="switch-row compact">
        <span>
          <strong>Show inactive approvals</strong>
          <small>Includes expired, used, denied, and revoked approvals.</small>
        </span>
        <input
          type="checkbox"
          name="show-inactive-approvals"
          checked={includeInactive}
          disabled={busy || loading}
          onChange={(event) => setIncludeInactive(event.target.checked)}
        />
      </label>
      {loading && approvals.length === 0 ? (
        <p role="status">Loading saved approvals…</p>
      ) : approvals.length === 0 ? (
        <p className="recovery-guidance" role="status">
          No {includeInactive ? '' : 'active '}saved approvals
          {activeProject === null ? ' on this device.' : ' for this project.'}
        </p>
      ) : (
        <ul className="saved-approval-list">
          {approvals.map((approval) => (
            <li key={approval.record.id}>
              <div>
                <strong>{approvalLabel(approval)}</strong>
                <small>
                  Project {approval.record.scope.projectId.slice(0, 8)} · item{' '}
                  <code>{approval.record.scope.resourceFingerprint.slice(0, 16)}</code>
                </small>
                <small>
                  Created {new Date(approval.record.createdAt).toLocaleString()} · expires{' '}
                  {new Date(approval.record.expiresAt).toLocaleString()}
                </small>
              </div>
              <span className={`status-chip ${approval.status === 'active' ? 'ok' : ''}`}>
                {approval.status}
              </span>
              {approval.status === 'active' && (
                <button
                  className="button"
                  type="button"
                  disabled={busy || revokingId !== null}
                  onClick={() => void revoke(approval)}
                  aria-label={`Revoke ${approvalLabel(approval)}`}
                >
                  <ShieldX size={13} aria-hidden="true" />
                  {revokingId === approval.record.id ? 'Revoking…' : 'Revoke'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function approvalLabel(approval: ApprovalView): string {
  const action = approval.record.scope.action.replaceAll('-', ' ');
  return action.replace(/^./u, (letter) => letter.toUpperCase());
}
