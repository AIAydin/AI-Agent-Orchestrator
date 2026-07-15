import {
  AlertTriangle,
  CheckCircle2,
  GitCompareArrows,
  Play,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { RunDisclosureSchema } from '../../../../../shared/application/contracts.js';
import type {
  WorkflowApprovalRequest,
  WorkflowHumanDecisionRequest,
  WorkflowRevisionEscapeRequest,
} from '../../../../../shared/workflow/contracts.js';
import type { WorkflowDecisionTarget } from './workflow-ui-types.js';
import { RunDisclosureDetails, RunDisclosureWarnings } from '../runs/RunDisclosureDetails.js';

interface WorkflowDecisionDialogProps {
  target: WorkflowDecisionTarget;
  busy: boolean;
  onClose: () => void;
  onApproveLaunch: (request: WorkflowApprovalRequest) => void;
  onApproveHuman: (request: WorkflowHumanDecisionRequest) => void;
  onDecideReview: (
    request: WorkflowHumanDecisionRequest,
    decision: 'approved' | 'changes-requested',
    feedback?: string,
  ) => void;
  onResolveRevision: (
    request: WorkflowRevisionEscapeRequest,
    decision: 'accept' | 'cancel',
  ) => void;
  onReviewChanges: (runId: string) => void;
}

export function WorkflowDecisionDialog(props: WorkflowDecisionDialogProps) {
  const dialog = useRef<HTMLElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(props.busy);
  const closeRef = useRef(props.onClose);
  busyRef.current = props.busy;
  closeRef.current = props.onClose;

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelButton.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (busyRef.current) return;
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      trapFocus(event, dialog.current);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, []);

  const descriptor = decisionDescriptor(props.target);
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        ref={dialog}
        className="modal workflow-decision-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workflow-decision-title"
        aria-describedby="workflow-decision-description workflow-decision-warning"
        aria-busy={props.busy}
        tabIndex={-1}
      >
        <header>
          <span className="modal-title-icon">
            {props.target.kind === 'revision' ? (
              <RotateCcw size={19} aria-hidden="true" />
            ) : (
              <ShieldCheck size={19} aria-hidden="true" />
            )}
          </span>
          <div>
            <span className="eyebrow">{descriptor.eyebrow}</span>
            <h2 id="workflow-decision-title">{descriptor.title}</h2>
            <p id="workflow-decision-description">{descriptor.description}</p>
          </div>
        </header>
        <p id="workflow-decision-warning" className="workflow-decision-warning">
          This decision is bound to the current run, attempt, and evidence fingerprint. Forgeboard
          will ask for native confirmation before changing durable workflow state.
        </p>
        <DecisionBody {...props} />
        <footer>
          <button
            ref={cancelButton}
            className="button"
            type="button"
            disabled={props.busy}
            onClick={props.onClose}
          >
            Keep waiting
          </button>
        </footer>
      </section>
    </div>
  );
}

function DecisionBody(props: WorkflowDecisionDialogProps) {
  const target = props.target;
  if (target.kind === 'launch') {
    return (
      <LaunchDecision
        request={target.request}
        busy={props.busy}
        onApprove={props.onApproveLaunch}
      />
    );
  }
  if (target.kind === 'revision') {
    return (
      <RevisionDecision
        request={target.request}
        busy={props.busy}
        onResolve={props.onResolveRevision}
        onReviewChanges={props.onReviewChanges}
      />
    );
  }
  if (target.request.targetType === 'human-review') {
    return (
      <ReviewDecision
        request={target.request}
        busy={props.busy}
        onDecide={props.onDecideReview}
        onReviewChanges={props.onReviewChanges}
      />
    );
  }
  return (
    <HumanApprovalDecision
      request={target.request}
      busy={props.busy}
      onApprove={props.onApproveHuman}
      onReviewChanges={props.onReviewChanges}
    />
  );
}

