import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

import type { AppSettings } from '../../../../shared/application/contracts.js';
import type {
  CollaborationAwarenessEntry,
  CollaborationConnection,
} from '../../../../shared/collaboration/index.js';
import { SettingsSection } from './shared.js';

interface ConnectivitySettingsProps {
  readonly settings: AppSettings;
  readonly setSettings: Dispatch<SetStateAction<AppSettings>>;
  readonly busy: boolean;
}

export function ConnectivitySettings({ settings, setSettings, busy }: ConnectivitySettingsProps) {
  const [accessToken, setAccessToken] = useState('');
  const [connection, setConnection] = useState<CollaborationConnection | null>(null);
  const [collaborators, setCollaborators] = useState<CollaborationAwarenessEntry[]>([]);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);

  useEffect(() => {
    const collaboration = window.forgeboard.collaboration;
    if (collaboration === undefined) return;
    let active = true;
    let eventObserved = false;
    void collaboration
      .get()
      .then((result) => {
        if (!active || eventObserved) return;
        if (result.ok) setConnection(result.value);
        else setConnectionMessage(result.error.message);
      })
      .catch(() => {
        if (active && !eventObserved) {
          setConnectionMessage('Forgeboard could not check the collaboration status. Try again.');
        }
      });
    const unsubscribe = collaboration.onEvent((event) => {
      if (!active) return;
      eventObserved = true;
      if (event.type === 'status-changed') {
        setConnection(event.connection);
        if (event.connection.status === 'connected') {
          setConnectionMessage(`Connected to room ${event.connection.roomId}.`);
        } else if (event.connection.status === 'offline') {
          setConnectionMessage('Collaboration is offline.');
          setCollaborators([]);
        }
      } else if (event.type === 'awareness-changed') {
        setCollaborators(event.states);
      } else if (event.type === 'connection-error') {
        setConnectionMessage(event.error.message);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const connectionActive =
    connection !== null && connection.status !== 'offline' && connection.status !== 'error';
  const inputDisabled = busy || connectionBusy || connectionActive;
  const canConnect =
    settings.collaborationEnabled &&
    settings.collaborationUrl.trim() !== '' &&
    settings.collaborationRoom.trim() !== '' &&
    settings.collaborationDisplayName.trim() !== '' &&
    settings.collaborationSubject.trim() !== '' &&
    accessToken.trim() !== '' &&
    !inputDisabled;

  async function join(): Promise<void> {
    const collaboration = window.forgeboard.collaboration;
    if (collaboration === undefined) {
      setConnectionMessage('Collaboration is not available in this build of Forgeboard.');
      return;
    }
    setConnectionBusy(true);
    setConnectionMessage(null);
    try {
      const result = await collaboration.join({
        serverUrl: settings.collaborationUrl,
        roomId: settings.collaborationRoom,
        subject: settings.collaborationSubject,
        displayName: settings.collaborationDisplayName,
        color: settings.collaborationColor,
        accessToken,
        reconnect: settings.collaborationReconnect,
      });
      if (result.ok) {
        setConnection(result.connection);
        setConnectionMessage(`Connected to room ${result.connection.roomId}.`);
      } else {
        setConnectionMessage(result.error.message);
      }
    } catch {
      setConnectionMessage(
        'Forgeboard could not understand the collaboration server’s response. Try again.',
      );
    } finally {
      setAccessToken('');
      setConnectionBusy(false);
    }
  }

  async function leave(): Promise<boolean> {
    const collaboration = window.forgeboard.collaboration;
    if (collaboration === undefined) return false;
    setConnectionBusy(true);
    setConnectionMessage(null);
    try {
      const result = await collaboration.leave();
      if (result.ok) {
        setConnection(null);
        setCollaborators([]);
        setConnectionMessage('Left the collaboration room.');
        return true;
      } else {
        setConnectionMessage(result.error.message);
        return false;
      }
    } catch {
      setConnectionMessage(
        'Forgeboard could not understand the collaboration server’s response. Try again.',
      );
      return false;
    } finally {
      setConnectionBusy(false);
    }
  }

  async function setCollaborationEnabled(enabled: boolean): Promise<void> {
    if (!enabled && connection !== null && !(await leave())) return;
    setSettings((current) => ({
      ...current,
      collaborationEnabled: enabled,
    }));
  }

  return (
    <>
      <SettingsSection
        title="Self-hosted collaboration"
        description="Work with others in real time through a server your team runs itself. Join a room only when you choose to; access tokens are never saved."
      >
        <label className="switch-row">
          <span>
            <strong>Enable collaboration</strong>
            <small>
              A connection starts only when you click Connect and approve the system prompt.
            </small>
          </span>
          <input
            type="checkbox"
            name="collaboration-enabled"
            checked={settings.collaborationEnabled}
            disabled={busy || connectionBusy}
            onChange={(event) => void setCollaborationEnabled(event.target.checked)}
          />
        </label>
        <label>
          Collaboration server URL
          <input
            name="collaboration-url"
            value={settings.collaborationUrl}
            disabled={inputDisabled}
            spellCheck={false}
            onChange={(event) =>
              setSettings((current) => ({
                ...current,
                collaborationUrl: event.target.value,
              }))
            }
          />
        </label>
        <div className="two-column">
          <label>
            Collaboration display name
            <input
              name="collaboration-display-name"
              value={settings.collaborationDisplayName}
              disabled={inputDisabled}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  collaborationDisplayName: event.target.value,
                }))
              }
            />
          </label>
          <label>
            Collaboration room
            <input
              name="collaboration-room"
              value={settings.collaborationRoom}
              disabled={inputDisabled}
              spellCheck={false}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  collaborationRoom: event.target.value,
                }))
              }
            />
          </label>
        </div>
        <div className="two-column">
          <label>
            Collaborator ID
            <input
              name="collaboration-subject"
              value={settings.collaborationSubject}
              disabled={inputDisabled}
              spellCheck={false}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  collaborationSubject: event.target.value,
                }))
              }
            />
          </label>
          <label>
            Collaborator color
            <input
              name="collaboration-color"
              type="color"
              value={settings.collaborationColor}
              disabled={inputDisabled}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  collaborationColor: event.target.value,
                }))
              }
            />
          </label>
        </div>
        <label>
          Session access token
          <input
            name="collaboration-access-token"
            type="password"
            aria-label="Session access token"
            value={accessToken}
            disabled={inputDisabled}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setAccessToken(event.target.value)}
          />
          <small>
            This field clears after every attempt. While a session is approved, the token is kept
            only in memory — never saved, sent elsewhere, or logged — and it is removed when you
            leave, reset, or quit.
          </small>
        </label>
        <label className="switch-row">
          <span>
            <strong>Reconnect collaboration automatically</strong>
            <small>
              Reconnects only to this approved room. Leaving the room ends the active session.
            </small>
          </span>
          <input
            type="checkbox"
            name="collaboration-reconnect"
            checked={settings.collaborationReconnect}
            disabled={inputDisabled}
            onChange={(event) =>
              setSettings((current) => ({
                ...current,
                collaborationReconnect: event.target.checked,
              }))
            }
          />
        </label>
        <div className="button-row">
          <button
            className="button primary"
            type="button"
            disabled={!canConnect}
            onClick={() => void join()}
          >
            {connectionBusy && !connectionActive ? 'Connecting…' : 'Connect'}
          </button>
          <button
            className="button"
            type="button"
            disabled={busy || connectionBusy || connection === null}
            onClick={() => void leave()}
          >
            Leave room
          </button>
        </div>
        <p className="recovery-guidance warning" role="status" aria-live="polite">
          {connectionMessage ?? collaborationStatus(connection)} Forgeboard shares only these canvas
          details: layout, titles, positions, task and review status, comments, and who is present.
          It does not check shared titles, connection labels, or comments for secrets, so avoid
          typing passwords or keys into them. Prompts, file contents, local paths, environment
          variables, credentials, and tokens stay on this computer.
        </p>
        {collaborators.length > 0 && (
          <div aria-label="People in this room">
            <strong>People in this room</strong>
            <ul>
              {collaborators.map(({ clientId, state }) => (
                <li key={clientId}>
                  {state.user.displayName} · {state.user.role}
                </li>
              ))}
            </ul>
          </div>
        )}
      </SettingsSection>
      <SettingsSection
        title="Application updates"
        description="This build cannot update itself. It never finds, downloads, or installs updates in the background."
      >
        <label>
          Update channel
          <select
            name="update-channel"
            value={settings.updateChannel}
            disabled
            aria-describedby="updater-unavailable"
          >
            <option value="stable">Stable · saved but not used</option>
            <option value="prerelease">Prerelease · saved but not used</option>
            <option value="disabled">Disabled</option>
          </select>
        </label>
        <label className="switch-row">
          <span>
            <strong>Download updates automatically</strong>
            <small>This build does not include an updater.</small>
          </span>
          <input
            type="checkbox"
            name="automatic-update-downloads"
            checked={settings.automaticUpdateDownloads}
            disabled
          />
        </label>
        <button className="button" type="button" disabled>
          Check for updates
        </button>
        <p id="updater-unavailable" className="recovery-guidance" role="status">
          Update checks are not available in this build. To update, install the latest signed
          release from the project’s GitHub Releases page. Any saved or imported automatic-download
          preference is ignored by this build.
        </p>
      </SettingsSection>
    </>
  );
}

function collaborationStatus(connection: CollaborationConnection | null): string {
  if (connection === null) return 'Not connected.';
  switch (connection.status) {
    case 'connected':
      return `Connected to room ${connection.roomId}.`;
    case 'connecting':
      return 'Signing in and starting the first secure sync.';
    case 'reconnecting':
      return 'Reconnecting to the approved room.';
    case 'disconnecting':
      return 'Leaving the room.';
    case 'error':
      return (
        connection.error?.message ?? 'The collaboration connection failed. Try connecting again.'
      );
    case 'offline':
      return 'Collaboration is offline.';
  }
}
