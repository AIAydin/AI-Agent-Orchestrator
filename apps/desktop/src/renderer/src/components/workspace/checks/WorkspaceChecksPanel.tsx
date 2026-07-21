import { CircleStop, Play } from 'lucide-react';

import type { CheckExecutionView } from '../../../../../shared/checks/contracts.js';
import { parseCheckSummary } from './check-output.js';
import { formatCommand } from '../model/helpers.js';
import type { CheckCommand } from '../model/types.js';
import './project-checks.css';

interface WorkspaceChecksPanelProps {
  commands: CheckCommand[];
  latestByCheckId: ReadonlyMap<string, CheckExecutionView>;
  busyCheckId: string | null;
  onPrepare: (checkId: string) => void;
  onCancel: (executionId: string) => void;
  onOpenSettings: () => void;
}

export function WorkspaceChecksPanel({
  commands,
  latestByCheckId,
  busyCheckId,
  onPrepare,
  onCancel,
  onOpenSettings,
}: WorkspaceChecksPanelProps) {
  return (
    <div
      id="workspace-panel-checks"
      className="drawer-panel"
      role="tabpanel"
      aria-labelledby="workspace-tab-checks"
      tabIndex={0}
    >
      <header className="drawer-panel-summary">
        <div>
          <strong>Project checks</strong>
          <small>
            Runs real commands on this computer. You approve each one first; full output is kept.
          </small>
        </div>
        <button type="button" aria-label="Configure project checks" onClick={onOpenSettings}>
          Configure
        </button>
      </header>
      <div className="check-command-list">
        {commands.map(({ id, label, command, detectedScript }) => {
          const configured = command.executable.trim().length > 0;
          const execution = latestByCheckId.get(id);
          const active = execution?.status === 'queued' || execution?.status === 'running';
          const busy = busyCheckId === id;
          const operationBusy = busyCheckId !== null;
          const state = execution?.status ?? (configured ? 'not-run' : 'unconfigured');
          const titleId = `project-check-${id}-title`;
          const parsedSummary =
            execution && (execution.kind === 'test' || execution.kind === 'custom')
              ? parseCheckSummary(execution.output)
              : null;
          return (
            <article className="project-check-card" key={id} aria-labelledby={titleId}>
              <header>
                <strong id={titleId}>{label}</strong>
                <span className={`check-state ${state}`} role="status" aria-live="polite">
                  {execution?.status ?? (configured ? 'Not run' : 'Not configured')}
                </span>
              </header>
              {configured ? (
                <code>{formatCommand(command.executable, command.arguments)}</code>
              ) : detectedScript ? (
                <small>
                  This project provides a script: <code>{detectedScript}</code>. Turn it on in
                  Settings.
                </small>
              ) : (
                <small>Set up a command in Settings to run this check.</small>
              )}
              <div className="project-check-actions">
                {active && execution ? (
                  <button
                    type="button"
                    disabled={operationBusy}
                    onClick={() => onCancel(execution.id)}
                    aria-label={`Cancel ${label}`}
                  >
                    <CircleStop size={12} aria-hidden="true" /> {busy ? 'Cancelling…' : 'Cancel'}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={!configured || operationBusy}
                    onClick={() => onPrepare(id)}
                    aria-label={`Run ${label}`}
                  >
                    <Play size={12} aria-hidden="true" /> {busy ? 'Preparing…' : 'Run'}
                  </button>
                )}
              </div>
              {execution && (
                <div className="project-check-result">
                  <small>
                    {execution.exitCode === null
                      ? active
                        ? execution.status === 'queued'
                          ? 'Queued · waiting to start'
                          : 'Running · no result yet'
                        : 'No result code reported'
                      : `Exit code ${execution.exitCode}`}
                    {execution.outputTruncated ? ' · output shortened' : ''}
                  </small>
                  {parsedSummary && (
                    <div
                      className="project-check-test-summary"
                      role="group"
                      aria-label={`${label} test summary`}
                    >
                      <span className="passed">
                        <strong>{parsedSummary.passed}</strong> passed
                      </span>
                      <span className={parsedSummary.failed > 0 ? 'failed' : ''}>
                        <strong>{parsedSummary.failed}</strong> failed
                      </span>
                      <span>
                        <strong>{parsedSummary.skipped}</strong> skipped
                      </span>
                      <span>
                        <strong>{parsedSummary.total}</strong> total
                      </span>
                    </div>
                  )}
                  {execution.output ? (
                    <pre tabIndex={0} aria-label={`${label} full output`}>
                      {execution.output}
                    </pre>
                  ) : null}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
