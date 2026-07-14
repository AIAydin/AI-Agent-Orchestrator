import type { AppSettings } from '../../../../shared/contracts.js';
import { DockerConfiguration } from '../DockerConfiguration.js';
import { SettingsSection, type AsyncSettingsProps } from './shared.js';

export function dockerConfigurationIncomplete(settings: AppSettings): boolean {
  return (
    settings.dockerEnabled &&
    (settings.dockerImage.trim() === '' || settings.dockerContainerExecutable.trim() === '')
  );
}

interface DockerSettingsProps extends AsyncSettingsProps {
  onError: (message: string) => void;
}

export function DockerSettings({ draft, setDraft, busy, onError }: DockerSettingsProps) {
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
      {dockerConfigurationIncomplete(draft) && (
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
          <strong>Host CLI credentials stay unmounted</strong>
          <small>
            The safe Docker profile never exposes host auth stores, sockets, or keychains.
            Authenticate inside your image through its own approved setup.
          </small>
        </span>
        <input
          type="checkbox"
          name="docker-mount-host-cli-credentials"
          checked={false}
          disabled
          aria-label="Mount host CLI credentials"
        />
      </label>
    </SettingsSection>
  );
}
