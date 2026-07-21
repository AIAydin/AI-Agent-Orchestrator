import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';

interface DirectJoinControlsProps {
  readonly accessToken: string;
  readonly setAccessToken: (value: string) => void;
  readonly disabled: boolean;
  readonly canConnect: boolean;
  readonly connecting: boolean;
  readonly onJoin: () => Promise<void>;
}

export function DirectJoinControls({
  accessToken,
  setAccessToken,
  disabled,
  canConnect,
  connecting,
  onJoin,
}: DirectJoinControlsProps) {
  const [revealed, setRevealed] = useState(false);

  function join(): void {
    setRevealed(false);
    void onJoin();
  }

  return (
    <div aria-label="Advanced access-token join">
      <strong>Advanced access-token join</strong>
      <div className="settings-form-field">
        <label htmlFor="collaboration-access-token">Session access token</label>
        <span className="path-picker">
          <input
            id="collaboration-access-token"
            name="collaboration-access-token"
            type={revealed ? 'text' : 'password'}
            aria-label="Session access token"
            value={accessToken}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="collaboration-access-token-help"
            onChange={(event) => setAccessToken(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              if (canConnect) join();
            }}
          />
          <button
            className="icon-button"
            type="button"
            aria-label={revealed ? 'Hide session access token' : 'Show session access token'}
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
        <small id="collaboration-access-token-help">
          This field clears after every attempt. The token stays only in memory — never saved, sent
          elsewhere, or logged — and is removed when you leave, reset, or quit.
        </small>
      </div>
      <button className="button primary" type="button" disabled={!canConnect} onClick={join}>
        {connecting ? 'Connecting…' : 'Connect with access token'}
      </button>
    </div>
  );
}
