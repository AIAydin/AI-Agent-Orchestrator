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
  return (
    <div aria-label="Advanced access-token join">
      <strong>Advanced access-token join</strong>
      <label>
        Session access token
        <input
          name="collaboration-access-token"
          type="password"
          aria-label="Session access token"
          value={accessToken}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setAccessToken(event.target.value)}
        />
        <small>
          This field clears after every attempt. During an approved session, the token stays only in
          memory — never saved, sent elsewhere, or logged — and is removed when you leave, reset, or
          quit.
        </small>
      </label>
      <button
        className="button primary"
        type="button"
        disabled={!canConnect}
        onClick={() => void onJoin()}
      >
        {connecting ? 'Connecting…' : 'Connect with access token'}
      </button>
    </div>
  );
}
