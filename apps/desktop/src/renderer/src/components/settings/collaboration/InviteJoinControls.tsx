import { Eye, EyeOff } from 'lucide-react';
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

import type { AppSettings } from '../../../../../shared/application/contracts.js';
import { collaborationInviteConnectionFromLink } from '../../../../../shared/collaboration/index.js';

interface InviteJoinControlsProps {
  readonly settings: AppSettings;
  readonly setSettings: Dispatch<SetStateAction<AppSettings>>;
  readonly disabled: boolean;
  readonly clearSignal: number;
  readonly onJoin: (inviteLink: string) => Promise<void>;
}

export function InviteJoinControls({
  settings,
  setSettings,
  disabled,
  clearSignal,
  onJoin,
}: InviteJoinControlsProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [hasLink, setHasLink] = useState(false);
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (inputRef.current !== null) inputRef.current.value = '';
    setHasLink(false);
    setRevealed(false);
  }, [clearSignal]);
  const hasRequiredSettings =
    settings.collaborationUrl.trim() !== '' &&
    settings.collaborationManagementUrl.trim() !== '' &&
    settings.collaborationSubject.trim() !== '' &&
    settings.collaborationDisplayName.trim() !== '';
  const canJoin = !disabled && hasRequiredSettings && hasLink;

  async function submit(): Promise<void> {
    const input = inputRef.current;
    if (input === null || input.value.trim() === '') return;
    const inviteLink = input.value;
    input.value = '';
    setHasLink(false);
    setRevealed(false);
    await onJoin(inviteLink);
  }

  function updateLink(value: string): void {
    setHasLink(value.trim() !== '');
    try {
      const connection = collaborationInviteConnectionFromLink(value);
      if (connection === null) return;
      setSettings((current) => ({
        ...current,
        collaborationUrl: connection.serverUrl,
        collaborationManagementUrl: connection.managementBaseUrl,
      }));
    } catch {
      // Validation remains at the trusted preload boundary. Keep partial pasted text private here.
    }
  }

  return (
    <div aria-label="Join with an invite link">
      <div className="settings-form-field">
        <label htmlFor="collaboration-invite-link">Invite link</label>
        <span className="path-picker">
          <input
            ref={inputRef}
            id="collaboration-invite-link"
            name="collaboration-invite-link"
            type={revealed ? 'text' : 'password'}
            aria-label="Invite link"
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="collaboration-invite-link-help"
            onChange={(event) => updateLink(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              if (canJoin) void submit();
            }}
          />
          <button
            className="icon-button"
            type="button"
            aria-label={revealed ? 'Hide invite link' : 'Show invite link'}
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
        <small id="collaboration-invite-link-help">
          New Forgeboard invites include the server connection automatically. The link is kept only
          for this attempt and clears immediately after you join.
        </small>
      </div>
      <button
        className="button"
        type="button"
        disabled={disabled || !hasRequiredSettings || !hasLink}
        onClick={() => void submit()}
      >
        Join room
      </button>
    </div>
  );
}
