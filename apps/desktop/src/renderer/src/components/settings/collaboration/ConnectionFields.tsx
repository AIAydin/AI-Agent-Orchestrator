import type { Dispatch, SetStateAction } from 'react';

import type { AppSettings } from '../../../../../shared/application/contracts.js';

interface ConnectionFieldsProps {
  readonly settings: AppSettings;
  readonly setSettings: Dispatch<SetStateAction<AppSettings>>;
  readonly disabled: boolean;
}

export function ConnectionFields({ settings, setSettings, disabled }: ConnectionFieldsProps) {
  function update(patch: Partial<AppSettings>): void {
    setSettings((current) => ({ ...current, ...patch }));
  }

  return (
    <>
      <label>
        Collaboration server URL
        <input
          name="collaboration-url"
          value={settings.collaborationUrl}
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => update({ collaborationUrl: event.target.value })}
        />
      </label>
      <label>
        Collaboration management API URL
        <input
          name="collaboration-management-url"
          value={settings.collaborationManagementUrl}
          disabled={disabled}
          spellCheck={false}
          placeholder="https://collaboration.example.com"
          onChange={(event) => update({ collaborationManagementUrl: event.target.value })}
        />
        <small>
          Used for explicit room and invite management. Use the HTTPS address published by your
          collaboration administrator. Plain HTTP is accepted only for a server on this device, such
          as http://127.0.0.1:1234. Forgeboard does not guess this API address from the WebSocket
          URL.
        </small>
      </label>
      <div className="two-column">
        <label>
          Collaboration display name
          <input
            name="collaboration-display-name"
            value={settings.collaborationDisplayName}
            disabled={disabled}
            onChange={(event) => update({ collaborationDisplayName: event.target.value })}
          />
        </label>
        <label>
          Collaboration room
          <input
            name="collaboration-room"
            value={settings.collaborationRoom}
            disabled={disabled}
            spellCheck={false}
            onChange={(event) => update({ collaborationRoom: event.target.value })}
          />
        </label>
      </div>
      <div className="two-column">
        <label>
          Collaborator ID
          <input
            name="collaboration-subject"
            value={settings.collaborationSubject}
            disabled={disabled}
            spellCheck={false}
            onChange={(event) => update({ collaborationSubject: event.target.value })}
          />
        </label>
        <label>
          Collaborator color
          <input
            name="collaboration-color"
            type="color"
            value={settings.collaborationColor}
            disabled={disabled}
            onChange={(event) => update({ collaborationColor: event.target.value })}
          />
        </label>
      </div>
      <label className="switch-row">
        <span>
          <strong>Reconnect collaboration automatically</strong>
          <small>Reconnects only to this approved room. Leaving ends the active session.</small>
        </span>
        <input
          type="checkbox"
          name="collaboration-reconnect"
          checked={settings.collaborationReconnect}
          disabled={disabled}
          onChange={(event) => update({ collaborationReconnect: event.target.checked })}
        />
      </label>
    </>
  );
}
