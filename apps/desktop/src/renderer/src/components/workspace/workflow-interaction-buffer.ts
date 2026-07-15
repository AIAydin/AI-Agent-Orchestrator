import type { WorkflowInteractionEventEnvelope } from '../../../../shared/workflow-contracts.js';

const MAX_EVENTS = 256;
const MAX_TEXT_CODE_UNITS = 262_144;

export function appendWorkflowInteraction(
  current: readonly WorkflowInteractionEventEnvelope[],
  event: WorkflowInteractionEventEnvelope,
): WorkflowInteractionEventEnvelope[] {
  const identity = interactionIdentity(event);
  const next = [
    ...current.filter((candidate) => interactionIdentity(candidate) !== identity),
    event,
  ];
  let textCodeUnits = next.reduce((total, candidate) => total + candidate.text.length, 0);
  while (next.length > MAX_EVENTS || textCodeUnits > MAX_TEXT_CODE_UNITS) {
    const removed = next.shift();
    if (removed === undefined) break;
    textCodeUnits -= removed.text.length;
  }
  return next;
}

export function workflowInteractionsForNode(
  events: readonly WorkflowInteractionEventEnvelope[],
  executionId: string,
  nodeId: string,
  attempt: number,
): readonly WorkflowInteractionEventEnvelope[] {
  return events.filter(
    (event) =>
      event.executionId === executionId && event.nodeId === nodeId && event.attempt === attempt,
  );
}

function interactionIdentity(event: WorkflowInteractionEventEnvelope): string {
  return `${event.executionId}:${event.nodeId}:${String(event.attempt)}:${String(event.sequence)}`;
}
