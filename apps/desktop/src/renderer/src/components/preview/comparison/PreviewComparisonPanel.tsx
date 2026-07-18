import { Columns2, Play, RefreshCw, Square } from 'lucide-react';
import { useState } from 'react';

import type { PreviewTargetView } from '../../../../../shared/preview/targets.js';
import { PREVIEW_DEVICE_PRESETS, type PreviewPresetId } from '../devices/presets.js';
import { ComparisonSurface } from './ComparisonSurface.js';
import type { AgentPreviewTarget, ComparisonSide, PreviewComparisonPanelProps } from './types.js';
import { useComparisonSessions } from './useComparisonSessions.js';
import './preview-comparison.css';

export function PreviewComparisonPanel(props: PreviewComparisonPanelProps) {
  const { configuration, targets, readOnly } = props;
  const [surfaceOpen, setSurfaceOpen] = useState(false);
  const controller = useComparisonSessions({
    ...props,
    leftTarget: configuration.leftTarget,
    rightTarget: configuration.rightTarget,
  });
  const agentTargets = targets.filter(isAgentTarget);
  const left = targetView(agentTargets, configuration.leftTarget);
  const right = targetView(agentTargets, configuration.rightTarget);
  const duplicate =
    configuration.leftTarget !== undefined &&
    configuration.leftTarget.runId === configuration.rightTarget?.runId;
  const bothReady =
    controller.sessions.left?.status === 'ready' && controller.sessions.right?.status === 'ready';

  function configure(side: ComparisonSide, patch: Partial<SideConfiguration>) {
    props.onConfiguration({
      ...configuration,
      ...(side === 'left'
        ? {
            ...(patch.target === undefined ? {} : { leftTarget: patch.target }),
            leftPreset: patch.preset ?? configuration.leftPreset,
          }
        : {
            ...(patch.target === undefined ? {} : { rightTarget: patch.target }),
            rightPreset: patch.preset ?? configuration.rightPreset,
          }),
    });
  }

  return (
    <section className="preview-comparison-panel" aria-label="Agent worktree comparison">
      <header>
        <div>
          <Columns2 size={14} />
          <h3>Compare agent worktrees</h3>
        </div>
        <span>Two real local servers</span>
      </header>
      <p>
        Choose two agent runs to compare their implementations. Forgeboard resolves each opaque run
        to its main-owned worktree and asks for native approval before launching either server.
      </p>
      <div className="preview-comparison-configurations">
        <SideConfiguration
          side="left"
          target={configuration.leftTarget}
          targetView={left}
          targets={agentTargets}
          excludedRunId={configuration.rightTarget?.runId}
          preset={configuration.leftPreset}
          sessionStatus={controller.sessions.left?.status ?? 'idle'}
          busy={controller.busy !== null}
          readOnly={readOnly}
          launchConfigured={props.launchConfigured}
          invalidConfiguration={duplicate}
          onTarget={(target) => configure('left', { target })}
          onPreset={(preset) => configure('left', { preset })}
          onLaunch={() =>
            !duplicate &&
            configuration.leftTarget &&
            void controller.launch(
              'left',
              configuration.leftTarget,
              isRunning(controller.sessions.left?.status),
            )
          }
          onStop={() => void controller.stop('left')}
        />
        <SideConfiguration
          side="right"
          target={configuration.rightTarget}
          targetView={right}
          targets={agentTargets}
          excludedRunId={configuration.leftTarget?.runId}
          preset={configuration.rightPreset}
          sessionStatus={controller.sessions.right?.status ?? 'idle'}
          busy={controller.busy !== null}
          readOnly={readOnly}
          launchConfigured={props.launchConfigured}
          invalidConfiguration={duplicate}
          onTarget={(target) => configure('right', { target })}
          onPreset={(preset) => configure('right', { preset })}
          onLaunch={() =>
            !duplicate &&
            configuration.rightTarget &&
            void controller.launch(
              'right',
              configuration.rightTarget,
              isRunning(controller.sessions.right?.status),
            )
          }
          onStop={() => void controller.stop('right')}
        />
      </div>
      {agentTargets.length < 2 ? (
        <p className="preview-target-recovery" role="status">
          Two agent worktrees are required. Run two agents for this project, then reopen this node.
        </p>
      ) : null}
      {duplicate ? (
        <p className="preview-failure" role="alert">
          Choose two different agent runs; Forgeboard will never show one server twice as a
          comparison.
        </p>
      ) : null}
      <button
        type="button"
        className="button primary preview-comparison-open"
        disabled={!bothReady || duplicate || !props.operations}
        onClick={() => setSurfaceOpen(true)}
      >
        <Columns2 size={13} /> Open side-by-side comparison
      </button>
      {surfaceOpen && bothReady && left && right && props.operations ? (
        <ComparisonSurface
          projectId={props.projectId}
          nodeId={props.nodeId}
          leftLabel={left.label}
          rightLabel={right.label}
          leftSession={controller.sessions.left!}
          rightSession={controller.sessions.right!}
          leftPreset={configuration.leftPreset}
          rightPreset={configuration.rightPreset}
          operations={props.operations}
          readOnly={readOnly}
          onClose={() => setSurfaceOpen(false)}
        />
      ) : null}
    </section>
  );
}