function LaunchDecision({
  request,
  busy,
  onApprove,
}: {
  request: WorkflowApprovalRequest;
  busy: boolean;
  onApprove: (request: WorkflowApprovalRequest) => void;
}) {
  const agentDisclosure = RunDisclosureSchema.safeParse(request.disclosure);
  return (
    <div className="workflow-decision-body">
      <dl className="workflow-decision-facts">
        <div>
          <dt>Node</dt>
          <dd>{request.nodeId}</dd>
        </div>
        <div>
          <dt>Executor</dt>
          <dd>{request.executorId}</dd>
        </div>
        <div>
          <dt>Attempt</dt>
          <dd>{request.attempt}</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>
            <time dateTime={request.expiresAt}>{new Date(request.expiresAt).toLocaleString()}</time>
          </dd>
        </div>
      </dl>
      <details open>
        <summary>Exact launch disclosure</summary>
        {agentDisclosure.success ? (
          <div className="workflow-agent-disclosure">
            <RunDisclosureWarnings disclosure={agentDisclosure.data} />
            <RunDisclosureDetails disclosure={agentDisclosure.data} />
          </div>
        ) : (
          <pre>{JSON.stringify(request.disclosure, null, 2)}</pre>
        )}
      </details>
      <button
        className="button primary workflow-decision-primary"
        type="button"
        disabled={busy}
        onClick={() => onApprove(request)}
      >
        <Play size={14} aria-hidden="true" />
        {busy ? 'Opening native confirmation…' : 'Continue to native launch approval'}
      </button>
    </div>
  );
}

function HumanApprovalDecision({
  request,
  busy,
  onApprove,
  onReviewChanges,
}: {
  request: WorkflowHumanDecisionRequest;
  busy: boolean;
  onApprove: (request: WorkflowHumanDecisionRequest) => void;
  onReviewChanges: (runId: string) => void;
}) {
  return (
    <div className="workflow-decision-body">
      <EvidenceFacts request={request} onReviewChanges={onReviewChanges} />
      <button
        className="button primary workflow-decision-primary"
        type="button"
        disabled={busy}
        onClick={() => onApprove(request)}
      >
        <CheckCircle2 size={14} aria-hidden="true" />
        {busy ? 'Opening native confirmation…' : 'Continue to native approval'}
      </button>
    </div>
  );
}

function ReviewDecision({
  request,
  busy,
  onDecide,
  onReviewChanges,
}: {
  request: WorkflowHumanDecisionRequest;
  busy: boolean;
  onDecide: WorkflowDecisionDialogProps['onDecideReview'];
  onReviewChanges: (runId: string) => void;
}) {
  const [decision, setDecision] = useState<'approved' | 'changes-requested'>('approved');
  const [feedback, setFeedback] = useState('');
  const needsFeedback = decision === 'changes-requested';
  return (
    <div className="workflow-decision-body">
      <EvidenceFacts request={request} onReviewChanges={onReviewChanges} />
      <fieldset className="workflow-review-choice">
        <legend>Review outcome</legend>
        <label>
          <input
            type="radio"
            name="workflow-review-decision"
            checked={decision === 'approved'}
            disabled={busy}
            onChange={() => setDecision('approved')}
          />
          <span>
            <strong>Approve current result</strong>
            <small>Allow downstream workflow work to continue.</small>
          </span>
        </label>
        <label>
          <input
            type="radio"
            name="workflow-review-decision"
            checked={decision === 'changes-requested'}
            disabled={busy}
            onChange={() => setDecision('changes-requested')}
          />
          <span>
            <strong>Request changes</strong>
            <small>Send actionable feedback into the configured revision path.</small>
          </span>
        </label>
      </fieldset>
      <label className="workflow-feedback-field">
        Actionable feedback {needsFeedback ? '(required)' : '(optional)'}
        <textarea
          name="workflow-review-feedback"
          rows={5}
          value={feedback}
          disabled={busy}
          maxLength={200_000}
          onChange={(event) => setFeedback(event.target.value)}
          placeholder="Describe what is approved or what must change."
        />
      </label>
      <button
        className="button primary workflow-decision-primary"
        type="button"
        disabled={busy || (needsFeedback && feedback.trim().length === 0)}
        onClick={() =>
          onDecide(request, decision, feedback.trim().length === 0 ? undefined : feedback.trim())
        }
      >
        <CheckCircle2 size={14} aria-hidden="true" />
        {busy ? 'Opening native confirmation…' : 'Continue to native review confirmation'}
      </button>
    </div>
  );
}

