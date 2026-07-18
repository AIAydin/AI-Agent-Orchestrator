import { useEffect, useRef, useState } from 'react';

import type { AppSettings } from '../../../../../shared/application/contracts.js';

interface InviteJoinControlsProps {
  readonly settings: AppSettings;
  readonly disabled: boolean;
  readonly clearSignal: number;
  readonly onJoin: (inviteLink: string) => Promise<void>;
}

export function InviteJoinControls({
  settings,
  disabled,
  clearSignal,
  onJoin,
}: InviteJoinControlsProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [hasLink, setHasLink] = useState(false);
  useEffect(() => {
    if (inputRef.current !== null) inputRef.current.value = '';
    setHasLink(false);
  }, [clearSignal]);
  const hasRequiredSettings =
    settings.collaborationEnabled &&
    settings.collaborationUrl.trim() !== '' &&
    settings.collaborationManagementUrl.trim() !== '' &&
    settings.collaborationSubject.trim() !== '' &&
    settings.collaborationDisplayName.trim() !== '';

  async function submit(): Promise<void> {
    const input = inputRef.current;
    if (input === null || input.value.trim() === '') return;
    const inviteLink = input.value;
    input.value = '';
    setHasLink(false);
    await onJoin(inviteLink);
  }

  return (
    <div aria-label="Join with an invite link">
      <label>
        Invite link
        <input
          ref={inputRef}
          name="collaboration-invite-link"
          type="password"
          aria-label="Invite link"
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setHasLink(event.currentTarget.value.trim() !== '')}
        />
        <small>
          Paste a trusted invite link. It is sent only to the configured management API and clears
          after every attempt.
        </small>
      </label>
      <button
        className="button"
        type="button"
        disabled={disabled || !hasRequiredSettings || !hasLink}
        onClick={() => void submit()}
      >
        Join with invite
      </button>
    </div>
  );
}
