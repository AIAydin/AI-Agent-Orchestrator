import { ConnectionPlanDialog } from './ConnectionPlanDialog.js';
import { GitHubCliSettings } from './GitHubCliSettings.js';
import { useGitHubCliController } from './useGitHubCliController.js';

import './git-connections.css';

/** Self-contained GitHub CLI status card with its reviewed selection flow. */
export function GitHubCliConnection({
  settingsBusy,
  onError,
}: {
  readonly settingsBusy: boolean;
  readonly onError: (message: string) => void;
}) {
  const controller = useGitHubCliController({ onError });
  const disabled = settingsBusy || controller.mutationBusy || controller.pendingPlan !== null;

  return (
    <section className="settings-section">
      <div className="settings-fields git-connections-settings">
        {controller.notice === null ? null : (
          <p
            className={`git-connections-notice ${controller.notice.tone}`}
            role={controller.notice.tone === 'warning' ? 'alert' : 'status'}
          >
            {controller.notice.message}
          </p>
        )}
        <GitHubCliSettings
          status={controller.cliStatus}
          loading={controller.cliLoading}
          disabled={disabled}
          onRefresh={controller.refreshCliStatus}
          onChoose={controller.chooseGitHubCli}
          onUseAutomatic={controller.useAutomaticGitHubCli}
        />
        {controller.pendingPlan === null ? null : (
          <ConnectionPlanDialog
            plan={controller.pendingPlan}
            busy={controller.mutationBusy}
            onCancel={controller.cancelPendingPlan}
            onConfirm={controller.confirmPendingPlan}
          />
        )}
      </div>
    </section>
  );
}
