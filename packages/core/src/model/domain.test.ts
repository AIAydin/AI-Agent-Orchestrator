import { describe, expect, it } from 'vitest';

import {
  CanvasEdgeSchema,
  CanvasNodeSchema,
  CanvasSchema,
  DiffReviewTargetSchema,
  ExecuteEdgeSchema,
  GitPullRequestDeliveryTargetSchema,
  ProjectSchema,
  type CanvasNodeType,
} from './domain.js';

const NOW = '2026-07-14T12:00:00.000Z';
const AGENT_RUN_ID = '11111111-1111-4111-8111-111111111111';

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
  {
    ...baseNode,
    id: 'extension-1',
    type: 'extension',
    data: {
      extensionId: 'example.tools',
      extensionVersion: '1.0.0',
      nodeTypeId: 'example-node',
      definition: { displayName: 'Example node', fields: [] },
      values: { enabled: true },
    },
  },
];

describe('domain schemas', () => {
  it('parses all 15 required node types plus declarative extensions and applies safe defaults', () => {
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
      'extension',
    ];

    expect(types).toEqual([...expected].sort());
    expect(nodes.every((node) => node.comments.length === 0)).toBe(true);
    expect(nodes.every((node) => node.resources.cpuUnits === 1)).toBe(true);
  });

  it('persists only opaque primary or agent-run Diff review targets', () => {
    expect(DiffReviewTargetSchema.parse({ kind: 'primary' })).toEqual({ kind: 'primary' });
    expect(DiffReviewTargetSchema.parse({ kind: 'agent-run', runId: AGENT_RUN_ID })).toEqual({
      kind: 'agent-run',
      runId: AGENT_RUN_ID,
    });

    const pathBearingTargets = [
      { kind: 'primary', root: '/private/repository' },
      { kind: 'primary', repositoryPath: 'C:\\repository' },
      { kind: 'primary', projectId: '22222222-2222-4222-8222-222222222222' },
      { kind: 'agent-run', runId: AGENT_RUN_ID, worktreePath: '/private/worktree' },
      { kind: 'agent-run', runId: AGENT_RUN_ID, cwd: '../renderer-selected-root' },
      { kind: 'agent-run', runId: AGENT_RUN_ID, worktreeId: 'renderer-worktree' },
      {
        kind: 'agent-worktree',
        projectId: '22222222-2222-4222-8222-222222222222',
        runId: AGENT_RUN_ID,
      },
      { kind: 'agent-run', runId: 'renderer-selected-folder' },
    ];
    for (const target of pathBearingTargets) {
      expect(DiffReviewTargetSchema.safeParse(target).success).toBe(false);
      expect(
        CanvasNodeSchema.safeParse({
          ...baseNode,
          id: 'unsafe-diff',
          type: 'diff-review',
          data: { reviewTarget: target },
        }).success,
      ).toBe(false);
    }
  });

  it('keeps legacy Diff drafts compatible while applying review presentation defaults', () => {
    const parsed = CanvasNodeSchema.parse({
      ...baseNode,
      id: 'legacy-diff',
      type: 'diff-review',
      data: { baseRef: 'main', headRef: 'feature', worktreeId: 'legacy-worktree' },
    });

    expect(parsed).toMatchObject({
      type: 'diff-review',
      data: { viewMode: 'split', showWhitespace: false, ignoreWhitespace: false },
    });
    if (parsed.type === 'diff-review') expect(parsed.data.reviewTarget).toBeUndefined();
  });

  it('persists only an opaque agent-run Git delivery target plus bounded UI configuration', () => {
    expect(
      GitPullRequestDeliveryTargetSchema.parse({ kind: 'agent-run', runId: AGENT_RUN_ID }),
    ).toEqual({ kind: 'agent-run', runId: AGENT_RUN_ID });
    const parsed = CanvasNodeSchema.parse({
      ...baseNode,
      id: 'git-delivery',
      type: 'git-pr',
      data: {
        deliveryTarget: { kind: 'agent-run', runId: AGENT_RUN_ID },
        remote: 'origin',
        destinationBranch: 'feature/remote-delivery',
        baseBranch: 'main',
        pullRequestTitle: 'Add safe remote delivery',
        pullRequestBody: 'Confirm the exact disclosed impact before publication.',
        pullRequestDraft: true,
        pullRequestUrl: 'https://github.com/forgeboard/example/pull/42',
      },
    });

    expect(parsed).toMatchObject({
      type: 'git-pr',
      data: {
        deliveryTarget: { kind: 'agent-run', runId: AGENT_RUN_ID },
        remote: 'origin',
        destinationBranch: 'feature/remote-delivery',
        baseBranch: 'main',
        pullRequestDraft: true,
      },
    });

    const unsafeData = [
      { deliveryTarget: { kind: 'agent-run', runId: AGENT_RUN_ID, worktreePath: '/tmp/run' } },
      { deliveryTarget: { kind: 'agent-run', runId: 'renderer-selected-folder' } },
      { deliveryTarget: { kind: 'agent-worktree', runId: AGENT_RUN_ID } },
      { remote: '../origin' },
      { destinationBranch: 'feature/.hidden/delivery' },
      { baseBranch: 'release.lock' },
      { pullRequestBody: 'unsafe\0body' },
      { pullRequestBody: 'x'.repeat(32_769) },
      { pullRequestUrl: 'file:///private/repository/pull/42' },
      { pullRequestUrl: 'https://token@example.com/owner/repository/pull/42' },
      { pullRequestUrl: 'https://example.com/owner/repository/pull/42?token=secret' },
      { pullRequestUrl: 'https://example.com/owner/repository/pull/42#deceptive' },
      { pullRequestUrl: 'https://example.com/owner/repository/issues/42' },
    ];
    for (const data of unsafeData) {
      expect(
        CanvasNodeSchema.safeParse({
          ...baseNode,
          id: 'unsafe-git-delivery',
          type: 'git-pr',
          data,
        }).success,
      ).toBe(false);
    }
  });

  it('opens legacy Git/PR nodes without manufacturing remote-delivery authority', () => {
    const parsed = CanvasNodeSchema.parse({
      ...baseNode,
      id: 'legacy-git-delivery',
      type: 'git-pr',
      data: {
        worktreeId: 'legacy-worktree',
        branch: 'legacy/agent-branch',
        baseBranch: 'main',
        commitIds: ['abcdef1'],
        ahead: 1,
      },
    });

    expect(parsed).toMatchObject({
      type: 'git-pr',
      data: {
        worktreeId: 'legacy-worktree',
        branch: 'legacy/agent-branch',
        commitIds: ['abcdef1'],
        ahead: 1,
        pullRequestDraft: false,
      },
    });
    if (parsed.type === 'git-pr') expect(parsed.data.deliveryTarget).toBeUndefined();
  });

  it('rejects unknown node fields instead of silently persisting them', () => {
    expect(() =>
      CanvasNodeSchema.parse({
        ...nodeInputs[0],
        repositoryFileContents: 'must not be accepted as accidental metadata',
      }),
    ).toThrow();
  });

  it('represents new operational nodes as honest drafts without fabricated local resources', () => {
    const draftTypes = [
      'agent',
      'file',
      'diff-review',
      'terminal',
      'web-preview',
      'mobile-preview',
      'test',
      'git-pr',
    ] as const;

    for (const [index, type] of draftTypes.entries()) {
      expect(
        CanvasNodeSchema.parse({
          ...baseNode,
          id: `draft-${index}`,
          type,
          data: {},
        }).type,
      ).toBe(type);
    }

    expect(
      CanvasNodeSchema.parse({ ...baseNode, id: 'gate-draft', type: 'review-gate', data: {} }),
    ).toMatchObject({ data: { retryPolicy: { maximumIterations: 3, backoffMs: 0 } } });
    expect(
      CanvasNodeSchema.parse({
        ...baseNode,
        id: 'whiteboard-draft',
        type: 'whiteboard-mockup',
        data: {},
      }),
    ).toMatchObject({ data: { excalidraw: {} } });
  });

  it('preserves independently optional Agent token categories', () => {
    expect(
      CanvasNodeSchema.parse({
        ...baseNode,
        id: 'agent-usage',
        type: 'agent',
        data: { tokenUsage: { cachedInputTokens: 12, totalTokens: 29 } },
      }),
    ).toMatchObject({ data: { tokenUsage: { cachedInputTokens: 12, totalTokens: 29 } } });
  });

  it('preserves schema-safe legacy edge metadata outside typed execution configuration', () => {
    expect(
      CanvasEdgeSchema.parse({
        id: 'edge-1',
        sourceNodeId: 'source',
        targetNodeId: 'target',
        type: 'context',
        config: {},
        inspector: { legacyColor: '#ff00aa', nested: { enabled: true } },
        createdAt: NOW,
      }),
    ).toMatchObject({
      config: { attachmentMode: 'explicit', required: true, attachmentIds: [] },
      inspector: { legacyColor: '#ff00aa', nested: { enabled: true } },
    });
    expect(
      CanvasEdgeSchema.parse({
        id: 'draft-revision',
        sourceNodeId: 'review',
        targetNodeId: 'implementation',
        type: 'revision',
        config: {},
        createdAt: NOW,
      }),
    ).toMatchObject({
      config: { actionableFeedbackRequired: true },
    });
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
