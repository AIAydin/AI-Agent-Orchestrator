import { describe, expect, it } from 'vitest';

import { validateWorkflow } from '@forgeboard/core';
import { RunStatusSchema } from '@forgeboard/core/domain';

import {
  canonicalCanvasFromLegacy,
  legacySurfaceFromCanonical,
  synchronizeCanvasDocument,
} from './adapter.js';
import type { LegacyCanvasDocument, LegacyCanvasNode } from './types.js';

const T1 = '2026-07-15T12:00:00.000Z';
const T2 = '2026-07-15T12:01:00.000Z';
const AGENT_RUN_ID = '11111111-1111-4111-8111-111111111111';
const COMPETING_RUN_ID = '22222222-2222-4222-8222-222222222222';

function node(id: string, kind: string, data: Record<string, unknown> = {}): LegacyCanvasNode {
  return {
    id,
    type: kind,
    position: { x: 10, y: 20 },
    width: 320,
    height: 180,
    data: {
      kind,
      title: id,
      description: `${id} description`,
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#445566',
      ...data,
    },
  };
}

function legacy(overrides: Partial<LegacyCanvasDocument> = {}): LegacyCanvasDocument {
  return {
    id: 'canvas-1',
    projectId: 'project-1',
    name: 'Workshop',
    nodes: [node('brief-1', 'brief'), node('agent-1', 'agent')],
    edges: [
      {
        id: 'context-1',
        source: 'brief-1',
        target: 'agent-1',
        type: 'context',
      },
    ],
    viewport: { x: 3, y: 4, zoom: 1.2 },
    updatedAt: T1,
    ...overrides,
  };
}

