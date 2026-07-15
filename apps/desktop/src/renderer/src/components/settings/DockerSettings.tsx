import type { AppSettings } from '../../../../shared/contracts.js';
import { DockerConfiguration } from '../DockerConfiguration.js';
import { SettingsSection, type AsyncSettingsProps } from './shared.js';

export function dockerConfigurationIncomplete(settings: AppSettings): boolean {
  return (
    settings.dockerEnabled &&
    (settings.dockerImage.trim() === '' ||
      settings.dockerContainerExecutable.trim() === '' ||
      settings.dockerMountHostCredentials)
  );
}

interface DockerSettingsProps extends AsyncSettingsProps {
  onError: (message: string) => void;
}

export function DockerSettings({ draft, setDraft, busy, onError }: DockerSettingsProps) {
  const runtimeFieldsIncomplete =
    draft.dockerEnabled &&
    (draft.dockerImage.trim() === '' || draft.dockerContainerExecutable.trim() === '');

  return (
    <SettingsSection
      title="Docker isolation"
      description="Optional stronger isolation. Forgeboard mounts only the assigned worktree and uses a non-root container user."
    >
      <label className="switch-row">
        <span>
          <strong>Enable Docker profiles</strong>
          <small>Docker is optional and never required for the local demo.</small>
        </span>
        <input
          type="checkbox"
          name="docker-enabled"
          checked={draft.dockerEnabled}
          disabled={draft.customPermissionProfile.runtime === 'docker'}
          aria-describedby={
            draft.customPermissionProfile.runtime === 'docker'
              ? 'docker-required-by-custom-profile'
              : undefined
          }
          onChange={(event) => {
            const dockerEnabled = event.target.checked;
            setDraft({
              ...draft,
              dockerEnabled,
              ...(!dockerEnabled && draft.defaultPermissionProfile === 'docker-isolated'
                ? { defaultPermissionProfile: 'worktree-write' as const }
                : {}),
            });
          }}
        />
      </label>
      {draft.customPermissionProfile.runtime === 'docker' && (
        <p id="docker-required-by-custom-profile" className="recovery-guidance" role="status">
          Docker stays enabled while the Custom profile uses it. Switch Custom to Host in the
          Permissions centre before turning Docker off.
        </p>
      )}
      <DockerConfiguration
        value={{
          dockerExecutable: draft.dockerExecutable,
          dockerImage: draft.dockerImage,
          dockerContainerExecutable: draft.dockerContainerExecutable,
        }}
        disabled={busy}
        onChange={(docker) => setDraft({ ...draft, ...docker })}
        onError={onError}
      />
      {runtimeFieldsIncomplete && (
        <div className="inline-notice" role="status">
          Choose an image and its absolute in-image agent executable before saving Docker isolation.
        </div>
      )}
      <div className="two-column">
        <label>
          CPU limit
          <input
            type="number"
            name="docker-cpu-limit"
            min="0.25"
            max="128"
            step="0.25"
            value={draft.dockerCpuLimit}
            onChange={(event) => setDraft({ ...draft, dockerCpuLimit: event.target.valueAsNumber })}
          />
        </label>
        <label>
          Memory limit (MB)
          <input
            type="number"
            name="docker-memory-limit-mb"
            min="128"
            max="1048576"
            value={draft.dockerMemoryMb}
            onChange={(event) => setDraft({ ...draft, dockerMemoryMb: event.target.valueAsNumber })}
          />
        </label>
      </div>
      <label>
        Container network
        <select
          name="docker-network"
          value={draft.dockerNetwork}
          onChange={(event) =>
            setDraft({
              ...draft,
              dockerNetwork: event.target.value as AppSettings['dockerNetwork'],
            })
          }
        >
          <option value="disabled">Disabled</option>
          <option value="enabled">Enabled with launch disclosure</option>
        </select>
      </label>
      <label className="switch-row warning-switch">
        <span>
          <strong>Mount host CLI credentials (unsupported)</strong>
          <small>
            Forgeboard never honors this preference or exposes host auth stores, sockets, or
            keychains. A checked value came from legacy or imported settings and can only be turned
            off.
          </small>
        </span>
        <input
          type="checkbox"
          name="docker-mount-host-cli-credentials"
          checked={draft.dockerMountHostCredentials}
          disabled={!draft.dockerMountHostCredentials}
          aria-label="Mount host CLI credentials"
          aria-describedby="docker-host-credentials-help"
          onChange={(event) => {
            if (!event.target.checked) {
              setDraft({ ...draft, dockerMountHostCredentials: false });
            }
          }}
        />
      </label>
      {draft.dockerMountHostCredentials && (
        <p id="docker-host-credentials-help" className="recovery-guidance warning" role="status">
          Host credential mounting is inactive and Docker launches fail closed while this legacy
          value is checked. Uncheck it and save Settings, then authenticate inside the selected
          image if the agent requires an account.
        </p>
      )}
    </SettingsSection>
  );
}
