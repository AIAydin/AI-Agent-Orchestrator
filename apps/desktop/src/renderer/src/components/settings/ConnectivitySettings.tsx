import type { AppSettings } from '../../../../shared/application/contracts.js';
import { SettingsSection } from './shared.js';

export function ConnectivitySettings({ settings }: { settings: AppSettings }) {
  return (
    <>
      <SettingsSection
        title="Self-hosted collaboration"
        description="The optional collaboration server exists as a separate service, but this desktop build does not yet include a client that can join it."
      >
        <label className="switch-row">
          <span>
            <strong>Enable collaboration</strong>
            <small>Unavailable until the desktop client and privacy review are complete.</small>
          </span>
          <input
            type="checkbox"
            name="collaboration-enabled"
            checked={settings.collaborationEnabled}
            disabled
            aria-describedby="collaboration-unavailable"
          />
        </label>
        <label>
          Collaboration server URL
          <input name="collaboration-url" value={settings.collaborationUrl} readOnly disabled />
        </label>
        <div className="two-column">
          <label>
            Collaboration display name
            <input
              name="collaboration-display-name"
              value={settings.collaborationDisplayName}
              readOnly
              disabled
            />
          </label>
          <label>
            Collaboration room
            <input name="collaboration-room" value={settings.collaborationRoom} readOnly disabled />
          </label>
        </div>
        <label className="switch-row">
          <span>
            <strong>Reconnect collaboration automatically</strong>
            <small>The reconnect policy is inactive while the desktop client is unavailable.</small>
          </span>
          <input
            type="checkbox"
            name="collaboration-reconnect"
            checked={settings.collaborationReconnect}
            disabled
          />
        </label>
        <p id="collaboration-unavailable" className="recovery-guidance warning" role="status">
          {settings.collaborationEnabled
            ? 'A stored or imported setting requests collaboration, but Forgeboard is not connected and will not send canvas data.'
            : 'No collaboration connection will be attempted and no canvas data will leave this device.'}
        </p>
      </SettingsSection>
      <SettingsSection
        title="Application updates"
        description="This build does not include an updater runtime. Release discovery, download verification, and installation are not performed in the background."
      >
        <label>
          Update channel
          <select
            name="update-channel"
            value={settings.updateChannel}
            disabled
            aria-describedby="updater-unavailable"
          >
            <option value="stable">Stable · stored but inactive</option>
            <option value="prerelease">Prerelease · stored but inactive</option>
            <option value="disabled">Disabled</option>
          </select>
        </label>
        <label className="switch-row">
          <span>
            <strong>Download updates automatically</strong>
            <small>No automatic updater is bundled in this build.</small>
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
          Manual update checks are unavailable. Install a newer signed release from the project’s
          GitHub Releases page when one is published. A stored or imported automatic-download
          preference is not acted on by this build.
        </p>
      </SettingsSection>
    </>
  );
}