describe('canonical desktop canvas adapter', () => {
  it('round-trips every canonical workflow lifecycle status without renderer collapse', () => {
    const initial = canonicalCanvasFromLegacy(legacy());
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;

    for (const status of RunStatusSchema.options) {
      const canonical = {
        ...initial.canvas,
        nodes: initial.canvas.nodes.map((candidate, index) =>
          index === 0 ? { ...candidate, status } : candidate,
        ),
      };
      const surface = legacySurfaceFromCanonical(canonical);
      expect(surface.nodes[0]?.data['status']).toBe(status);
      const reloaded = canonicalCanvasFromLegacy({ ...surface, canonical });
      expect(reloaded.ok).toBe(true);
      if (reloaded.ok) expect(reloaded.canvas.nodes[0]?.status).toBe(status);
    }
  });

  it('materializes stable canonical dimensions for an unresized legacy node', () => {
    const sized = node('task-1', 'task');
    const unresized: LegacyCanvasNode = {
      id: sized.id,
      type: sized.type,
      position: sized.position,
      data: sized.data,
    };
    const synchronized = synchronizeCanvasDocument(legacy({ nodes: [unresized], edges: [] }));

    expect(synchronized.ok).toBe(true);
    if (!synchronized.ok) return;
    expect(synchronized.document.nodes[0]).toMatchObject({ width: 320, height: 180 });
    expect(synchronized.document.canonical.nodes[0]?.size).toEqual({ width: 320, height: 180 });

    const reloaded = synchronizeCanvasDocument(synchronized.document);
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.document.nodes[0]).toMatchObject({ width: 320, height: 180 });
  });

  it('normalizes legacy group bounds to the shared default and rendering floor', () => {
    const sized = node('group-default', 'group-frame', { childNodeIds: [] });
    const unresized: LegacyCanvasNode = {
      id: sized.id,
      type: sized.type,
      position: sized.position,
      data: sized.data,
    };
    const undersized = {
      ...node('group-small', 'group-frame', { childNodeIds: [] }),
      width: 200,
      height: 100,
    };
    const synchronized = synchronizeCanvasDocument(
      legacy({ nodes: [unresized, undersized], edges: [] }),
    );

    expect(synchronized.ok).toBe(true);
    if (!synchronized.ok) return;
    expect(synchronized.document.nodes).toMatchObject([
      { id: 'group-default', width: 520, height: 360 },
      { id: 'group-small', width: 360, height: 240 },
    ]);
  });

  it('migrates legacy nodes and edges into a complete typed canvas without fake resources', () => {
    const migrated = canonicalCanvasFromLegacy(legacy());
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;

    expect(migrated.canvas).toMatchObject({
      schemaVersion: 1,
      id: 'canvas-1',
      projectId: 'project-1',
      viewState: { viewport: { x: 3, y: 4, zoom: 1.2 } },
      nodes: [
        { id: 'brief-1', type: 'product-brief', status: 'draft' },
        {
          id: 'agent-1',
          type: 'agent',
          status: 'draft',
          data: { contextAttachmentIds: [], promptDraft: '' },
        },
      ],
      edges: [
        {
          id: 'context-1',
          type: 'context',
          config: {
            attachmentMode: 'explicit',
            required: true,
            attachmentIds: ['brief-1'],
          },
        },
      ],
    });
    expect(migrated.canvas.nodes[1]?.inspector['legacyData']).toMatchObject({
      description: 'agent-1 description',
    });
  });

  it('preserves canonical-only workflow data while applying a newer renderer edit', () => {
    const initial = canonicalCanvasFromLegacy(legacy());
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const canonical = {
      ...initial.canvas,
      nodes: initial.canvas.nodes.map((candidate) =>
        candidate.id === 'agent-1' && candidate.type === 'agent'
          ? {
              ...candidate,
              status: 'ready' as const,
              comments: [
                {
                  id: 'comment-1',
                  authorId: 'local-user',
                  body: 'Keep this durable review note.',
                  createdAt: T1,
                },
              ],
              resources: { cpuUnits: 2, memoryMb: 1024, exclusiveKeys: ['worktree:agent-1'] },
              data: {
                ...candidate.data,
                tokenUsage: { inputTokens: 12, outputTokens: 8 },
              },
            }
          : candidate,
      ),
      groups: [
        {
          id: 'group-1',
          title: 'Implementation',
          nodeIds: ['agent-1'],
          position: { x: 0, y: 0 },
          size: { width: 500, height: 400 },
          color: '#556677',
          locked: false,
        },
      ],
      workflowLimits: { maximumConcurrency: 2, maximumCpuUnits: 8, maximumMemoryMb: 8192 },
      updatedAt: T1,
    };
    const surface = legacySurfaceFromCanonical(canonical);
    const edited = {
      ...surface,
      canonical,
      updatedAt: T2,
      nodes: surface.nodes.map((candidate) =>
        candidate.id === 'agent-1'
          ? { ...candidate, data: { ...candidate.data, title: 'Edited agent title' } }
          : candidate,
      ),
    };

    const migrated = canonicalCanvasFromLegacy(edited);
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    const agent = migrated.canvas.nodes.find((candidate) => candidate.id === 'agent-1');
    expect(agent).toMatchObject({
      title: 'Edited agent title',
      status: 'ready',
      comments: [{ body: 'Keep this durable review note.' }],
      resources: { cpuUnits: 2, memoryMb: 1024, exclusiveKeys: ['worktree:agent-1'] },
      data: { tokenUsage: { inputTokens: 12, outputTokens: 8 } },
    });
    expect(migrated.canvas.groups).toEqual(canonical.groups);
    expect(migrated.canvas.workflowLimits).toEqual(canonical.workflowLimits);
  });

  it('uses a newer canonical revision as authoritative and regenerates the renderer surface', () => {
    const initial = canonicalCanvasFromLegacy(legacy());
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const canonical = {
      ...initial.canvas,
      name: 'Canonical name',
      updatedAt: T2,
    };
    const synchronized = synchronizeCanvasDocument({
      ...legacy({ name: 'Stale renderer name' }),
      canonical,
    });

    expect(synchronized.ok).toBe(true);
    if (!synchronized.ok) return;
    expect(synchronized.document.name).toBe('Canonical name');
    expect(synchronized.document.canonical).toEqual(canonical);
    expect(synchronized.document.schemaVersion).toBe(2);
  });

  it('derives one canonical group owner from frame membership and removes stale ownership', () => {
    const initial = canonicalCanvasFromLegacy(
      legacy({
        nodes: [
          node('frame-a', 'group-frame', {
            childNodeIds: ['child-1', 'missing-child', 'frame-b', 'child-1'],
            purpose: 'feature-area',
            layout: 'horizontal',
            autoFit: true,
          }),
          node('frame-b', 'group-frame', {
            childNodeIds: ['child-1', 'child-2'],
            purpose: 'workflow-stage',
          }),
          node('child-1', 'task'),
          node('child-2', 'agent'),
        ],
        edges: [],
      }),
    );

    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    expect(initial.canvas.nodes.find((candidate) => candidate.id === 'frame-a')).toMatchObject({
      data: { childNodeIds: ['child-1', 'frame-b'] },
    });
    expect(initial.canvas.nodes.find((candidate) => candidate.id === 'frame-b')).toMatchObject({
      data: { childNodeIds: ['child-2'] },
    });
    expect(initial.canvas.nodes.find((candidate) => candidate.id === 'child-1')?.groupId).toBe(
      'frame-a',
    );
    expect(initial.canvas.nodes.find((candidate) => candidate.id === 'child-2')?.groupId).toBe(
      'frame-b',
    );
    expect(initial.canvas.nodes.find((candidate) => candidate.id === 'frame-b')?.groupId).toBe(
      'frame-a',
    );
    expect(initial.canvas.groups).toMatchObject([
      { id: 'frame-a', nodeIds: ['child-1', 'frame-b'], locked: false },
      { id: 'frame-b', nodeIds: ['child-2'], locked: false },
    ]);

    const edited = legacySurfaceFromCanonical(initial.canvas);
    const reconciled = canonicalCanvasFromLegacy({
      ...edited,
      canonical: initial.canvas,
      updatedAt: T2,
      nodes: edited.nodes.map((candidate) =>
        candidate.id === 'frame-a'
          ? { ...candidate, data: { ...candidate.data, childNodeIds: [] } }
          : candidate,
      ),
    });
    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) return;
    expect(
      reconciled.canvas.nodes.find((candidate) => candidate.id === 'child-1'),
    ).not.toHaveProperty('groupId');
    expect(reconciled.canvas.groups.find((group) => group.id === 'frame-a')?.nodeIds).toEqual([]);

    const deletedSurface = legacySurfaceFromCanonical(initial.canvas);
    const deletedFrame = canonicalCanvasFromLegacy({
      ...deletedSurface,
      canonical: initial.canvas,
      updatedAt: T2,
      nodes: deletedSurface.nodes.filter((candidate) => candidate.id !== 'frame-b'),
    });
    expect(deletedFrame.ok).toBe(true);
    if (!deletedFrame.ok) return;
    expect(deletedFrame.canvas.groups.some((group) => group.id === 'frame-b')).toBe(false);
    expect(
      deletedFrame.canvas.nodes.find((candidate) => candidate.id === 'child-2'),
    ).not.toHaveProperty('groupId');
  });

  it('reconciles competing frame claims by geometry, floor-resolved area, and stable ID', () => {
    const child = {
      ...node('child', 'task'),
      position: { x: 20, y: 20 },
      width: 100,
      height: 80,
    };
    const outside = {
      ...node('outside-first', 'group-frame', { childNodeIds: ['child'] }),
      position: { x: 1_000, y: 1_000 },
      width: 100,
      height: 100,
    };
    const large = {
      ...node('large-containing', 'group-frame', { childNodeIds: ['child'] }),
      position: { x: 0, y: 0 },
      width: 800,
      height: 600,
    };
    const tiedZ = {
      ...node('z-containing', 'group-frame', { childNodeIds: ['child'] }),
      position: { x: 0, y: 0 },
      width: 200,
      height: 100,
    };
    const tiedA = {
      ...node('a-containing', 'group-frame', {
        childNodeIds: ['missing', 'large-containing', 'child', 'child'],
      }),
      position: { x: 0, y: 0 },
      width: 200,
      height: 100,
    };
    const orders = [
      [outside, large, tiedZ, tiedA, child],
      [child, tiedA, tiedZ, large, outside],
    ];

    for (const nodes of orders) {
      const migrated = canonicalCanvasFromLegacy(legacy({ nodes, edges: [] }));
      expect(migrated.ok).toBe(true);
      if (!migrated.ok) continue;

      expect(migrated.canvas.nodes.find((candidate) => candidate.id === 'child')?.groupId).toBe(
        'a-containing',
      );
      expect(
        migrated.canvas.nodes.find((candidate) => candidate.id === 'a-containing'),
      ).toMatchObject({
        size: { width: 360, height: 240 },
        data: { childNodeIds: ['child', 'large-containing'] },
      });
      expect(
        migrated.canvas.nodes.find((candidate) => candidate.id === 'large-containing'),
      ).toMatchObject({ groupId: 'a-containing', data: { childNodeIds: [] } });
      for (const frameId of ['outside-first', 'z-containing']) {
        expect(migrated.canvas.nodes.find((candidate) => candidate.id === frameId)).toMatchObject({
          data: { childNodeIds: [] },
        });
      }
      expect(
        migrated.canvas.groups
          .map((group) => ({ id: group.id, nodeIds: group.nodeIds }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      ).toEqual([
        { id: 'a-containing', nodeIds: ['child', 'large-containing'] },
        { id: 'large-containing', nodeIds: [] },
        { id: 'outside-first', nodeIds: [] },
        { id: 'z-containing', nodeIds: [] },
      ]);
    }
  });

  it('round-trips nested frames and deterministically cuts imported membership cycles', () => {
    const migrated = canonicalCanvasFromLegacy(
      legacy({
        nodes: [
          node('outer', 'group-frame', { childNodeIds: ['inner'] }),
          node('inner', 'group-frame', { childNodeIds: ['outer', 'leaf'] }),
          node('leaf', 'task'),
        ],
        edges: [],
      }),
    );

    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.canvas.nodes.find(({ id }) => id === 'outer')).not.toHaveProperty('groupId');
    expect(migrated.canvas.nodes.find(({ id }) => id === 'inner')).toMatchObject({
      groupId: 'outer',
      data: { childNodeIds: ['leaf'] },
    });
    expect(migrated.canvas.nodes.find(({ id }) => id === 'leaf')).toMatchObject({
      groupId: 'inner',
    });

    const surface = legacySurfaceFromCanonical(migrated.canvas);
    const roundTrip = canonicalCanvasFromLegacy({
      ...surface,
      canonical: migrated.canvas,
      updatedAt: T2,
    });
    expect(roundTrip.ok).toBe(true);
    if (!roundTrip.ok) return;
    expect(roundTrip.canvas.groups.map(({ id, nodeIds }) => ({ id, nodeIds }))).toEqual([
      { id: 'outer', nodeIds: ['inner'] },
      { id: 'inner', nodeIds: ['leaf'] },
    ]);
  });

  it('maps every built-in draft plus declarative extension nodes', () => {
    const kinds = [
      'agent',
      'brief',
      'task',
      'file',
      'diff',
      'terminal',
      'web-preview',
      'mobile-preview',
      'test',
      'review-gate',
      'git-pr',
      'diagram',
      'whiteboard',
      'note-image',
      'group-frame',
    ];
    const extension = node('extension-1', 'extension', {
      extensionId: 'example.tools',
      extensionVersion: '1.0.0',
      extensionNodeTypeId: 'example-node',
      extensionDefinition: { displayName: 'Example', fields: [] },
      extensionValues: { enabled: true },
      extensionAvailability: 'active',
    });
    const migrated = canonicalCanvasFromLegacy(
      legacy({
        nodes: [...kinds.map((kind, index) => node(`node-${index}`, kind)), extension],
        edges: [],
      }),
    );

    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.canvas.nodes).toHaveLength(16);
    expect(migrated.canvas.nodes.at(-1)).toMatchObject({
      type: 'extension',
      data: {
        extensionId: 'example.tools',
        nodeTypeId: 'example-node',
        values: { enabled: true },
      },
    });
  });

  it('round-trips Excalidraw-compatible whiteboard data and context/export references exactly', () => {
    const excalidraw = {
      type: 'excalidraw',
      version: 2,
      source: 'https://forgeboard.local',
      elements: [
        {
          id: 'annotation-1',
          type: 'text',
          x: 24,
          y: 24,
          width: 180,
          height: 42,
          text: 'Review checkout',
        },
      ],
      appState: { viewBackgroundColor: '#ffffff', gridSize: 20 },
      files: {},
    };
    const migrated = canonicalCanvasFromLegacy(
      legacy({
        nodes: [
          node('whiteboard-1', 'whiteboard', {
            excalidraw,
            annotationIds: ['annotation-1'],
            exportArtifactIds: ['artifact-export-1'],
            contextSpecificationArtifactId: 'artifact-specification-1',
          }),
        ],
        edges: [],
      }),
    );

    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.canvas.nodes[0]).toMatchObject({
      type: 'whiteboard-mockup',
      data: {
        excalidraw,
        annotationIds: ['annotation-1'],
        exportArtifactIds: ['artifact-export-1'],
        contextSpecificationArtifactId: 'artifact-specification-1',
      },
    });
    const reloaded = canonicalCanvasFromLegacy(legacySurfaceFromCanonical(migrated.canvas));
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.canvas.nodes[0]?.data).toEqual(migrated.canvas.nodes[0]?.data);
  });

  it('round-trips an opaque Diff review target and presentation preferences exactly', () => {
    const migrated = canonicalCanvasFromLegacy(
      legacy({
        nodes: [
          node('diff-1', 'diff', {
            reviewTarget: { kind: 'agent-run', runId: AGENT_RUN_ID },
            baseRef: 'main',
            headRef: 'agent/feature',
            viewMode: 'unified',
            showWhitespace: true,
            hunkDecisions: { 'hunk-1': 'accepted' },
            lineCommentIds: ['comment-1'],
            revisionRequest: 'Add a regression test for the changed behavior.',
            approval: 'changes-requested',
          }),
        ],
        edges: [],
      }),
    );

    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    const original = migrated.canvas.nodes[0];
    expect(original).toMatchObject({
      type: 'diff-review',
      data: {
        reviewTarget: { kind: 'agent-run', runId: AGENT_RUN_ID },
        baseRef: 'main',
        headRef: 'agent/feature',
        viewMode: 'unified',
        showWhitespace: true,
        ignoreWhitespace: false,
        hunkDecisions: { 'hunk-1': 'accepted' },
        lineCommentIds: ['comment-1'],
        revisionRequest: 'Add a regression test for the changed behavior.',
        approval: 'changes-requested',
      },
    });

    const surface = legacySurfaceFromCanonical(migrated.canvas);
    expect(surface.nodes[0]?.data).toMatchObject({
      reviewTarget: { kind: 'agent-run', runId: AGENT_RUN_ID },
      viewMode: 'unified',
      showWhitespace: true,
      lineCommentIds: ['comment-1'],
    });
    const roundTripped = canonicalCanvasFromLegacy({
      ...surface,
      canonical: migrated.canvas,
      updatedAt: T2,
    });
    expect(roundTripped.ok).toBe(true);
    if (!roundTripped.ok || original?.type !== 'diff-review') return;
    expect(roundTripped.canvas.nodes[0]?.data).toEqual(original.data);

    const olderRendererSurface = {
      ...surface,
      nodes: surface.nodes.map((candidate) => ({
        ...candidate,
        data: Object.fromEntries(
          Object.entries(candidate.data).filter(
            ([key]) => !['reviewTarget', 'showWhitespace', 'lineCommentIds'].includes(key),
          ),
        ),
      })),
    };
    const preserved = canonicalCanvasFromLegacy({
      ...olderRendererSurface,
      canonical: migrated.canvas,
      updatedAt: T2,
    });
    expect(preserved.ok).toBe(true);
    if (!preserved.ok) return;
    expect(preserved.canvas.nodes[0]?.data).toMatchObject({
      reviewTarget: { kind: 'agent-run', runId: AGENT_RUN_ID },
      showWhitespace: true,
      lineCommentIds: ['comment-1'],
    });
  });

  it('fails closed on path-bearing or non-UUID Diff review targets', () => {
    const invalidTargets = [
      { kind: 'primary', root: '/private/repository' },
      { kind: 'agent-run', runId: AGENT_RUN_ID, worktreePath: '/private/worktree' },
      { kind: 'agent-run', runId: 'renderer-selected-folder' },
    ];

    for (const reviewTarget of invalidTargets) {
      const migrated = canonicalCanvasFromLegacy(
        legacy({ nodes: [node('diff-1', 'diff', { reviewTarget })], edges: [] }),
      );
      expect(migrated).toMatchObject({
        ok: false,
        issues: [{ code: 'INVALID_TYPED_NODE', entityId: 'diff-1' }],
      });
    }
  });

  it('round-trips every UI-authored preview setting with an opaque checkout target', () => {
    const previewTarget = { kind: 'agent-run', runId: AGENT_RUN_ID } as const;
    const migrated = canonicalCanvasFromLegacy(
      legacy({
        nodes: [
          node('web-1', 'web-preview', {
            previewTarget,
            previewCommand: {
              executable: 'pnpm',
              arguments: ['run', 'dev', '--host', '{HOST}', '--port', '{PORT}'],
            },
            previewPackageScript: 'dev:web',
            previewCwdRelative: 'apps/web',
            previewReadinessPath: '/health',
            previewUrlPath: '/workshop',
            previewPreset: 'laptop',
            previewSecondaryPreset: 'tablet',
            previewOrientation: 'landscape',
            previewSideBySide: true,
            browserAuthenticationEnabled: true,
            agentBrowserAccess: true,
            previewComparison: {
              leftTarget: previewTarget,
              rightTarget: { kind: 'agent-run', runId: COMPETING_RUN_ID },
              leftPreset: 'desktop',
              rightPreset: 'tablet',
            },
          }),
          node('mobile-1', 'mobile-preview', {
            previewTarget: { kind: 'primary' },
            previewCommand: { executable: 'npm', arguments: ['run', 'start'] },
            previewCwdRelative: '.',
            previewReadinessPath: '/',
            previewUrlPath: '/mobile',
            previewPreset: 'iphone',
            previewSecondaryPreset: 'pixel',
            previewOrientation: 'portrait',
            previewSideBySide: true,
          }),
        ],
        edges: [],
      }),
    );

    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.canvas.nodes[0]).toMatchObject({
      type: 'web-preview',
      data: {
        target: previewTarget,
        command: {
          executable: 'pnpm',
          args: ['run', 'dev', '--host', '{HOST}', '--port', '{PORT}'],
        },
        packageScript: 'dev:web',
        cwdRelative: 'apps/web',
        readinessPath: '/health',
        urlPath: '/workshop',
        preset: 'laptop',
        secondaryPreset: 'tablet',
        orientation: 'landscape',
        sideBySide: true,
        browserAuthenticationEnabled: true,
        agentBrowserAccess: true,
        comparison: {
          leftTarget: previewTarget,
          rightTarget: { kind: 'agent-run', runId: COMPETING_RUN_ID },
          leftPreset: 'desktop',
          rightPreset: 'tablet',
        },
      },
    });

    const surface = legacySurfaceFromCanonical(migrated.canvas);
    expect(surface.nodes[0]?.data).toMatchObject({
      previewTarget,
      previewCommand: {
        executable: 'pnpm',
        arguments: ['run', 'dev', '--host', '{HOST}', '--port', '{PORT}'],
      },
      previewPackageScript: 'dev:web',
      previewCwdRelative: 'apps/web',
      previewReadinessPath: '/health',
      previewUrlPath: '/workshop',
      previewPreset: 'laptop',
      previewSecondaryPreset: 'tablet',
      previewOrientation: 'landscape',
      previewSideBySide: true,
      browserAuthenticationEnabled: true,
      agentBrowserAccess: true,
      previewComparison: {
        leftTarget: previewTarget,
        rightTarget: { kind: 'agent-run', runId: COMPETING_RUN_ID },
        leftPreset: 'desktop',
        rightPreset: 'tablet',
      },
    });

    const roundTripped = canonicalCanvasFromLegacy({
      ...surface,
      canonical: migrated.canvas,
      updatedAt: T2,
    });
    expect(roundTripped.ok).toBe(true);
    if (!roundTripped.ok) return;
    expect(roundTripped.canvas.nodes.map((candidate) => candidate.data)).toEqual(
      migrated.canvas.nodes.map((candidate) => candidate.data),
    );

    const olderRenderer = {
      ...surface,
      nodes: surface.nodes.map((candidate) => ({
        ...candidate,
        data: Object.fromEntries(
          Object.entries(candidate.data).filter(([key]) => !key.startsWith('preview')),
        ),
      })),
    };
    const preserved = canonicalCanvasFromLegacy({
      ...olderRenderer,
      canonical: migrated.canvas,
      updatedAt: T2,
    });
    expect(preserved.ok).toBe(true);
    if (!preserved.ok) return;
    expect(preserved.canvas.nodes.map((candidate) => candidate.data)).toEqual(
      migrated.canvas.nodes.map((candidate) => candidate.data),
    );
  });

  it('rejects imported preview comparisons that repeat one agent target', () => {
    const repeated = { kind: 'agent-run', runId: AGENT_RUN_ID } as const;
    const migrated = canonicalCanvasFromLegacy(
      legacy({
        nodes: [
          node('web-1', 'web-preview', {
            previewComparison: {
              leftTarget: repeated,
              rightTarget: repeated,
              leftPreset: 'desktop',
              rightPreset: 'tablet',
            },
          }),
        ],
        edges: [],
      }),
    );

    expect(migrated).toMatchObject({
      ok: false,
      issues: [{ code: 'INVALID_TYPED_NODE', entityId: 'web-1' }],
    });
  });

  it('rejects preview targets that contain a renderer-selected checkout path', () => {
    const migrated = canonicalCanvasFromLegacy(
      legacy({
        nodes: [
          node('preview-1', 'web-preview', {
            previewTarget: {
              kind: 'agent-run',
              runId: AGENT_RUN_ID,
              worktreePath: '/private/renderer-selected-worktree',
            },
          }),
        ],
        edges: [],
      }),
    );
    expect(migrated).toMatchObject({
      ok: false,
      issues: [{ code: 'INVALID_TYPED_NODE', entityId: 'preview-1' }],
    });
  });

  it('persists UI-authored Task execution configuration without a source edit', () => {
    const document = legacy({
      nodes: [
        node('agent-1', 'agent', {
          adapterId: 'test-agent',
          permissionProfile: 'worktree-write',
        }),
        node('task-1', 'task', {
          description: 'Implement the UI-authored task.',
          priority: 'high',
          assigneeId: 'agent-1',
          acceptanceCriteria: [
            { id: 'criterion-1', description: 'Focused tests pass.', satisfied: false },
          ],
          relatedFiles: [
            {
              projectId: 'project-1',
              relativePath: 'src/task.ts',
              kind: 'file',
              missing: false,
            },
          ],
          taskStatus: 'ready',
        }),
      ],
      edges: [],
    });

    const migrated = canonicalCanvasFromLegacy(document);

    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.canvas.nodes.find((candidate) => candidate.id === 'task-1')).toMatchObject({
      type: 'task',
      data: {
        description: 'Implement the UI-authored task.',
        priority: 'high',
        assigneeId: 'agent-1',
        acceptanceCriteria: [{ description: 'Focused tests pass.', satisfied: false }],
        relatedFiles: [{ relativePath: 'src/task.ts', kind: 'file' }],
        taskStatus: 'ready',
      },
    });
    const surface = legacySurfaceFromCanonical(migrated.canvas);
    expect(surface.nodes.find((candidate) => candidate.id === 'task-1')?.data).toMatchObject({
      description: 'Implement the UI-authored task.',
      assigneeId: 'agent-1',
      priority: 'high',
    });
  });

  it('round-trips genuine Agent capability and usage metadata through canonical data', () => {
    const migrated = canonicalCanvasFromLegacy(
      legacy({
        nodes: [
          node('agent-1', 'agent', {
            adapterId: 'codex',
            permissionProfile: 'worktree-write',
            pauseSupported: false,
            interruptSupported: true,
            resumeSupported: true,
            tokenUsage: {
              inputTokens: 120,
              cachedInputTokens: 20,
              outputTokens: 30,
              totalTokens: 150,
            },
            cost: { amount: 0.0125, currency: 'USD' },
          }),
        ],
        edges: [],
      }),
    );

    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    const canonicalAgent = migrated.canvas.nodes.find((candidate) => candidate.id === 'agent-1');
    expect(canonicalAgent).toMatchObject({
      type: 'agent',
      data: {
        pauseSupported: false,
        interruptSupported: true,
        resumeSupported: true,
        tokenUsage: {
          inputTokens: 120,
          cachedInputTokens: 20,
          outputTokens: 30,
          totalTokens: 150,
        },
        cost: { amount: 0.0125, currency: 'USD' },
      },
    });

    const surface = legacySurfaceFromCanonical(migrated.canvas);
    expect(surface.nodes[0]?.data).toMatchObject({
      pauseSupported: false,
      interruptSupported: true,
      resumeSupported: true,
      tokenUsage: {
        inputTokens: 120,
        cachedInputTokens: 20,
        outputTokens: 30,
        totalTokens: 150,
      },
      cost: { amount: 0.0125, currency: 'USD' },
    });
  });

  it('normalizes legacy required input/output token counts without dropping saved usage', () => {
    const migrated = canonicalCanvasFromLegacy(
      legacy({
        nodes: [node('agent-1', 'agent', { tokenUsage: { input: 8, output: 5 } })],
        edges: [],
      }),
    );

    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.canvas.nodes[0]?.data).toMatchObject({
      tokenUsage: { inputTokens: 8, outputTokens: 5 },
    });
  });

  it('preserves UI-authored Terminal configuration across canonical save and reload', () => {
    const configured = legacy({
      nodes: [
        node('terminal-1', 'terminal', {
          command: {
            executable: '/bin/zsh',
            arguments: ['-l', '--no-rcs'],
            cwdRelative: '.',
            environmentNames: ['PATH', 'HOME'],
          },
        }),
      ],
      edges: [],
    });

    const synchronized = synchronizeCanvasDocument(configured);
    expect(synchronized.ok).toBe(true);
    if (!synchronized.ok) return;
    expect(synchronized.document.nodes[0]?.data.command).toEqual({
      executable: '/bin/zsh',
      arguments: ['-l', '--no-rcs'],
      cwdRelative: '.',
      environmentNames: ['PATH', 'HOME'],
    });

    const reloaded = synchronizeCanvasDocument(synchronized.document);
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.document.nodes[0]?.data.command).toEqual({
      executable: '/bin/zsh',
      arguments: ['-l', '--no-rcs'],
      cwdRelative: '.',
      environmentNames: ['PATH', 'HOME'],
    });
  });

  it('persists UI-authored test commands and bounded review-gate configuration canonically', () => {
    const migrated = canonicalCanvasFromLegacy(
      legacy({
        nodes: [
          node('test-1', 'test', {
            checkKind: 'test',
            command: {
              executable: 'pnpm',
              arguments: ['run', 'test'],
              cwdRelative: 'packages/app',
              environmentNames: ['CI'],
            },
            runIds: ['check-tests'],
          }),
          node('agent-reviewer', 'agent', {
            adapterId: 'test-agent',
            permissionProfile: 'worktree-write',
          }),
          node('gate-1', 'review-gate', {
            humanApprovalRequired: true,
            requiredCheckIds: ['check-tests'],
            testsRequired: true,
            lintRequired: false,
            reviewerAgentId: 'agent-reviewer',
            retryPolicy: { maximumIterations: 4, backoffMs: 250 },
            gateState: 'pending',
          }),
        ],
        edges: [],
      }),
    );

    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.canvas.nodes[0]).toMatchObject({
      type: 'test',
      data: {
        command: {
          executable: 'pnpm',
          args: ['run', 'test'],
          cwdRelative: 'packages/app',
          environmentNames: ['CI'],
        },
        runIds: ['check-tests'],
      },
      inspector: { legacyData: { checkKind: 'test' } },
    });
    expect(migrated.canvas.nodes[2]).toMatchObject({
      type: 'review-gate',
      data: {
        humanApprovalRequired: true,
        requiredCheckIds: ['check-tests'],
        testsRequired: true,
        reviewerAgentId: 'agent-reviewer',
        retryPolicy: { maximumIterations: 4, backoffMs: 250 },
      },
    });

    const surface = legacySurfaceFromCanonical(migrated.canvas);
    expect(surface.nodes[0]?.data).toMatchObject({
      checkKind: 'test',
      command: {
        executable: 'pnpm',
        args: ['run', 'test'],
        cwdRelative: 'packages/app',
        environmentNames: ['CI'],
      },
      runIds: ['check-tests'],
    });
  });

  it('promotes a UI-authored revision edge into an explicit bounded loop with human escape', () => {
    const migrated = canonicalCanvasFromLegacy(
      legacy({
        nodes: [
          node('implementation-1', 'agent', {
            adapterId: 'test-agent',
            permissionProfile: 'worktree-write',
          }),
          node('gate-1', 'review-gate', {
            humanApprovalRequired: true,
            retryPolicy: { maximumIterations: 3, backoffMs: 0 },
          }),
        ],
        edges: [
          {
            id: 'review-1',
            source: 'implementation-1',
            target: 'gate-1',
            type: 'review',
            data: {
              config: {
                reviewer: 'gate',
                requireApproval: true,
                structuredFindings: true,
              },
            },
          },
          {
            id: 'revision-1',
            source: 'gate-1',
            target: 'implementation-1',
            type: 'revision',
            data: {
              config: { loopId: 'loop-1', actionableFeedbackRequired: true },
              loop: {
                maximumAttempts: 5,
                stopConditions: ['review-approved', 'human-accepted'],
                humanEscapeInstructions:
                  'Ask the user to accept the current result or cancel after five attempts.',
              },
            },
          },
        ],
      }),
    );

    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.canvas.revisionLoops).toEqual([
      {
        id: 'loop-1',
        implementationNodeId: 'implementation-1',
        reviewNodeId: 'gate-1',
        reviewEdgeId: 'review-1',
        revisionEdgeId: 'revision-1',
        maximumAttempts: 5,
        stopConditions: ['review-approved', 'human-accepted'],
        humanEscapeHatch: {
          enabled: true,
          approvalRequired: true,
          instructions: 'Ask the user to accept the current result or cancel after five attempts.',
        },
      },
    ]);
    expect(migrated.canvas.nodes[1]).toMatchObject({
      type: 'review-gate',
      data: { retryPolicy: { maximumIterations: 5, backoffMs: 0 } },
    });
    expect(validateWorkflow(migrated.canvas).valid).toBe(true);

    const surface = legacySurfaceFromCanonical(migrated.canvas);
    expect(surface.edges[1]?.data).toMatchObject({
      loop: {
        maximumAttempts: 5,
        stopConditions: ['review-approved', 'human-accepted'],
      },
    });
  });

  it('fails closed instead of discarding non-JSON renderer metadata', () => {
    const migrated = canonicalCanvasFromLegacy(
      legacy({ nodes: [node('agent-1', 'agent', { unsafe: undefined })], edges: [] }),
    );
    expect(migrated).toEqual({
      ok: false,
      issues: [
        {
          code: 'NON_JSON_METADATA',
          entityId: 'agent-1',
          message: 'Canvas node metadata must contain only finite JSON values.',
        },
      ],
    });
  });
});