function RevisionDecision({
  request,
  busy,
  onResolve,
  onReviewChanges,
}: {
  request: WorkflowRevisionEscapeRequest;
  busy: boolean;
  onResolve: WorkflowDecisionDialogProps['onResolveRevision'];
  onReviewChanges: (runId: string) => void;
}) {
  return (
    <div className="workflow-decision-body">
      <div className="workflow-revision-warning">
        <AlertTriangle size={16} aria-hidden="true" />
        <p>
          Loop <strong>{request.loopId}</strong> reached its configured limit after{' '}
          <strong>{request.attemptsStarted}</strong> attempts. Choose whether to accept the current
          result or cancel this workflow.
        </p>
      </div>
      <BoundDecisionEvidence
        evidence={request.evidence}
        evidenceFingerprint={request.evidenceFingerprint}
        onReviewChanges={onReviewChanges}
      />
      <div className="workflow-revision-actions">
        <button
          className="button danger"
          type="button"
          disabled={busy}
          onClick={() => onResolve(request, 'cancel')}
        >
          Cancel workflow
        </button>
        <button
          className="button primary"
          type="button"
          disabled={busy}
          onClick={() => onResolve(request, 'accept')}
        >
          Accept current result
        </button>
      </div>
    </div>
  );
}

function EvidenceFacts({
  request,
  onReviewChanges,
}: {
  request: WorkflowHumanDecisionRequest;
  onReviewChanges: (runId: string) => void;
}) {
  return (
    <>
      <dl className="workflow-decision-facts">
        <div>
          <dt>Decision type</dt>
          <dd>{request.targetType.replaceAll('-', ' ')}</dd>
        </div>
        <div>
          <dt>Target</dt>
          <dd>{request.targetId}</dd>
        </div>
        <div>
          <dt>Attempt</dt>
          <dd>{request.targetAttempt}</dd>
        </div>
      </dl>
      <BoundDecisionEvidence
        evidence={request.evidence}
        evidenceFingerprint={request.evidenceFingerprint}
        onReviewChanges={onReviewChanges}
      />
    </>
  );
}

function BoundDecisionEvidence({
  evidence,
  evidenceFingerprint,
  onReviewChanges,
}: Pick<WorkflowHumanDecisionRequest, 'evidence' | 'evidenceFingerprint'> & {
  readonly onReviewChanges: (runId: string) => void;
}) {
  const runId = boundAgentRunId(evidence);
  return (
    <section className="workflow-bound-evidence" aria-label="Exact decision evidence">
      {runId !== undefined && (
        <button className="button" type="button" onClick={() => onReviewChanges(runId)}>
          <GitCompareArrows size={14} aria-hidden="true" />
          Review bound worktree changes
        </button>
      )}
      <details open>
        <summary>Exact evidence bound to this decision</summary>
        <pre>{JSON.stringify(evidence, null, 2)}</pre>
      </details>
      <details>
        <summary>Evidence binding identifier</summary>
        <pre>{evidenceFingerprint}</pre>
      </details>
    </section>
  );
}

function boundAgentRunId(evidence: WorkflowHumanDecisionRequest['evidence']): string | undefined {
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence))
    return undefined;
  const relevantOutputs = evidence['relevantOutputs'];
  const ids = new Set<string>();
  collectAgentRunIds(relevantOutputs, ids);
  return ids.size === 1 ? [...ids][0] : undefined;
}

function collectAgentRunIds(value: unknown, ids: Set<string>): void {
  if (typeof value === 'string') {
    const match =
      /^agent-run:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu.exec(
        value,
      );
    if (match?.[1] !== undefined) ids.add(match[1]);
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) collectAgentRunIds(child, ids);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value)) collectAgentRunIds(child, ids);
}

function decisionDescriptor(target: WorkflowDecisionTarget): {
  eyebrow: string;
  title: string;
  description: string;
} {
  if (target.kind === 'launch') {
    return {
      eyebrow: 'Executable approval gate',
      title: 'Review this workflow launch',
      description: 'No process starts until the exact prepared executor request is approved.',
    };
  }
  if (target.kind === 'revision') {
    return {
      eyebrow: 'Revision escape decision',
      title: 'The revision limit was reached',
      description: 'This workflow cannot continue without an explicit human resolution.',
    };
  }
  if (target.request.targetType === 'human-review') {
    return {
      eyebrow: 'Human review gate',
      title: 'Review the current workflow result',
      description: 'Approve this evidence or request changes with actionable feedback.',
    };
  }
  return {
    eyebrow: 'Semantic approval gate',
    title: 'Review this workflow decision',
    description: 'Approve the evidence-bound connection or keep the workflow waiting.',
  };
}

function trapFocus(event: KeyboardEvent, container: HTMLElement | null): void {
  const focusable = container
    ? [
        ...container.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), details > summary, [href], [tabindex]:not([tabindex="-1"])',
        ),
      ]
    : [];
  if (focusable.length === 0) {
    event.preventDefault();
    container?.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  } else if (!container?.contains(document.activeElement)) {
    event.preventDefault();
    first?.focus();
  }
}
