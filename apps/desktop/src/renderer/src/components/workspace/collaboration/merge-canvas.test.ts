import { describe, expect, it } from 'vitest';

import type { CanvasDocument } from '../../../../../shared/application/contracts.js';
import {
  CollaborationMetadataSnapshotSchema,
  type CollaborationMetadataSnapshot,
} from '../../../../../shared/collaboration/index.js';
import { mergeCollaborationCanvasSnapshot } from './merge-canvas.js';

const NOW = '2026-07-15T12:00:00.000Z';
const CANVAS_ID = '70000000-0000-4000-8000-000000000002';
const PROJECT_ID = '70000000-0000-4000-8000-000000000001';

describe('mergeCollaborationCanvasSnapshot', () => {
  it('applies safe shared metadata while preserving machine-local typed data', () => {
    const result = mergeCollaborationCanvasSnapshot(document(), snapshot(), {
      initial: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const agent = result.document.nodes.find((node) => node.id === 'agent-1');
    expect(agent).toMatchObject({
      position: { x: 110, y: 120 },
      width: 360,
      height: 220,
      data: {
        title: 'Shared agent title',
        prompt: 'PRIVATE_PROMPT',
        repositoryPath: '/Users/private/repository',
        token: 'PRIVATE_TOKEN',
        locked: true,
      },
    });
    expect(result.document.canonical?.nodes.find((node) => node.id === 'agent-1')).toMatchObject({
      comments: [
        {
          id: 'comment-1',
          authorId: 'editor-2',
          body: 'Review this node',
          resolvedAt: NOW,
        },
      ],
      inspector: {
        collaboration: {
          workflow: [{ id: 'workflow-1', status: 'running' }],
          reviews: [{ id: 'review-1', status: 'changes-requested' }],
        },
      },
    });

    const file = result.document.nodes.find((node) => node.id === 'file-remote');
    expect(file?.data).toMatchObject({
      kind: 'file',
      readOnly: true,
    });
    expect(file?.data['recoverableWarning']).toMatch(/metadata only/u);
    expect(file?.data).not.toHaveProperty('file');
    expect(JSON.stringify(file)).not.toContain('/Users/');

    expect(result.document.canonical?.groups).toEqual([
      expect.objectContaining({ id: 'group-1', nodeIds: ['agent-1'] }),
    ]);
    expect(result.document.nodes.find((node) => node.id === 'group-1')).toMatchObject({
      data: {
        kind: 'group-frame',
        purpose: 'feature-area',
        childNodeIds: ['agent-1'],
        layout: 'grid',
        autoFit: true,
      },
    });
    expect(result.document.canonical?.nodes.find((node) => node.id === 'group-1')).toMatchObject({
      type: 'group-frame',
      collapsed: true,
      data: {
        purpose: 'feature-area',
        childNodeIds: ['agent-1'],
        layout: 'grid',
        autoFit: true,
      },
    });
    expect(result.document.canonical?.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'edge-remote',
          label: 'Shared context',
          status: 'running',
        }),
      ]),
    );
  });

  it('unions unsent local work only for the first room snapshot', () => {
    const initial = mergeCollaborationCanvasSnapshot(document(), snapshot(), {
      initial: true,
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    expect(initial.document.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining(['agent-1', 'local-task', 'local-extension', 'file-remote']),
    );
    expect(initial.document.edges.map((edge) => edge.id)).toEqual(
      expect.arrayContaining(['local-edge', 'extension-edge', 'edge-remote']),
    );

    const later = mergeCollaborationCanvasSnapshot(document(), snapshot(), {
      initial: false,
    });
    expect(later.ok).toBe(true);
    if (!later.ok) return;
    expect(later.document.nodes.map((node) => node.id)).not.toContain('local-task');
    expect(later.document.edges.map((edge) => edge.id)).not.toContain('local-edge');
    expect(later.document.nodes.map((node) => node.id)).toContain('local-extension');
    expect(later.document.edges.map((edge) => edge.id)).toContain('extension-edge');
  });

  it('rejects a snapshot for a different canvas without mutating local state', () => {
    const foreign = snapshot({
      canvas: {
        ...snapshot().canvas,
        id: 'foreign-canvas',
      },
    });
    expect(mergeCollaborationCanvasSnapshot(document(), foreign, { initial: true })).toEqual({
      ok: false,
      message: 'The collaboration room snapshot belongs to a different canvas.',
    });
  });

  it('propagates task unassignment instead of reviving a stale legacy assignee', () => {
    const local = document();
    const localTask = local.nodes.find((node) => node.id === 'local-task');
    if (localTask === undefined) throw new Error('Missing task fixture.');
    const shared = snapshot();
    const unassigned = CollaborationMetadataSnapshotSchema.parse({
      ...shared,
      nodes: {
        ...shared.nodes,
        'local-task': {
          id: 'local-task',
          type: 'task',
          title: 'Shared task',
          position: { x: 20, y: 30 },
        },
      },
      tasks: {
        'local-task': {
          id: 'local-task',
          title: 'Shared task',
          status: 'ready',
        },
      },
    });
    const result = mergeCollaborationCanvasSnapshot(
      {
        ...local,
        nodes: [
          ...local.nodes.filter((node) => node.id !== 'local-task'),
          { ...localTask, data: { ...localTask.data, assigneeId: 'editor-1' } },
        ],
      },
      unassigned,
      { initial: false },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const task = result.document.nodes.find((node) => node.id === 'local-task');
    expect(task?.data).not.toHaveProperty('assigneeId');
    expect(
      result.document.canonical?.nodes.find((node) => node.id === 'local-task')?.data,
    ).not.toHaveProperty('assigneeId');
  });

  it('removes stale workflow and review metadata after the room deletes it', () => {
    const first = mergeCollaborationCanvasSnapshot(document(), snapshot(), {
      initial: false,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(
      first.document.canonical?.nodes.find((node) => node.id === 'agent-1')?.inspector,
    ).toHaveProperty('collaboration');
    const shared = snapshot();
    const cleared = CollaborationMetadataSnapshotSchema.parse({
      ...shared,
      workflow: {},
      reviews: {},
    });

    const second = mergeCollaborationCanvasSnapshot(first.document, cleared, {
      initial: false,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(
      second.document.canonical?.nodes.find((node) => node.id === 'agent-1')?.inspector,
    ).not.toHaveProperty('collaboration');
  });

  it('replaces stale local group-frame behavior and membership on every remote snapshot', () => {
    const local = document();
    const staleFrame: CanvasDocument['nodes'][number] = {
      id: 'group-1',
      type: 'group-frame',
      position: { x: 0, y: 0 },
      width: 380,
      height: 260,
      data: {
        kind: 'group-frame',
        title: 'Stale local group',
        color: '#223344',
        purpose: 'custom',
        childNodeIds: ['local-task', 'local-extension'],
        layout: 'horizontal',
        autoFit: false,
        localOnlyNote: 'PRIVATE_LOCAL_GROUP_NOTE',
      },
    };
    const first = mergeCollaborationCanvasSnapshot(
      { ...local, nodes: [...local.nodes, staleFrame] },
      snapshot(),
      { initial: false },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.document.nodes.find((node) => node.id === 'group-1')?.data).toMatchObject({
      purpose: 'feature-area',
      childNodeIds: ['agent-1', 'local-extension'],
      layout: 'grid',
      autoFit: true,
      localOnlyNote: 'PRIVATE_LOCAL_GROUP_NOTE',
    });

    const shared = snapshot();
    const agent = shared.nodes['agent-1'];
    const file = shared.nodes['file-remote'];
    const group = shared.groups['group-1'];
    if (agent === undefined || file === undefined || group === undefined) {
      throw new Error('Missing collaboration group fixture.');
    }
    const ungroupedAgent = { ...agent };
    delete ungroupedAgent.groupId;
    const updated = CollaborationMetadataSnapshotSchema.parse({
      ...shared,
      nodes: {
        ...shared.nodes,
        'agent-1': ungroupedAgent,
        'file-remote': { ...file, groupId: 'group-1' },
      },
      groups: {
        'group-1': {
          ...group,
          purpose: 'product-surface',
          layout: 'vertical',
          autoFit: false,
        },
      },
    });
    const second = mergeCollaborationCanvasSnapshot(first.document, updated, {
      initial: false,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const frame = second.document.canonical?.nodes.find((node) => node.id === 'group-1');
    expect(frame).toMatchObject({
      type: 'group-frame',
      data: {
        purpose: 'product-surface',
        childNodeIds: ['file-remote', 'local-extension'],
        layout: 'vertical',
        autoFit: false,
      },
    });
    expect(second.document.canonical?.groups).toEqual([
      expect.objectContaining({
        id: 'group-1',
        nodeIds: ['file-remote', 'local-extension'],
      }),
    ]);
    expect(
      second.document.canonical?.nodes.find((node) => node.id === 'agent-1'),
    ).not.toHaveProperty('groupId');
    expect(
      second.document.canonical?.nodes.find((node) => node.id === 'file-remote'),
    ).toMatchObject({
      groupId: 'group-1',
    });
    expect(
      second.document.canonical?.nodes.find((node) => node.id === 'local-extension'),
    ).toMatchObject({ groupId: 'group-1' });
  });

  it('accepts older group metadata and clears unsupported stale frame settings to safe defaults', () => {
    const shared = snapshot();
    const group = shared.groups['group-1'];
    if (group === undefined) throw new Error('Missing collaboration group fixture.');
    const legacyGroup = { ...group };
    delete legacyGroup.purpose;
    delete legacyGroup.layout;
    delete legacyGroup.autoFit;
    const legacySnapshot = CollaborationMetadataSnapshotSchema.parse({
      ...shared,
      groups: { 'group-1': legacyGroup },
    });

    const result = mergeCollaborationCanvasSnapshot(document(), legacySnapshot, {
      initial: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes.find((node) => node.id === 'group-1')?.data).toMatchObject({
      purpose: 'custom',
      childNodeIds: ['agent-1'],
      layout: 'freeform',
      autoFit: false,
    });
  });

  it('normalizes remote node and group geometry to the same rendered bounds contract', () => {
    const shared = snapshot();
    const agent = shared.nodes['agent-1'];
    const frame = shared.nodes['group-1'];
    const group = shared.groups['group-1'];
    if (agent === undefined || frame === undefined || group === undefined) {
      throw new Error('Missing collaboration group fixture.');
    }
    const frameWithoutCollapsed = { ...frame };
    delete frameWithoutCollapsed.collapsed;
    const normalizedInput = CollaborationMetadataSnapshotSchema.parse({
      ...shared,
      nodes: {
        ...shared.nodes,
        'agent-1': { ...agent, size: { width: 1, height: 1 } },
        'group-1': { ...frameWithoutCollapsed, size: { width: 2, height: 2 } },
      },
      groups: {
        'group-1': {
          ...group,
          size: { width: 3, height: 3 },
          collapsed: true,
        },
      },
    });

    const result = mergeCollaborationCanvasSnapshot(document(), normalizedInput, {
      initial: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes.find((node) => node.id === 'agent-1')).toMatchObject({
      width: 210,
      height: 92,
    });
    expect(result.document.nodes.find((node) => node.id === 'group-1')).toMatchObject({
      width: 360,
      height: 240,
      data: { collapsed: true },
    });
    expect(result.document.canonical?.groups.find(({ id }) => id === 'group-1')).toMatchObject({
      position: { x: 80, y: 90 },
      size: { width: 360, height: 240 },
    });
  });

  it('indexes large bounded workflow, review, and group membership sets before merging', () => {
    const count = 500;
    const groupId = 'performance-group';
    const nodes = {
      ...Object.fromEntries(
        Array.from({ length: count }, (_, index) => {
          const id = `agent-${index}`;
          return [
            id,
            {
              id,
              type: 'agent',
              title: `Agent ${index}`,
              position: { x: index, y: index },
              groupId,
            },
          ] as const;
        }),
      ),
      [groupId]: {
        id: groupId,
        type: 'group-frame',
        title: 'Performance group',
        position: { x: 0, y: 0 },
        size: { width: 2_000, height: 2_000 },
      },
    };
    const workflow = Object.fromEntries(
      Array.from({ length: count }, (_, index) => {
        const id = `workflow-${index}`;
        return [id, { id, nodeId: `agent-${index}`, status: 'running', updatedAt: NOW }];
      }),
    );
    const reviews = Object.fromEntries(
      Array.from({ length: count }, (_, index) => {
        const id = `review-${index}`;
        return [
          id,
          {
            id,
            nodeId: `agent-${index}`,
            reviewerId: 'reviewer-1',
            status: 'pending',
            createdAt: NOW,
          },
        ];
      }),
    );
    const shared = CollaborationMetadataSnapshotSchema.parse({
      canvas: {
        id: CANVAS_ID,
        title: 'Large canvas',
        version: 1,
        updatedAt: NOW,
      },
      nodes,
      edges: {},
      groups: {
        [groupId]: {
          id: groupId,
          title: 'Performance group',
          position: { x: 0, y: 0 },
          size: { width: 2_000, height: 2_000 },
        },
      },
      tasks: {},
      comments: {},
      workflow,
      reviews,
    });
    const local: CanvasDocument = {
      id: CANVAS_ID,
      projectId: PROJECT_ID,
      name: 'Large canvas',
      nodes: Object.values(shared.nodes).map((node) =>
        node.type === 'group-frame'
          ? {
              id: node.id,
              type: 'group-frame',
              position: node.position,
              data: {
                kind: 'group-frame',
                title: node.title,
                color: '#445566',
                purpose: 'custom',
                childNodeIds: [],
                layout: 'freeform',
                autoFit: false,
              },
            }
          : {
              id: node.id,
              type: 'agent',
              position: node.position,
              data: { kind: 'agent', title: node.title, color: '#445566' },
            },
      ),
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      updatedAt: NOW,
    };

    const result = mergeCollaborationCanvasSnapshot(local, shared, {
      initial: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes).toHaveLength(count + 1);
    expect(
      result.document.canonical?.nodes.find((node) => node.id === 'agent-499')?.inspector,
    ).toMatchObject({
      collaboration: {
        workflow: [expect.objectContaining({ id: 'workflow-499' })],
        reviews: [expect.objectContaining({ id: 'review-499' })],
      },
    });
    const frame = result.document.canonical?.nodes.find((node) => node.id === groupId);
    expect(frame).toMatchObject({ type: 'group-frame' });
    if (frame?.type !== 'group-frame') return;
    expect(frame.data.childNodeIds).toHaveLength(count);
    expect(new Set(frame.data.childNodeIds).size).toBe(count);
    expect(frame.data.childNodeIds).toContain('agent-499');
  });
});

function document(): CanvasDocument {
  return {
    id: CANVAS_ID,
    projectId: PROJECT_ID,
    name: 'Local canvas',
    nodes: [
      {
        id: 'agent-1',
        type: 'agent',
        position: { x: 10, y: 20 },
        width: 320,
        height: 180,
        data: {
          kind: 'agent',
          title: 'Local agent',
          color: '#445566',
          prompt: 'PRIVATE_PROMPT',
          repositoryPath: '/Users/private/repository',
          token: 'PRIVATE_TOKEN',
        },
      },
      {
        id: 'local-task',
        type: 'task',
        position: { x: 20, y: 30 },
        data: { kind: 'task', title: 'Unsent local task', color: '#223344' },
      },
      {
        id: 'local-extension',
        type: 'extension',
        position: { x: 30, y: 40 },
        data: {
          kind: 'extension',
          title: 'Local extension',
          color: '#334455',
          extensionId: 'local.extension',
          extensionVersion: '1.0.0',
          extensionNodeTypeId: 'custom',
          extensionDefinition: {},
          extensionValues: { secret: 'LOCAL_ONLY' },
          extensionAvailability: 'active',
        },
      },
    ],
    edges: [
      {
        id: 'local-edge',
        source: 'agent-1',
        target: 'local-task',
        type: 'context',
        data: {},
      },
      {
        id: 'extension-edge',
        source: 'local-extension',
        target: 'agent-1',
        type: 'context',
        data: {},
      },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt: NOW,
  };
}

function snapshot(
  overrides: Partial<CollaborationMetadataSnapshot> = {},
): CollaborationMetadataSnapshot {
  return CollaborationMetadataSnapshotSchema.parse({
    canvas: {
      id: CANVAS_ID,
      title: 'Shared canvas',
      version: 1,
      updatedAt: NOW,
      viewport: { x: 5, y: 6 },
      zoom: 1.25,
    },
    nodes: {
      'agent-1': {
        id: 'agent-1',
        type: 'agent',
        title: 'Shared agent title',
        position: { x: 110, y: 120 },
        size: { width: 360, height: 220 },
        color: '#112233',
        status: 'running',
        locked: true,
        groupId: 'group-1',
        createdAt: NOW,
        updatedAt: NOW,
      },
      'file-remote': {
        id: 'file-remote',
        type: 'file',
        title: 'Shared file metadata',
        position: { x: 400, y: 100 },
        availability: 'local',
      },
      'group-1': {
        id: 'group-1',
        type: 'group-frame',
        title: 'Shared group',
        position: { x: 80, y: 90 },
        size: { width: 450, height: 300 },
        color: '#556677',
        collapsed: true,
      },
    },
    edges: {
      'edge-remote': {
        id: 'edge-remote',
        sourceId: 'agent-1',
        targetId: 'file-remote',
        type: 'context',
        label: 'Shared context',
        status: 'active',
      },
    },
    groups: {
      'group-1': {
        id: 'group-1',
        title: 'Shared group',
        position: { x: 80, y: 90 },
        size: { width: 450, height: 300 },
        color: '#556677',
        collapsed: true,
        purpose: 'feature-area',
        layout: 'grid',
        autoFit: true,
      },
    },
    tasks: {},
    comments: {
      'comment-1': {
        id: 'comment-1',
        nodeId: 'agent-1',
        authorId: 'editor-2',
        body: 'Review this node',
        resolved: true,
        createdAt: NOW,
      },
    },
    workflow: {
      'workflow-1': {
        id: 'workflow-1',
        nodeId: 'agent-1',
        status: 'running',
        updatedAt: NOW,
      },
    },
    reviews: {
      'review-1': {
        id: 'review-1',
        nodeId: 'agent-1',
        reviewerId: 'editor-2',
        status: 'changes-requested',
        commentIds: ['comment-1'],
        createdAt: NOW,
      },
    },
    ...overrides,
  });
}
