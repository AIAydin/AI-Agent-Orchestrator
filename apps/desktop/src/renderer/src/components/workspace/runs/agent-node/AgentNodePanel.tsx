import { Bot, FastForward, History, Pause, ShieldCheck, Square, Trash2 } from 'lucide-react';
import { useEffect, useRef } from 'react';

import type {
  AgentDetection,
  AppSettings,
  RunAdapterId,
} from '../../../../../../shared/application/contracts.js';
import type { AgentProviderGate } from '../useAgentProviderGate.js';
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
import { WorkspaceTooltip } from '../../shell/tooltips/WorkspaceTooltip.js';

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
  readonly pendingControlAction?: 'pause' | 'continue' | 'interrupt' | 'terminate' | null;
  readonly configurationReadOnly: boolean;
  readonly providerGate?: AgentProviderGate | null;
  readonly onRecheckProvider?: () => void;
  readonly onOpenSettings?: () => void;
  readonly onRecord: () => void;
  readonly onUpdateSelected: (data: Partial<WorkshopNode['data']>) => void;
  readonly onRunInputChange: (value: string) => void;
  readonly onSendRunInput: (explicitInput?: string) => void;
  readonly onControlRun: (action: 'pause' | 'continue' | 'interrupt' | 'terminate') => void;
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
  const pauseSupported = selectedNode.data.pauseSupported === true;
  const paused = selectedNode.data.status === 'paused';
  const refreshKey = `${selectedNode.data.runId ?? ''}:${selectedNode.data.status ?? ''}:${selectedNode.data.transcriptUpdatedAt ?? ''}`;
  const selectedModel =
    effectiveNodeModel(
      selectedAgent,
      selectedNode.data.model,
      settings.agentDefaultModels[selectedAdapter],
    ) ?? null;
  const selectedPermissionOption = PERMISSION_PROFILE_OPTIONS.find(
    (option) => option.value === selectedPermission,
  );
  const historyActionUnavailableReason = props.configurationReadOnly
    ? 'Unlock this node and get edit access to start another attempt.'
    : props.running
      ? 'Wait for the current run to finish first.'
      : props.preparingRun
        ? 'Wait for the current launch review to finish.'
        : null;
  const mutationUnavailableReason = props.configurationReadOnly
    ? 'Unlock this node and get edit access to control the agent.'
    : null;
  const inputReason =
    mutationUnavailableReason ??
    (interactiveInputSupported
      ? paused
        ? 'Continue this Agent run before sending input.'
        : 'Send input to the running agent.'
      : "This session doesn't accept typed input.");
  const interruptReason =
    mutationUnavailableReason ??
    (interruptSupported
      ? paused
        ? 'Continue this Agent run before interrupting it.'
        : 'Ask the agent to stop gracefully.'
      : "This session doesn't support graceful interrupt.");
  const continueInputReason =
    mutationUnavailableReason ??
    (interactiveInputSupported
      ? "Types the word “continue” as input — it doesn't unpause the process."
      : "This session doesn't accept typed input.");
  const pauseReason =
    mutationUnavailableReason ??
    (pauseSupported
      ? paused
        ? 'Continue the suspended process.'
        : 'Suspend the process without restarting it.'
      : 'Pause is unavailable on this operating system or runtime.');
  const providerGate = props.providerGate ?? null;
  const providerBlockedReason =
    providerGate !== null && providerGate.state !== 'connected' ? providerGate.blockedReason : null;
  const prepareReason =
    mutationUnavailableReason ??
    permissionUnavailable ??
    providerBlockedReason ??
    (props.preparingRun
      ? 'Wait for the current launch review to finish.'
      : 'Review this Agent run before launch.');
  const liveTokenUsage = tokenUsageRows(selectedNode.data.tokenUsage);
  const pendingControlAction = props.pendingControlAction ?? null;
  const controlPending = pendingControlAction !== null;
  const transcript = selectedNode.data.transcript;
  const promptText = selectedNode.data.prompt ?? selectedNode.data.description;
  const transcriptRef = useRef<HTMLPreElement | null>(null);
  const transcriptStickToEndRef = useRef(true);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const threadStickToEndRef = useRef(true);
  const selectedNodeId = selectedNode.id;

  useEffect(() => {
    transcriptStickToEndRef.current = true;
    threadStickToEndRef.current = true;
  }, [selectedNodeId]);

  useEffect(() => {
    const element = transcriptRef.current;
    if (element !== null && transcriptStickToEndRef.current) {
      element.scrollTop = element.scrollHeight;
    }
    const thread = threadRef.current;
    if (thread !== null && threadStickToEndRef.current) {
      thread.scrollTop = thread.scrollHeight;
    }
  }, [selectedNodeId, transcript]);

  return (
    <section className="agent-chat" aria-label="Agent run settings">
      <details className="agent-run-config" open>
        <summary>
          <span className="agent-run-config-heading">
            <Bot size={14} aria-hidden="true" />
            <h3>Agent run</h3>
          </span>
          <span className="agent-run-config-facts">
            {selectedAgent?.label ?? selectedAdapter} · {selectedModel ?? 'Default model'} ·{' '}
            {selectedPermissionOption?.label ?? selectedPermission}
          </span>
          <span className="agent-run-config-badge">Approval required</span>
        </summary>
        <div className="agent-run-config-fields">
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
                ? "Overrides the Settings default for this node. You'll see the exact model in launch review."
                : `${selectedAgent?.label ?? 'This adapter'} doesn't support model selection. It uses its own default.`}
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
          {selectedAdapter === 'custom' &&
          !permissionProfileNeedsDocker(selectedPermission, settings) ? (
            <small>
              A custom agent runs like any program here — Forgeboard shows what it will do but
              can&apos;t wall it off. A worktree protects your main folder; Docker adds a hard
              boundary.
            </small>
          ) : null}
        </div>
      </details>
      <div
        ref={threadRef}
        className="agent-chat-thread"
        role="group"
        aria-label="Run conversation"
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          threadStickToEndRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        }}
      >
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
          {...(props.onResumeAttempt === undefined
            ? {}
            : { onResumeAttempt: props.onResumeAttempt })}
          {...(props.onReviewAttempt === undefined
            ? {}
            : { onReviewAttempt: props.onReviewAttempt })}
        />
        {(props.running || transcript) && promptText.trim() !== '' ? (
          <div className="agent-chat-turn-user">
            <p className="agent-chat-user-bubble">{promptText}</p>
          </div>
        ) : null}
        <section
          className="agent-live-output"
          aria-labelledby={`agent-live-output-${selectedNode.id}`}
        >
          <header>
            <History size={13} aria-hidden="true" />
            <h4 id={`agent-live-output-${selectedNode.id}`}>Live output</h4>
          </header>
          {selectedNode.data.transcript ? (
            <pre
              ref={transcriptRef}
              tabIndex={0}
              onScroll={(event) => {
                const element = event.currentTarget;
                transcriptStickToEndRef.current =
                  element.scrollHeight - element.scrollTop - element.clientHeight < 40;
              }}
            >
              {selectedNode.data.transcript}
            </pre>
          ) : (
            <p>No live output yet.</p>
          )}
          {selectedNode.data.lastRunSummary ? (
            <strong role="status" className="agent-chat-chip">
              {selectedNode.data.lastRunSummary}
            </strong>
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
      </div>
      <div className="agent-chat-composer">
        {permissionUnavailable !== null ? (
          <p id={permissionIssueId} className="recovery-guidance warning" role="alert">
            {permissionUnavailable} Pick a different agent or permission profile first.
          </p>
        ) : null}
        {!props.running && providerGate !== null && providerGate.warning !== null ? (
          <div className="recovery-guidance warning agent-provider-gate" role="status">
            <p>{providerGate.warning}</p>
            <div className="agent-provider-gate-actions">
              <button type="button" disabled={providerGate.busy} onClick={props.onRecheckProvider}>
                {providerGate.busy ? providerGate.busyActionLabel : providerGate.actionLabel}
              </button>
              {props.onOpenSettings !== undefined ? (
                <button type="button" onClick={props.onOpenSettings}>
                  Open settings
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        <label>
          Prompt
          <textarea
            name={`node-${selectedNode.id}-prompt`}
            rows={4}
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
              <WorkspaceTooltip content={inputReason}>
                <input
                  name={`node-${selectedNode.id}-agent-input`}
                  value={props.runInput}
                  placeholder="Type a message for the running agent"
                  aria-label="Message to the running agent"
                  disabled={paused || !interactiveInputSupported || props.configurationReadOnly}
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
              </WorkspaceTooltip>
              <WorkspaceTooltip content={inputReason}>
                <button
                  type="button"
                  aria-label="Send input"
                  disabled={paused || !interactiveInputSupported || props.configurationReadOnly}
                  onClick={() => props.onSendRunInput()}
                >
                  Send
                </button>
              </WorkspaceTooltip>
            </div>
            <WorkspaceTooltip content={interruptReason}>
              <button
                type="button"
                aria-label="Interrupt Agent"
                disabled={
                  paused || !interruptSupported || props.configurationReadOnly || controlPending
                }
                onClick={() => props.onControlRun('interrupt')}
              >
                <Square size={12} aria-hidden="true" />{' '}
                {pendingControlAction === 'interrupt' ? 'Interrupting…' : 'Interrupt'}
              </button>
            </WorkspaceTooltip>
            <WorkspaceTooltip content={continueInputReason}>
              <button
                type="button"
                aria-label="Send continue input"
                disabled={
                  paused ||
                  !interactiveInputSupported ||
                  props.configurationReadOnly ||
                  controlPending
                }
                onClick={() => props.onSendRunInput('continue')}
              >
                <FastForward size={12} aria-hidden="true" /> Send “continue”
              </button>
            </WorkspaceTooltip>
            <WorkspaceTooltip content={pauseReason}>
              <button
                type="button"
                aria-label="Pause or continue Agent process"
                disabled={!pauseSupported || props.configurationReadOnly || controlPending}
                onClick={() => props.onControlRun(paused ? 'continue' : 'pause')}
              >
                {paused ? (
                  <FastForward size={12} aria-hidden="true" />
                ) : (
                  <Pause size={12} aria-hidden="true" />
                )}{' '}
                {pendingControlAction === 'pause'
                  ? 'Pausing process…'
                  : pendingControlAction === 'continue'
                    ? 'Continuing process…'
                    : paused
                      ? 'Continue process'
                      : pauseSupported
                        ? 'Pause process'
                        : 'Pause unavailable'}
              </button>
            </WorkspaceTooltip>
            <button
              type="button"
              className="danger-text"
              disabled={controlPending}
              onClick={() => props.onControlRun('terminate')}
            >
              <Trash2 size={12} aria-hidden="true" />{' '}
              {pendingControlAction === 'terminate' ? 'Terminating…' : 'Terminate'}
            </button>
          </div>
        ) : (
          <div className="agent-composer-actions">
            <WorkspaceTooltip content={prepareReason}>
              <button
                type="button"
                className="button primary review-run-button"
                aria-label="Review and run Agent"
                disabled={
                  props.preparingRun ||
                  runnableAgents.length === 0 ||
                  permissionUnavailable !== null ||
                  providerBlockedReason !== null ||
                  props.configurationReadOnly
                }
                onClick={props.onPrepareRun}
              >
                <ShieldCheck size={14} aria-hidden="true" />
                {props.preparingRun ? 'Preparing the run…' : 'Review & run'}
              </button>
            </WorkspaceTooltip>
          </div>
        )}
        <p>
          Nothing starts yet — you&apos;ll approve the exact command, folder, files, and permissions
          first.
        </p>
        <p className="agent-control-disclosure">
          Pause suspends the whole process tree; unsupported platforms and Docker remain
          unavailable. “Send continue” types the word as input — it doesn&apos;t unpause. Resume
          needs an interrupted attempt with a provider session and always launches a freshly
          reviewed continuation.
        </p>
      </div>
    </section>
  );
}
