import type { WorkshopNode } from '../canvas/CanvasNode.js';
import type { WorkflowStartInput } from '../../../../../shared/workflow/contracts.js';
import type { WorkflowExecutionView } from '../../../../../shared/workflow/contracts.js';
import type { WorkshopEdge } from '../model/types.js';
import { descendantIds } from '../canvas/interactions/groups/group-containment.js';

export interface WorkflowNodeEligibility {
  readonly runnable: boolean;
  readonly reason: string;
}

/**
 * Resolves why an agent node cannot launch right now (for example its
 * provider connection is disconnected), or null when nothing blocks it.
 */
export type AgentRunBlockReason = (node: WorkshopNode) => string | null;

export interface WorkflowSelectionEligibility extends WorkflowNodeEligibility {
  readonly scope?: WorkflowStartInput['scope'];
}

export function workflowExecutionMatchesCurrentCanvas(
  execution: Pick<WorkflowExecutionView, 'canvasUpdatedAt'> | null,
  persistedCanvasUpdatedAt: string | null,
  hasUnsavedLocalMutation: boolean,
): boolean {
  return (
    execution !== null &&
    persistedCanvasUpdatedAt !== null &&
    !hasUnsavedLocalMutation &&
    execution.canvasUpdatedAt === persistedCanvasUpdatedAt
  );
}

export function workflowNodeEligibility(
  node: WorkshopNode,
  edges: readonly WorkshopEdge[],
  allNodes: readonly WorkshopNode[] = [],
  agentRunBlockReason?: AgentRunBlockReason,
): WorkflowNodeEligibility {
  if (node.data.kind === 'agent') {
    const blocked = agentRunBlockReason?.(node) ?? null;
    return blocked === null
      ? { runnable: true, reason: 'Run this node and everything it depends on' }
      : { runnable: false, reason: blocked };
  }
  if (node.data.kind === 'test' || node.data.kind === 'review-gate') {
    return { runnable: true, reason: 'Run this node and everything it depends on' };
  }
  if (
    node.data.kind === 'diff' &&
    edges.some(
      (edge) =>
        edge.target === node.id &&
        edge.data?.edgeType === 'review' &&
        edge.data.config.reviewer === 'human' &&
        edge.data.config.requireApproval,
    )
  ) {
    return { runnable: true, reason: 'Run this review together with its source workflow' };
  }
  if (node.data.kind === 'task') {
    const assigneeId = taskAssigneeId(node);
    if (assigneeId === undefined) {
      return {
        runnable: false,
        reason: 'Choose an agent for this task before running it.',
      };
    }
    const assignee = allNodes.find(
      (candidate) => candidate.id === assigneeId && candidate.data.kind === 'agent',
    );
    if (assignee === undefined) {
      return {
        runnable: false,
        reason: 'The agent chosen for this task is missing or is no longer an agent node.',
      };
    }
    const blocked = agentRunBlockReason?.(assignee) ?? null;
    if (blocked !== null) return { runnable: false, reason: blocked };
    return {
      runnable: true,
      reason: 'Run this task with its assigned agent and everything it depends on',
    };
  }
  return {
    runnable: false,
    reason: `${node.data.title} only holds information on the canvas, so there is nothing to run.`,
  };
}

export function runnableWorkflowNodeCount(
  nodes: readonly WorkshopNode[],
  edges: readonly WorkshopEdge[],
  agentRunBlockReason?: AgentRunBlockReason,
): number {
  return nodes.filter(
    (node) => workflowNodeEligibility(node, edges, nodes, agentRunBlockReason).runnable,
  ).length;
}

export function workflowSelectionEligibility(
  selectedNodes: readonly WorkshopNode[],
  allNodes: readonly WorkshopNode[],
  edges: readonly WorkshopEdge[],
  agentRunBlockReason?: AgentRunBlockReason,
): WorkflowSelectionEligibility {
  if (selectedNodes.length === 0) {
    return { runnable: false, reason: 'Select a node that can run' };
  }
  if (selectedNodes.length === 1 && selectedNodes[0]?.data.kind === 'group-frame') {
    const group = selectedNodes[0];
    const childIds = descendantIds(allNodes, group.id);
    const runnableChildren = allNodes.filter(
      (node) =>
        childIds.includes(node.id) &&
        workflowNodeEligibility(node, edges, allNodes, agentRunBlockReason).runnable,
    );
    return runnableChildren.length === 0
      ? {
          runnable: false,
          reason: `${group.data.title} does not contain any nodes that can run.`,
        }
      : {
          runnable: true,
          reason: `Run ${String(runnableChildren.length)} node${runnableChildren.length === 1 ? '' : 's'} in this group`,
          scope: { kind: 'group', groupId: group.id, includeUpstream: true },
        };
  }
  for (const node of selectedNodes) {
    const eligibility = workflowNodeEligibility(node, edges, allNodes, agentRunBlockReason);
    if (!eligibility.runnable) return eligibility;
  }
  const ids = [...new Set(selectedNodes.map((node) => node.id))].sort((left, right) =>
    left.localeCompare(right),
  );
  return ids.length === 1
    ? {
        runnable: true,
        reason: 'Run this node and everything it depends on',
        scope: { kind: 'node', nodeId: ids[0]!, includeUpstream: true },
      }
    : {
        runnable: true,
        reason: `Run these ${String(ids.length)} selected nodes and everything they depend on`,
        scope: { kind: 'selection', nodeIds: ids, includeUpstream: true },
      };
}

function taskAssigneeId(node: WorkshopNode): string | undefined {
  const value = node.data['assigneeId'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
