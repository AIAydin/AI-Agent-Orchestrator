import type { JSX } from 'react';
import { Plus, Trash2 } from 'lucide-react';

import type { NodeFaceProps } from '../../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';

/** Task face: status, assignee, priority, and done conditions as compact rows. */
export function TaskNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const readOnly = session.graphReadOnly || data.locked || interactions.readOnly;
  const agents = session.nodeRoster.filter((entry) => entry.kind === 'agent');
  const criteria = data.acceptanceCriteria ?? [];

  const update = (patch: Parameters<typeof session.updateNodeData>[1]): void => {
    session.updateNodeData(id, patch);
  };

  return (
    <section className="node-face task-node-face" aria-label="Task">
      <div className="node-face-strip nodrag">
        <span className="node-face-strip-label">Task</span>
        <span className="node-face-status" role="status">
          {data.taskStatus ?? 'backlog'}
        </span>
      </div>
      <fieldset className="node-face-body nowheel nodrag" disabled={readOnly}>
        <div className="task-face-grid">
          <label>
            Status
            <select
              name={`node-${id}-task-face-status`}
              aria-label="Task status"
              value={data.taskStatus ?? 'backlog'}
              disabled={readOnly}
              onFocus={() => session.recordHistory()}
              onChange={(event) =>
                update({ taskStatus: event.target.value as NonNullable<typeof data.taskStatus> })
              }
            >
              <option value="backlog">Backlog</option>
              <option value="ready">Ready</option>
              <option value="in-progress">In progress</option>
              <option value="review">Review</option>
              <option value="done">Done</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </label>
          <label>
            Priority
            <select
              name={`node-${id}-task-face-priority`}
              aria-label="Priority"
              value={data.priority ?? 'normal'}
              disabled={readOnly}
              onFocus={() => session.recordHistory()}
              onChange={(event) =>
                update({ priority: event.target.value as NonNullable<typeof data.priority> })
              }
            >
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </label>
        </div>
        <label>
          Assigned agent
          <select
            name={`node-${id}-task-face-assignee`}
            aria-label="Assigned agent"
            value={data.assigneeId ?? ''}
            disabled={readOnly}
            onFocus={() => session.recordHistory()}
            onChange={(event) => update({ assigneeId: event.target.value })}
          >
            <option value="">Choose an agent…</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.title}
              </option>
            ))}
          </select>
        </label>

        <div className="node-face-list-header">
          <strong>
            Done when <span>{criteria.length}</span>
          </strong>
          <button
            type="button"
            aria-label="Add a done condition"
            disabled={readOnly}
            onClick={() => {
              session.recordHistory();
              update({
                acceptanceCriteria: [
                  ...criteria,
                  { id: crypto.randomUUID(), description: 'New done condition', satisfied: false },
                ],
              });
            }}
          >
            <Plus size={12} aria-hidden="true" /> Add
          </button>
        </div>
        {criteria.map((criterion, index) => (
          <div className="node-face-row" key={criterion.id}>
            <input
              type="checkbox"
              name={`task-face-criterion-satisfied-${criterion.id}`}
              checked={criterion.satisfied}
              aria-label={`Mark ${criterion.description} as done`}
              disabled={readOnly}
              onFocus={() => session.recordHistory()}
              onChange={(event) =>
                update({
                  acceptanceCriteria: criteria.map((candidate, candidateIndex) =>
                    candidateIndex === index
                      ? { ...candidate, satisfied: event.target.checked }
                      : candidate,
                  ),
                })
              }
            />
            <input
              name={`task-face-criterion-description-${criterion.id}`}
              value={criterion.description}
              aria-label={`Done condition ${index + 1}`}
              disabled={readOnly}
              onFocus={() => session.recordHistory()}
              onChange={(event) =>
                update({
                  acceptanceCriteria: criteria.map((candidate, candidateIndex) =>
                    candidateIndex === index
                      ? { ...candidate, description: event.target.value.slice(0, 10_000) }
                      : candidate,
                  ),
                })
              }
            />
            <button
              type="button"
              className="icon-button danger-text"
              aria-label={`Remove ${criterion.description}`}
              disabled={readOnly}
              onClick={() => {
                session.recordHistory();
                update({
                  acceptanceCriteria: criteria.filter(
                    (candidate) => candidate.id !== criterion.id,
                  ),
                });
              }}
            >
              <Trash2 size={12} aria-hidden="true" />
            </button>
          </div>
        ))}
      </fieldset>
    </section>
  );
}
