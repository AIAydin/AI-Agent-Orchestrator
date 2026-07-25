import { describe, expect, it } from 'vitest';

import type { WorkshopNode } from '../canvas/CanvasNode.js';
import { openProjectFileNode } from './open-file-node.js';

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';

function node(id: string, data: Partial<WorkshopNode['data']> = {}): WorkshopNode {
  return {
    id,
    type: 'workshop',
    selected: true,
    position: { x: 10, y: 20 },
    data: {
      kind: 'agent',
      title: `Node ${id}`,
      description: '',
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#445566',
      ...data,
    },
  };
}

describe('openProjectFileNode', () => {
  it('creates a minimal file node bound to the clicked project file', () => {
    const result = openProjectFileNode({
      projectId: PROJECT_ID,
      relativePath: 'src/app.ts',
      nodes: [node('agent-1')],
      newNodeId: 'file-node-1',
    });

    expect(result.kind).toBe('created');
    if (result.kind !== 'created') return;
    expect(result.nodeId).toBe('file-node-1');
    const created = result.nodes.find((candidate) => candidate.id === 'file-node-1');
    expect(created).toMatchObject({
      type: 'workshop',
      selected: true,
      data: {
        kind: 'file',
        description: 'app.ts',
        status: 'idle',
        locked: false,
        collapsed: false,
        file: {
          projectId: PROJECT_ID,
          relativePath: 'src/app.ts',
          kind: 'file',
          missing: false,
        },
      },
    });
    expect(created?.width).toBeGreaterThan(0);
    expect(created?.height).toBeGreaterThan(0);
    // Auto name comes from the shared pool and never collides with the roster.
    expect(created?.data.title).not.toBe('');
    expect(created?.data.title).not.toBe('Node agent-1');
    // The new node is the only selected one.
    expect(result.nodes.filter((candidate) => candidate.selected)).toHaveLength(1);
  });

  it('reuses the existing file node for the same project file', () => {
    const existing = node('file-node-1', {
      kind: 'file',
      file: { projectId: PROJECT_ID, relativePath: 'src/app.ts', kind: 'file', missing: false },
    });

    const result = openProjectFileNode({
      projectId: PROJECT_ID,
      relativePath: 'src/app.ts',
      nodes: [existing],
      newNodeId: 'file-node-2',
    });

    expect(result).toEqual({ kind: 'existing', nodeId: 'file-node-1' });
  });

  it('creates a fresh node when the path matches in another project only', () => {
    const foreign = node('file-node-1', {
      kind: 'file',
      file: {
        projectId: '00000000-0000-4000-8000-000000000002',
        relativePath: 'src/app.ts',
        kind: 'file',
        missing: false,
      },
    });

    const result = openProjectFileNode({
      projectId: PROJECT_ID,
      relativePath: 'src/app.ts',
      nodes: [foreign],
      newNodeId: 'file-node-2',
    });

    expect(result.kind).toBe('created');
  });
});
