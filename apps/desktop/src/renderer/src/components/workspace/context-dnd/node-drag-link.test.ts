import { describe, expect, it } from 'vitest';

import type { WorkshopNode } from '../canvas/CanvasNode.js';
import { resolveFileNodeContextDrop } from './node-drag-link.js';

const PROJECT_ID = '70000000-0000-4000-8000-000000000001';

describe('resolveFileNodeContextDrop', () => {
  it('links an ordinary same-project File node whose center is dropped on an Agent', () => {
    const source = fileNode({ x: 220, y: 120 });
    const target = agentNode({ x: 200, y: 100 });

    expect(
      resolveFileNodeContextDrop({
        projectId: PROJECT_ID,
        source,
        draggedNodes: [source],
        nodes: [source, target],
      }),
    ).toEqual({
      ok: true,
      targetNodeId: target.id,
      payload: {
        schemaVersion: 1,
        kind: 'project-file',
        projectId: PROJECT_ID,
        relativePath: 'src/context.ts',
        sourceNodeId: source.id,
      },
    });
  });

  it('preserves ordinary movement when the File node is not dropped on an Agent', () => {
    const source = fileNode({ x: 0, y: 0 });
    expect(
      resolveFileNodeContextDrop({
        projectId: PROJECT_ID,
        source,
        draggedNodes: [source],
        nodes: [source, agentNode({ x: 400, y: 400 })],
      }),
    ).toBeNull();
  });

  it('does not link to an Agent that is part of the same multi-node drag', () => {
    const source = fileNode({ x: 220, y: 120 });
    const target = agentNode({ x: 200, y: 100 });
    expect(
      resolveFileNodeContextDrop({
        projectId: PROJECT_ID,
        source,
        draggedNodes: [source, target],
        nodes: [source, target],
      }),
    ).toBeNull();
  });

  it.each([
    {
      label: 'cross-project source',
      source: fileNode({ x: 220, y: 120 }, { projectId: '80000000-0000-4000-8000-000000000001' }),
      target: agentNode({ x: 200, y: 100 }),
      message: /another project/u,
    },
    {
      label: 'missing source',
      source: fileNode({ x: 220, y: 120 }, { missing: true }),
      target: agentNode({ x: 200, y: 100 }),
      message: /replacement/u,
    },
    {
      label: 'directory source',
      source: fileNode({ x: 220, y: 120 }, { kind: 'directory' }),
      target: agentNode({ x: 200, y: 100 }),
      message: /regular files/u,
    },
    {
      label: 'locked target',
      source: fileNode({ x: 220, y: 120 }),
      target: agentNode({ x: 200, y: 100 }, true),
      message: /Unlock the agent/u,
    },
  ])('rejects a $label after an intentional Agent collision', ({ source, target, message }) => {
    const result = resolveFileNodeContextDrop({
      projectId: PROJECT_ID,
      source,
      draggedNodes: [source],
      nodes: [source, target],
    });
    expect(result).toMatchObject({ ok: false });
    expect(result && !result.ok ? result.message : '').toMatch(message);
  });
});

function fileNode(
  position: { readonly x: number; readonly y: number },
  overrides: Partial<NonNullable<WorkshopNode['data']['file']>> = {},
): WorkshopNode {
  return {
    id: 'file-1',
    type: 'workshop',
    position,
    measured: { width: 100, height: 60 },
    data: {
      kind: 'file',
      title: 'context.ts',
      description: 'File',
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#667788',
      file: {
        projectId: PROJECT_ID,
        relativePath: 'src/context.ts',
        kind: 'file',
        missing: false,
        ...overrides,
      },
    },
  };
}

function agentNode(
  position: { readonly x: number; readonly y: number },
  locked = false,
): WorkshopNode {
  return {
    id: 'agent-1',
    type: 'workshop',
    position,
    measured: { width: 180, height: 100 },
    data: {
      kind: 'agent',
      title: 'Agent',
      description: 'Agent',
      status: 'idle',
      locked,
      collapsed: false,
      color: '#445566',
    },
  };
}
