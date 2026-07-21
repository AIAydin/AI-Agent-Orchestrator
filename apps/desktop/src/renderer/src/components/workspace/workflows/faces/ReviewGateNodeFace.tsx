import type { JSX } from 'react';
import { ShieldCheck } from 'lucide-react';

import type { NodeFaceProps } from '../../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';
import { gateLabel, gateLabelFromView } from '../workflow-node-config.js';
import { useWorkflowRuntime } from '../WorkflowRuntimeContext.js';

/**
 * Review-gate face: authoritative gate state, required checks, and the pending
 * approval action (opens the existing decision dialog). Reviewer/retry policy
 * configuration stays in the inspector panel until 2d.
 */
export function ReviewGateNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const runtime = useWorkflowRuntime();
  const readOnly = session.graphReadOnly || data.locked || interactions.readOnly;
  const gate = runtime.reviewGateFor(id);
  const decision = runtime.pendingDecisionFor(id);
  const required = new Set(data.requiredCheckIds ?? []);

  const update = (patch: Parameters<typeof session.updateNodeData>[1]): void => {
    session.recordHistory();
    session.updateNodeData(id, patch);
  };

  return (
    <section className="node-face review-gate-node-face" aria-label="Quality gate">
      <div className="node-face-strip nodrag">
        <span className="node-face-strip-label">
          <ShieldCheck size={12} aria-hidden="true" /> Quality gate
        </span>
        <span className="node-face-status" role="status">
          {gate === null ? gateLabel(data.gateState) : gateLabelFromView(gate.status)}
        </span>
      </div>
      <div className="node-face-body nowheel nodrag">
        <label className="node-face-row review-gate-face-toggle">
          <input
            type="checkbox"
            name={`node-${id}-face-human-approval`}
            checked={data.humanApprovalRequired ?? true}
            disabled={readOnly}
            aria-label="Require human approval"
            onChange={(event) => update({ humanApprovalRequired: event.target.checked })}
          />
          <span>Require human approval</span>
        </label>

        <div className="node-face-list-header">
          <strong>
            Required checks <span>{required.size}</span>
          </strong>
        </div>
        {session.checkProducers.length === 0 ? (
          <p className="node-face-hint">Add a test node to the canvas, then select it here.</p>
        ) : (
          session.checkProducers.map((producer) => (
            <label className="node-face-row" key={producer.nodeId}>
              <input
                type="checkbox"
                name={`node-${id}-face-producer-${producer.nodeId}`}
                checked={required.has(producer.producerId)}
                disabled={readOnly}
                aria-label={`Require ${producer.title}`}
                onChange={(event) => {
                  const next = new Set(required);
                  if (event.target.checked) next.add(producer.producerId);
                  else next.delete(producer.producerId);
                  update({ requiredCheckIds: [...next].sort() });
                }}
              />
              <span className="review-gate-face-producer">
                {producer.title} <small>{producer.checkKind}</small>
              </span>
            </label>
          ))
        )}

        {gate !== null && gate.reasons.length > 0 ? (
          <ul className="review-gate-face-reasons" aria-label="Review gate reasons">
            {gate.reasons.slice(0, 4).map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : null}

        {decision !== null && runtime.mutationsAuthorized ? (
          <button
            type="button"
            className="review-gate-face-decide"
            onClick={() => runtime.requestDecision(decision)}
          >
            Review and decide
          </button>
        ) : null}
      </div>
    </section>
  );
}
