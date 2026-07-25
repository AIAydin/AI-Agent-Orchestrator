import { createContext, useContext, type ReactNode } from 'react';

import type {
  WorkflowExecutionView,
  WorkflowInteractionEventEnvelope,
  WorkflowReviewGateView,
} from '../../../../../shared/workflow/contracts.js';
import type { WorkflowDecisionTarget } from './workflow-ui-types.js';

/**
 * Volatile workflow-run state for components rendered inside canvas nodes
 * (test and review-gate faces). Kept separate from AgentSessionContext so
 * workflow output events re-render only the faces that consume them.
 */
export interface WorkflowRuntimeContextValue {
  readonly executions: readonly WorkflowExecutionView[];
  readonly interactionEvents: readonly WorkflowInteractionEventEnvelope[];
  readonly busyAction: string | null;
  readonly mutationsAuthorized: boolean;
  reviewGateFor(nodeId: string): WorkflowReviewGateView | null;
  pendingDecisionFor(nodeId: string): WorkflowDecisionTarget | null;
  requestDecision(target: WorkflowDecisionTarget): void;
  startNode(nodeId: string): void;
  cancelNode(input: { executionId: string; nodeId: string; attempt: number }): void;
}

/**
 * Node-id match for a human/revision decision request. `WorkflowHumanDecisionRequest` keys off
 * `targetId` (which is the node id itself when `targetType` is `'review-gate'`, per
 * `humanDecisionRequests()` in `main/workflow/host/view.ts`) rather than a `nodeId` field.
 * `WorkflowRevisionEscapeRequest` keys off `loopId`, an edge-scoped identifier with no node
 * mapping exposed on `WorkflowExecutionView` — so a revision escape can never be resolved back to
 * a node id from this pure selector alone. The optional `nodeId` read additionally matches
 * identity-shaped test doubles.
 */
function requestTargetsNode(request: object, nodeId: string): boolean {
  const targetId = 'targetId' in request ? (request as { targetId?: unknown }).targetId : undefined;
  const looseNodeId = 'nodeId' in request ? (request as { nodeId?: unknown }).nodeId : undefined;
  return targetId === nodeId || looseNodeId === nodeId;
}

/** Pure selector: the decision the user can currently make for a node, if any. */
export function workflowPendingDecision(
  execution: WorkflowExecutionView | null,
  nodeId: string,
): WorkflowDecisionTarget | null {
  if (execution === null) return null;
  const human = execution.humanDecisions.find((request) => requestTargetsNode(request, nodeId));
  if (human !== undefined) return { kind: 'human', request: human };
  const revision = execution.revisionEscapes.find((request) => requestTargetsNode(request, nodeId));
  if (revision !== undefined) return { kind: 'revision', request: revision };
  const launch = execution.approvals.find((request) => request.nodeId === nodeId);
  if (launch !== undefined) return { kind: 'launch', request: launch };
  return null;
}

const WorkflowRuntimeContext = createContext<WorkflowRuntimeContextValue | null>(null);

export const WorkflowRuntimeProvider: React.FC<{
  value: WorkflowRuntimeContextValue;
  children: ReactNode;
}> = ({ value, children }) => (
  <WorkflowRuntimeContext.Provider value={value}>{children}</WorkflowRuntimeContext.Provider>
);

export function useWorkflowRuntime(): WorkflowRuntimeContextValue {
  const value = useContext(WorkflowRuntimeContext);
  if (value === null) {
    throw new Error('useWorkflowRuntime requires a WorkflowRuntimeProvider.');
  }
  return value;
}
