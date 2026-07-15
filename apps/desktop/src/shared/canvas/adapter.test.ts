import { describe, expect, it } from 'vitest';

import { validateWorkflow } from '@forgeboard/core';

import {
  canonicalCanvasFromLegacy,
  legacySurfaceFromCanonical,
  synchronizeCanvasDocument,
} from './adapter.js';
import type { LegacyCanvasDocument, LegacyCanvasNode } from './types.js';

const T1 = '2026-07-15T12:00:00.000Z';
const T2 = '2026-07-15T12:01:00.000Z';

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
              data: { ...candidate.data, tokenUsage: { input: 12, output: 8 } },
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
      data: { tokenUsage: { input: 12, output: 8 } },
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
