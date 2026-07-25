/* eslint-disable @typescript-eslint/unbound-method */
import { useEffect, useRef, useState, type JSX } from 'react';
import { GripHorizontal } from 'lucide-react';

import type { PermissionProfile } from '../../../../../../shared/application/contracts.js';
import type { AgentPeersProvisionView } from '../../../../../../shared/agent-peers/index.js';
import type { TerminalSessionView } from '../../../../../../shared/terminal/index.js';
import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import { unwrap } from '../../../../lib/ipc.js';
import { isRunAdapterId } from '../../model/helpers.js';
import { providerBrandLogo } from '../../node-registry/brand-logos.js';
import { providerTheme } from '../../node-registry/provider-themes.js';
import { ensureUniqueNodeName } from '../../node-registry/node-names.js';
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

/** How long a start may stay silent (no session, no error) before the node offers Retry. */
export const AGENT_LAUNCH_TIMEOUT_MS = 20_000;

/** Peer provisioning is optional — a hung provision IPC must never wedge the whole launch. */
export const AGENT_PEER_PROVISION_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = window.setTimeout(
      () => rejectPromise(new Error('The operation timed out.')),
      timeoutMs,
    );
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolvePromise(value);
      },
      (cause: unknown) => {
        window.clearTimeout(timer);
        rejectPromise(cause instanceof Error ? cause : new Error('The operation failed.'));
      },
    );
  });
}

/** Last path segment for the terse workspace line; the full path stays in the tooltip. */
function directoryLabel(directory: string): string {
  const segments = directory.split(/[\\/]/u).filter((segment) => segment !== '');
  return segments.at(-1) ?? directory;
}

/**
 * The canvas window that hosts a real CLI session for an agent node. It renders the provider-tinted
 * title bar, the embedded terminal (or a start/exit card), and a bottom
 * strip for choosing the agent, model, permission profile, and context.
 */
