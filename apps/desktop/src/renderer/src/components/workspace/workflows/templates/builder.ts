import { MarkerType } from '@xyflow/react';
import { planWorkflowScope } from '@forgeboard/core/workflow-runtime';

import type { AppSettings } from '../../../../../../shared/application/contracts.js';
import { canonicalCanvasFromLegacy } from '../../../../../../shared/canvas/adapter.js';
import { NODE_DEFINITIONS, type WorkshopNode } from '../../canvas/CanvasNode.js';
import { createEdgeData, edgeDataForPersistence } from '../../model/edge-config.js';
import {
  initialWorkshopNodeDimensions,
  workshopNodeForPersistence,
} from '../../model/node-persistence.js';
import type { WorkshopEdge } from '../../model/types.js';
import { initialWorkflowNodeData } from '../workflow-node-config.js';
import {
  workflowTemplateById,
  type WorkflowTemplate,
  type WorkflowTemplateEdge,
  type WorkflowTemplateId,
} from './catalog.js';

export interface BuiltWorkflowTemplate {
  readonly template: WorkflowTemplate;
  readonly nodes: WorkshopNode[];
  readonly edges: WorkshopEdge[];
}

export function buildWorkflowTemplate(
  templateId: WorkflowTemplateId,
  settings: AppSettings,
  origin: { readonly x: number; readonly y: number },
  createId: () => string = () => crypto.randomUUID(),
): BuiltWorkflowTemplate {
  const template = workflowTemplateById(templateId);
  const ids = new Map(template.nodes.map((node) => [node.key, createId()] as const));
  const nodes = template.nodes.map((node) => {
    const id = requiredId(ids, node.key);
    const definition = NODE_DEFINITIONS[node.kind];
    return {
      id,
      type: 'workshop' as const,
      selected: false,
      position: { x: origin.x + node.x, y: origin.y + node.y },
      ...initialWorkshopNodeDimensions(node.kind),
      data: {
        kind: node.kind,
        title: node.title,
        description: node.description,
        status: 'idle' as const,
        locked: false,
        collapsed: false,
        color: definition.color,
        ...initialWorkflowNodeData(node.kind, id, settings),
        ...(node.prompt === undefined ? {} : { prompt: node.prompt }),
        ...(node.markdown === undefined ? {} : { markdown: node.markdown }),
        ...(node.kind === 'task'
          ? { taskStatus: 'backlog' as const, priority: 'normal' as const }
          : {}),
        ...(node.kind === 'mobile-preview'
          ? {
              previewPreset: 'iphone' as const,
              previewSecondaryPreset: 'tablet' as const,
              previewSideBySide: true,
            }
          : {}),
      },
    } satisfies WorkshopNode;
  });
  const edges = template.edges.map((edge) => buildEdge(edge, ids, createId));
  assertPersistableGraph(nodes, edges);
  return { template, nodes, edges };
}

function buildEdge(
  edge: WorkflowTemplateEdge,
  ids: ReadonlyMap<string, string>,
  createId: () => string,
): WorkshopEdge {
  const source = requiredId(ids, edge.source);
  const target = requiredId(ids, edge.target);
  const loopId = edge.revisionLoop === true ? createId() : undefined;
  const data = createEdgeData(edge.type, source, {
    config: {
      ...(edge.outputKind === undefined ? {} : { outputKind: edge.outputKind }),
      ...(edge.reviewer === undefined ? {} : { reviewer: edge.reviewer }),
      ...(loopId === undefined ? {} : { loopId }),
    },
    ...(loopId === undefined
      ? {}
      : {
          loop: {
            maximumAttempts: 3,
            stopConditions: ['review-approved', 'human-accepted'],
            humanEscapeInstructions:
              'After three attempts, pause and ask a human to accept the current result or cancel the workflow.',
          },
        }),
  });
  return {
    id: createId(),
    source,
    target,
    type: 'smoothstep',
    markerEnd: { type: MarkerType.ArrowClosed },
    label: edge.type,
    data,
  };
}

function assertPersistableGraph(
  nodes: readonly WorkshopNode[],
  edges: readonly WorkshopEdge[],
): void {
  const updatedAt = new Date().toISOString();
  const result = canonicalCanvasFromLegacy({
    id: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    name: 'Workflow template validation',
    nodes: nodes.map(workshopNodeForPersistence),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: edge.data?.edgeType ?? 'context',
      data: edgeDataForPersistence(edge.data),
    })),
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt,
  });
  if (!result.ok) {
    throw new Error(
      `Workflow template is not persistable: ${result.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  const eligibleNodeIds = result.canvas.nodes
    .filter((node) => ['agent', 'task', 'test', 'review-gate'].includes(node.type))
    .map((node) => node.id);
  planWorkflowScope(result.canvas, {
    planId: crypto.randomUUID(),
    scope: { kind: 'workflow' },
    eligibleNodeIds,
  });
}

function requiredId(ids: ReadonlyMap<string, string>, key: string): string {
  const id = ids.get(key);
  if (id === undefined) throw new Error(`Workflow template node is missing: ${key}`);
  return id;
}
