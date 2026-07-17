import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  WorkflowApprovalRequest,
  WorkflowCancelNodeInput,
  WorkflowExecutionView,
  WorkflowHumanDecisionRequest,
  WorkflowRevisionEscapeRequest,
  WorkflowStartInput,
  WorkflowInteractionEventEnvelope,
  WorkflowNodeInput,
  WorkflowNodeInterrupt,
} from '../../../../../shared/workflow/contracts.js';
import type { IpcResult } from '../../../../../shared/application/contracts.js';
import { unwrap } from '../../../lib/ipc.js';
import { appendWorkflowInteraction } from './workflow-interaction-buffer.js';

interface UseWorkflowRunsOptions {
  projectId: string;
  canvasId: string | null;
  flushCanvas: () => Promise<boolean>;
  setEvents: React.Dispatch<React.SetStateAction<string[]>>;
  onError: (message: string) => void;
  mutationsAuthorized: boolean;
}

export const WORKFLOW_ROLE_READ_ONLY_MESSAGE =
  'This collaboration role can inspect workflow history but cannot mutate workflow execution.';

export function useWorkflowRuns({
  projectId,
  canvasId,
  flushCanvas,
  setEvents,
  onError,
  mutationsAuthorized,
}: UseWorkflowRunsOptions) {
  const [executions, setExecutions] = useState<WorkflowExecutionView[]>([]);
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [interactionEvents, setInteractionEvents] = useState<WorkflowInteractionEventEnvelope[]>(
    [],
  );
  const executionIdsRef = useRef<ReadonlySet<string>>(new Set());
  const pendingInteractionEventsRef = useRef<WorkflowInteractionEventEnvelope[]>([]);
  const identityRef = useRef(workspaceIdentity(projectId, canvasId));
  identityRef.current = workspaceIdentity(projectId, canvasId);

  const admitExecutionIds = useCallback((executionIds: readonly string[]) => {
    if (executionIds.length === 0) return;
    const known = new Set(executionIdsRef.current);
    for (const executionId of executionIds) known.add(executionId);
    executionIdsRef.current = known;
    const admitted = pendingInteractionEventsRef.current.filter((event) =>
      known.has(event.executionId),
    );
    if (admitted.length === 0) return;
    pendingInteractionEventsRef.current = pendingInteractionEventsRef.current.filter(
      (event) => !known.has(event.executionId),
    );
    setInteractionEvents((current) =>
      admitted.reduce((buffer, event) => appendWorkflowInteraction(buffer, event), current),
    );
  }, []);

  const recordExecution = useCallback(
    (execution: WorkflowExecutionView) => {
      admitExecutionIds([execution.id]);
      setExecutions((current) => sortExecutions(upsertExecution(current, execution)));
    },
    [admitExecutionIds],
  );

  const refresh = useCallback(async () => {
    if (canvasId === null) return;
    const identity = workspaceIdentity(projectId, canvasId);
    setLoading(true);
    try {
      const listed = unwrap(
        await window.forgeboard.workflows.list({
          projectId,
          canvasId,
          limit: 50,
        }),
      );
      if (identityRef.current !== identity) return;
      const sorted = sortExecutions(listed);
      admitExecutionIds(sorted.map(({ id }) => id));
      setExecutions((current) =>
        sortExecutions(
          sorted.reduce((merged, execution) => upsertExecution(merged, execution), [...current]),
        ).slice(0, 50),
      );
      setSelectedExecutionId((current) => {
        const decisionRun = sorted.find((execution) => executionDecisionCount(execution) > 0);
        if (decisionRun !== undefined) return decisionRun.id;
        if (current !== null && sorted.some((execution) => execution.id === current))
          return current;
        return sorted.find((execution) => workflowIsActive(execution))?.id ?? sorted[0]?.id ?? null;
      });
    } catch (cause) {
      if (identityRef.current === identity) {
        onError(errorMessage(cause, 'Could not load workflow history.'));
      }
    } finally {
      if (identityRef.current === identity) setLoading(false);
    }
  }, [admitExecutionIds, canvasId, onError, projectId]);

  useEffect(() => {
    setExecutions([]);
    setSelectedExecutionId(null);
    setBusyAction(null);
    setInteractionEvents([]);
    executionIdsRef.current = new Set();
    pendingInteractionEventsRef.current = [];
    void refresh();
  }, [refresh]);

  useEffect(
    () =>
      window.forgeboard.workflows.onEvent((event) => {
        const execution = event.execution;
        if (execution.projectId !== projectId || execution.canvasId !== canvasId) return;
        recordExecution(execution);
        const requiresDecision = executionDecisionCount(execution) > 0;
        setSelectedExecutionId((current) =>
          requiresDecision ? execution.id : (current ?? execution.id),
        );
        setEvents((current) =>
          [workflowEventLabel(event.type, event.nodeId), ...current].slice(0, 80),
        );
      }),
    [canvasId, projectId, recordExecution, setEvents],
  );

  useEffect(
    () =>
      window.forgeboard.workflows.onInteractionEvent((event) => {
        if (executionIdsRef.current.has(event.executionId)) {
          setInteractionEvents((current) => appendWorkflowInteraction(current, event));
          return;
        }
        pendingInteractionEventsRef.current = appendWorkflowInteraction(
          pendingInteractionEventsRef.current,
          event,
        );
      }),
    [],
  );

  const start = useCallback(
    async (scope: WorkflowStartInput['scope']) => {
      if (!mutationsAuthorized) {
        onError(WORKFLOW_ROLE_READ_ONLY_MESSAGE);
        return;
      }
      if (canvasId === null) {
        onError('Wait for the canvas to finish loading before starting a workflow.');
        return;
      }
      setBusyAction('start');
      try {
        if (!(await flushCanvas())) {
          onError('The workflow was not started because the canvas could not be saved.');
          return;
        }
        const execution = unwrap(
          await window.forgeboard.workflows.start({
            projectId,
            canvasId,
            scope,
          }),
        );
        recordExecution(execution);
        setSelectedExecutionId(execution.id);
        setEvents((current) => [scopeLabel(scope), ...current].slice(0, 80));
      } catch (cause) {
        onError(errorMessage(cause, 'Could not start the workflow.'));
      } finally {
        setBusyAction(null);
      }
    },
    [canvasId, flushCanvas, mutationsAuthorized, onError, projectId, recordExecution, setEvents],
  );

  const runMutation = useCallback(
    async (
      action: string,
      invoke: () => Promise<IpcResult<WorkflowExecutionView | null>>,
      cancelledMessage: string,
      fallbackError: string,
    ): Promise<void> => {
      if (!mutationsAuthorized) {
        onError(WORKFLOW_ROLE_READ_ONLY_MESSAGE);
        return;
      }
      setBusyAction(action);
      try {
        const execution = unwrap(await invoke());
        if (execution === null) {
          setEvents((current) => [cancelledMessage, ...current].slice(0, 80));
        } else {
          recordExecution(execution);
        }
      } catch (cause) {
        onError(errorMessage(cause, fallbackError));
      } finally {
        setBusyAction(null);
      }
    },
    [mutationsAuthorized, onError, recordExecution, setEvents],
  );

  const approveNode = useCallback(
    async (request: WorkflowApprovalRequest) => {
      await runMutation(
        `launch:${request.nodeId}`,
        () =>
          window.forgeboard.workflows.approveNode({
            executionId: request.executionId,
            nodeId: request.nodeId,
            preparationId: request.preparationId,
            approvalFingerprint: request.approvalFingerprint,
            confirmed: true,
          }),
        'Launch approval was cancelled; no process started.',
        'Could not approve the workflow launch.',
      );
    },
    [runMutation],
  );

  const approveHuman = useCallback(
    async (request: WorkflowHumanDecisionRequest) => {
      const targetType = request.targetType;
      if (targetType === 'human-review') {
        onError('Choose approve or request changes for this human review.');
        return;
      }
      await runMutation(
        `decision:${request.targetId}`,
        () =>
          window.forgeboard.workflows.approveHuman({
            executionId: request.executionId,
            targetId: request.targetId,
            targetType,
            targetAttempt: request.targetAttempt,
            evidenceFingerprint: request.evidenceFingerprint,
            confirmed: true,
          }),
        'Approval was cancelled; the workflow remains paused.',
        'Could not record the workflow approval.',
      );
    },
    [onError, runMutation],
  );

  const decideReview = useCallback(
    async (
      request: WorkflowHumanDecisionRequest,
      decision: 'approved' | 'changes-requested',
      feedback?: string,
    ) => {
      if (request.targetType !== 'human-review') {
        onError('This request is not a human review.');
        return;
      }
      await runMutation(
        `review:${request.targetId}`,
        () =>
          window.forgeboard.workflows.decideReview({
            executionId: request.executionId,
            targetId: request.targetId,
            targetType: 'human-review',
            targetAttempt: request.targetAttempt,
            evidenceFingerprint: request.evidenceFingerprint,
            decision,
            ...(feedback === undefined ? {} : { feedback }),
            confirmed: true,
          }),
        'Review confirmation was cancelled; the workflow remains paused.',
        'Could not record the review decision.',
      );
    },
    [onError, runMutation],
  );

  const resolveRevisionEscape = useCallback(
    async (request: WorkflowRevisionEscapeRequest, decision: 'accept' | 'cancel') => {
      await runMutation(
        `revision:${request.loopId}`,
        () =>
          window.forgeboard.workflows.resolveRevisionEscape({
            executionId: request.executionId,
            loopId: request.loopId,
            attemptsStarted: request.attemptsStarted,
            evidenceFingerprint: request.evidenceFingerprint,
            decision,
            confirmed: true,
          }),
        'Revision decision was cancelled; the workflow remains paused.',
        'Could not resolve the revision limit.',
      );
    },
    [runMutation],
  );

  const cancel = useCallback(
    async (executionId: string) => {
      await runMutation(
        `cancel:${executionId}`,
        () => window.forgeboard.workflows.cancel({ executionId, confirmed: true }),
        'Workflow cancellation was dismissed.',
        'Could not cancel the workflow.',
      );
    },
    [runMutation],
  );

  const cancelNode = useCallback(
    async (input: Omit<WorkflowCancelNodeInput, 'confirmed'>) => {
      await runMutation(
        `cancel-node:${input.nodeId}`,
        () => window.forgeboard.workflows.cancelNode({ ...input, confirmed: true }),
        'Test cancellation was dismissed.',
        'Could not cancel the Test node.',
      );
    },
    [runMutation],
  );

  const sendInput = useCallback(
    async (input: WorkflowNodeInput): Promise<boolean> => {
      if (!mutationsAuthorized) {
        onError(WORKFLOW_ROLE_READ_ONLY_MESSAGE);
        return false;
      }
      setBusyAction(`input:${input.nodeId}`);
      try {
        const accepted = unwrap(await window.forgeboard.workflows.sendInput(input));
        if (accepted) {
          setEvents((current) =>
            [
              `Sent interactive input to ${input.nodeId} attempt ${String(input.attempt)}.`,
              ...current,
            ].slice(0, 80),
          );
        }
        return accepted;
      } catch (cause) {
        onError(errorMessage(cause, 'Could not send input to the workflow node.'));
        return false;
      } finally {
        setBusyAction(null);
      }
    },
    [mutationsAuthorized, onError, setEvents],
  );

  const interrupt = useCallback(
    async (input: WorkflowNodeInterrupt): Promise<boolean> => {
      if (!mutationsAuthorized) {
        onError(WORKFLOW_ROLE_READ_ONLY_MESSAGE);
        return false;
      }
      setBusyAction(`interrupt:${input.nodeId}`);
      try {
        const accepted = unwrap(await window.forgeboard.workflows.interrupt(input));
        if (accepted) {
          setEvents((current) =>
            [`Interrupted ${input.nodeId} attempt ${String(input.attempt)}.`, ...current].slice(
              0,
              80,
            ),
          );
        }
        return accepted;
      } catch (cause) {
        onError(errorMessage(cause, 'Could not interrupt the workflow node.'));
        return false;
      } finally {
        setBusyAction(null);
      }
    },
    [mutationsAuthorized, onError, setEvents],
  );

  const currentExecution = useMemo(
    () =>
      executions.find((execution) => execution.id === selectedExecutionId) ?? executions[0] ?? null,
    [executions, selectedExecutionId],
  );
  const activeExecution = useMemo(
    () => executions.find((execution) => workflowIsActive(execution)) ?? null,
    [executions],
  );

  return {
    executions,
    currentExecution,
    activeExecution,
    selectedExecutionId,
    loading,
    busyAction,
    mutationsAuthorized,
    interactionEvents,
    selectExecution: setSelectedExecutionId,
    refresh,
    start,
    approveNode,
    approveHuman,
    decideReview,
    resolveRevisionEscape,
    cancel,
    cancelNode,
    sendInput,
    interrupt,
  };
}