export function AgentSessionNode({
  id,
  data,
}: {
  id: string;
  data: WorkshopNodeData;
}): JSX.Element {
  const {
    project,
    settings,
    runnableAgents,
    graphReadOnly,
    reportError,
    updateNodeData,
    recordHistory,
    nodeTitle,
    removeAgentContext,
    requestDeleteNode,
    nodeRoster,
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

  const fallbackAdapter = isRunAdapterId(settings.defaultAgent) ? settings.defaultAgent : 'codex';
  const adapter = data.adapterId ?? fallbackAdapter;
  const agent = runnableAgents.find((candidate) => candidate.id === adapter);

  const model = effectiveNodeModel(agent, data.model, settings.agentDefaultModels[adapter]);
  const profile: PermissionProfile = data.permissionProfile ?? 'worktree-write';
  const launch = agent ? agentSessionLaunch(agent, model, profile, peerMaterial) : null;
  const recordedWorkspaceRunRef = useRef<string | null>(null);
  const recordManagedWorkspace = (session: TerminalSessionView | null): void => {
    if (
      session?.workspace?.kind !== 'managed-agent-worktree' ||
      recordedWorkspaceRunRef.current === session.workspace.runId
    ) {
      return;
    }
    recordedWorkspaceRunRef.current = session.workspace.runId;
    updateNodeData(id, {
      runId: session.workspace.runId,
      branch: session.workspace.branch,
      worktreeId: undefined,
      worktreeRecordedActive: true,
      lastRunPermissionProfile: 'worktree-write',
    });
  };

  const controller = useTerminalNodeController({
    projectId: project.id,
    nodeId: id,
    configuration: launch?.configuration ?? EMPTY_CONFIGURATION,
    onError: reportError,
    onSessionChange: recordManagedWorkspace,
    operations: terminalOperationsFromWindow(),
  });

  const readOnly = graphReadOnly || data.locked || interactions.readOnly;
  const theme = providerTheme(adapter);
  const Logo = providerBrandLogo(adapter);
  const unavailableReason = agentSessionUnavailableReason(agent);
  const canStart = unavailableReason === null;

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
    // Re-provision fresh rather than calling `prepareLaunch` directly here: `prepareLaunch` would
    // still carry whatever `peerMaterial` is stashed from the just-terminated session — its
    // already-consumed provisionId/token — which violates the single-use provision contract.
    // Routing through `provisionAndRelaunch` (declared below, alongside Start's identical needs)
    // gets the relaunched session its own fresh grant, exactly like Start and exit-strip Restart
    // already do.
    provisionAndRelaunch();
  }, [hasActiveSession]);

  // Peer-tool provisioning (Task 10): a fresh, single-use grant is fetched before every relaunch —
  // Start, exit-strip Restart, AND the config-drift relaunch effect above all funnel through
  // `provisionAndRelaunch`, so every newly launched session gets its OWN provisionId, never one a
  // previously-terminated session already consumed. Calling `controller.prepareLaunch()`
  // synchronously right after `setPeerMaterial` here would still close over the pre-provisioning
  // `configuration` — React state updates are not visible until the next render. So, exactly like
  // the restart-to-apply flag above, this defers to an effect that fires once the render carrying
  // the new peer state (and thus a fresh `controllerRef.current` bound to the updated configuration)
  // has committed. `provisioningRef` guards re-entrancy: a rapid double-click on Start/Restart must
  // not fire a second, overlapping provision call.
  const provisioningRef = useRef(false);
  const pendingStartRef = useRef(false);
  const [provisionAttempt, setProvisionAttempt] = useState(0);

  // Launch watchdog: counts every start attempt; if none of session/exit/error shows up within
  // the timeout, the node flips to a terse "Start timed out." + Retry instead of endless Starting.
  const [launchAttempt, setLaunchAttempt] = useState(0);
  const [launchStalled, setLaunchStalled] = useState(false);

  const provisionAndRelaunch = (): void => {
    if (provisioningRef.current) return;
    provisioningRef.current = true;
    setLaunchStalled(false);
    setLaunchAttempt((count) => count + 1);
    void (async () => {
      try {
        let view: AgentPeersProvisionView | null = null;
        try {
          // Bounded: peer tools are a bonus, so a provision IPC that never settles falls back
          // to "unavailable" and the CLI still launches (it also keeps `provisioningRef` from
          // wedging permanently true, which would silently swallow every later Retry).
          const result = await withTimeout(
            window.forgeboard.agentPeers.provision({
              projectId: project.id,
              nodeId: id,
              adapterId: adapter,
            }),
            AGENT_PEER_PROVISION_TIMEOUT_MS,
          );
          view = result.ok ? result.value : null;
        } catch {
          view = null;
        }
        setPeerMaterial(
          view === null
            ? null
            : {
                provisionId: view.provisionId,
                extraArguments: view.extraArguments,
              },
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

  const startSession = (): void => provisionAndRelaunch();

  // Zero-click sessions: an agent node IS its CLI. Once the initial session listing settles,
  // a node without a live session launches one — creation and workspace reopen alike, even
  // over a persisted ended session. At most once per mount (the ref survives StrictMode's
  // re-run), so a session that dies rests on the exit strip instead of crash-looping.
  const autoLaunchedRef = useRef(false);
  useEffect(() => {
    if (!controller.loaded || autoLaunchedRef.current) return;
    autoLaunchedRef.current = true;
    if (readOnly || !canStart || controller.active || controller.error !== null) return;
    startSession();
  });

  useEffect(() => {
    if (!pendingStartRef.current) return;
    pendingStartRef.current = false;
    void controllerRef.current.prepareLaunch();
  }, [provisionAttempt]);

  // The watchdog re-arms per attempt and stands down as soon as the launch lands anywhere
  // observable (live session, exit strip, or an error that already offers Retry). It exists
  // because several silent dead-ends are reachable — a plan cancelled between prepare and
  // auto-confirm, a prepare abandoned by a generation bump — and every one of them used to
  // leave the node on "Starting…" forever.
  useEffect(() => {
    if (launchAttempt === 0 || hasActiveSession || endedSession || controller.error !== null) {
      setLaunchStalled(false);
      return;
    }
    const timer = window.setTimeout(() => setLaunchStalled(true), AGENT_LAUNCH_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [launchAttempt, hasActiveSession, endedSession, controller.error]);

  // Single-use: once the session exits, drop the stashed provision so the next Start/Restart
  // provisions fresh instead of relaunching with a stale provisionId/token.
  useEffect(() => {
    if (!endedSession) return;
    setPeerMaterial(null);
    setPeerHint(null);
  }, [endedSession]);

  // Agent sessions skip the in-app "Terminal safety review" page: one Start click goes straight to
  // main-process authorization. Built-in worktree sessions are reconstructed and launched
  // automatically there; unsupported/custom paths may still require native confirmation. Capturing
  // the launched config key first also drives restart-to-apply and exit-strip Restart. The guard
  // makes confirm fire once per plan even under React's double-invoked effects.
  const autoConfirmedPlanIdRef = useRef<string | null>(null);
  const pendingPlanId = controller.pendingPlan?.planId ?? null;
  useEffect(() => {
    if (pendingPlanId === null || autoConfirmedPlanIdRef.current === pendingPlanId) return;
    autoConfirmedPlanIdRef.current = pendingPlanId;
    launchedKeyRef.current = currentKeyRef.current;
    void controllerRef.current.confirmLaunch();
  }, [pendingPlanId]);

  // A plan can still be pending if the node unmounts between prepare and auto-confirm; cancel it so
  // no prepared-but-unconfirmed launch is left dangling.
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

  // Terse workspace line: which branch + directory the live session actually runs in.
  const sessionWorkspace = controller.session?.workspace;
  const workspaceBranch =
    sessionWorkspace?.kind === 'managed-agent-worktree' ? sessionWorkspace.branch : null;
  const workspaceDirectory = sessionWorkspace?.directory ?? null;

  // PR action: one terse confirmation, then main commits (if needed), pushes, and runs
  // `gh pr create --fill` in the session's worktree or the project directory.
  const [prBusy, setPrBusy] = useState(false);
  const [prNote, setPrNote] = useState<{ readonly text: string; readonly failed: boolean } | null>(
    null,
  );
  const canOpenPr = data.runId !== undefined || profile === 'project-write';
  const openPullRequest = (): void => {
    if (prBusy) return;
    if (!window.confirm('Commit, push, and open a pull request for this session?')) return;
    setPrBusy(true);
    setPrNote(null);
    void (async () => {
      try {
        const view = unwrap(
          await window.forgeboard.agentPr.create({
            projectId: project.id,
            nodeId: id,
            ...(data.runId === undefined ? {} : { runId: data.runId }),
          }),
        );
        setPrNote({
          text: view.url ?? `Pull request opened from ${view.branch}.`,
          failed: false,
        });
      } catch (cause) {
        setPrNote({
          text: cause instanceof Error ? cause.message : 'Could not create the pull request.',
          failed: true,
        });
      } finally {
        setPrBusy(false);
      }
    })();
  };

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
    const titlesInUse = new Set(
      nodeRoster.filter((entry) => entry.id !== id).map((entry) => entry.title),
    );
    const nextTitle = ensureUniqueNodeName(titleDraft, titlesInUse);
    if (nextTitle !== data.title) updateNodeData(id, { title: nextTitle });
  };
  const cancelTitleEdit = (): void => setEditingTitle(false);

  return (
    <>
      <div
        className="agent-window-titlebar agent-drag-handle"
        role="group"
        aria-label={`Move ${data.title} agent node`}
      >
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
        <GripHorizontal className="agent-drag-grip" size={15} aria-hidden="true" />
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
        {Logo !== null && (
          <span className="agent-title-logo" style={{ color: theme?.accent }} aria-hidden="true">
            <Logo size={14} />
          </span>
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
            {Logo === null ? adapter.slice(0, 1).toUpperCase() : <Logo size={22} />}
          </span>
          {unavailableReason !== null ? (
            <p className="agent-start-reason">{unavailableReason}</p>
          ) : controller.error !== null || launchStalled ? (
            <>
              {controller.error === null && launchStalled && (
                <p className="agent-start-reason">Start timed out.</p>
              )}
              <button
                type="button"
                className="button primary"
                disabled={readOnly}
                onClick={() => startSession()}
              >
                Retry
              </button>
            </>
          ) : readOnly ? null : (
            <p className="agent-start-reason">Starting…</p>
          )}
        </div>
      )}

      {controller.error !== null && <p className="recovery-guidance warning">{controller.error}</p>}
      {controller.notice !== null && <p className="agent-session-notice">{controller.notice}</p>}

      <div className="agent-window-strip nowheel nodrag">
        <label className="agent-window-field">
          <span>Access</span>
          <select
            className="nodrag"
            aria-label="Permission profile"
            name={`node-${id}-permission-profile`}
            value={profile}
            disabled={readOnly}
            onFocus={recordHistory}
            onChange={(event) =>
              updateNodeData(id, {
                permissionProfile: event.target.value as PermissionProfile,
              })
            }
          >
            {PERMISSION_PROFILE_OPTIONS.map((option) => (
              <option
                key={option.value}
                value={option.value}
                disabled={permissionProfileUnavailableReason(option.value, settings) !== null}
              >
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {canOpenPr && (
          <button
            type="button"
            className="agent-pr-button nodrag"
            disabled={readOnly || prBusy}
            title="Commit, push, and open a pull request"
            onClick={openPullRequest}
          >
            {prBusy ? 'PR…' : 'PR'}
          </button>
        )}
        {(workspaceBranch !== null || workspaceDirectory !== null) && (
          <span
            className="agent-workspace-line"
            title={workspaceDirectory ?? undefined}
            aria-label="Session workspace"
          >
            {[workspaceBranch, workspaceDirectory === null ? null : directoryLabel(workspaceDirectory)]
              .filter((part): part is string => part !== null)
              .join(' · ')}
          </span>
        )}
        {prNote !== null && (
          <small className={`agent-pr-note${prNote.failed ? ' warning' : ''}`} role="status">
            {prNote.text}
          </small>
        )}
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
