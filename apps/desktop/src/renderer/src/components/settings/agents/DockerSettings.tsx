import type { AppSettings } from '../../../../../shared/application/contracts.js';
import type { DockerReadinessEvidence } from '../../docker/readiness-evidence.js';
import { DockerConfiguration } from '../../docker/DockerConfiguration.js';
import { numericDraftValue } from '../fields/numeric-draft.js';
import { SettingsSection, type AsyncSettingsProps } from '../shared.js';

export function dockerConfigurationIncomplete(settings: AppSettings): boolean {
  return (
    settings.dockerEnabled &&
    (settings.dockerImage.trim() === '' ||
      settings.dockerContainerExecutable.trim() === '' ||
      settings.dockerMountHostCredentials)
  );
}

interface DockerSettingsProps extends AsyncSettingsProps {
  readiness: DockerReadinessEvidence | null;
  onReadinessChange: (evidence: DockerReadinessEvidence | null) => void;
  onError: (message: string) => void;
}

export function DockerSettings({
  draft,
  setDraft,
  busy,
  readiness,
  onReadinessChange,
  onError,
}: DockerSettingsProps) {
  const runtimeFieldsIncomplete =
    draft.dockerEnabled &&
    (draft.dockerImage.trim() === '' || draft.dockerContainerExecutable.trim() === '');

  return (
    <SettingsSection
      title="Extra protection with Docker"
      description="Optional extra protection. Docker gives each agent only its own project copy, without full access to your computer."
    >
      <label className="switch-row">
        <span>
          <strong>Enable Docker profiles</strong>
          <small>Docker is optional — the local demo works without it.</small>
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
            onReadinessChange(null);
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
        initialReadiness={readiness}
        onReadinessChange={onReadinessChange}
        onError={onError}
      />
      {runtimeFieldsIncomplete && (
        <div className="inline-notice" role="status">
          Choose a Docker image and the full path of the agent program inside it before saving these
          settings.
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
            value={numericDraftValue(draft.dockerCpuLimit)}
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
            value={numericDraftValue(draft.dockerMemoryMb)}
            onChange={(event) => setDraft({ ...draft, dockerMemoryMb: event.target.valueAsNumber })}
          />
        </label>
      </div>
      <label>
        Network access in Docker
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
          <option value="disabled">Off</option>
          <option value="enabled">On (shown in the review before each run)</option>
        </select>
      </label>
      <label className="switch-row warning-switch">
        <span>
          <strong>Share this computer's sign-in details with Docker (unsupported)</strong>
          <small>
            Forgeboard never shares your passwords, sign-in tokens, or keychain with Docker. If this
            is on, it came from old or imported settings — you can only turn it off.
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
          Sharing sign-in details never works, and Docker launches fail closed — every run is
          blocked for safety — while this old setting is on. Turn it off and save Settings. If the
          agent needs an account, sign in inside the Docker image instead.
        </p>
      )}
    </SettingsSection>
  );
}
