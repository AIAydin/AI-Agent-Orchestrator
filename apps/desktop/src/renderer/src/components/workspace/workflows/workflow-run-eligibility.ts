import type { WorkshopNode } from '../canvas/CanvasNode.js';
import type { WorkflowStartInput } from '../../../../../shared/workflow/contracts.js';
import type { WorkflowExecutionView } from '../../../../../shared/workflow/contracts.js';
import type { WorkshopEdge } from '../model/types.js';

export interface WorkflowNodeEligibility {
  readonly runnable: boolean;
  readonly reason: string;
}

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
): WorkflowNodeEligibility {
  if (node.data.kind === 'agent' || node.data.kind === 'test' || node.data.kind === 'review-gate') {
    return { runnable: true, reason: 'Run this node with its upstream dependencies' };
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
    return { runnable: true, reason: 'Run this bound human review with its source workflow' };
  }
  if (node.data.kind === 'task') {
    const assigneeId = taskAssigneeId(node);
    if (assigneeId === undefined) {
      return {
        runnable: false,
        reason: 'Choose an Agent assignee before running this Task.',
      };
    }
    if (
      !allNodes.some((candidate) => candidate.id === assigneeId && candidate.data.kind === 'agent')
    ) {
      return {
        runnable: false,
        reason: 'The configured Task assignee is missing or is not an Agent node.',
      };
    }
    return {
      runnable: true,
      reason: 'Run this Task with its configured Agent assignee and upstream dependencies',
    };
  }
  return {
    runnable: false,
    reason: `${node.data.title} is a canvas/context node and does not launch a process.`,
  };
}

export function runnableWorkflowNodeCount(
  nodes: readonly WorkshopNode[],
  edges: readonly WorkshopEdge[],
): number {
  return nodes.filter((node) => workflowNodeEligibility(node, edges, nodes).runnable).length;
}

export function workflowSelectionEligibility(
  selectedNodes: readonly WorkshopNode[],
  allNodes: readonly WorkshopNode[],
  edges: readonly WorkshopEdge[],
): WorkflowSelectionEligibility {
  if (selectedNodes.length === 0) {
    return { runnable: false, reason: 'Select a runnable workflow node' };
  }
  if (selectedNodes.length === 1 && selectedNodes[0]?.data.kind === 'group-frame') {
    const group = selectedNodes[0];
    const childIds = stringIds(group.data['childNodeIds']);
    const runnableChildren = allNodes.filter(
      (node) =>
        childIds.includes(node.id) && workflowNodeEligibility(node, edges, allNodes).runnable,
    );
    return runnableChildren.length === 0
      ? {
          runnable: false,
          reason: `${group.data.title} does not contain any runnable workflow nodes.`,
        }
      : {
          runnable: true,
          reason: `Run ${String(runnableChildren.length)} runnable node${runnableChildren.length === 1 ? '' : 's'} in this group`,
          scope: { kind: 'group', groupId: group.id, includeUpstream: true },
        };
  }
  for (const node of selectedNodes) {
    const eligibility = workflowNodeEligibility(node, edges, allNodes);
    if (!eligibility.runnable) return eligibility;
  }
  const ids = [...new Set(selectedNodes.map((node) => node.id))].sort((left, right) =>
    left.localeCompare(right),
  );
  return ids.length === 1
    ? {
        runnable: true,
        reason: 'Run this node with its upstream dependencies',
        scope: { kind: 'node', nodeId: ids[0]!, includeUpstream: true },
      }
    : {
        runnable: true,
        reason: `Run these ${String(ids.length)} selected nodes with their upstream dependencies`,
        scope: { kind: 'selection', nodeIds: ids, includeUpstream: true },
      };
}

function stringIds(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

function taskAssigneeId(node: WorkshopNode): string | undefined {
  const value = node.data['assigneeId'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
