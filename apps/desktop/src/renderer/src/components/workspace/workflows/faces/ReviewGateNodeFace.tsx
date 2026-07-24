import { useState, type JSX } from 'react';
import { Settings2, ShieldCheck } from 'lucide-react';

import type { WorkflowReviewGateView } from '../../../../../../shared/workflow/contracts.js';
import type { NodeFaceProps } from '../../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';
import {
  boundedInteger,
  gateLabel,
  gateLabelFromView,
  reviewerAdapterSupported,
  reviewerOptionLabel,
} from '../workflow-node-config.js';
import { useWorkflowRuntime } from '../WorkflowRuntimeContext.js';

/**
 * Review-gate face: authoritative gate state, required checks, and the pending
 * approval action (opens the existing decision dialog) in the body; reviewer /
 * retry / lint & test policy live in a node-anchored config popover.
 */
export function ReviewGateNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const runtime = useWorkflowRuntime();
  const readOnly = session.graphReadOnly || data.locked || interactions.readOnly;
  const gate = runtime.reviewGateFor(id);
  const decision = runtime.pendingDecisionFor(id);
  const required = new Set(data.requiredCheckIds ?? []);
  const [configuring, setConfiguring] = useState(false);

  const agentEntries = session.nodeRoster.filter((entry) => entry.kind === 'agent');
  const reviewerAgents = agentEntries.filter((entry) =>
    reviewerAdapterSupported(entry.adapterId ?? session.settings.defaultAgent),
  );
  const unsupportedAgents = agentEntries.filter(
    (entry) => !reviewerAdapterSupported(entry.adapterId ?? session.settings.defaultAgent),
  );
  const selectedReviewer = reviewerAgents.find((entry) => entry.id === data.reviewerAgentId);
  const selectedProducers = session.checkProducers.filter((producer) =>
    required.has(producer.producerId),
  );
  const missingTestEvidence =
    data.testsRequired === true &&
    !selectedProducers.some((producer) => producer.checkKind === 'test');
  const missingLintEvidence =
    data.lintRequired === true &&
    !selectedProducers.some((producer) => producer.checkKind === 'lint');
  const retryPolicy = data.retryPolicy ?? { maximumIterations: 3, backoffMs: 0 };

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
        <button
          type="button"
          aria-label="Configure review gate"
          aria-pressed={configuring}
          onClick={() => setConfiguring((open) => !open)}
        >
          <Settings2 size={12} aria-hidden="true" /> Configure
        </button>
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

        {gate !== null ? <ReviewGateEvidence gate={gate} /> : null}

        {decision !== null && runtime.mutationsAuthorized ? (
          <button
            type="button"
            className="review-gate-face-decide"
            onClick={() => runtime.requestDecision(decision)}
          >
            Review and decide
          </button>
        ) : null}

        {configuring ? (
          <fieldset
            className="node-face-popover review-gate-face-config"
            disabled={readOnly}
            aria-label="Review gate configuration"
          >
            <div className="review-gate-face-requirements">
              <label className="node-face-row">
                <input
                  type="checkbox"
                  name={`node-${id}-face-tests-required`}
                  checked={data.testsRequired ?? false}
                  aria-label="Tests must pass"
                  onChange={(event) => update({ testsRequired: event.target.checked })}
                />
                <span>Tests must pass</span>
              </label>
              <label className="node-face-row">
                <input
                  type="checkbox"
                  name={`node-${id}-face-lint-required`}
                  checked={data.lintRequired ?? false}
                  aria-label="Lint must pass"
                  onChange={(event) => update({ lintRequired: event.target.checked })}
                />
                <span>Lint must pass</span>
              </label>
            </div>
            {missingTestEvidence || missingLintEvidence ? (
              <p className="test-face-warning" role="alert">
                {missingTestEvidence && missingLintEvidence
                  ? 'Select both a test check and a lint check before this gate can run.'
                  : missingTestEvidence
                    ? 'Select a check whose kind is Test before this gate can run.'
                    : 'Select a check whose kind is Lint before this gate can run.'}
              </p>
            ) : null}

            <label>
              Reviewer agent (optional)
              <select
                name={`node-${id}-face-reviewer-agent`}
                aria-label="Reviewer agent"
                value={selectedReviewer?.id ?? ''}
                onChange={(event) => update({ reviewerAgentId: event.target.value })}
              >
                <option value="">No AI reviewer</option>
                {reviewerAgents.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {reviewerOptionLabel(
                      entry.title,
                      entry.adapterId ?? session.settings.defaultAgent,
                    )}
                  </option>
                ))}
              </select>
            </label>
            {agentEntries.length === 0 ? (
              <p className="test-face-warning">
                Add and configure an Agent node before enabling an AI reviewer.
              </p>
            ) : null}
            {unsupportedAgents.length > 0 ? (
              <p className="test-face-warning">
                Reviewer mode currently supports Codex and Claude Code. Reconfigure or add a
                supported Agent for {unsupportedAgents.map((entry) => entry.title).join(', ')}.
              </p>
            ) : null}
            {typeof data.reviewerAgentId === 'string' &&
            data.reviewerAgentId.length > 0 &&
            selectedReviewer === undefined ? (
              <div className="test-face-warning" role="alert">
                <p>
                  This imported gate points to reviewer agent <code>{data.reviewerAgentId}</code>,
                  which isn&apos;t available or supported. Remove the requirement so the gate can
                  continue.
                </p>
                <button type="button" onClick={() => update({ reviewerAgentId: '' })}>
                  Remove reviewer requirement
                </button>
              </div>
            ) : null}

            <div className="task-face-grid">
              <label>
                Maximum attempts
                <input
                  type="number"
                  name={`node-${id}-face-maximum-iterations`}
                  min={1}
                  max={100}
                  value={retryPolicy.maximumIterations}
                  onChange={(event) =>
                    update({
                      retryPolicy: {
                        ...retryPolicy,
                        maximumIterations: boundedInteger(event.target.value, 1, 100),
                      },
                    })
                  }
                />
              </label>
              <label>
                Wait between retries · ms
                <input
                  type="number"
                  name={`node-${id}-face-retry-backoff`}
                  min={0}
                  max={86_400_000}
                  value={retryPolicy.backoffMs}
                  onChange={(event) =>
                    update({
                      retryPolicy: {
                        ...retryPolicy,
                        backoffMs: boundedInteger(event.target.value, 0, 86_400_000),
                      },
                    })
                  }
                />
              </label>
            </div>
            <p className="node-face-hint">
              A reviewer agent can add notes, but it can&apos;t make a failed check pass.
            </p>
          </fieldset>
        ) : null}
      </div>
    </section>
  );
}

