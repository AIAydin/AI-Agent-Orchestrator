import { useMemo } from 'react';

import type { WorkshopNode } from '../../canvas/CanvasNode.js';
import {
  type AgentSessionContextValue,
  type FileTargetEntry,
} from '../../runs/agent-session/AgentSessionContext.js';
import { useAgentSessionContextLists } from '../../runs/agent-session/context-lists.js';
import { useKeyedStable } from '../../../../lib/use-keyed-stable.js';

type DerivedAgentSessionFields = 'nodeRoster' | 'checkProducers' | 'fileTargets';

type UseWorkspaceAgentSessionValueInput = {
  readonly nodes: WorkshopNode[];
} & Omit<AgentSessionContextValue, DerivedAgentSessionFields>;

export function useWorkspaceAgentSessionValue({
  nodes,
  project,
  settings,
  runnableAgents,
  graphReadOnly,
  openSettings,
  reportError,
  flushCanvas,
  updateNodeData,
  fitGroupFrame,
  arrangeGroupFrame,
  recordHistory,
  nodeTitle,
  removeAgentContext,
  requestDeleteNode,
  attachWhiteboardContext,
  openGitPrReadiness,
  openDiffReview,
}: UseWorkspaceAgentSessionValueInput): AgentSessionContextValue {
  const { nodeRoster, checkProducers } = useAgentSessionContextLists(nodes);
  const fileTargetsSource = useMemo<readonly FileTargetEntry[]>(
    () =>
      nodes
        .filter((node) => node.data.kind === 'file' && node.data.file !== undefined)
        .map((node) => ({
          nodeId: node.id,
          title: node.data.title,
          file: node.data.file!,
        })),
    [nodes],
  );
  const fileTargets = useKeyedStable(
    fileTargetsSource,
    fileTargetsSource
      .map(
        (entry) =>
          `${entry.nodeId}\u0000${entry.file.projectId}\u0000${entry.file.relativePath}\u0000${entry.file.kind}\u0000${String(entry.file.missing)}\u0000${entry.file.lastKnownHash ?? ''}`,
      )
      .join('\n'),
  );

  return useMemo<AgentSessionContextValue>(
    () => ({
      project,
      settings,
      runnableAgents,
      graphReadOnly,
      openSettings,
      reportError,
      flushCanvas,
      updateNodeData,
      fitGroupFrame,
      arrangeGroupFrame,
      recordHistory,
      nodeTitle,
      removeAgentContext,
      requestDeleteNode,
      attachWhiteboardContext,
      nodeRoster,
      checkProducers,
      fileTargets,
      openGitPrReadiness,
      openDiffReview,
    }),
    [
      arrangeGroupFrame,
      attachWhiteboardContext,
      checkProducers,
      fileTargets,
      fitGroupFrame,
      flushCanvas,
      graphReadOnly,
      nodeRoster,
      nodeTitle,
      openDiffReview,
      openGitPrReadiness,
      openSettings,
      project,
      recordHistory,
      removeAgentContext,
      reportError,
      requestDeleteNode,
      runnableAgents,
      settings,
      updateNodeData,
    ],
  );
}
