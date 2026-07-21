import { AlertTriangle, Link2 } from 'lucide-react';

import type { WorkshopNode } from './CanvasNode.js';
import { edgeExplanation } from '../model/helpers.js';
import type { EdgeKind, WorkshopEdge } from '../model/types.js';
import type { WorkshopEdgeData } from '../model/edge-config.js';

/**
 * Shared edge-editing controls used by both the sidebar `TypedEdgeInspector`
 * and the on-canvas `EdgeConfigPopover`. Keeping the field logic here means
 * both surfaces stay identical and edits flow through the same callbacks.
 */

export function EdgeTypeField({
  edge,
  data,
  onUpdateType,
}: {
  edge: WorkshopEdge;
  data: WorkshopEdgeData;
  onUpdateType: (edgeType: EdgeKind) => void;
}) {
  return (
    <>
      <label>
        Connection type
        <select
          name={`edge-${edge.id}-connection-behavior`}
          value={data.edgeType}
          onChange={(event) => onUpdateType(event.target.value as EdgeKind)}
        >
          <option value="context">Context</option>
          <option value="execute">Run</option>
          <option value="output">Output</option>
          <option value="review">Review</option>
          <option value="revision">Revision</option>
          <option value="dependency">Dependency</option>
        </select>
      </label>
      <div className="edge-explanation">
        <strong>{data.edgeType}</strong>
        <p>{edgeExplanation(data.edgeType)}</p>
      </div>
    </>
  );
}

