import { Eye, EyeOff } from 'lucide-react';
import { useRef, useState } from 'react';

import type { AppSettings } from '../../../../../../shared/application/contracts.js';
import type {
  CollaborationOwnerSessionView,
  CollaborationRoomBootstrapJoinInput,
} from '../../../../../../shared/collaboration/index.js';
import { collaborationPublicInviteConnectionIssue } from '../../../../../../shared/collaboration/index.js';

type RoomAccessInput = CollaborationRoomBootstrapJoinInput;

interface RoomAccessControlsProps {
  readonly settings: AppSettings;
  readonly busy: boolean;
  readonly onBootstrap: (input: RoomAccessInput) => Promise<CollaborationOwnerSessionView | null>;
  readonly onBootstrapAndInvite: (input: RoomAccessInput) => Promise<void>;
  readonly onRecover: (input: RoomAccessInput) => Promise<void>;
}

export function RoomAccessControls({
  settings,
  busy,
  onBootstrap,
  onBootstrapAndInvite,
  onRecover,
}: RoomAccessControlsProps) {
  const [mode, setMode] = useState<'create' | 'recover'>('create');
  const [adminToken, setAdminToken] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submissionLock = useRef(false);
  const disabled = busy || submitting;
  const configured =
    settings.collaborationUrl.trim() !== '' &&
    settings.collaborationManagementUrl.trim() !== '' &&
    settings.collaborationRoom.trim() !== '' &&
    settings.collaborationSubject.trim() !== '' &&
    settings.collaborationDisplayName.trim() !== '';
  const missingConnectionLinks =
    settings.collaborationUrl.trim() === '' || settings.collaborationManagementUrl.trim() === '';
  const inviteConnectionIssue = missingConnectionLinks
    ? null
    : collaborationPublicInviteConnectionIssue(
        settings.collaborationUrl,
        settings.collaborationManagementUrl,
      );

  async function submit(createInvite = false): Promise<void> {
    if (submissionLock.current || disabled || !configured) return;
    submissionLock.current = true;
    setSubmitting(true);
    const credential = adminToken;
    setAdminToken('');
    setRevealed(false);
    const input: RoomAccessInput = {
      serverUrl: settings.collaborationUrl,
      managementBaseUrl: settings.collaborationManagementUrl,
      roomId: settings.collaborationRoom,
      subject: settings.collaborationSubject,
      displayName: settings.collaborationDisplayName,
      color: settings.collaborationColor,
      ...(credential.trim() === '' ? {} : { adminToken: credential }),
      reconnect: settings.collaborationReconnect,
    };
    try {
      await (mode === 'create'
        ? createInvite
          ? onBootstrapAndInvite(input)
          : onBootstrap(input)
        : onRecover(input));
    } finally {
      submissionLock.current = false;
      setSubmitting(false);
    }
  }

  return (
    <section aria-label="Room access">
      <label>
        Action
        <select
          name="collaboration-room-access-action"
          aria-label="Room access action"
          value={mode}
          disabled={disabled}
          onChange={(event) => setMode(event.target.value as 'create' | 'recover')}
        >
          <option value="create">Create new room</option>
          <option value="recover">Recover existing owner access</option>
        </select>
      </label>
      <details className="collaboration-admin-token">
        <summary>
          {mode === 'create' ? 'My server requires an admin token' : 'Owner recovery'}
        </summary>
        <div className="settings-form-field">
          <label htmlFor="collaboration-admin-token">Server administrator token</label>
          <span className="path-picker">
            <input
              id="collaboration-admin-token"
              name="collaboration-admin-token"
              type={revealed ? 'text' : 'password'}
              value={adminToken}
              disabled={disabled}
              autoComplete="off"
              spellCheck={false}
              aria-describedby="collaboration-admin-token-help"
              onChange={(event) => setAdminToken(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                if (!disabled && configured) void submit();
              }}
            />
            <button
              className="icon-button"
              type="button"
              aria-label={
                revealed ? 'Hide server administrator token' : 'Show server administrator token'
              }
              disabled={disabled}
              onClick={() => setRevealed((current) => !current)}
            >
              {revealed ? (
                <EyeOff size={15} aria-hidden="true" />
              ) : (
                <Eye size={15} aria-hidden="true" />
              )}
            </button>
          </span>
          <small id="collaboration-admin-token-help">
            Cleared immediately and never saved. Recovery rotates the old owner credential.
          </small>
        </div>
      </details>
      <button
        className={mode === 'recover' ? 'button danger' : 'button'}
        type="button"
        disabled={disabled || !configured}
        onClick={() => void submit()}
      >
        {mode === 'create' ? 'Create room and connect' : 'Rotate owner access and connect'}
      </button>
      {mode === 'create' && (
        <>
          <button
            className="button primary"
            type="button"
            disabled={disabled || !configured || inviteConnectionIssue !== null}
            onClick={() => void submit(true)}
          >
            Create room + copy 10-minute invite
          </button>
          <small>Creates a one-use editor invite and copies it without showing its secret.</small>
        </>
      )}
      {missingConnectionLinks && (
        <small className="collaboration-missing-links" role="status">
          Add the public WebSocket and management links above.
        </small>
      )}
      {inviteConnectionIssue !== null && (
        <small className="collaboration-missing-links" role="status">
          {inviteConnectionIssue}
        </small>
      )}
    </section>
  );
}
