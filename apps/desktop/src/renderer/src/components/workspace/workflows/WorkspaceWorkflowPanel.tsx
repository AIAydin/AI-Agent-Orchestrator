import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  GitBranch,
  Play,
  RefreshCw,
  Square,
} from 'lucide-react';

import type {
  WorkflowApprovalRequest,
  WorkflowExecutionView,
  WorkflowHumanDecisionRequest,
  WorkflowInteractionEventEnvelope,
  WorkflowNodeInput,
  WorkflowNodeInterrupt,
  WorkflowRevisionEscapeRequest,
} from '../../../../../shared/workflow/contracts.js';
import type { WorkflowDecisionTarget } from './workflow-ui-types.js';
import { WorkflowNodeTerminal } from './WorkflowNodeTerminal.js';
import { workflowInteractionsForNode } from './workflow-interaction-buffer.js';
import { workflowIsActive } from './useWorkflowRuns.js';

interface WorkspaceWorkflowPanelProps {
  executions: readonly WorkflowExecutionView[];
  current: WorkflowExecutionView | null;
  nodeTitles: ReadonlyMap<string, string>;
  interactiveNodeIds: ReadonlySet<string>;
  interactionEvents: readonly WorkflowInteractionEventEnvelope[];
  loading: boolean;
  busyAction: string | null;
  mutationsAuthorized: boolean;
  onSelect: (executionId: string) => void;
  onRefresh: () => void;
  onCancel: (executionId: string) => void;
  onReviewDecision: (target: WorkflowDecisionTarget) => void;
  onOpenAgentWorktree: (runId: string) => void;
  onSendInput: (input: WorkflowNodeInput) => Promise<boolean>;
  onInterrupt: (input: WorkflowNodeInterrupt) => Promise<boolean>;
}

