import { describe, expect, it } from 'vitest';

import {
  CanvasNodeSchema,
  CanvasSchema,
  ExecuteEdgeSchema,
  ProjectSchema,
  type CanvasNodeType,
} from './domain.js';

const NOW = '2026-07-14T12:00:00.000Z';

const baseNode = {
  title: 'Node',
  color: '#445566',
  icon: 'box',
  position: { x: 0, y: 0 },
  size: { width: 320, height: 200 },
  createdAt: NOW,
  updatedAt: NOW,
};

const nodeInputs: readonly Record<string, unknown>[] = [
  {
    ...baseNode,
    id: 'agent-1',
    type: 'agent',
    data: { adapterId: 'codex', permissionProfileId: 'worktree' },
  },
  { ...baseNode, id: 'brief-1', type: 'product-brief', data: {} },
  { ...baseNode, id: 'task-1', type: 'task', data: {} },
  {
    ...baseNode,
    id: 'file-1',
    type: 'file',
    data: { file: { projectId: 'project-1', relativePath: 'src/index.ts', kind: 'file' } },
  },
  {
    ...baseNode,
    id: 'diff-1',
    type: 'diff-review',
    data: { baseRef: 'main', headRef: 'feature', worktreeId: 'worktree-1' },
  },
  {
    ...baseNode,
    id: 'terminal-1',
    type: 'terminal',
    data: { permissionProfileId: 'worktree' },
  },
  { ...baseNode, id: 'web-1', type: 'web-preview', data: { worktreeId: 'worktree-1' } },
  {
    ...baseNode,
    id: 'mobile-1',
    type: 'mobile-preview',
    data: {
      worktreeId: 'worktree-1',
      viewports: [
        { id: 'phone-1', name: 'Phone', width: 390, height: 844, orientation: 'portrait' },
      ],
    },
  },
  {
    ...baseNode,
    id: 'test-1',
    type: 'test',
    data: { command: { executable: 'pnpm', args: ['test'] } },
  },
  {
    ...baseNode,
    id: 'gate-1',
    type: 'review-gate',
    data: { retryPolicy: { maximumIterations: 3, backoffMs: 0 } },
  },
  {
    ...baseNode,
    id: 'git-1',
    type: 'git-pr',
    data: { worktreeId: 'worktree-1', branch: 'feature', baseBranch: 'main' },
  },
  { ...baseNode, id: 'diagram-1', type: 'diagram', data: {} },
  { ...baseNode, id: 'board-1', type: 'whiteboard-mockup', data: { excalidraw: { elements: [] } } },
  { ...baseNode, id: 'note-1', type: 'note-image', data: {} },
  { ...baseNode, id: 'frame-1', type: 'group-frame', data: { purpose: 'feature-area' } },
];

describe('domain schemas', () => {
  it('parses all 15 required node types and applies safe defaults', () => {
    const nodes = nodeInputs.map((node) => CanvasNodeSchema.parse(node));
    const types = nodes.map((node) => node.type).sort();
    const expected: CanvasNodeType[] = [
      'agent',
      'product-brief',
      'task',
      'file',
      'diff-review',
      'terminal',
      'web-preview',
      'mobile-preview',
      'test',
      'review-gate',
      'git-pr',
      'diagram',
      'whiteboard-mockup',
      'note-image',
      'group-frame',
    ];

    expect(types).toEqual([...expected].sort());
    expect(nodes.every((node) => node.comments.length === 0)).toBe(true);
    expect(nodes.every((node) => node.resources.cpuUnits === 1)).toBe(true);
  });

  it('rejects unknown node fields instead of silently persisting them', () => {
    expect(() =>
      CanvasNodeSchema.parse({
        ...nodeInputs[0],
        repositoryFileContents: 'must not be accepted as accidental metadata',
      }),
    ).toThrow();
  });

  it('requires the project default canvas to be owned by the project', () => {
    const project = {
      schemaVersion: 1,
      id: 'project-1',
      name: 'Example',
      repository: {
        path: '/repo',
        canonicalPath: '/repo',
        status: 'available',
        lastVerifiedAt: NOW,
      },
      canvasIds: ['canvas-1'],
      defaultCanvasId: 'canvas-2',
      settingsId: 'settings-1',
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(ProjectSchema.safeParse(project).success).toBe(false);
  });

  it('requires an actual review gate reference for gated execution', () => {
    const edge = {
      id: 'edge-1',
      sourceNodeId: 'task-1',
      targetNodeId: 'agent-1',
      type: 'execute',
      config: { approval: 'review-gate' },
      createdAt: NOW,
    };
    expect(ExecuteEdgeSchema.safeParse(edge).success).toBe(false);
  });

  it('rejects unsupported persisted schema versions', () => {
    const canvas = {
      schemaVersion: 2,
      id: 'canvas-1',
      projectId: 'project-1',
      name: 'Canvas',
      viewState: { viewport: { x: 0, y: 0, zoom: 1 } },
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(CanvasSchema.safeParse(canvas).success).toBe(false);
  });
});
