import { useState } from 'react';

import type {
  CollaborationInviteCreateInput,
  CollaborationInviteHistoryPage,
  CollaborationInviteRole,
} from '../../../../../shared/collaboration/index.js';

interface InviteManagementControlsProps {
  readonly page: CollaborationInviteHistoryPage | null;
  readonly busy: boolean;
  readonly onCreateQuick: () => Promise<void>;
  readonly onCreate: (input: CollaborationInviteCreateInput) => Promise<void>;
  readonly onCopy: (inviteId: string) => Promise<void>;
  readonly onRevoke: (inviteId: string) => Promise<void>;
  readonly onRefresh: () => Promise<void>;
  readonly onPrevious: () => Promise<void>;
  readonly onNext: () => Promise<void>;
  readonly canPrevious: boolean;
}

const EXPIRATIONS = [
  { value: 900, label: '15 minutes' },
  { value: 3_600, label: '1 hour' },
  { value: 86_400, label: '1 day' },
  { value: 604_800, label: '7 days' },
] as const;

export function InviteManagementControls({
  page,
  busy,
  onCreateQuick,
  onCreate,
  onCopy,
  onRevoke,
  onRefresh,
  onPrevious,
  onNext,
  canPrevious,
}: InviteManagementControlsProps) {
  const [role, setRole] = useState<CollaborationInviteRole>('editor');
  const [expiresInSeconds, setExpiresInSeconds] = useState(3_600);
  const [maxUses, setMaxUses] = useState(1);

  return (
    <div aria-label="Manage room invites">
      <strong>Quick invite</strong>
      <p>One editor, one use, valid for 10 minutes.</p>
      <button
        className="button primary"
        type="button"
        disabled={busy}
        onClick={() => void onCreateQuick()}
      >
        Create &amp; copy 10-minute invite
      </button>
      <hr />
      <strong>Create invite</strong>
      <div className="two-column">
        <label>
          Invite role
          <select
            name="collaboration-invite-role"
            value={role}
            disabled={busy}
            onChange={(event) => setRole(event.target.value as CollaborationInviteRole)}
          >
            <option value="editor">Editor</option>
            <option value="reviewer">Reviewer</option>
            <option value="viewer">Viewer</option>
          </select>
        </label>
        <label>
          Invite expires after
          <select
            name="collaboration-invite-expiration"
            value={expiresInSeconds}
            disabled={busy}
            onChange={(event) => setExpiresInSeconds(Number(event.target.value))}
          >
            {EXPIRATIONS.map((expiration) => (
              <option key={expiration.value} value={expiration.value}>
                {expiration.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Maximum uses
        <input
          name="collaboration-invite-max-uses"
          type="number"
          min={1}
          max={100}
          step={1}
          value={maxUses}
          disabled={busy}
          onChange={(event) => setMaxUses(event.target.valueAsNumber)}
        />
      </label>
      <button
        className="button"
        type="button"
        disabled={busy || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100}
        onClick={() => void onCreate({ role, expiresInSeconds, maxUses })}
      >
        Create invite
      </button>
      <p>
        Invite history lives on the server. Links stay only in protected memory, so Copy works only
        for invites created in this app session.
      </p>
      <div className="settings-inline-actions">
        <button
          className="button secondary"
          type="button"
          disabled={busy}
          onClick={() => void onRefresh()}
        >
          Refresh invites
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={busy || !canPrevious}
          onClick={() => void onPrevious()}
        >
          Previous
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={busy || page?.nextCursor === null || page === null}
          onClick={() => void onNext()}
        >
          Next
        </button>
      </div>
      {page === null ? (
        <p>Invite history has not been loaded. Refresh to review this room.</p>
      ) : page.invites.length === 0 ? (
        <p>No invite history was found for this room.</p>
      ) : (
        <ul aria-label="Room invite history">
          {page.invites.map((invite) => (
            <li key={invite.id}>
              <span>
                {invite.role} · {invite.status} · created {formatExpiration(invite.createdAt)} ·
                expires {formatExpiration(invite.expiresAt)} · {invite.useCount} / {invite.maxUses}{' '}
                uses
              </span>{' '}
              {invite.copyAvailable && (
                <button
                  className="button"
                  type="button"
                  disabled={busy}
                  onClick={() => void onCopy(invite.id)}
                >
                  Copy
                </button>
              )}{' '}
              {invite.status === 'active' && (
                <button
                  className="button danger"
                  type="button"
                  disabled={busy}
                  onClick={() => void onRevoke(invite.id)}
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatExpiration(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? 'at the server deadline' : timestamp.toLocaleString();
}
