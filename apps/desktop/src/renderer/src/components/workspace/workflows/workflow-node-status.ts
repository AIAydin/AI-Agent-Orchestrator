import type {
  WorkflowNodeRunView,
  WorkflowReviewGateView,
} from '../../../../../shared/workflow/contracts.js';
import type { WorkshopNode } from '../canvas/CanvasNode.js';

/** Keeps the canonical workflow lifecycle exact on the transient canvas presentation. */
export function workflowCanvasNodeStatus(
  status: WorkflowNodeRunView['status'],
): WorkshopNode['data']['status'] {
  return status;
}

export function workflowCanvasReviewGateState(
  status: WorkflowReviewGateView['status'],
): NonNullable<WorkshopNode['data']['gateState']> {
  return status === 'waiting-human' ? 'waiting-for-human' : status;
}