export function EdgeConfiguration({
  data,
  edge,
  nodes,
  onChange,
}: {
  data: WorkshopEdgeData;
  edge: WorkshopEdge;
  nodes: readonly WorkshopNode[];
  onChange: (data: WorkshopEdgeData) => void;
}) {
  if (data.edgeType === 'context') {
    const source = nodes.find((node) => node.id === edge.source);
    return (
      <section className="edge-config-section">
        <h3>Context attachments</h3>
        <div className="edge-context-source">
          <Link2 size={13} />
          <span>{source?.data.title ?? edge.source}</span>
          <code>{edge.source}</code>
        </div>
        <label className="checkbox-label">
          <input
            type="checkbox"
            name={`edge-${edge.id}-context-required`}
            checked={data.config.required}
            onChange={(event) =>
              onChange({
                edgeType: 'context',
                config: { ...data.config, required: event.target.checked },
              })
            }
          />
          Don&apos;t let the agent start until this attachment is ready
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            name={`edge-${edge.id}-context-muted`}
            checked={data.config.muted}
            onChange={(event) =>
              onChange({
                edgeType: 'context',
                config: { ...data.config, muted: event.target.checked },
              })
            }
          />
          Muted
        </label>
        <small>
          {data.config.attachmentIds.length} attachment
          {data.config.attachmentIds.length === 1 ? '' : 's'} will be shared with the agent before
          it starts.
        </small>
      </section>
    );
  }

  if (data.edgeType === 'execute') {
    const gates = nodes.filter((node) => node.data.kind === 'review-gate');
    return (
      <section className="edge-config-section">
        <label>
          When to run
          <select
            name={`edge-${edge.id}-execute-trigger`}
            value={data.config.trigger}
            onChange={(event) =>
              onChange({
                edgeType: 'execute',
                config: {
                  ...data.config,
                  trigger: event.target.value as 'on-success' | 'on-completion',
                },
              })
            }
          >
            <option value="on-success">Only if it succeeds</option>
            <option value="on-completion">After it finishes, even if it fails</option>
          </select>
        </label>
        <label>
          Approval
          <select
            name={`edge-${edge.id}-execute-approval`}
            value={data.config.approval}
            onChange={(event) => {
              const approval = event.target.value as 'none' | 'human' | 'review-gate';
              onChange({
                edgeType: 'execute',
                config: {
                  trigger: data.config.trigger,
                  approval,
                  ...(approval === 'review-gate' && gates[0] !== undefined
                    ? { approvalGateNodeId: data.config.approvalGateNodeId ?? gates[0].id }
                    : {}),
                },
              });
            }}
          >
            <option value="none">No approval</option>
            <option value="human">Human approval</option>
            <option value="review-gate" disabled={gates.length === 0}>
              Review gate
            </option>
          </select>
        </label>
        {data.config.approval === 'review-gate' && (
          <label>
            Review gate node
            <select
              name={`edge-${edge.id}-execute-gate`}
              value={data.config.approvalGateNodeId ?? ''}
              onChange={(event) =>
                onChange({
                  edgeType: 'execute',
                  config: { ...data.config, approvalGateNodeId: event.target.value },
                })
              }
            >
              {gates.map((gate) => (
                <option key={gate.id} value={gate.id}>
                  {gate.data.title}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>
    );
  }

  if (data.edgeType === 'output') {
    return (
      <section className="edge-config-section">
        <label>
          Output to share
          <select
            name={`edge-${edge.id}-output-kind`}
            value={data.config.outputKind}
            onChange={(event) =>
              onChange({
                edgeType: 'output',
                config: {
                  ...data.config,
                  outputKind: event.target.value as typeof data.config.outputKind,
                },
              })
            }
          >
            <option value="branch">Branch</option>
            <option value="diff">Changes (diff)</option>
            <option value="preview">Preview</option>
            <option value="test-result">Test result</option>
            <option value="artifact">File produced by a run</option>
          </select>
        </label>
        <RequiredToggle
          name={`edge-${edge.id}-output-required`}
          checked={data.config.required}
          label="Require verified output before the next step runs"
          onChange={(required) =>
            onChange({ edgeType: 'output', config: { ...data.config, required } })
          }
        />
      </section>
    );
  }

  if (data.edgeType === 'review') {
    return (
      <section className="edge-config-section">
        <label>
          Who reviews
          <select
            name={`edge-${edge.id}-reviewer`}
            value={data.config.reviewer}
            onChange={(event) =>
              onChange({
                edgeType: 'review',
                config: {
                  ...data.config,
                  reviewer: event.target.value as typeof data.config.reviewer,
                },
              })
            }
          >
            <option value="human">Human</option>
            <option value="agent">Agent</option>
            <option value="gate">Review gate</option>
          </select>
        </label>
        <RequiredToggle
          name={`edge-${edge.id}-review-approval-required`}
          checked={data.config.requireApproval}
          label="Require approval"
          onChange={(requireApproval) =>
            onChange({ edgeType: 'review', config: { ...data.config, requireApproval } })
          }
        />
        <RequiredToggle
          name={`edge-${edge.id}-review-structured-findings`}
          checked={data.config.structuredFindings}
          label="Require findings in a fixed format"
          onChange={(structuredFindings) =>
            onChange({ edgeType: 'review', config: { ...data.config, structuredFindings } })
          }
        />
      </section>
    );
  }

  if (data.edgeType === 'revision') {
    return (
      <section className="edge-config-section">
        <label>
          Loop ID
          <input
            name={`edge-${edge.id}-revision-loop-id`}
            value={data.config.loopId ?? ''}
            placeholder="Name this revision loop"
            onChange={(event) => {
              const loopId = event.target.value.replace(/[^A-Za-z0-9._:-]/gu, '').slice(0, 128);
              onChange({
                edgeType: 'revision',
                config: {
                  actionableFeedbackRequired: true,
                  ...(loopId === '' ? {} : { loopId }),
                },
                loop: data.loop,
              });
            }}
          />
        </label>
        <label>
          Maximum attempts
          <input
            type="number"
            name={`edge-${edge.id}-revision-maximum-attempts`}
            min={1}
            max={100}
            value={data.loop.maximumAttempts}
            onChange={(event) =>
              onChange({
                ...data,
                loop: {
                  ...data.loop,
                  maximumAttempts: Math.min(
                    100,
                    Math.max(1, Number.parseInt(event.target.value, 10) || 1),
                  ),
                },
              })
            }
          />
        </label>
        <RequiredToggle
          name={`edge-${edge.id}-revision-stop-review`}
          checked={data.loop.stopConditions.includes('review-approved')}
          label="Stop when review is approved"
          onChange={(checked) =>
            onChange({
              ...data,
              loop: {
                ...data.loop,
                stopConditions: toggleStopCondition(
                  data.loop.stopConditions,
                  'review-approved',
                  checked,
                ),
              },
            })
          }
        />
        <RequiredToggle
          name={`edge-${edge.id}-revision-stop-tests`}
          checked={data.loop.stopConditions.includes('tests-passed')}
          label="Stop when required tests pass"
          onChange={(checked) =>
            onChange({
              ...data,
              loop: {
                ...data.loop,
                stopConditions: toggleStopCondition(
                  data.loop.stopConditions,
                  'tests-passed',
                  checked,
                ),
              },
            })
          }
        />
        <RequiredToggle
          name={`edge-${edge.id}-revision-stop-human`}
          checked={data.loop.stopConditions.includes('human-accepted')}
          label="Also stop when a person accepts the work"
          onChange={(checked) =>
            onChange({
              ...data,
              loop: {
                ...data.loop,
                stopConditions: toggleStopCondition(
                  data.loop.stopConditions,
                  'human-accepted',
                  checked,
                ),
              },
            })
          }
        />
        <label>
          How a person can step in
          <textarea
            name={`edge-${edge.id}-revision-human-escape`}
            rows={3}
            value={data.loop.humanEscapeInstructions}
            onChange={(event) =>
              onChange({
                ...data,
                loop: { ...data.loop, humanEscapeInstructions: event.target.value },
              })
            }
          />
        </label>
        <div className="edge-warning">
          <AlertTriangle size={13} />
          {data.config.loopId === undefined
            ? 'Enter a loop ID before this revision connection can run.'
            : data.loop.humanEscapeInstructions.trim().length < 10
              ? 'Explain how a person can step in (at least 10 characters).'
              : 'Connect the work to its review with a Review connection, then point this Revision connection back to the work. A person must approve before taking over.'}
        </div>
      </section>
    );
  }

  return (
    <section className="edge-config-section">
      <h3>Dependency</h3>
      <p>The next task waits until this one succeeds.</p>
    </section>
  );
}

function toggleStopCondition(
  current: readonly ('review-approved' | 'tests-passed' | 'human-accepted')[],
  condition: 'review-approved' | 'tests-passed' | 'human-accepted',
  enabled: boolean,
): ('review-approved' | 'tests-passed' | 'human-accepted')[] {
  const next = new Set(current);
  if (enabled) next.add(condition);
  else next.delete(condition);
  if (!next.has('review-approved') && !next.has('tests-passed')) next.add('review-approved');
  return ['review-approved', 'tests-passed', 'human-accepted'].filter((candidate) =>
    next.has(candidate as 'review-approved' | 'tests-passed' | 'human-accepted'),
  ) as ('review-approved' | 'tests-passed' | 'human-accepted')[];
}

function RequiredToggle({
  checked,
  label,
  name,
  onChange,
}: {
  checked: boolean;
  label: string;
  name: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="checkbox-label">
      <input
        type="checkbox"
        name={name}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}
