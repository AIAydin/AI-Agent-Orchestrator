import { Bot, FastForward, History, Pause, ShieldCheck, Square, Trash2 } from 'lucide-react';

import type {
  AgentDetection,
  AppSettings,
  RunAdapterId,
} from '../../../../../../shared/application/contracts.js';
import type { WorkshopNode } from '../../canvas/CanvasNode.js';
import { ConfiguredPermissionSummary } from '../../../permissions/ConfiguredPermissionSummary.js';
import {
  PERMISSION_PROFILE_OPTIONS,
  permissionProfileNeedsDocker,
  permissionProfileUnavailableReason,
} from '../../../permissions/permission-profile-ui.js';
import { AgentAttemptHistory, type AgentAttemptActionCallbacks } from './AgentAttemptHistory.js';
import { effectiveNodeModel } from './model-selection.js';
import { tokenUsageRows } from './usage/token-usage.js';

import './agent-node.css';

type RunnableAgent = AgentDetection & { id: RunAdapterId };
type PermissionProfile = NonNullable<WorkshopNode['data']['permissionProfile']>;

export interface AgentNodePanelProps extends AgentAttemptActionCallbacks {
  readonly projectId: string;
  readonly selectedNode: WorkshopNode;
  readonly selectedAdapter: RunAdapterId;
  readonly selectedPermission: PermissionProfile;
  readonly runnableAgents: readonly RunnableAgent[];
  readonly settings: AppSettings;
  readonly runInput: string;
  readonly running: boolean;
  readonly preparingRun: boolean;
  readonly configurationReadOnly: boolean;
  readonly onRecord: () => void;
  readonly onUpdateSelected: (data: Partial<WorkshopNode['data']>) => void;
  readonly onRunInputChange: (value: string) => void;
  readonly onSendRunInput: (explicitInput?: string) => void;
  readonly onControlRun: (action: 'interrupt' | 'terminate') => void;
  readonly onPrepareRun: () => void;
}

