import type { AppSettings, Project } from '../../../../shared/application/contracts.js';
import { ConfiguredPermissionSummary } from '../permissions/ConfiguredPermissionSummary.js';
import { CustomPermissionProfileEditor } from '../permissions/CustomPermissionProfileEditor.js';
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
  return (
    <>
      <SettingsSection
        title="Permission centre"
        description="Pick the default profile and see what each one allows. Every launch still asks for your approval."
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
            {PERMISSION_PROFILE_OPTIONS.map((option) => (
              <option
                key={option.value}
                value={option.value}
                disabled={
                  draft.defaultAgent === 'test-agent' &&
                  permissionProfileNeedsDocker(option.value, draft)
                }
              >
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div className="permission-profile-cards" aria-label="Available permission profiles">
          {PERMISSION_PROFILE_OPTIONS.map((option) => (
            <article key={option.value}>
              <strong>{option.label}</strong>
              <p>{option.description}</p>
              <ConfiguredPermissionSummary
                profile={option.value}
                settings={draft}
                adapterId={draft.defaultAgent}
              />
            </article>
          ))}
        </div>
      </SettingsSection>
      <SettingsSection
        title="Custom profile"
        description="One reusable profile with ordinary controls — no code, JSON, or environment files to edit."
      >
        <CustomPermissionProfileEditor
          draft={draft}
          setDraft={setDraft}
          activeProject={activeProject}
          busy={busy}
          onError={onError}
        />
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