export function WorkspaceWorkflowPanel({
  executions,
  current,
  nodeTitles,
  interactiveNodeIds,
  interactionEvents,
  loading,
  busyAction,
  mutationsAuthorized,
  onSelect,
  onRefresh,
  onCancel,
  onReviewDecision,
  onOpenAgentWorktree,
  onSendInput,
  onInterrupt,
}: WorkspaceWorkflowPanelProps) {
  return (
    <div
      id="workspace-panel-workflows"
      className="drawer-panel workflow-panel"
      role="tabpanel"
      aria-labelledby="workspace-tab-workflows"
      tabIndex={0}
      aria-busy={loading || busyAction !== null}
    >
      {!mutationsAuthorized && (
        <p className="workflow-role-notice" role="status">
          Your role can view workflow history and output, but not start, approve, control, or cancel
          a run.
        </p>
      )}
      <header className="drawer-panel-summary workflow-panel-toolbar">
        <div>
          <strong>Workflow runs</strong>
          <small>Run the saved canvas or a selected node from the toolbar.</small>
        </div>
        <div className="drawer-panel-actions">
          {executions.length > 0 && (
            <label>
              <span className="sr-only">Workflow run</span>
              <select
                name="workflow-run-selection"
                aria-label="Workflow run"
                value={current?.id ?? ''}
                onChange={(event) => onSelect(event.target.value)}
              >
                {executions.map((execution) => (
                  <option key={execution.id} value={execution.id}>
                    {formatRunOption(execution)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="button" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={12} aria-hidden="true" /> {loading ? 'Loading…' : 'Refresh'}
          </button>
          {current && workflowIsActive(current) && (
            <button
              type="button"
              className="workflow-cancel"
              disabled={busyAction !== null || !mutationsAuthorized}
              onClick={() => onCancel(current.id)}
            >
              <Square size={11} aria-hidden="true" /> Cancel run
            </button>
          )}
        </div>
      </header>

      {current === null ? (
        <p className="drawer-empty">
          No runs yet. Save the canvas, then choose Run canvas or Run selected.
        </p>
      ) : (
        <WorkflowExecutionDetails
          execution={current}
          nodeTitles={nodeTitles}
          interactiveNodeIds={interactiveNodeIds}
          interactionEvents={interactionEvents}
          busyAction={busyAction}
          mutationsAuthorized={mutationsAuthorized}
          onReviewDecision={onReviewDecision}
          onOpenAgentWorktree={onOpenAgentWorktree}
          onSendInput={onSendInput}
          onInterrupt={onInterrupt}
        />
      )}
    </div>
  );
}

function WorkflowExecutionDetails({
  execution,
  nodeTitles,
  interactiveNodeIds,
  interactionEvents,
  busyAction,
  mutationsAuthorized,
  onReviewDecision,
  onOpenAgentWorktree,
  onSendInput,
  onInterrupt,
}: {
  execution: WorkflowExecutionView;
  nodeTitles: ReadonlyMap<string, string>;
  interactiveNodeIds: ReadonlySet<string>;
  interactionEvents: readonly WorkflowInteractionEventEnvelope[];
  busyAction: string | null;
  mutationsAuthorized: boolean;
  onReviewDecision: (target: WorkflowDecisionTarget) => void;
  onOpenAgentWorktree: (runId: string) => void;
  onSendInput: (input: WorkflowNodeInput) => Promise<boolean>;
  onInterrupt: (input: WorkflowNodeInterrupt) => Promise<boolean>;
}) {
  const pendingDecisions =
    execution.approvals.length + execution.humanDecisions.length + execution.revisionEscapes.length;
  return (
    <div className="workflow-run-layout">
      <section className="workflow-run-summary" aria-label="Workflow run summary">
        <div>
          <span className={`workflow-state ${execution.status}`}>
            {statusLabel(execution.status)}
          </span>
          <strong>{scopeLabel(execution, nodeTitles)}</strong>
          <small>
            Updated <time dateTime={execution.updatedAt}>{formatDate(execution.updatedAt)}</time>
          </small>
        </div>
        <dl>
          <div>
            <dt>Nodes</dt>
            <dd>{execution.planNodeIds.length}</dd>
          </div>
          <div>
            <dt>Active</dt>
            <dd>{execution.scheduling.activeNodeIds.length}</dd>
          </div>
          <div>
            <dt>Waiting</dt>
            <dd>
              {execution.scheduling.waitingNodeIds.length +
                execution.scheduling.waitingForApprovalNodeIds.length}
            </dd>
          </div>
          <div>
            <dt>Decisions</dt>
            <dd>{pendingDecisions}</dd>
          </div>
        </dl>
      </section>

      {pendingDecisions > 0 && (
        <section className="workflow-decision-list" aria-label="Workflow decisions">
          {execution.approvals.map((request) => (
            <LaunchDecisionCard
              key={request.preparationId}
              request={request}
              title={nodeTitle(nodeTitles, request.nodeId)}
              disabled={busyAction !== null || !mutationsAuthorized}
              onReview={() => onReviewDecision({ kind: 'launch', request })}
            />
          ))}
          {execution.humanDecisions.map((request) => (
            <HumanDecisionCard
              key={humanRequestKey(request)}
              request={request}
              title={nodeTitle(nodeTitles, request.targetId)}
              disabled={busyAction !== null || !mutationsAuthorized}
              onReview={() => onReviewDecision({ kind: 'human', request })}
            />
          ))}
          {execution.revisionEscapes.map((request) => (
            <RevisionDecisionCard
              key={`${request.loopId}:${request.attemptsStarted}`}
              request={request}
              disabled={busyAction !== null || !mutationsAuthorized}
              onReview={() => onReviewDecision({ kind: 'revision', request })}
            />
          ))}
        </section>
      )}

      <section className="workflow-node-list" aria-label="Workflow node status">
        {execution.nodeRuns.map((run) => (
          <article key={run.nodeId}>
            <span className={`workflow-node-icon ${run.status}`}>
              {run.status === 'succeeded' ? (
                <CheckCircle2 size={13} aria-hidden="true" />
              ) : run.status === 'failed' || run.status === 'lost' ? (
                <AlertTriangle size={13} aria-hidden="true" />
              ) : run.status === 'running' ? (
                <Play size={13} aria-hidden="true" />
              ) : (
                <Clock3 size={13} aria-hidden="true" />
              )}
            </span>
            <div>
              <strong>{nodeTitle(nodeTitles, run.nodeId)}</strong>
              <small>
                Attempt {run.attempt} · {statusLabel(run.status)}
              </small>
              {run.statusReason && <p>{run.statusReason}</p>}
              {run.reviewableAgentRunId !== undefined && (
                <button
                  type="button"
                  onClick={() => onOpenAgentWorktree(run.reviewableAgentRunId!)}
                >
                  Review this agent worktree
                </button>
              )}
            </div>
            {run.status === 'running' && interactiveNodeIds.has(run.nodeId) && (
              <WorkflowNodeTerminal
                executionId={execution.id}
                nodeId={run.nodeId}
                attempt={run.attempt}
                title={nodeTitle(nodeTitles, run.nodeId)}
                events={workflowInteractionsForNode(
                  interactionEvents,
                  execution.id,
                  run.nodeId,
                  run.attempt,
                )}
                busy={busyAction !== null || !mutationsAuthorized}
                onSendInput={onSendInput}
                onInterrupt={onInterrupt}
              />
            )}
          </article>
        ))}
      </section>

      {execution.edges.length > 0 && (
        <section className="workflow-edge-list" aria-label="Workflow connection status">
          <header>
            <GitBranch size={12} aria-hidden="true" />
            <strong>Connections</strong>
          </header>
          {execution.edges.map((edge) => (
            <article key={edge.edgeId}>
              <span className={`workflow-edge-run-status ${edge.status}`}>
                {statusLabel(edge.status)}
              </span>
              <span className={`workflow-edge-state ${edge.disposition}`}>
                {statusLabel(edge.disposition)}
              </span>
              <strong>
                {nodeTitle(nodeTitles, edge.sourceNodeId)} →{' '}
                {nodeTitle(nodeTitles, edge.targetNodeId)}
              </strong>
              <small>{edge.type}</small>
              <p>{edge.reason}</p>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}

function LaunchDecisionCard({
  request,
  title,
  disabled,
  onReview,
}: {
  request: WorkflowApprovalRequest;
  title: string;
  disabled: boolean;
  onReview: () => void;
}) {
  return (
    <article>
      <div>
        <strong>Start {title}</strong>
        <small>
          You&apos;ll review the exact command first · expires{' '}
          {new Date(request.expiresAt).toLocaleTimeString()}
        </small>
      </div>
      <button type="button" disabled={disabled} onClick={onReview}>
        Review what will run
      </button>
    </article>
  );
}

function HumanDecisionCard({
  request,
  title,
  disabled,
  onReview,
}: {
  request: WorkflowHumanDecisionRequest;
  title: string;
  disabled: boolean;
  onReview: () => void;
}) {
  return (
    <article>
      <div>
        <strong>{humanDecisionLabel(request.targetType, title)}</strong>
        <small>Attempt {request.targetAttempt} · tied to this exact result</small>
      </div>
      <button type="button" disabled={disabled} onClick={onReview}>
        {request.targetType === 'human-review' ? 'Review result' : 'Review approval'}
      </button>
    </article>
  );
}

function RevisionDecisionCard({
  request,
  disabled,
  onReview,
}: {
  request: WorkflowRevisionEscapeRequest;
  disabled: boolean;
  onReview: () => void;
}) {
  return (
    <article>
      <div>
        <strong>Retry limit reached</strong>
        <small>
          Loop {request.loopId} · tried {request.attemptsStarted} times
        </small>
      </div>
      <button type="button" disabled={disabled} onClick={onReview}>
        Choose what to do
      </button>
    </article>
  );
}

function nodeTitle(nodeTitles: ReadonlyMap<string, string>, nodeId: string): string {
  return nodeTitles.get(nodeId) ?? nodeId;
}

function scopeLabel(
  execution: WorkflowExecutionView,
  nodeTitles: ReadonlyMap<string, string>,
): string {
  const scope = execution.scope;
  if (scope.kind === 'workflow') return 'Entire saved canvas';
  if (scope.kind === 'node')
    return `${nodeTitle(nodeTitles, scope.nodeId)} and everything it needs`;
  if (scope.kind === 'selection') return `${scope.nodeIds.length} selected nodes`;
  return `Group ${scope.groupId}`;
}

function statusLabel(status: string): string {
  const words = status.replaceAll('-', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function humanDecisionLabel(
  targetType: WorkflowHumanDecisionRequest['targetType'],
  title: string,
): string {
  if (targetType === 'human-review') return `Review ${title}`;
  if (targetType === 'review-gate') return `Approve review gate ${title}`;
  return `Approve connection ${title}`;
}

function humanRequestKey(request: WorkflowHumanDecisionRequest): string {
  return `${request.targetType}:${request.targetId}:${request.targetAttempt}`;
}

function formatRunOption(execution: WorkflowExecutionView): string {
  return `${new Date(execution.createdAt).toLocaleString()} · ${statusLabel(execution.status)}`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}