export function AgentNodePanel(props: AgentNodePanelProps) {
  const {
    selectedNode,
    selectedAdapter,
    selectedPermission,
    runnableAgents,
    settings,
    onUpdateSelected,
  } = props;
  const permissionUnavailable = permissionProfileUnavailableReason(
    selectedPermission,
    settings,
    selectedAdapter,
  );
  const permissionIssueId = `node-${selectedNode.id}-permission-unavailable`;
  const modelHelpId = `node-${selectedNode.id}-model-help`;
  const selectedAgent = runnableAgents.find((agent) => agent.id === selectedAdapter);
  const modelSelectionSupported = selectedAgent?.capabilities?.modelSelection === true;
  const interactiveInputSupported = selectedNode.data.interactiveInputSupported === true;
  const interruptSupported = selectedNode.data.interruptSupported === true;
  const refreshKey = `${selectedNode.data.runId ?? ''}:${selectedNode.data.status ?? ''}:${selectedNode.data.transcriptUpdatedAt ?? ''}`;
  const selectedModel =
    effectiveNodeModel(
      selectedAgent,
      selectedNode.data.model,
      settings.agentDefaultModels[selectedAdapter],
    ) ?? null;
  const historyActionUnavailableReason = props.configurationReadOnly
    ? 'Unlock this node and use an editable collaboration role to start another attempt.'
    : props.running
      ? 'Wait for the active Agent run to finish before starting another attempt.'
      : props.preparingRun
        ? 'Wait for the current launch review to finish.'
        : null;
  const mutationUnavailableReason = props.configurationReadOnly
    ? 'Unlock this node and use an editable collaboration role to control the Agent.'
    : null;
  const liveTokenUsage = tokenUsageRows(selectedNode.data.tokenUsage);

  return (
    <>
      <section className="agent-run-config" aria-label="Agent run settings">
        <header>
          <div>
            <Bot size={14} />
            <h3>Agent run</h3>
          </div>
          <span>Approval required</span>
        </header>
        <label>
          Agent to run
          <select
            name={`node-${selectedNode.id}-agent-adapter`}
            value={selectedAdapter}
            disabled={props.running || props.configurationReadOnly}
            onFocus={props.onRecord}
            onChange={(event) => {
              const adapterId = event.target.value;
              const adapter = runnableAgents.find((agent) => agent.id === adapterId);
              onUpdateSelected({
                adapterId,
                ...(adapter?.capabilities?.modelSelection === true ? {} : { model: undefined }),
              });
            }}
          >
            {runnableAgents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.label} {agent.version ? `(${agent.version})` : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          Model (optional)
          <input
            name={`node-${selectedNode.id}-agent-model`}
            aria-label="Model (optional)"
            value={selectedNode.data.model ?? ''}
            disabled={props.running || props.configurationReadOnly || !modelSelectionSupported}
            aria-describedby={modelHelpId}
            maxLength={200}
            placeholder={
              settings.agentDefaultModels[selectedAdapter] ?? 'Use the provider CLI default'
            }
            onFocus={props.onRecord}
            onChange={(event) =>
              onUpdateSelected({
                model: event.target.value.trim() === '' ? undefined : event.target.value,
              })
            }
          />
          <small id={modelHelpId}>
            {modelSelectionSupported
              ? "Overrides this adapter's Settings default for this Agent node. The exact model argument is shown in launch review; the CLI may reject unsupported models."
              : `${selectedAgent?.label ?? 'This adapter'} does not declare model selection. It uses its own configured default.`}
          </small>
        </label>
        <label>
          Permission profile
          <select
            name={`node-${selectedNode.id}-permission-profile`}
            value={selectedPermission}
            disabled={props.running || props.configurationReadOnly}
            onFocus={props.onRecord}
            onChange={(event) =>
              onUpdateSelected({
                permissionProfile: event.target.value as PermissionProfile,
              })
            }
          >
            {PERMISSION_PROFILE_OPTIONS.map((option) => (
              <option
                key={option.value}
                value={option.value}
                disabled={
                  permissionProfileUnavailableReason(option.value, settings, selectedAdapter) !==
                  null
                }
              >
                {option.label} · {option.description}
              </option>
            ))}
          </select>
        </label>
        <ConfiguredPermissionSummary
          profile={selectedPermission}
          settings={settings}
          adapterId={selectedAdapter}
        />
        {permissionUnavailable !== null ? (
          <p id={permissionIssueId} className="recovery-guidance warning" role="alert">
            {permissionUnavailable} Choose a different agent or permission profile before reviewing
            this run.
          </p>
        ) : null}
        {selectedAdapter === 'custom' &&
        !permissionProfileNeedsDocker(selectedPermission, settings) ? (
          <small>
            A custom agent runs like any program on this computer: Forgeboard shows you exactly what
            it will do but cannot wall it off. A separate worktree protects your main project
            folder; choose Docker for a hard technical boundary.
          </small>
        ) : null}
        <label>
          Prompt
          <textarea
            name={`node-${selectedNode.id}-prompt`}
            rows={6}
            value={selectedNode.data.prompt ?? selectedNode.data.description}
            disabled={props.running || props.configurationReadOnly}
            placeholder="Describe what you want this agent to do…"
            onFocus={props.onRecord}
            onChange={(event) => onUpdateSelected({ prompt: event.target.value })}
          />
        </label>
        {props.running ? (
          <div className="live-run-controls">
            <div>
              <input
                name={`node-${selectedNode.id}-agent-input`}
                value={props.runInput}
                placeholder="Type a message for the running agent"
                aria-label="Message to the running agent"
                disabled={!interactiveInputSupported || props.configurationReadOnly}
                title={
                  mutationUnavailableReason ??
                  (interactiveInputSupported
                    ? undefined
                    : 'This running session does not expose interactive input.')
                }
                onChange={(event) => props.onRunInputChange(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    interactiveInputSupported &&
                    !props.configurationReadOnly
                  ) {
                    props.onSendRunInput();
                  }
                }}
              />
              <button
                type="button"
                disabled={!interactiveInputSupported || props.configurationReadOnly}
                title={
                  mutationUnavailableReason ??
                  (interactiveInputSupported
                    ? undefined
                    : 'This running session does not expose interactive input.')
                }
                onClick={() => props.onSendRunInput()}
              >
                Send
              </button>
            </div>
            <button
              type="button"
              disabled={!interruptSupported || props.configurationReadOnly}
              title={
                mutationUnavailableReason ??
                (interruptSupported
                  ? undefined
                  : 'This running session does not expose graceful interrupt.')
              }
              onClick={() => props.onControlRun('interrupt')}
            >
              <Square size={12} /> Interrupt
            </button>
            <button
              type="button"
              disabled={!interactiveInputSupported || props.configurationReadOnly}
              title={
                mutationUnavailableReason ??
                (interactiveInputSupported
                  ? 'Sends the literal word “continue” as ordinary input. It does not unpause the process.'
                  : 'This running session does not expose interactive input.')
              }
              onClick={() => props.onSendRunInput('continue')}
            >
              <FastForward size={12} /> Send “continue”
            </button>
            <button
              type="button"
              disabled
              title="Adapter API v1 cannot pause and later continue the same local process."
            >
              <Pause size={12} /> Pause unavailable
            </button>
            <button
              type="button"
              className="danger-text"
              onClick={() => props.onControlRun('terminate')}
            >
              <Trash2 size={12} /> Terminate
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="button primary review-run-button"
            disabled={
              props.preparingRun ||
              runnableAgents.length === 0 ||
              permissionUnavailable !== null ||
              props.configurationReadOnly
            }
            title={mutationUnavailableReason ?? permissionUnavailable ?? undefined}
            aria-describedby={permissionUnavailable === null ? undefined : permissionIssueId}
            onClick={props.onPrepareRun}
          >
            <ShieldCheck size={14} />
            {props.preparingRun ? 'Preparing the run…' : 'Review & run'}
          </button>
        )}
        <p>
          Nothing starts from this button alone. Forgeboard first shows the exact command, folder,
          files, and permissions for your approval.
        </p>
        <p className="agent-control-disclosure">
          Pause, input, and resume are different controls. Forgeboard cannot pause an Agent process.
          “Send continue” is literal interactive input. Resume is available only from an interrupted
          attempt with a provider session, and always launches a freshly reviewed continuation.
        </p>
      </section>
      <section
        className="agent-live-output"
        aria-labelledby={`agent-live-output-${selectedNode.id}`}
      >
        <header>
          <History size={13} />
          <h4 id={`agent-live-output-${selectedNode.id}`}>Live output</h4>
        </header>
        {selectedNode.data.transcript ? (
          <pre>{selectedNode.data.transcript}</pre>
        ) : (
          <p>No live output yet. Forgeboard never fabricates agent output.</p>
        )}
        {selectedNode.data.lastRunSummary ? (
          <strong>{selectedNode.data.lastRunSummary}</strong>
        ) : null}
        {selectedNode.data.branch ||
        selectedNode.data.worktreeId ||
        selectedNode.data.tokenUsage ||
        selectedNode.data.cost ? (
          <dl>
            {selectedNode.data.branch ? (
              <div>
                <dt>Branch</dt>
                <dd>{selectedNode.data.branch}</dd>
              </div>
            ) : null}
            {selectedNode.data.worktreeId ? (
              <div>
                <dt>Worktree</dt>
                <dd>Assigned to this run</dd>
              </div>
            ) : null}
            {liveTokenUsage.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
            {selectedNode.data.cost ? (
              <div>
                <dt>Cost</dt>
                <dd>
                  {selectedNode.data.cost.currency} {selectedNode.data.cost.amount.toFixed(4)}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </section>
      <AgentAttemptHistory
        projectId={props.projectId}
        nodeId={selectedNode.id}
        refreshKey={refreshKey}
        agents={runnableAgents}
        selectedAuthority={{
          adapterId: selectedAdapter,
          model: selectedModel,
          permissionProfile: selectedPermission,
        }}
        actionUnavailableReason={historyActionUnavailableReason}
        {...(props.onRetryAttempt === undefined ? {} : { onRetryAttempt: props.onRetryAttempt })}
        {...(props.onResumeAttempt === undefined ? {} : { onResumeAttempt: props.onResumeAttempt })}
        {...(props.onReviewAttempt === undefined ? {} : { onReviewAttempt: props.onReviewAttempt })}
      />
    </>
  );
}
