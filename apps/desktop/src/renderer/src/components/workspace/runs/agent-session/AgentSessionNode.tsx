import { useEffect, useRef, useState, type JSX } from 'react';

import type { PermissionProfile } from '../../../../../../shared/application/contracts.js';
import type { AgentPeersProvisionView } from '../../../../../../shared/agent-peers/index.js';
import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import { isRunAdapterId } from '../../model/helpers.js';
import { providerTheme } from '../../node-registry/provider-themes.js';
import {
  PERMISSION_PROFILE_OPTIONS,
  permissionProfileUnavailableReason,
} from '../../../permissions/permission-profile-ui.js';
import { useCanvasNodeInteractions } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import { TerminalSurface, type TerminalSurfaceHandle } from '../../terminal/TerminalSurface.js';
import type { TerminalNodeConfiguration } from '../../terminal/types.js';
import { terminalOperationsFromWindow } from '../../terminal/types.js';
import { useTerminalNodeController } from '../../terminal/useTerminalNodeController.js';
import { effectiveNodeModel } from '../agent-node/model-selection.js';
import {
  agentSessionLaunch,
  agentSessionUnavailableReason,
  modelFlagSupported,
  type AgentSessionPeerLaunchMaterial,
} from './launch-config.js';
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

/** Shown whenever the hub could not hand back a usable peer channel, whatever the cause. */
const PEER_TOOLS_UNAVAILABLE_HINT = 'Peer tools unavailable.';

