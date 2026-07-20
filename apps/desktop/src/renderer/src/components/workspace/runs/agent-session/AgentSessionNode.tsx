import { useRef, type JSX } from 'react';

import type { PermissionProfile } from '../../../../../../shared/application/contracts.js';
import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import { isRunAdapterId } from '../../model/helpers.js';
import { providerTheme } from '../../node-registry/provider-themes.js';
import {
  PERMISSION_PROFILE_OPTIONS,
  permissionProfileUnavailableReason,
} from '../../../permissions/permission-profile-ui.js';
import { useCanvasNodeInteractions } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import { TerminalLaunchReviewDialog } from '../../terminal/TerminalLaunchReviewDialog.js';
import { TerminalSurface, type TerminalSurfaceHandle } from '../../terminal/TerminalSurface.js';
import type { TerminalNodeConfiguration } from '../../terminal/types.js';
import { terminalOperationsFromWindow } from '../../terminal/types.js';
import { useTerminalNodeController } from '../../terminal/useTerminalNodeController.js';
import { effectiveNodeModel } from '../agent-node/model-selection.js';
import { agentSessionLaunch, agentSessionUnavailableReason } from './launch-config.js';
import { useAgentSession } from './AgentSessionContext.js';
import './agent-session.css';

/** React Flow drag-handle selector so only an agent window's title bar starts a drag. */
export const AGENT_NODE_DRAG_HANDLE = '.agent-drag-handle';

/** Stable empty configuration used while no agent/launch is resolvable (keeps the hook call unconditional). */
const EMPTY_CONFIGURATION: TerminalNodeConfiguration = {
  executable: '',
  arguments: [],
  cwdRelative: '',
  environmentVariableNames: [],
};

/**
 * The canvas window that hosts a real CLI session for an agent node. It renders the provider-tinted
 * title bar, the embedded terminal (or a start/exit card), the launch safety review, and a bottom
 * strip for choosing the agent, model, permission profile, and context.
 */
