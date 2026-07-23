import type { WorkflowExecutionView } from '../../../../../../shared/workflow/contracts.js';
import type { WorkflowDecisionTarget } from '../../workflows/workflow-ui-types.js';

export function workflowDecisionIsCurrent(
  target: WorkflowDecisionTarget,
  execution: WorkflowExecutionView | null,
): boolean {
  if (execution === null || target.request.executionId !== execution.id) return false;
  if (target.kind === 'launch') {
    return execution.approvals.some(
      (request) =>
        request.preparationId === target.request.preparationId &&
        request.approvalFingerprint === target.request.approvalFingerprint,
    );
  }
  if (target.kind === 'human') {
    return execution.humanDecisions.some(
      (request) =>
        request.targetId === target.request.targetId &&
        request.targetType === target.request.targetType &&
        request.targetAttempt === target.request.targetAttempt &&
        request.evidenceFingerprint === target.request.evidenceFingerprint,
    );
  }
  return execution.revisionEscapes.some(
    (request) =>
      request.loopId === target.request.loopId &&
      request.attemptsStarted === target.request.attemptsStarted &&
      request.evidenceFingerprint === target.request.evidenceFingerprint,
  );
}

export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.closest('[contenteditable="true"]') !== null ||
    target.tagName === 'INPUT' ||
    target.tagName === 'SELECT' ||
    target.tagName === 'TEXTAREA'
  );
}
