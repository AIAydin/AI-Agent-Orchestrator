import { useRef, useState } from 'react';

import type { AppSettings } from '../../../../../../shared/application/contracts.js';
import type { CollaborationRoomBootstrapJoinInput } from '../../../../../../shared/collaboration/index.js';

type RoomAccessInput = CollaborationRoomBootstrapJoinInput;

interface RoomAccessControlsProps {
  readonly settings: AppSettings;
  readonly busy: boolean;
  readonly onBootstrap: (input: RoomAccessInput) => Promise<void>;
  readonly onRecover: (input: RoomAccessInput) => Promise<void>;
}

export function RoomAccessControls({
  settings,
  busy,
  onBootstrap,
  onRecover,
}: RoomAccessControlsProps) {
  const [mode, setMode] = useState<'create' | 'recover'>('create');
  const [adminToken, setAdminToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submissionLock = useRef(false);
  const disabled = busy || submitting;
  const configured =
    settings.collaborationEnabled &&
    settings.collaborationUrl.trim() !== '' &&
    settings.collaborationManagementUrl.trim() !== '' &&
    settings.collaborationRoom.trim() !== '' &&
    settings.collaborationSubject.trim() !== '' &&
    settings.collaborationDisplayName.trim() !== '';

  async function submit(): Promise<void> {
    if (submissionLock.current || disabled || !configured) return;
    submissionLock.current = true;
    setSubmitting(true);
    const credential = adminToken;
    setAdminToken('');
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
      await (mode === 'create' ? onBootstrap(input) : onRecover(input));
    } finally {
      submissionLock.current = false;
      setSubmitting(false);
    }
  }

  return (
    <section aria-labelledby="collaboration-room-access-heading">
      <h4 id="collaboration-room-access-heading">Room access</h4>
      <p id="collaboration-room-access-help">
        Create a room or recover its owner access without editing configuration files. Recovery
        rotates the owner credential, invalidating it for subsequent requests, messages, and
        reconnects.
      </p>
      <label>
        Room access action
        <select
          name="collaboration-room-access-action"
          value={mode}
          disabled={disabled}
          aria-describedby="collaboration-room-access-help"
          onChange={(event) => setMode(event.target.value as 'create' | 'recover')}
        >
          <option value="create">Create new room</option>
          <option value="recover">Recover existing owner access</option>
        </select>
      </label>
      <label>
        Server administrator token
        <input
          name="collaboration-admin-token"
          type="password"
          value={adminToken}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          aria-describedby="collaboration-admin-token-help"
          onChange={(event) => setAdminToken(event.target.value)}
        />
        <small id="collaboration-admin-token-help">
          Optional only when the management server permits local loopback bootstrap. This value is
          cleared immediately and is never saved.
        </small>
      </label>
      <button
        className={mode === 'recover' ? 'button danger' : 'button'}
        type="button"
        disabled={disabled || !configured}
        onClick={() => void submit()}
      >
        {mode === 'create' ? 'Create room and connect' : 'Rotate owner access and connect'}
      </button>
    </section>
  );
}