interface SideConfiguration {
  target?: AgentPreviewTarget;
  preset: PreviewPresetId;
}

interface SideConfigurationProps {
  side: ComparisonSide;
  target?: AgentPreviewTarget | undefined;
  targetView?: PreviewTargetView | undefined;
  targets: readonly PreviewTargetView[];
  excludedRunId?: string | undefined;
  preset: PreviewPresetId;
  sessionStatus: string;
  busy: boolean;
  readOnly: boolean;
  launchConfigured: boolean;
  invalidConfiguration: boolean;
  onTarget: (target: AgentPreviewTarget) => void;
  onPreset: (preset: PreviewPresetId) => void;
  onLaunch: () => void;
  onStop: () => void;
}

function SideConfiguration(props: SideConfigurationProps) {
  const running = isRunning(props.sessionStatus);
  const unavailable = props.target !== undefined && props.targetView?.available !== true;
  const label = props.side === 'left' ? 'Left' : 'Right';
  return (
    <fieldset>
      <legend>{label} implementation</legend>
      <label>
        Agent worktree
        <select
          name={`preview-comparison-${props.side}-target`}
          aria-label={`${label} agent worktree`}
          value={props.target?.runId ?? ''}
          disabled={props.readOnly || props.busy}
          onChange={(event) => {
            const candidate = props.targets.find(
              (view) =>
                view.target.kind === 'agent-run' && view.target.runId === event.target.value,
            );
            if (candidate?.target.kind === 'agent-run') props.onTarget(candidate.target);
          }}
        >
          <option value="">Choose an agent run</option>
          {props.target && !props.targetView ? (
            <option value={props.target.runId}>Saved agent worktree · unavailable</option>
          ) : null}
          {props.targets.map((view) => {
            if (view.target.kind !== 'agent-run') return null;
            return (
              <option
                key={view.target.runId}
                value={view.target.runId}
                disabled={!view.available || view.target.runId === props.excludedRunId}
              >
                {view.label}
                {view.available ? '' : ' · unavailable'}
              </option>
            );
          })}
        </select>
      </label>
      <label>
        Device
        <select
          name={`preview-comparison-${props.side}-device`}
          aria-label={`${label} comparison device`}
          value={props.preset}
          disabled={props.readOnly || props.busy}
          onChange={(event) => props.onPreset(event.target.value as PreviewPresetId)}
        >
          {Object.entries(PREVIEW_DEVICE_PRESETS).map(([id, preset]) => (
            <option key={id} value={id}>
              {preset.label} · {preset.width} × {preset.height}
            </option>
          ))}
        </select>
      </label>
      <div className="preview-comparison-side-status">
        <span>{props.sessionStatus}</span>
        {running ? (
          <>
            <button
              type="button"
              onClick={props.onLaunch}
              disabled={props.busy || props.readOnly || props.invalidConfiguration}
            >
              <RefreshCw size={12} /> Restart
            </button>
            <button type="button" onClick={props.onStop} disabled={props.busy}>
              <Square size={12} /> Stop
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={props.onLaunch}
            disabled={
              props.busy ||
              props.readOnly ||
              !props.target ||
              unavailable ||
              props.invalidConfiguration ||
              !props.launchConfigured
            }
          >
            <Play size={12} /> Start
          </button>
        )}
      </div>
      {unavailable ? (
        <p className="preview-target-recovery" role="status">
          {props.targetView?.unavailableReason ??
            'This saved worktree is no longer available. Choose another agent run.'}
        </p>
      ) : null}
    </fieldset>
  );
}

function isAgentTarget(
  view: PreviewTargetView,
): view is PreviewTargetView & { target: AgentPreviewTarget } {
  return view.target.kind === 'agent-run';
}

function targetView(
  targets: readonly PreviewTargetView[],
  target: AgentPreviewTarget | undefined,
): PreviewTargetView | undefined {
  return target
    ? targets.find((view) => view.target.kind === 'agent-run' && view.target.runId === target.runId)
    : undefined;
}

function isRunning(status: string | undefined): boolean {
  return status !== undefined && ['starting', 'ready', 'stopping'].includes(status);
}