/** Authoritative, read-only evidence for an evaluated review gate. */
function ReviewGateEvidence({ gate }: { readonly gate: WorkflowReviewGateView }): JSX.Element {
  const findings = gate.reviewerAssessment?.findings ?? [];
  const blocking = new Set(gate.blockingFindingIds);
  return (
    <section className="review-gate-face-evidence" aria-label="Authoritative review gate evidence">
      <p>
        Attempt {gate.attempt} · deterministic {gate.deterministicStatus.replaceAll('-', ' ')} ·
        reviewer {gate.reviewerStatus.replaceAll('-', ' ')} · human{' '}
        {gate.humanStatus.replaceAll('-', ' ')}
      </p>
      <ul className="review-gate-face-reasons" aria-label="Review gate reasons">
        {gate.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      <div aria-label="Selected check evidence">
        <strong>Selected checks</strong>
        {gate.checks.length === 0 ? (
          <p className="node-face-hint">No check evidence yet.</p>
        ) : (
          <ul className="review-gate-face-reasons">
            {gate.checks.map((check) => (
              <li key={check.id}>
                <code>{check.id}</code> · {check.kind} · {check.status}
                {check.exitCode === undefined ? '' : ` · exit ${String(check.exitCode)}`}
              </li>
            ))}
          </ul>
        )}
      </div>
      {gate.reviewerAssessment !== null ? (
        <div aria-label="Reviewer assessment">
          <strong>
            Reviewer {gate.reviewerAssessment.reviewerNodeId} · {gate.reviewerAssessment.verdict}
          </strong>
          {gate.reviewerAssessment.summary !== undefined ? (
            <p>{gate.reviewerAssessment.summary}</p>
          ) : null}
          {findings.length > 0 ? (
            <ul className="review-gate-face-reasons">
              {findings.map((finding) => (
                <li key={finding.id}>
                  {finding.severity} · {finding.message}
                  {blocking.has(finding.id) ? ' · blocking' : ''}
                  {finding.path === undefined ? '' : ` · ${finding.path}`}
                  {finding.line === undefined ? '' : `:${String(finding.line)}`}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