/**
 * The canvas window that hosts a real CLI session for an agent node. It renders the provider-tinted
 * title bar, the embedded terminal (or a start/exit card), and a bottom
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
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

  // Peer-tool provisioning (Task 10): a single-use grant fetched fresh on every Start/Restart,
  // never reused across relaunches. `peerMaterial` feeds the launch command; `peerHint` is the
  // terse, separately-tracked display text (kept apart so "never attempted yet" — both null — is
  // distinguishable from "attempted and unavailable" once a fallback hint has been resolved).
  const [peerMaterial, setPeerMaterial] = useState<AgentSessionPeerLaunchMaterial | null>(null);
  const [peerHint, setPeerHint] = useState<string | null>(null);

  const fallbackAdapter = isRunAdapterId(settings.defaultAgent) ? settings.defaultAgent : 'test-agent';
  const adapter = data.adapterId ?? fallbackAdapter;
  const agent = runnableAgents.find((candidate) => candidate.id === adapter);

  const model = effectiveNodeModel(agent, data.model, settings.agentDefaultModels[adapter]);
  const profile: PermissionProfile = data.permissionProfile ?? 'worktree-write';
  const launch = agent ? agentSessionLaunch(agent, model, profile, peerMaterial) : null;

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
  // Only surface the Model field when the agent both advertises model selection AND launch-config
  // maps a model flag for it; otherwise a typed model would be silently dropped from the command.
  const modelSelection =
    agent?.capabilities?.modelSelection === true && modelFlagSupported(adapter);

  const hasActiveSession = controller.session !== null && controller.active;
  const endedSession = controller.session !== null && !controller.active;

  // When a session has ended, the exit code (and any signal) explains why. An empty exit code that
  // still says "Session ended" hides launch failures, so surface whatever the process reported.
  const exitCode = controller.session?.exitCode ?? null;
  const exitSignal = controller.session?.exitSignal ?? null;
  const exitDetail =
    (exitCode !== null ? ` · exit ${String(exitCode)}` : '') +
    (exitSignal !== null ? ` · ${exitSignal}` : '');

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

  // Restart-to-apply relaunch: terminating and re-launching cannot chain with
  // `terminate().then(prepareLaunch)` because prepareLaunch's guard still sees the live session and
  // refuses. Instead, flag the intent, terminate, and let the effect below relaunch once the
  // controller reports no active session.
  const pendingRestartRef = useRef(false);
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const currentKeyRef = useRef(currentKey);
  currentKeyRef.current = currentKey;

  useEffect(() => {
    if (!pendingRestartRef.current || hasActiveSession) return;
    pendingRestartRef.current = false;
    void controllerRef.current.prepareLaunch();
  }, [hasActiveSession]);

  // Peer-tool provisioning (Task 10): fetched fresh on every Start/Restart click, before
  // prepareLaunch, so the launched command carries the hub's extraArguments/peerProvisionId.
  // Calling `controller.prepareLaunch()` synchronously right after `setPeerMaterial` here would
  // still close over the pre-provisioning `configuration` — React state updates are not visible
  // until the next render. So, exactly like the restart-to-apply flag above, this defers to an
  // effect that fires once the render carrying the new peer state (and thus a fresh
  // `controllerRef.current` bound to the updated configuration) has committed.
  // `provisioningRef` guards re-entrancy: a rapid double-click on Start/Restart must not fire a
  // second, overlapping provision call.
  const provisioningRef = useRef(false);
  const pendingStartRef = useRef(false);
  const [provisionAttempt, setProvisionAttempt] = useState(0);

  const startSession = (): void => {
    if (provisioningRef.current) return;
    provisioningRef.current = true;
    void (async () => {
      try {
        let view: AgentPeersProvisionView | null = null;
        try {
          const result = await window.forgeboard.agentPeers.provision({
            projectId: project.id,
            nodeId: id,
            adapterId: adapter,
          });
          view = result.ok ? result.value : null;
        } catch {
          view = null;
        }
        setPeerMaterial(
          view === null
            ? null
            : { provisionId: view.provisionId, extraArguments: view.extraArguments },
        );
        setPeerHint(
          view === null
            ? PEER_TOOLS_UNAVAILABLE_HINT
            : view.available
              ? null
              : (view.hint ?? PEER_TOOLS_UNAVAILABLE_HINT),
        );
        pendingStartRef.current = true;
        // A dedicated counter (rather than depending on peerMaterial/peerHint directly) guarantees
        // the effect below fires even when two consecutive attempts resolve to the same value
        // (e.g. unavailable twice in a row), which React would otherwise treat as no change.
        setProvisionAttempt((count) => count + 1);
      } finally {
        provisioningRef.current = false;
      }
    })();
  };

  useEffect(() => {
    if (!pendingStartRef.current) return;
    pendingStartRef.current = false;
    void controllerRef.current.prepareLaunch();
  }, [provisionAttempt]);

  // Single-use: once the session exits, drop the stashed provision so the next Start/Restart
  // provisions fresh instead of relaunching with a stale provisionId/token.
  useEffect(() => {
    if (!endedSession) return;
    setPeerMaterial(null);
    setPeerHint(null);
  }, [endedSession]);

  // Agent sessions skip the in-app "Terminal safety review" page: one Start click goes straight to
  // the agent. As soon as prepareLaunch resolves with a pending plan, auto-confirm it (capturing the
  // launched config key first, exactly as the removed review dialog did). This also drives the
  // restart-to-apply and exit-strip Restart flows, since both re-enter through prepareLaunch. The
  // guard makes the confirm fire once per plan even under React's double-invoked effects. The
  // main-process native confirmation (if configured) is untouched.
  const autoConfirmedPlanIdRef = useRef<string | null>(null);
  const pendingPlanId = controller.pendingPlan?.planId ?? null;
  useEffect(() => {
    if (pendingPlanId === null || autoConfirmedPlanIdRef.current === pendingPlanId) return;
    autoConfirmedPlanIdRef.current = pendingPlanId;
    launchedKeyRef.current = currentKeyRef.current;
    void controllerRef.current.confirmLaunch();
  }, [pendingPlanId]);

  // A plan can still be pending if the node unmounts between prepare and auto-confirm; cancel it so
  // no reviewed-but-unconfirmed launch is left dangling.
  useEffect(() => () => void controllerRef.current.cancelLaunch().catch(() => undefined), []);

  const requestRestartToApply = (): void => {
    pendingRestartRef.current = true;
    void controller.terminate().catch((cause: unknown) => {
      pendingRestartRef.current = false;
      reportError(cause instanceof Error ? cause.message : 'Could not restart the session.');
    });
  };

  const contextChips = (data.contextAttachmentIds ?? [])
    .map((cid) => ({ cid, title: nodeTitle(cid) }))
    .filter((entry): entry is { cid: string; title: string } => entry.title !== null);

  const lastRunSummary = data.lastRunSummary ?? '';
  const transcript = data.transcript ?? '';

  // The whole title bar is the React Flow drag handle, so the title renders as static, draggable
  // text; double-clicking swaps it for the editable input (autofocus + select-all). Enter/blur
  // commits the edit, Escape cancels, and read-only nodes cannot enter edit mode.
  const beginTitleEdit = (): void => {
    if (readOnly) return;
    setTitleDraft(data.title);
    setEditingTitle(true);
  };
  const commitTitleEdit = (): void => {
    setEditingTitle(false);
    if (titleDraft !== data.title) updateNodeData(id, { title: titleDraft });
  };
  const cancelTitleEdit = (): void => setEditingTitle(false);

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
        {editingTitle ? (
          <input
            className="agent-title-input nodrag"
            aria-label="Node title"
            name={`node-${id}-title`}
            value={titleDraft}
            autoFocus
            onFocus={(event) => {
              recordHistory();
              event.currentTarget.select();
            }}
            onChange={(event) => setTitleDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitTitleEdit();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                cancelTitleEdit();
              }
            }}
            onBlur={commitTitleEdit}
          />
        ) : (
          <strong className="agent-title-text" title={data.title} onDoubleClick={beginTitleEdit}>
            {data.title}
          </strong>
        )}
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
        <>
          {/* Keep the terminal visible after the session dies so its final output (an error, an
              exit message, a login prompt) stays readable, read-only, instead of vanishing. */}
          <div className="agent-terminal nowheel nodrag">
            <TerminalSurface
              ref={surfaceRef}
              sessionId={controller.session?.id ?? null}
              output={controller.output}
              inputEnabled={false}
              onInput={() => undefined}
              onResize={(columns, rows) => controller.resize(columns, rows)}
            />
          </div>
          <div className="agent-exit-strip">
            <span>Session ended{exitDetail}</span>
            <button
              type="button"
              className="button"
              disabled={readOnly}
              onClick={() => startSession()}
            >
              Restart
            </button>
          </div>
        </>
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
              onClick={() => startSession()}
            >
              Start session
            </button>
          )}
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
        {peerHint !== null && <small className="agent-peer-hint">{peerHint}</small>}
        {configDrifted && (
          <button
            type="button"
            className="agent-restart-apply nodrag"
            disabled={readOnly}
            onClick={requestRestartToApply}
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
