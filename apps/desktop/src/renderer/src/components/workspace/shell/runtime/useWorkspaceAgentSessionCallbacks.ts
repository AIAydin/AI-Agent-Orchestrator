import { useCallback, type RefObject } from 'react';

import type { WorkshopNode } from '../../canvas/CanvasNode.js';
import type { DiffReviewOpenRequest } from '../../diff-review/index.js';
import type { useDiffReviewSession } from '../../diff-review/useDiffReviewSession.js';

interface UseWorkspaceAgentSessionCallbacksInput {
  readonly projectId: string;
  readonly nodesRef: RefObject<WorkshopNode[]>;
  readonly gitReview: ReturnType<typeof useDiffReviewSession>;
}

export function useWorkspaceAgentSessionCallbacks({
  projectId,
  nodesRef,
  gitReview,
}: UseWorkspaceAgentSessionCallbacksInput) {
  const openGitPrReadiness = useCallback(
    (runId: string) => gitReview.openTarget({ kind: 'agent-worktree', projectId, runId }),
    [gitReview, projectId],
  );
  const nodeTitle = useCallback(
    (nodeId: string) => nodesRef.current.find((node) => node.id === nodeId)?.data.title ?? null,
    [nodesRef],
  );
  const openDiffReview = useCallback(
    (nodeId: string, request: DiffReviewOpenRequest) => {
      const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
      if (node?.data.kind !== 'diff') return;
      gitReview.openNodeReview(nodeId, node.data.reviewTarget, request);
    },
    [gitReview, nodesRef],
  );

  return { nodeTitle, openDiffReview, openGitPrReadiness };
}
