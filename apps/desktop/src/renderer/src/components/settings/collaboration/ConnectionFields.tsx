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
      <div className="two-column">
        <ServerUrlField settings={settings} disabled={disabled} update={update} />
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

export function CollaborationProfileFields({
  settings,
  setSettings,
  disabled,
}: ConnectionFieldsProps) {
  function update(patch: Partial<AppSettings>): void {
    setSettings((current) => ({ ...current, ...patch }));
  }

  return (
    <div className="collaboration-profile-fields">
      <label>
        Your name
        <input
          name="collaboration-display-name"
          aria-label="Collaboration display name"
          value={settings.collaborationDisplayName}
          disabled={disabled}
          autoComplete="name"
          onChange={(event) => update({ collaborationDisplayName: event.target.value })}
        />
      </label>
      <label className="collaboration-color-field">
        Your color
        <input
          name="collaboration-color"
          aria-label="Collaborator color"
          type="color"
          value={settings.collaborationColor}
          disabled={disabled}
          onChange={(event) => update({ collaborationColor: event.target.value })}
        />
      </label>
    </div>
  );
}

export function CollaborationRoomField({ settings, setSettings, disabled }: ConnectionFieldsProps) {
  return (
    <label>
      Room name
      <input
        name="collaboration-room"
        aria-label="Collaboration room"
        value={settings.collaborationRoom}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) =>
          setSettings((current) => ({
            ...current,
            collaborationRoom: event.target.value,
          }))
        }
      />
    </label>
  );
}

function ServerUrlField({
  settings,
  disabled,
  update,
}: {
  settings: AppSettings;
  disabled: boolean;
  update: (patch: Partial<AppSettings>) => void;
}) {
  return (
    <>
      <label>
        Collaboration server URL
        <input
          name="collaboration-url"
          aria-label="Collaboration server URL"
          value={settings.collaborationUrl}
          disabled={disabled}
          spellCheck={false}
          aria-describedby="collaboration-url-help"
          onChange={(event) => update({ collaborationUrl: event.target.value })}
        />
        <small id="collaboration-url-help">
          The ws:// or wss:// address from your administrator.
        </small>
      </label>
      <label>
        Collaboration management API URL
        <input
          name="collaboration-management-url"
          aria-label="Collaboration management API URL"
          value={settings.collaborationManagementUrl}
          disabled={disabled}
          spellCheck={false}
          placeholder="https://collaboration.example.com"
          onChange={(event) => update({ collaborationManagementUrl: event.target.value })}
        />
        <small>
          Used to create rooms and redeem invites. HTTP is accepted only on this device.
        </small>
      </label>
    </>
  );
}
