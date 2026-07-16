import { describe, expect, it } from 'vitest';

import {
  CollaborationMetadataSnapshotSchema,
  type CollaborationMetadataSnapshot,
} from '../../../../../shared/collaboration/index.js';
import { preserveRemoteCollaborationMetadata } from './outgoing-snapshot.js';

const NOW = '2026-07-15T12:00:00.000Z';

describe('preserveRemoteCollaborationMetadata', () => {
  it('round-trips safe fields that the local canvas cannot author without adopting file bindings', () => {
    const local = snapshot();
    const localFile = local.nodes['file-1'];
    if (localFile === undefined) throw new Error('Missing file fixture.');
    const remote = snapshot({
      canvas: { ...local.canvas, theme: 'dark' },
      nodes: {
        ...local.nodes,
        'file-1': {
          ...localFile,
          localResourceId: '00000000-0000-4000-8000-000000000099',
          availability: 'unavailable',
          order: 8,
          taskId: 'task-1',
        },
      },
      groups: {
        'group-1': {
          id: 'group-1',
          title: 'Group',
          position: { x: 0, y: 0 },
          size: { width: 400, height: 300 },
          collapsed: true,
          order: 3,
        },
      },
      workflow: {
        'workflow-1': {
          id: 'workflow-1',
          nodeId: 'task-1',
          status: 'running',
          updatedAt: NOW,
        },
      },
      reviews: {
        'review-1': {
          id: 'review-1',
          nodeId: 'task-1',
          reviewerId: 'reviewer-1',
          status: 'pending',
          createdAt: NOW,
        },
      },
    });

    const result = preserveRemoteCollaborationMetadata(local, remote);

    expect(result.canvas.theme).toBe('dark');
    expect(result.nodes['file-1']).toMatchObject({
      availability: 'unavailable',
      order: 8,
      taskId: 'task-1',
    });
    expect(result.nodes['file-1']).not.toHaveProperty('localResourceId');
    expect(result.groups['group-1']).toMatchObject({ collapsed: true, order: 3 });
    expect(result.workflow).toHaveProperty('workflow-1');
    expect(result.reviews).toHaveProperty('review-1');
  });

  it('does not resurrect remote-only graph, workflow, or review records after local deletion', () => {
    const remote = snapshot();
    const local = snapshot({
      nodes: {},
      edges: {},
      groups: {},
      tasks: {},
      comments: {},
      workflow: {},
      reviews: {},
    });
    const result = preserveRemoteCollaborationMetadata(local, remote);
    expect(result.nodes).toEqual({});
    expect(result.workflow).toEqual({});
    expect(result.reviews).toEqual({});
  });
});

function snapshot(
  overrides: Partial<CollaborationMetadataSnapshot> = {},
): CollaborationMetadataSnapshot {
  return CollaborationMetadataSnapshotSchema.parse({
    canvas: { id: 'canvas-1', title: 'Canvas', version: 1, updatedAt: NOW },
    nodes: {
      'task-1': {
        id: 'task-1',
        type: 'task',
        title: 'Task',
        position: { x: 0, y: 0 },
      },
      'file-1': {
        id: 'file-1',
        type: 'file',
        title: 'File',
        position: { x: 10, y: 10 },
        availability: 'metadata-only',
      },
    },
    edges: {},
    groups: {
      'group-1': {
        id: 'group-1',
        title: 'Group',
        position: { x: 0, y: 0 },
        size: { width: 400, height: 300 },
      },
    },
    tasks: {
      'task-1': { id: 'task-1', title: 'Task', status: 'ready' },
    },
    comments: {},
    workflow: {},
    reviews: {},
    ...overrides,
  });
}