export function AgentSessionNode({ id, data }: { id: string; data: WorkshopNodeData }): JSX.Element {
  const {
    project,
    settings,
    runnableAgents,
    graphReadOnly,
    gateFor,
    recheckProvider,
    openSettings,
    reportError,
    updateNodeData,
    recordHistory,
    nodeTitle,
    removeAgentContext,
    requestDeleteNode,
  } = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const surfaceRef = useRef<TerminalSurfaceHandle | null>(null);

  const fallbackAdapter = isRunAdapterId(settings.defaultAgent) ? settings.defaultAgent : 'test-agent';
  const adapter = data.adapterId ?? fallbackAdapter;
  const agent = runnableAgents.find((candidate) => candidate.id === adapter);

  const model = effectiveNodeModel(agent, data.model, settings.agentDefaultModels[adapter]);
  const profile: PermissionProfile = data.permissionProfile ?? 'worktree-write';
  const launch = agent ? agentSessionLaunch(agent, model, profile) : null;

  const controller = useTerminalNodeController({
    projectId: project.id,
    nodeId: id,
    configuration: launch?.configuration ?? EMPTY_CONFIGURATION,
    onError: reportError,
    operations: terminalOperationsFromWindow(),
  });

  const readOnly = graphReadOnly || data.locked || interactions.readOnly;
  const theme = providerTheme(adapter);
  const gate = gateFor(adapter);
  const unavailableReason = agentSessionUnavailableReason(agent);
  const blocked = gate !== null && gate.state !== 'connected';
  const canStart = unavailableReason === null && !blocked;
  const modelSelection = agent?.capabilities?.modelSelection === true;

  const hasActiveSession = controller.session !== null && controller.active;
  const endedSession = controller.session !== null && !controller.active;

  // Restart-to-apply: remember the config key that was live when the session was last (re)launched;
  // when the desired launch config drifts from it while a session is live, prompt to restart.
  // Terminal sessions cannot be reconfigured in place, so this surfaces the mismatch instead of
  // silently ignoring it.
  const launchedKeyRef = useRef<string | null>(null);
  const currentKey =
    launch === null
      ? null
      : `${launch.configuration.executable} ${launch.configuration.arguments.join(' ')}`;
  const configDrifted =
    hasActiveSession && launchedKeyRef.current !== null && launchedKeyRef.current !== currentKey;

  const contextChips = (data.contextAttachmentIds ?? [])
    .map((cid) => ({ cid, title: nodeTitle(cid) }))
    .filter((entry): entry is { cid: string; title: string } => entry.title !== null);

  const lastRunSummary = data.lastRunSummary ?? '';
  const transcript = data.transcript ?? '';

  return (
    <>
      <div className="agent-window-titlebar agent-drag-handle">
        <button
          type="button"
          className="traffic close nodrag"
          aria-label="Delete node"
          onClick={() => {
            if (window.confirm('Delete this agent node?')) requestDeleteNode(id);
          }}
        />
        <button
          type="button"
          className="traffic collapse nodrag"
          aria-label="Collapse node"
          onClick={() => interactions.setCollapsed(id, true)}
        />
        <button
          type="button"
          className="traffic zoom nodrag"
          aria-label="Focus terminal"
          onClick={() => surfaceRef.current?.focus()}
        />
        <input
          className="agent-title-input nodrag"
          aria-label="Node title"
          name={`node-${id}-title`}
          value={data.title}
          disabled={readOnly}
          onFocus={recordHistory}
          onChange={(event) => updateNodeData(id, { title: event.target.value })}
        />
        <span className="agent-provider-label">{theme?.label ?? agent?.label ?? adapter}</span>
        <span
          className={`run-status ${data.status}`}
          role="status"
          aria-label={`Status: ${data.status}`}
        />
      </div>

      {hasActiveSession ? (
        <div className="agent-terminal nowheel nodrag">
          <TerminalSurface
            ref={surfaceRef}
            sessionId={controller.session?.id ?? null}
            output={controller.output}
            inputEnabled={!readOnly}
            onInput={(chunk) => controller.sendInput(chunk)}
            onResize={(columns, rows) => controller.resize(columns, rows)}
          />
        </div>
      ) : endedSession ? (
        <div className="agent-exit-strip">
          <span>Session ended</span>
          <button
            type="button"
            className="button"
            disabled={readOnly}
            onClick={() => void controller.prepareLaunch()}
          >
            Restart
          </button>
        </div>
      ) : (
        <div className="agent-start-card">
          <span className="agent-monogram" aria-hidden="true">
            {theme?.monogram ?? adapter.slice(0, 1).toUpperCase()}
          </span>
          {unavailableReason !== null ? (
            <p className="agent-start-reason">{unavailableReason}</p>
          ) : gate !== null && gate.warning !== null ? (
            <div className="recovery-guidance warning">
              <p>{gate.warning}</p>
              <div className="recovery-guidance-actions">
                <button type="button" className="button" onClick={() => recheckProvider(adapter)}>
                  {gate.actionLabel}
                </button>
                <button type="button" className="button" onClick={() => openSettings()}>
                  Open settings
                </button>
              </div>
            </div>
          ) : null}
          {canStart && (
            <button
              type="button"
              className="button primary"
              disabled={readOnly}
              onClick={() => void controller.prepareLaunch()}
            >
              Start session
            </button>
          )}
        </div>
      )}

      {controller.pendingPlan !== null && (
        <div className="agent-review-overlay nodrag nowheel">
          <TerminalLaunchReviewDialog
            plan={controller.pendingPlan}
            busy={controller.busy === 'confirming'}
            onCancel={() => void controller.cancelLaunch()}
            onContinue={() => {
              launchedKeyRef.current = currentKey;
              void controller.confirmLaunch();
            }}
          />
        </div>
      )}

      {controller.error !== null && <p className="recovery-guidance warning">{controller.error}</p>}
      {controller.notice !== null && <p className="agent-session-notice">{controller.notice}</p>}

      <div className="agent-window-strip nowheel nodrag">
        <select
          className="nodrag"
          aria-label="Agent"
          name={`node-${id}-agent-adapter`}
          value={adapter}
          disabled={readOnly}
          onFocus={recordHistory}
          onChange={(event) => {
            const adapterId = event.target.value;
            const nextAgent = runnableAgents.find((candidate) => candidate.id === adapterId);
            updateNodeData(id, {
              adapterId,
              ...(nextAgent?.capabilities?.modelSelection === true ? {} : { model: undefined }),
            });
          }}
        >
          {runnableAgents.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.label} {candidate.version ? `(${candidate.version})` : ''}
            </option>
          ))}
        </select>
        {modelSelection && (
          <input
            className="nodrag"
            aria-label="Model"
            name={`node-${id}-agent-model`}
            value={data.model ?? ''}
            disabled={readOnly}
            maxLength={200}
            placeholder={settings.agentDefaultModels[adapter] ?? 'Provider default'}
            onFocus={recordHistory}
            onChange={(event) =>
              updateNodeData(id, {
                model: event.target.value.trim() === '' ? undefined : event.target.value,
              })
            }
          />
        )}
        <select
          className="nodrag"
          aria-label="Permission profile"
          name={`node-${id}-permission-profile`}
          value={profile}
          disabled={readOnly}
          onFocus={recordHistory}
          onChange={(event) =>
            updateNodeData(id, { permissionProfile: event.target.value as PermissionProfile })
          }
        >
          {PERMISSION_PROFILE_OPTIONS.map((option) => (
            <option
              key={option.value}
              value={option.value}
              disabled={permissionProfileUnavailableReason(option.value, settings, adapter) !== null}
            >
              {option.label}
            </option>
          ))}
        </select>
        {launch?.profileNote != null && (
          <small className="agent-profile-note">{launch.profileNote}</small>
        )}
        {configDrifted && (
          <button
            type="button"
            className="agent-restart-apply nodrag"
            disabled={readOnly}
            onClick={() => {
              void controller.terminate().then(() => controller.prepareLaunch());
            }}
          >
            Restart to apply
          </button>
        )}
        {data.status !== 'idle' && (
          <span className={`node-status-label ${data.status}`}>{data.status}</span>
        )}
        {lastRunSummary !== '' && <span className="agent-last-run-summary">{lastRunSummary}</span>}
        {transcript !== '' && (
          <details className="agent-last-run">
            <summary>Last run output</summary>
            <pre>{transcript}</pre>
          </details>
        )}
        {contextChips.length > 0 && (
          <div className="agent-context-chips">
            {contextChips.map(({ cid, title }) => (
              <span key={cid} className="agent-context-chip">
                {title}
                <button
                  type="button"
                  aria-label={`Remove ${title}`}
                  disabled={readOnly}
                  onClick={() => removeAgentContext(id, cid)}
                >
                  {'\u00d7'}
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
