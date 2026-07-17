import { CheckCircle2, ListChecks, ShieldCheck } from 'lucide-react';

import type { AppSettings } from '../../../../../shared/application/contracts.js';
import type { WorkflowReviewGateView } from '../../../../../shared/workflow/contracts.js';
import type { WorkshopNode } from '../canvas/CanvasNode.js';
import { ConfiguredPermissionSummary } from '../../permissions/ConfiguredPermissionSummary.js';
import { checkProducerId } from './workflow-node-config.js';

interface WorkflowNodeInspectorProps {
  readonly node: WorkshopNode;
  readonly nodes: readonly WorkshopNode[];
  readonly settings: AppSettings;
  readonly reviewGate?: WorkflowReviewGateView;
  readonly onRecord: () => void;
  readonly onUpdate: (data: Partial<WorkshopNode['data']>) => void;
  readonly onError: (message: string) => void;
}

export function WorkflowNodeInspector(props: WorkflowNodeInspectorProps) {
  if (props.node.data.kind === 'task') return <TaskNodeInspector {...props} />;
  if (props.node.data.kind === 'review-gate') return <ReviewGateInspector {...props} />;
  return null;
}

function TaskNodeInspector({
  node,
  nodes,
  settings,
  onRecord,
  onUpdate,
}: WorkflowNodeInspectorProps) {
  const agents = nodes.filter((candidate) => candidate.data.kind === 'agent');
  const assignedAgent = agents.find((candidate) => candidate.id === node.data.assigneeId);
  const criteria = node.data.acceptanceCriteria ?? [];
  const fileNodes = nodes.filter(
    (candidate) => candidate.data.kind === 'file' && candidate.data.file !== undefined,
  );
  const relatedPaths = new Set(
    (node.data.relatedFiles ?? []).map((file) => `${file.projectId}:${file.relativePath}`),
  );
  return (
    <section className="workflow-node-config" aria-label="Task node configuration">
      <header>
        <div>
          <ListChecks size={14} />
          <h3>Executable task</h3>
        </div>
        <span>Agent-backed</span>
      </header>
      <label>
        Agent assignee
        <select
          name={`node-${node.id}-task-assignee`}
          value={node.data.assigneeId ?? ''}
          onFocus={onRecord}
          onChange={(event) => onUpdate({ assigneeId: event.target.value })}
        >
          <option value="">Choose an Agent node…</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.data.title}
            </option>
          ))}
        </select>
      </label>
      {agents.length === 0 && (
        <p className="workflow-config-warning" role="alert">
          Add and configure an Agent node before this Task can run.
        </p>
      )}
      {assignedAgent !== undefined && (
        <div className="workflow-inherited-permission">
          <ConfiguredPermissionSummary
            profile={assignedAgent.data.permissionProfile ?? settings.defaultPermissionProfile}
            settings={settings}
            adapterId={assignedAgent.data.adapterId ?? settings.defaultAgent}
          />
          <p>
            This Task inherits its assignee Agent profile. Change the boundary on{' '}
            <strong>{assignedAgent.data.title}</strong>; the exact effective profile is disclosed
            again before the Task launches.
          </p>
        </div>
      )}
      <div className="workflow-retry-grid">
        <label>
          Priority
          <select
            name={`node-${node.id}-task-priority`}
            value={node.data.priority ?? 'normal'}
            onFocus={onRecord}
            onChange={(event) =>
              onUpdate({ priority: event.target.value as NonNullable<typeof node.data.priority> })
            }
          >
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </label>
        <label>
          Task status
          <select
            name={`node-${node.id}-task-status`}
            value={node.data.taskStatus ?? 'backlog'}
            onFocus={onRecord}
            onChange={(event) =>
              onUpdate({
                taskStatus: event.target.value as NonNullable<typeof node.data.taskStatus>,
              })
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
      </div>
      <label>
        Acceptance criteria · one per line
        <textarea
          name={`node-${node.id}-task-criteria`}
          rows={5}
          value={criteria.map((criterion) => criterion.description).join('\n')}
          placeholder={'Behavior works end to end\nRelevant tests pass'}
          onFocus={onRecord}
          onChange={(event) =>
            onUpdate({ acceptanceCriteria: updatedCriteria(criteria, event.target.value) })
          }
        />
      </label>
      {fileNodes.length > 0 && (
        <fieldset className="workflow-check-producers">
          <legend>Related file metadata</legend>
          {fileNodes.map((fileNode) => {
            const file = fileNode.data.file!;
            const key = `${file.projectId}:${file.relativePath}`;
            return (
              <label key={fileNode.id} className="workflow-toggle">
                <input
                  type="checkbox"
                  name={`node-${node.id}-related-file-${fileNode.id}`}
                  checked={relatedPaths.has(key)}
                  onFocus={onRecord}
                  onChange={(event) => {
                    const next = (node.data.relatedFiles ?? []).filter(
                      (candidate) => `${candidate.projectId}:${candidate.relativePath}` !== key,
                    );
                    onUpdate({ relatedFiles: event.target.checked ? [...next, file] : next });
                  }}
                />
                <span>{file.relativePath}</span>
              </label>
            );
          })}
        </fieldset>
      )}
      <p>
        Related paths are prompt metadata only. Add explicit Context connections when the assigned
        agent should receive file contents; every launch still requires exact disclosure approval.
      </p>
    </section>
  );
}

