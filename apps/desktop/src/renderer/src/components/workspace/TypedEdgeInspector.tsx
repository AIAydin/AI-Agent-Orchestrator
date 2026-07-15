import { AlertTriangle, Link2 } from 'lucide-react';

import type { WorkshopNode } from '../CanvasNode.js';
import { edgeExplanation } from './helpers.js';
import type { EdgeKind, WorkshopEdge } from './types.js';
import { createEdgeData, type WorkshopEdgeData } from './edge-config.js';

interface TypedEdgeInspectorProps {
  edge: WorkshopEdge;
  nodes: readonly WorkshopNode[];
  onChange: (data: WorkshopEdgeData) => void;
  onUpdateType: (edgeType: EdgeKind) => void;
}

export function TypedEdgeInspector({
  edge,
  nodes,
  onChange,
  onUpdateType,
}: TypedEdgeInspectorProps) {
  const data = edge.data ?? createEdgeData('context', edge.source);
  return (
    <div className="inspector-content">
      <label>
        Connection behavior
        <select
          name={`edge-${edge.id}-connection-behavior`}
          value={data.edgeType}
          onChange={(event) => onUpdateType(event.target.value as EdgeKind)}
        >
          <option value="context">Context</option>
          <option value="execute">Execute</option>
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
      <EdgeConfiguration data={data} edge={edge} nodes={nodes} onChange={onChange} />
    </div>
  );
}

function EdgeConfiguration({
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
        <h3>Explicit context</h3>
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
          Block the agent until this exact attachment resolves
        </label>
        <small>
          {data.config.attachmentIds.length} explicit attachment ID
          {data.config.attachmentIds.length === 1 ? '' : 's'} will be disclosed before launch.
        </small>
      </section>
    );
  }

  if (data.edgeType === 'execute') {
    const gates = nodes.filter((node) => node.data.kind === 'review-gate');
    return (
      <section className="edge-config-section">
        <label>
          Trigger
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
            <option value="on-success">Only after success</option>
            <option value="on-completion">After any completion</option>
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
            <option value="none">No additional approval</option>
            <option value="human">Human approval</option>
            <option value="review-gate" disabled={gates.length === 0}>
              Review gate
            </option>
          </select>
        </label>
        {data.config.approval === 'review-gate' && (
          <label>
            Gate node
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
          Published output
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
            <option value="diff">Diff</option>
            <option value="preview">Preview</option>
            <option value="test-result">Test result</option>
            <option value="artifact">Artifact</option>
          </select>
        </label>
        <RequiredToggle
          name={`edge-${edge.id}-output-required`}
          checked={data.config.required}
          label="Require verified output before downstream execution"
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
          Reviewer authority
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
          label="Require structured findings"
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
          Bounded loop ID
          <input
            name={`edge-${edge.id}-revision-loop-id`}
            value={data.config.loopId ?? ''}
            placeholder="Configure an explicit revision loop"
            onChange={(event) => {
              const loopId = event.target.value.replace(/[^A-Za-z0-9._:-]/gu, '').slice(0, 128);
              onChange({
                edgeType: 'revision',
                config: {
                  actionableFeedbackRequired: true,
                  ...(loopId === '' ? {} : { loopId }),
                },
              });
            }}
          />
        </label>
        <div className="edge-warning">
          <AlertTriangle size={13} />
          Revisions always require actionable feedback and a matching bounded loop with a human
          escape hatch.
        </div>
      </section>
    );
  }

  return (
    <section className="edge-config-section">
      <h3>Dependency</h3>
      <p>The downstream task remains blocked until the source task succeeds.</p>
    </section>
  );
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
