import { useMemo } from 'react';

import type { WorkflowReviewGateView } from '../../../../../../shared/workflow/contracts.js';
import { unwrap } from '../../../../lib/ipc.js';
import {
  workflowPendingDecision,
  type WorkflowRuntimeContextValue,
} from '../../workflows/WorkflowRuntimeContext.js';
import type { useWorkflowRuns } from '../../workflows/useWorkflowRuns.js';

type WorkspaceWorkflowRuns = ReturnType<typeof useWorkflowRuns>;

interface UseWorkspaceWorkflowRuntimeInput {
  readonly workflows: WorkspaceWorkflowRuns;
  readonly reviewGates: ReadonlyMap<string, WorkflowReviewGateView>;
  readonly requestDecision: WorkflowRuntimeContextValue['requestDecision'];
}

export function useWorkspaceWorkflowRuntime({
  workflows,
  reviewGates,
  requestDecision,
}: UseWorkspaceWorkflowRuntimeInput): WorkflowRuntimeContextValue {
  const {
    executions,
    interactionEvents,
    busyAction,
    mutationsAuthorized,
    currentExecution,
    start,
    cancelNode,
  } = workflows;

  return useMemo<WorkflowRuntimeContextValue>(
    () => ({
      executions,
      interactionEvents,
      busyAction,
      mutationsAuthorized,
      reviewGateFor: (nodeId: string) => reviewGates.get(nodeId) ?? null,
      pendingDecisionFor: (nodeId: string) => workflowPendingDecision(currentExecution, nodeId),
      requestDecision,
      startNode: (nodeId: string) => void start({ kind: 'node', nodeId, includeUpstream: false }),
      cancelNode: (input) => void cancelNode(input),
      revealArtifact: async (input) => {
        unwrap(await window.forgeboard.workflows.revealArtifact(input));
      },
      openArtifact: async (input) => {
        unwrap(await window.forgeboard.workflows.openArtifact(input));
      },
    }),
    [
      busyAction,
      cancelNode,
      currentExecution,
      executions,
      interactionEvents,
      mutationsAuthorized,
      requestDecision,
      reviewGates,
      start,
    ],
  );
}