export function workflowIsActive(execution: WorkflowExecutionView | null): boolean {
  return (
    execution !== null &&
    ['queued', 'running', 'waiting-for-approval', 'paused', 'cancelling'].includes(execution.status)
  );
}

function upsertExecution(
  executions: readonly WorkflowExecutionView[],
  execution: WorkflowExecutionView,
): WorkflowExecutionView[] {
  const current = executions.find((candidate) => candidate.id === execution.id);
  if (
    current !== undefined &&
    (current.revision > execution.revision ||
      (current.revision === execution.revision && current.updatedAt > execution.updatedAt))
  ) {
    return [...executions];
  }
  return [execution, ...executions.filter((candidate) => candidate.id !== execution.id)];
}

function sortExecutions(executions: readonly WorkflowExecutionView[]): WorkflowExecutionView[] {
  return [...executions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function executionDecisionCount(execution: WorkflowExecutionView): number {
  return (
    execution.approvals.length + execution.humanDecisions.length + execution.revisionEscapes.length
  );
}

function workspaceIdentity(projectId: string, canvasId: string | null): string {
  return `${projectId}:${canvasId ?? 'loading'}`;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function scopeLabel(scope: WorkflowStartInput['scope']): string {
  if (scope.kind === 'workflow') return 'Started the saved canvas workflow.';
  if (scope.kind === 'node') return 'Started the selected node and its upstream dependencies.';
  if (scope.kind === 'selection') return 'Started the selected workflow nodes.';
  return 'Started the selected workflow group.';
}

function workflowEventLabel(type: string, nodeId: string | undefined): string {
  const node = nodeId === undefined ? '' : ` for ${nodeId}`;
  switch (type) {
    case 'approval-requested':
      return `Workflow approval requested${node}.`;
    case 'node-started':
      return `Workflow node started${node}.`;
    case 'node-completed':
      return `Workflow node completed${node}.`;
    case 'execution-cancelled':
      return 'Workflow cancelled.';
    case 'execution-recovered':
      return 'Recovered a durable workflow after restart.';
    case 'decision-recorded':
      return `Workflow decision recorded${node}.`;
    case 'host-error':
      return `Workflow host reported an error${node}.`;
    default:
      return 'Workflow execution created.';
  }
}