function ReviewGateInspector({
  node,
  nodes,
  reviewGate,
  onRecord,
  onUpdate,
}: WorkflowNodeInspectorProps) {
  const testNodes = nodes.filter((candidate) => candidate.data.kind === 'test');
  const required = new Set(node.data.requiredCheckIds ?? []);
  const retryPolicy = node.data.retryPolicy ?? { maximumIterations: 3, backoffMs: 0 };
  const selectedTests = testNodes.filter((candidate) => required.has(checkProducerId(candidate)));
  const missingTestEvidence =
    node.data.testsRequired === true &&
    !selectedTests.some((candidate) => (candidate.data.checkKind ?? 'test') === 'test');
  const missingLintEvidence =
    node.data.lintRequired === true &&
    !selectedTests.some((candidate) => candidate.data.checkKind === 'lint');

  const updateGate = (data: Partial<WorkshopNode['data']>): void => onUpdate(data);

  return (
    <section className="workflow-node-config" aria-label="Review gate configuration">
      <header>
        <div>
          <ShieldCheck size={14} />
          <h3>Quality gate</h3>
        </div>
        <span>
          {reviewGate === undefined ? 'Not evaluated' : gateLabelFromView(reviewGate.status)}
        </span>
      </header>
      {reviewGate !== undefined && <ReviewGateEvidence gate={reviewGate} />}
      <label className="workflow-toggle">
        <input
          type="checkbox"
          name={`node-${node.id}-human-approval`}
          checked={node.data.humanApprovalRequired ?? true}
          onFocus={onRecord}
          onChange={(event) => updateGate({ humanApprovalRequired: event.target.checked })}
        />
        <span>
          <strong>Require human approval</strong>
          <small>A deterministic or AI pass cannot bypass this decision.</small>
        </span>
      </label>
      <div className="workflow-gate-requirements">
        <label className="workflow-toggle">
          <input
            type="checkbox"
            name={`node-${node.id}-tests-required`}
            checked={node.data.testsRequired ?? false}
            onFocus={onRecord}
            onChange={(event) => updateGate({ testsRequired: event.target.checked })}
          />
          <span>Tests must pass</span>
        </label>
        <label className="workflow-toggle">
          <input
            type="checkbox"
            name={`node-${node.id}-lint-required`}
            checked={node.data.lintRequired ?? false}
            onFocus={onRecord}
            onChange={(event) => updateGate({ lintRequired: event.target.checked })}
          />
          <span>Lint must pass</span>
        </label>
      </div>
      <fieldset className="workflow-check-producers">
        <legend>
          <ListChecks size={13} /> Required check producers
        </legend>
        {testNodes.length === 0 ? (
          <p>Add a Test node, configure its exact command, then select it here.</p>
        ) : (
          testNodes.map((candidate) => {
            const producerId = checkProducerId(candidate);
            return (
              <label key={candidate.id} className="workflow-toggle">
                <input
                  type="checkbox"
                  name={`node-${node.id}-producer-${candidate.id}`}
                  checked={required.has(producerId)}
                  onFocus={onRecord}
                  onChange={(event) => {
                    const next = new Set(required);
                    if (event.target.checked) next.add(producerId);
                    else next.delete(producerId);
                    updateGate({ requiredCheckIds: [...next].sort() });
                  }}
                />
                <span>
                  <strong>{candidate.data.title}</strong>
                  <small>{candidate.data.checkKind ?? 'test'}</small>
                </span>
              </label>
            );
          })
        )}
      </fieldset>
      {(missingTestEvidence || missingLintEvidence) && (
        <p className="workflow-config-warning" role="alert">
          {missingTestEvidence && missingLintEvidence
            ? 'Select both a test and lint producer before this gate can run.'
            : missingTestEvidence
              ? 'Select a producer whose check kind is Test before this gate can run.'
              : 'Select a producer whose check kind is Lint before this gate can run.'}
        </p>
      )}
      <p className="workflow-config-warning">
        Reviewer-agent gates are not available in this build. Deterministic checks and explicit
        human review remain enforceable.
      </p>
      {typeof node.data.reviewerAgentId === 'string' && node.data.reviewerAgentId.length > 0 && (
        <div className="workflow-config-warning" role="alert">
          <p>
            This imported gate references unavailable reviewer agent{' '}
            <code>{node.data.reviewerAgentId}</code> and cannot advance until it is removed.
          </p>
          <button
            type="button"
            onClick={() => {
              onRecord();
              // Empty optional strings are compacted out by the canonical canvas adapter.
              updateGate({ reviewerAgentId: '' });
            }}
          >
            Remove unavailable reviewer
          </button>
        </div>
      )}
      <div className="workflow-retry-grid">
        <label>
          Maximum iterations
          <input
            type="number"
            name={`node-${node.id}-maximum-iterations`}
            min={1}
            max={100}
            value={retryPolicy.maximumIterations}
            onFocus={onRecord}
            onChange={(event) =>
              updateGate({
                retryPolicy: {
                  ...retryPolicy,
                  maximumIterations: boundedInteger(event.target.value, 1, 100),
                },
              })
            }
          />
        </label>
        <label>
          Retry backoff · ms
          <input
            type="number"
            name={`node-${node.id}-retry-backoff`}
            min={0}
            max={86_400_000}
            value={retryPolicy.backoffMs}
            onFocus={onRecord}
            onChange={(event) =>
              updateGate({
                retryPolicy: {
                  ...retryPolicy,
                  backoffMs: boundedInteger(event.target.value, 0, 86_400_000),
                },
              })
            }
          />
        </label>
      </div>
      <p>
        Failing deterministic checks remain authoritative. A reviewer agent may add structured
        findings, but it cannot turn a failing check green.
      </p>
      <span className="workflow-gate-summary">
        <CheckCircle2 size={13} /> {required.size} required producer{required.size === 1 ? '' : 's'}
      </span>
    </section>
  );
}

