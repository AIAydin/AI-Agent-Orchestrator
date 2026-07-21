/* eslint-disable @typescript-eslint/unbound-method -- session.reportError/recordHistory are plain
   context functions (not `this`-bound class methods), passed directly as handlers here exactly
   as AgentSessionNode does. */
import { CircleStop, Keyboard, Play, RotateCcw, Settings2, TerminalSquare } from 'lucide-react';
import { useRef, useState, type JSX } from 'react';

import { EnvironmentAllowlistEditor } from '../../configuration/EnvironmentAllowlistEditor.js';
import type { NodeFaceProps } from '../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../runs/agent-session/AgentSessionContext.js';
import { TerminalLaunchReviewDialog } from './TerminalLaunchReviewDialog.js';
import { TerminalSurface, type TerminalSurfaceHandle } from './TerminalSurface.js';
import { terminalCommandConfiguration, terminalNodeConfiguration } from './node-configuration.js';
import { terminalOperationsFromWindow, type TerminalNodeConfiguration } from './types.js';
import { useTerminalNodeController } from './useTerminalNodeController.js';
import './terminal-node.css';

/**
 * Terminal face: the live xterm session fills the node body (mirroring the
 * agent-session embed), a compact strip shows the resolved program plus
 * Start/Interrupt/Terminate, and the executable/arguments/cwd/env are edited in
 * a node-anchored popover. The launch review renders as an in-node overlay.
 */
export function TerminalNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const readOnly = session.graphReadOnly || data.locked || interactions.readOnly;
  const configuration = terminalNodeConfiguration(data, session.settings);
  const surfaceRef = useRef<TerminalSurfaceHandle | null>(null);
  const [configuring, setConfiguring] = useState(false);

  const controller = useTerminalNodeController({
    projectId: session.project.id,
    nodeId: id,
    configuration,
    onError: session.reportError,
    operations: terminalOperationsFromWindow(),
  });

  const program = configuration.executable.split(/[\\/]/u).at(-1) ?? configuration.executable;
  const mutationBusy = controller.busy !== null || controller.pendingPlan !== null;
  const canStart = !readOnly && !controller.active && !mutationBusy;

  const updateConfiguration = (patch: Partial<TerminalNodeConfiguration>): void => {
    session.recordHistory();
    session.updateNodeData(id, {
      command: terminalCommandConfiguration({ ...configuration, ...patch }),
    });
  };

  return (
    <section className="node-face terminal-node-face" aria-label="Terminal">
      <div className="node-face-strip nodrag">
        <span className="node-face-strip-label">
          <TerminalSquare size={12} aria-hidden="true" /> {program === '' ? 'No program' : program}
        </span>
        {controller.active ? (
          <>
            <button
              type="button"
              aria-label="Interrupt"
              disabled={controller.busy !== null}
              onClick={() => void controller.interrupt()}
            >
              <Keyboard size={12} aria-hidden="true" /> Interrupt
            </button>
            <button
              type="button"
              className="danger-text"
              aria-label="Terminate"
              disabled={controller.busy !== null && controller.busy !== 'interrupting'}
              onClick={() => void controller.terminate()}
            >
              <CircleStop size={12} aria-hidden="true" /> Stop
            </button>
          </>
        ) : (
          <button
            type="button"
            aria-label={controller.session === null ? 'Review and start' : 'Review and restart'}
            disabled={!canStart}
            onClick={() => void controller.prepareLaunch()}
          >
            {controller.session === null ? (
              <Play size={12} aria-hidden="true" />
            ) : (
              <RotateCcw size={12} aria-hidden="true" />
            )}
            {controller.session === null ? 'Start' : 'Restart'}
          </button>
        )}
        <button
          type="button"
          aria-label="Configure terminal"
          aria-pressed={configuring}
          disabled={readOnly || controller.active}
          onClick={() => setConfiguring((open) => !open)}
        >
          <Settings2 size={12} aria-hidden="true" /> Configure
        </button>
      </div>

      <div className="node-face-body nowheel nodrag">
        <div className="terminal-face-surface">
          <TerminalSurface
            ref={surfaceRef}
            sessionId={controller.session?.id ?? null}
            output={controller.output}
            inputEnabled={controller.active && !readOnly && controller.busy === null}
            onInput={(chunk) => controller.sendInput(chunk)}
            onResize={(columns, rows) => controller.resize(columns, rows)}
          />
          {controller.session === null ? (
            <p className="node-face-hint">Choose a program, then Start to run it here.</p>
          ) : null}
        </div>
        {controller.error !== null ? (
          <p className="terminal-face-error" role="alert">
            {controller.error}
          </p>
        ) : null}

        {configuring ? (
          <div className="node-face-popover" aria-label="Terminal configuration">
            <label className="node-face-row">
              Program
              <input
                type="text"
                aria-label="Program"
                name={`node-${id}-terminal-face-executable`}
                value={configuration.executable}
                readOnly={readOnly}
                onFocus={session.recordHistory}
                onChange={
                  readOnly ? undefined : (event) => updateConfiguration({ executable: event.target.value })
                }
              />
            </label>
            <label className="node-face-row">
              Folder
              <input
                type="text"
                aria-label="Folder to run in"
                name={`node-${id}-terminal-face-cwd`}
                value={configuration.cwdRelative}
                placeholder="."
                readOnly={readOnly}
                onFocus={session.recordHistory}
                onChange={
                  readOnly
                    ? undefined
                    : (event) => updateConfiguration({ cwdRelative: event.target.value })
                }
              />
            </label>
            <EnvironmentAllowlistEditor
              name={`node-${id}-terminal-face-environment`}
              value={configuration.environmentVariableNames}
              compact
              onChange={
                readOnly
                  ? () => undefined
                  : (environmentVariableNames) =>
                      updateConfiguration({ environmentVariableNames })
              }
            />
          </div>
        ) : null}
      </div>

      {controller.pendingPlan !== null ? (
        <div className="node-face-overlay nodrag" role="dialog" aria-label="Review terminal launch">
          <TerminalLaunchReviewDialog
            plan={controller.pendingPlan}
            busy={controller.busy === 'confirming' || controller.busy === 'cancelling-plan'}
            onCancel={() => void controller.cancelLaunch()}
            onContinue={() => void controller.confirmLaunch()}
          />
        </div>
      ) : null}
    </section>
  );
}
