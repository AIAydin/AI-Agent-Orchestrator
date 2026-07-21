import type { JSX } from 'react';
import { CircleStop, ExternalLink, FolderOpen, Play, RefreshCw, TestTube2 } from 'lucide-react';

import type { NodeFaceProps } from '../../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';
import { useWorkflowRuntime } from '../WorkflowRuntimeContext.js';
import type { TestNodeArtifact } from './contracts.js';
import { testNodeAttempts, testStatusLabel } from './view-model.js';

/**
 * Test-runner face: command summary, run status, Start/Cancel, latest-attempt
 * summary, attempt count, and verified artifact actions. Command configuration
 * and full output/history stay in the inspector panel until 2d.
 */
export function TestNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const runtime = useWorkflowRuntime();
  const readOnly = session.graphReadOnly || data.locked || interactions.readOnly;
  const attempts = testNodeAttempts(id, runtime.executions, runtime.interactionEvents);
  const current = attempts[0] ?? null;
  const executable = data.command?.executable ?? '';
  const commandLine = [executable, ...(data.command?.arguments ?? [])].join(' ').trim();
  const commandConfigured = executable.trim() !== '';
  const operationBusy = runtime.busyAction !== null;
  const canStart =
    !readOnly &&
    !operationBusy &&
    current?.active !== true &&
    commandConfigured &&
    runtime.mutationsAuthorized;
  const artifacts = (current?.artifacts ?? []).filter(
    (artifact) => artifact.nodeId === id && artifact.projectId === session.project.id,
  );

  const invokeArtifact = async (
    action: (input: Parameters<typeof runtime.revealArtifact>[0]) => Promise<void>,
    artifact: TestNodeArtifact,
  ): Promise<void> => {
    if (current?.checkExecutionId === undefined) return;
    try {
      await action({
        checkExecutionId: current.checkExecutionId,
        executionId: artifact.executionId,
        nodeId: artifact.nodeId,
        attempt: artifact.attempt,
        relativePath: artifact.relativePath,
        sha256: artifact.sha256,
      });
    } catch (cause) {
      session.reportError(
        cause instanceof Error ? cause.message : 'The test artifact could not be opened.',
      );
    }
  };

  return (
    <section className="node-face test-node-face" aria-label="Test runner">
      <div className="node-face-strip nodrag">
        <span className="node-face-strip-label">
          <TestTube2 size={12} aria-hidden="true" /> Test runner
        </span>
        <span
          className={`node-face-status ${current?.status === 'failed' ? 'failed' : ''}`}
          role="status"
        >
          {current === null ? 'Not run' : testStatusLabel(current)}
        </span>
      </div>
      <div className="node-face-body nowheel nodrag">
        {commandConfigured ? (
          <code className="test-face-command">{commandLine}</code>
        ) : (
          <p role="alert" className="test-face-warning">
            Set up a command in the panel before running this test.
          </p>
        )}

        <div className="node-face-row">
          {current?.active === true ? (
            <button
              type="button"
              aria-label="Cancel"
              disabled={operationBusy || !runtime.mutationsAuthorized}
              onClick={() =>
                runtime.cancelNode({
                  executionId: current.executionId,
                  nodeId: id,
                  attempt: current.attempt,
                })
              }
            >
              <CircleStop size={12} aria-hidden="true" />
              {operationBusy ? 'Cancelling…' : 'Cancel'}
            </button>
          ) : (
            <button
              type="button"
              aria-label="Review and run"
              disabled={!canStart}
              onClick={() => runtime.startNode(id)}
            >
              {current === null ? (
                <Play size={12} aria-hidden="true" />
              ) : (
                <RefreshCw size={12} aria-hidden="true" />
              )}
              Review and run
            </button>
          )}
          <span className="node-face-status">
            {attempts.length} attempt{attempts.length === 1 ? '' : 's'}
          </span>
        </div>

        {current?.summary !== null && current?.summary !== undefined ? (
          <p className="test-face-summary">
            {current.summary.passed} passed · {current.summary.failed} failed ·{' '}
            {current.summary.total} total
          </p>
        ) : null}
        {current?.approvalRequired === true ? (
          <p role="status" className="test-face-warning">
            Waiting for your approval in the Workflows panel.
          </p>
        ) : null}
        {current?.statusReason !== undefined ? (
          <p className="test-face-warning">{current.statusReason}</p>
        ) : null}

        {artifacts.length > 0 && current?.checkExecutionId !== undefined ? (
          <div className="test-face-artifacts" aria-label="Verified test artifacts">
            {artifacts.map((artifact) => (
              <div
                className="node-face-row"
                key={`${artifact.executionId}:${artifact.attempt}:${artifact.relativePath}`}
              >
                <code>{artifact.relativePath}</code>
                <button
                  type="button"
                  aria-label={`Reveal ${artifact.label}`}
                  onClick={() =>
                    void invokeArtifact((input) => runtime.revealArtifact(input), artifact)
                  }
                >
                  <FolderOpen size={11} aria-hidden="true" /> Reveal {artifact.label}
                </button>
                <button
                  type="button"
                  aria-label={`Open ${artifact.label}`}
                  onClick={() =>
                    void invokeArtifact((input) => runtime.openArtifact(input), artifact)
                  }
                >
                  <ExternalLink size={11} aria-hidden="true" /> Open {artifact.label}
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