function ReviewGateEvidence({ gate }: { readonly gate: WorkflowReviewGateView }) {
  const findings = gate.reviewerAssessment?.findings ?? [];
  const blocking = new Set(gate.blockingFindingIds);
  return (
    <section className="workflow-gate-evidence" aria-label="Authoritative review gate evidence">
      <p>
        Attempt {gate.attempt} · deterministic {gate.deterministicStatus.replaceAll('-', ' ')} ·
        reviewer {gate.reviewerStatus.replaceAll('-', ' ')} · human{' '}
        {gate.humanStatus.replaceAll('-', ' ')}
      </p>
      <ul aria-label="Review gate reasons">
        {gate.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      <div aria-label="Selected check evidence">
        <strong>Selected checks</strong>
        {gate.checks.length === 0 ? (
          <p>No current selected check evidence.</p>
        ) : (
          <ul>
            {gate.checks.map((check) => (
              <li key={check.id}>
                <code>{check.id}</code> · {check.kind} · {check.status}
                {check.exitCode === undefined ? '' : ` · exit ${String(check.exitCode)}`}
              </li>
            ))}
          </ul>
        )}
      </div>
      {gate.reviewerAssessment !== null && (
        <div aria-label="Reviewer assessment">
          <strong>
            Reviewer {gate.reviewerAssessment.reviewerNodeId} · {gate.reviewerAssessment.verdict}
          </strong>
          {gate.reviewerAssessment.summary !== undefined && (
            <p>{gate.reviewerAssessment.summary}</p>
          )}
          {findings.length > 0 && (
            <ul>
              {findings.map((finding) => (
                <li key={finding.id}>
                  {finding.severity} · {finding.message}
                  {blocking.has(finding.id) ? ' · blocking' : ''}
                  {finding.path === undefined ? '' : ` · ${finding.path}`}
                  {finding.line === undefined ? '' : `:${String(finding.line)}`}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function boundedInteger(value: string, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return minimum;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function updatedCriteria(
  previous: NonNullable<WorkshopNode['data']['acceptanceCriteria']>,
  value: string,
): NonNullable<WorkshopNode['data']['acceptanceCriteria']> {
  return value
    .split('\n')
    .map((description) => description.trim())
    .filter(Boolean)
    .map((description, index) => {
      const current = previous[index];
      return current?.description === description
        ? current
        : { id: current?.id ?? crypto.randomUUID(), description, satisfied: false };
    });
}

function gateLabel(state: WorkshopNode['data']['gateState']): string {
  return {
    pending: 'Pending',
    passed: 'Passed',
    failed: 'Failed',
    'waiting-for-human': 'Waiting for human',
  }[state ?? 'pending'];
}

function gateLabelFromView(state: WorkflowReviewGateView['status']): string {
  return gateLabel(state === 'waiting-human' ? 'waiting-for-human' : state);
}
