import type { Project } from '../../../../../shared/application/contracts.js';
import { SettingsSection } from '../shared.js';
import { ConnectionPlanDialog } from './ConnectionPlanDialog.js';
import { GitHubCliSettings } from './GitHubCliSettings.js';
import { RemoteConnections } from './RemoteConnections.js';
import { useGitConnectionsController } from './useGitConnectionsController.js';

import './git-connections.css';

export function GitConnectionsSettings({
  projects,
  activeProject,
  settingsBusy,
  onError,
}: {
  readonly projects: readonly Project[];
  readonly activeProject: Project | null;
  readonly settingsBusy: boolean;
  readonly onError: (message: string) => void;
}) {
  const controller = useGitConnectionsController({ projects, activeProject, onError });
  const disabled = settingsBusy || controller.mutationBusy || controller.pendingPlan !== null;

  return (
    <SettingsSection
      title="Git connections"
      description="Manage the places where each project stores its code (Git remotes) and the optional GitHub CLI tool, all from the desktop app. Changes you confirm apply right away — they do not use Save settings."
    >
      <div
        className="git-connections-settings"
        onKeyDown={(event) => {
          if (
            event.key === 'Enter' &&
            event.target instanceof HTMLInputElement &&
            event.target.type === 'text'
          ) {
            event.preventDefault();
          }
        }}
      >
        <label className="git-connections-project">
          Project
          <select
            name="git-connections-project"
            aria-label="Project"
            value={controller.projectId}
            disabled={disabled || controller.availableProjects.length === 0}
            onChange={(event) => controller.setProjectId(event.target.value)}
          >
            {controller.availableProjects.length === 0 ? (
              <option value="">No Git projects available</option>
            ) : (
              controller.availableProjects.map((project, index) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                  {index === 0 && activeProject?.id === project.id ? ' · active' : ''}
                </option>
              ))
            )}
          </select>
        </label>
        <p className="git-connections-immediate-note">
          These changes do not use the Save settings button. Each one shows its own review, then a
          confirmation from your computer with Cancel pre-selected.
        </p>
        {controller.notice === null ? null : (
          <p
            className={`git-connections-notice ${controller.notice.tone}`}
            role={controller.notice.tone === 'warning' ? 'alert' : 'status'}
          >
            {controller.notice.message}
          </p>
        )}
        <RemoteConnections
          key={controller.projectId}
          connections={controller.connections}
          hasSelectedProject={controller.projectId !== ''}
          loading={controller.connectionsLoading}
          disabled={disabled}
          onRefresh={controller.refreshConnections}
          onPrepareNetwork={controller.prepareNetwork}
          onPrepareLocal={controller.prepareLocal}
          onPrepareRemove={controller.prepareRemove}
        />
        <GitHubCliSettings
          status={controller.cliStatus}
          loading={controller.cliLoading}
          disabled={disabled}
          onRefresh={controller.refreshCliStatus}
          onChoose={controller.chooseGitHubCli}
          onUseAutomatic={controller.useAutomaticGitHubCli}
        />
      </div>
      {controller.pendingPlan === null ? null : (
        <ConnectionPlanDialog
          plan={controller.pendingPlan}
          busy={controller.mutationBusy}
          onCancel={controller.cancelPendingPlan}
          onConfirm={controller.confirmPendingPlan}
        />
      )}
    </SettingsSection>
  );
}
