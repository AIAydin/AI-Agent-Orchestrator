import { useState } from 'react';

import type {
  CollaborationInviteCreateInput,
  CollaborationInviteRole,
  CollaborationInviteSafeView,
} from '../../../../../shared/collaboration/index.js';

interface InviteManagementControlsProps {
  readonly invites: CollaborationInviteSafeView[];
  readonly busy: boolean;
  readonly onCreate: (input: CollaborationInviteCreateInput) => Promise<void>;
  readonly onCopy: (inviteId: string) => Promise<void>;
  readonly onRevoke: (inviteId: string) => Promise<void>;
}

const EXPIRATIONS = [
  { value: 900, label: '15 minutes' },
  { value: 3_600, label: '1 hour' },
  { value: 86_400, label: '1 day' },
  { value: 604_800, label: '7 days' },
] as const;

export function InviteManagementControls({
  invites,
  busy,
  onCreate,
  onCopy,
  onRevoke,
}: InviteManagementControlsProps) {
  const [role, setRole] = useState<CollaborationInviteRole>('editor');
  const [expiresInSeconds, setExpiresInSeconds] = useState(3_600);
  const [maxUses, setMaxUses] = useState(1);

  return (
    <div aria-label="Manage room invites">
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
        Invite links remain in protected main-process memory. Use Copy to place one directly on the
        system clipboard.
      </p>
      {invites.length === 0 ? (
        <p>No invites have been created in this room session.</p>
      ) : (
        <ul aria-label="Session invites">
          {invites.map((invite) => (
            <li key={invite.id}>
              <span>
                {invite.role} · expires {formatExpiration(invite.expiresAt)} · up to{' '}
                {invite.maxUses} {invite.maxUses === 1 ? 'use' : 'uses'}
              </span>{' '}
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={() => void onCopy(invite.id)}
              >
                Copy
              </button>{' '}
              <button
                className="button danger"
                type="button"
                disabled={busy}
                onClick={() => void onRevoke(invite.id)}
              >
                Revoke
              </button>
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
