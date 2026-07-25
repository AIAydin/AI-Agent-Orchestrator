import { useEffect, useState, type JSX } from 'react';
import { CircleStop, Play, RefreshCw, TestTube2 } from 'lucide-react';

import type { NodeFaceProps } from '../../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';
import { normalizedCommandFor } from '../workflow-node-config.js';
import { useWorkflowRuntime } from '../WorkflowRuntimeContext.js';
import { formatCommandLine, parseCommandLine } from './command-line.js';
import { latestTestAttempt, testStatusLabel, type TestNodeAttemptView } from './view-model.js';

/**
 * Test face: one command line, a short description, and Run with an output
 * preview. Rename the node from its header; connect it to an agent to share
 * the result as context.
 */
export function TestNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const runtime = useWorkflowRuntime();
  const readOnly = session.graphReadOnly || data.locked || interactions.readOnly;
  const current = latestTestAttempt(id, runtime.executions, runtime.interactionEvents);
  const command = normalizedCommandFor(data);
  const commandLine = formatCommandLine(command);
  const [draft, setDraft] = useState(commandLine);
  useEffect(() => setDraft(commandLine), [commandLine]);
  const commandConfigured = command.executable.trim() !== '';
  const operationBusy = runtime.busyAction !== null;
  const canStart =
    !readOnly &&
    !operationBusy &&
    current?.active !== true &&
    commandConfigured &&
    runtime.mutationsAuthorized;

  return (
    <section className="node-face test-node-face" aria-label="Test runner">
      <div className="node-face-strip nodrag">
        <span className="node-face-strip-label">
          <TestTube2 size={12} aria-hidden="true" /> Test
        </span>
        <span
          className={`node-face-status ${current?.status === 'failed' ? 'failed' : ''}`}
          role="status"
        >
          {current === null ? 'Not run' : testStatusLabel(current)}
        </span>
      </div>
      <div className="node-face-body nowheel nodrag">
        <label>
          Command
          <input
            name={`node-${id}-face-command-line`}
            aria-label="Command"
            value={draft}
            placeholder="pnpm test"
            readOnly={readOnly}
            onFocus={() => session.recordHistory()}
            onChange={(event) => {
              setDraft(event.target.value);
              session.updateNodeData(id, {
                command: { ...command, ...parseCommandLine(event.target.value) },
              });
            }}
          />
        </label>
        <label>
          Description
          <input
            name={`node-${id}-face-description`}
            aria-label="Description"
            value={data.description}
            placeholder="What this run checks"
            readOnly={readOnly}
            onFocus={() => session.recordHistory()}
            onChange={(event) =>
              session.updateNodeData(id, { description: event.target.value.slice(0, 1_000) })
            }
          />
        </label>

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
              aria-label="Run"
              disabled={!canStart}
              onClick={() => runtime.startNode(id)}
            >
              {current === null ? (
                <Play size={12} aria-hidden="true" />
              ) : (
                <RefreshCw size={12} aria-hidden="true" />
              )}
              Run
            </button>
          )}
        </div>

        {current?.approvalRequired === true ? (
          <p role="status" className="test-face-warning">
            Waiting for your approval in the Workflows panel.
          </p>
        ) : null}
        {current?.statusReason !== undefined ? (
          <p className="test-face-warning">{current.statusReason}</p>
        ) : null}

        {current !== null ? <AttemptOutput attempt={current} /> : null}
      </div>
    </section>
  );
}

/** Read-only output of the latest attempt. */
function AttemptOutput({ attempt }: { readonly attempt: TestNodeAttemptView }): JSX.Element {
  if (attempt.output === '') {
    return (
      <p className="test-face-empty">
        {attempt.active ? 'Waiting for output…' : "Output isn't available in this session."}
      </p>
    );
  }
  return (
    <>
      <pre className="test-face-output" tabIndex={0} aria-label="Test output">
        {attempt.output}
      </pre>
      {attempt.outputTruncated ? (
        <small>Output was cut off because it reached the size limit.</small>
      ) : null}
    </>
  );
}
