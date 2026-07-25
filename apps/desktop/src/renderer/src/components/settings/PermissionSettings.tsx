import type { AppSettings, Project } from '../../../../shared/application/contracts.js';
import { ConfiguredPermissionSummary } from '../permissions/ConfiguredPermissionSummary.js';
import {
  PERMISSION_PROFILE_OPTIONS,
  permissionProfileNeedsDocker,
} from '../permissions/permission-profile-ui.js';
import { SettingsSection, type AsyncSettingsProps } from './shared.js';
import { SavedApprovalsSettings } from './SavedApprovalsSettings.js';

interface PermissionSettingsProps extends AsyncSettingsProps {
  activeProject: Project | null;
  onError: (message: string) => void;
}

export function PermissionSettings({
  activeProject,
  draft,
  setDraft,
  busy,
  onError,
}: PermissionSettingsProps) {
  const options = PERMISSION_PROFILE_OPTIONS.filter(
    (option) => option.value !== 'custom' || draft.defaultPermissionProfile === 'custom',
  );
  return (
    <>
      <SettingsSection
        title="Permissions"
        description="Pick the default profile for new agent sessions. Each card shows what it allows."
      >
        <label>
          Default permission profile
          <select
            name="permission-centre-default-profile"
            value={draft.defaultPermissionProfile}
            disabled={busy}
            onChange={(event) => {
              const defaultPermissionProfile = event.target
                .value as AppSettings['defaultPermissionProfile'];
              setDraft({
                ...draft,
                defaultPermissionProfile,
                ...(permissionProfileNeedsDocker(defaultPermissionProfile, draft)
                  ? { dockerEnabled: true }
                  : {}),
              });
            }}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div className="permission-profile-cards" aria-label="Available permission profiles">
          {options.map((option) => (
            <article key={option.value}>
              <strong>{option.label}</strong>
              <p>{option.description}</p>
              <ConfiguredPermissionSummary profile={option.value} settings={draft} />
            </article>
          ))}
        </div>
      </SettingsSection>
      <SettingsSection
        title="Saved approvals"
        description="Review and revoke remembered approvals. Changes apply right away — they're not part of the settings draft."
      >
        <SavedApprovalsSettings activeProject={activeProject} busy={busy} onError={onError} />
      </SettingsSection>
    </>
  );
}
