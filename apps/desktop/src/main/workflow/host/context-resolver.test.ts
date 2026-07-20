import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CanvasNodeSchema,
  CanvasSchema,
  createWorkflowExecutionRuntime,
  type Canvas,
  type CanvasNode,
} from '@forgeboard/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../shared/application/contracts.js';
import { FileNodeWorkflowContextResolver } from './context-resolver.js';
import { serializeWorkflowCanvasContext } from '../context/canvas-source.js';
import { WORKFLOW_EVIDENCE_VERIFIER_ID } from '../evidence/contracts.js';

const PROJECT_ID = 'project-1';
const T0 = '2026-07-15T20:00:00.000Z';
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('FileNodeWorkflowContextResolver', () => {
  it('resolves selected File-node IDs through a hashed explicit manifest', async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, 'src.ts'), 'export const answer = 42;\n');
    const runtime = workflowRuntime([agentNode(['file-1']), fileNode('file-1', 'src.ts')]);
    const appendAudit = vi.fn();
    const resolver = new FileNodeWorkflowContextResolver({
      getProject: () => project(root),
      appendAudit,
    });

    const result = await resolver.resolve({
      executionId: 'workflow-1',
      projectId: PROJECT_ID,
      nodeId: 'agent-1',
      attempt: 1,
      attachmentIds: ['file-1'],
      runtime,
    });

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({
      attachmentId: 'file-1',
      attachment: {
        path: realpathSync(join(root, 'src.ts')),
        kind: 'file',
        label: 'Source file',
        explicitlyApproved: true,
      },
    });
    expect(result.attachments[0]?.attachment.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(typeof result.manifestId).toBe('string');
    expect(result.manifestDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(appendAudit).toHaveBeenCalledWith(
      'workflow-context',
      'resolve',
      'allowed',
      expect.objectContaining({ attachmentIds: ['file-1'] }),
    );
  });

  it('fails closed for opaque IDs, directories, and sensitive files', async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, '.env'), 'SECRET=not-read\n');
    const appendAudit = vi.fn();
    const resolver = new FileNodeWorkflowContextResolver({
      getProject: () => project(root),
      appendAudit,
    });
    const sensitive = workflowRuntime([agentNode(['secret']), fileNode('secret', '.env')]);

    await expect(resolver.resolve(request(sensitive, ['../../raw-path']))).rejects.toThrow(
      'no longer exists',
    );
    const directory = workflowRuntime([
      agentNode(['directory']),
      fileNode('directory', 'src', 'directory'),
    ]);
    await expect(resolver.resolve(request(directory, ['directory']))).rejects.toThrow(
      'Select explicit File nodes',
    );
    await expect(resolver.resolve(request(sensitive, ['secret']))).rejects.toThrow(/credentials/iu);
    const finalAuditMetadata = appendAudit.mock.calls.at(-1)?.[3] as
      | Record<string, unknown>
      | undefined;
    expect(finalAuditMetadata?.['reason']).toMatch(/credentials/iu);
  });

  it('does not create a manifest when no context was explicitly selected', async () => {
    const root = fixtureRoot();
    const appendAudit = vi.fn();
    const resolver = new FileNodeWorkflowContextResolver({
      getProject: () => project(root),
      appendAudit,
    });
    const result = await resolver.resolve(request(workflowRuntime([agentNode([])]), []));
    expect(result).toEqual({ attachments: [], projectRoot: root });
  });

  it('resolves Task-bound context using only its explicitly assigned Agent adapter', async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, 'task.ts'), 'export const delegated = true;\n');
    const appendAudit = vi.fn();
    const resolver = new FileNodeWorkflowContextResolver({
      getProject: () => project(root),
      appendAudit,
    });
    const runtime = workflowRuntime([
      taskNode('agent-1'),
      agentNode([]),
      fileNode('task-file', 'task.ts'),
    ]);

    const result = await resolver.resolve(request(runtime, ['task-file'], 'task-1'));

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.attachmentId).toBe('task-file');
    expect(result.attachments[0]?.attachment.path).toBe(realpathSync(join(root, 'task.ts')));
    expect(result.attachments[0]?.attachment.explicitlyApproved).toBe(true);
    expect(appendAudit).toHaveBeenCalledWith(
      'workflow-context',
      'resolve',
      'allowed',
      expect.objectContaining({ nodeId: 'task-1', attachmentIds: ['task-file'] }),
    );
  });

  it('reuses the file policy for deterministic context-edge proof', async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, 'review.md'), '# Reviewed context\n');
    const appendAudit = vi.fn();
    const resolver = new FileNodeWorkflowContextResolver({
      getProject: () => project(root),
      appendAudit,
    });

    const proof = await resolver.resolveEvidence({
      executionId: 'workflow-1',
      projectId: PROJECT_ID,
      edgeId: 'context-edge',
      sourceNodeId: 'file-1',
      targetNodeId: 'agent-1',
      targetAttempt: 1,
      attachmentIds: ['file-1'],
      files: [
        {
          attachmentId: 'file-1',
          fileNodeId: 'file-1',
          relativePath: 'review.md',
          readOnly: true,
        },
      ],
      canvasSources: [],
    });

    expect(proof.attachmentIds).toEqual(['file-1']);
    expect(proof.contentDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(appendAudit).toHaveBeenLastCalledWith(
      'workflow-context',
      'verify-edge',
      'allowed',
      expect.objectContaining({ edgeId: 'context-edge' }),
    );

    const edge: Canvas['edges'][number] = {
      id: 'context-edge',
      type: 'context',
      sourceNodeId: 'file-1',
      targetNodeId: 'agent-1',
      config: {
        attachmentMode: 'explicit',
        required: true,
        muted: false,
        attachmentIds: ['file-1'],
      },
      inspector: {},
      createdAt: T0,
    };
    const initial = workflowRuntime(
      [agentNode(['file-1']), fileNode('file-1', 'review.md')],
      [edge],
    );
    const runtime = {
      ...initial,
      evidence: {
        ...initial.evidence,
        contextResolutions: {
          'context-edge': {
            edgeId: 'context-edge',
            runId: initial.run.id,
            sourceNodeId: 'file-1',
            targetNodeId: 'agent-1',
            targetAttempt: 1,
            attachmentIds: ['file-1'],
            contentDigest: `sha256:${proof.contentDigest}`,
            verifiedAt: T0,
            verifierId: WORKFLOW_EVIDENCE_VERIFIER_ID,
          },
        },
      },
    };
    const resolved = await resolver.resolve(request(runtime, ['file-1']));
    expect(resolved.manifestDigest).toBe(proof.contentDigest);

    writeFileSync(join(root, 'review.md'), '# Changed after verification\n');
    await expect(resolver.resolve(request(runtime, ['file-1']))).rejects.toThrow(
      'changed after its evidence was verified',
    );
  });

  it('binds each File attachment ID to its reviewed relative path', async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, 'a.md'), 'A\n');
    writeFileSync(join(root, 'b.md'), 'B\n');
    const resolver = new FileNodeWorkflowContextResolver({
      getProject: () => project(root),
      appendAudit: vi.fn(),
    });
    const base = {
      executionId: 'workflow-1',
      projectId: PROJECT_ID,
      edgeId: 'context-edge',
      sourceNodeId: 'file-1',
      targetNodeId: 'agent-1',
      targetAttempt: 1,
      attachmentIds: ['file-1', 'file-2'],
      canvasSources: [],
    };
    const first = await resolver.resolveEvidence({
      ...base,
      files: [fileReference('file-1', 'a.md'), fileReference('file-2', 'b.md')],
    });
    const swapped = await resolver.resolveEvidence({
      ...base,
      files: [fileReference('file-1', 'b.md'), fileReference('file-2', 'a.md')],
    });
    expect(swapped.contentDigest).not.toBe(first.contentDigest);
    const reordered = await resolver.resolveEvidence({
      ...base,
      attachmentIds: ['file-2', 'file-1'],
      files: [fileReference('file-1', 'a.md'), fileReference('file-2', 'b.md')],
    });
    expect(reordered.contentDigest).not.toBe(first.contentDigest);
  });

  it('rejects aggregate generated context above the launch budget before approval', async () => {
    const root = fixtureRoot();
    const resolver = new FileNodeWorkflowContextResolver({
      getProject: () => project(root),
      appendAudit: vi.fn(),
    });
    const content = 'x'.repeat(4 * 1024 * 1024);
    const sha256 = createHash('sha256').update(content).digest('hex');
    const attachmentIds = Array.from({ length: 9 }, (_, index) => `brief-${String(index)}`);
    await expect(
      resolver.resolveEvidence({
        executionId: 'workflow-1',
        projectId: PROJECT_ID,
        edgeId: 'large-edge',
        sourceNodeId: attachmentIds[0]!,
        targetNodeId: 'agent-1',
        targetAttempt: 1,
        attachmentIds,
        files: [],
        canvasSources: attachmentIds.map((attachmentId) => ({
          attachmentId,
          sourceNodeId: attachmentId,
          sourceType: 'product-brief' as const,
          content,
          sha256,
        })),
      }),
    ).rejects.toThrow(/32 MiB aggregate/iu);
  });

  it('resolves a mixed File, Product Brief, Task, Diagram, Whiteboard, and Note selection in edge order', async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, 'review.md'), '# File context\n');
    const brief = canvasContextNode('brief-1', 'product-brief', { markdown: '# Brief' });
    const task = canvasContextNode('task-context', 'task', { description: 'Ship the feature' });
    const diagram = canvasContextNode('diagram-1', 'diagram', {
      mermaidSource: 'flowchart LR\nA-->B',
    });
    const whiteboard = canvasContextNode('whiteboard-1', 'whiteboard-mockup', {
      excalidraw: { type: 'excalidraw', version: 2, elements: [] },
      annotationIds: ['annotation-1'],
    });
    const note = canvasContextNode('note-1', 'note-image', { markdown: 'Remember this' });
    const attachmentIds = [
      'brief-1',
      'file-1',
      'task-context',
      'diagram-1',
      'whiteboard-1',
      'note-1',
    ];
    const nodes = [
      agentNode(attachmentIds),
      brief,
      fileNode('file-1', 'review.md'),
      task,
      diagram,
      whiteboard,
      note,
    ];
    const resolver = new FileNodeWorkflowContextResolver({
      getProject: () => project(root),
      appendAudit: vi.fn(),
    });
    const canonicalNodes = workflowRuntime(nodes).canvas.nodes;
    const canvasSources = canonicalNodes
      .filter(
        (node) =>
          node.type === 'product-brief' ||
          node.type === 'task' ||
          node.type === 'diagram' ||
          node.type === 'whiteboard-mockup' ||
          node.type === 'note-image',
      )
      .map(serializeWorkflowCanvasContext);
    const proof = await resolver.resolveEvidence({
      executionId: 'workflow-1',
      projectId: PROJECT_ID,
      edgeId: 'mixed-edge',
      sourceNodeId: 'brief-1',
      targetNodeId: 'agent-1',
      targetAttempt: 1,
      attachmentIds,
      files: [
        {
          attachmentId: 'file-1',
          fileNodeId: 'file-1',
          relativePath: 'review.md',
          readOnly: true,
        },
      ],
      canvasSources,
    });
    expect(proof.attachmentIds).toEqual(attachmentIds);
    const edge: Canvas['edges'][number] = {
      id: 'mixed-edge',
      type: 'context',
      sourceNodeId: 'brief-1',
      targetNodeId: 'agent-1',
      config: { attachmentMode: 'explicit', required: true, muted: false, attachmentIds },
      inspector: {},
      createdAt: T0,
    };
    const initial = workflowRuntime(nodes, [edge]);
    const runtime = {
      ...initial,
      evidence: {
        ...initial.evidence,
        contextResolutions: {
          'mixed-edge': {
            edgeId: 'mixed-edge',
            runId: initial.run.id,
            sourceNodeId: 'brief-1',
            targetNodeId: 'agent-1',
            targetAttempt: 1,
            attachmentIds,
            contentDigest: `sha256:${proof.contentDigest}`,
            verifiedAt: T0,
            verifierId: WORKFLOW_EVIDENCE_VERIFIER_ID,
          },
        },
      },
    };

    expect(
      runtime.canvas.nodes
        .filter(
          (node) =>
            node.type === 'product-brief' ||
            node.type === 'task' ||
            node.type === 'diagram' ||
            node.type === 'whiteboard-mockup' ||
            node.type === 'note-image',
        )
        .map(serializeWorkflowCanvasContext),
    ).toEqual(canvasSources);

    const resolved = await resolver.resolve(request(runtime, attachmentIds));
    expect(resolved.attachments.map(({ attachmentId }) => attachmentId)).toEqual(attachmentIds);
    expect(resolved.generatedArtifacts).toHaveLength(5);
    expect(resolved.generatedArtifacts?.map(({ attachmentId }) => attachmentId)).toEqual([
      'brief-1',
      'task-context',
      'diagram-1',
      'whiteboard-1',
      'note-1',
    ]);
    for (const generated of resolved.generatedArtifacts ?? []) {
      expect(generated.artifact.path).toContain(join(root, '.forgeboard-context'));
      expect(generated.artifact.sha256).toMatch(/^[0-9a-f]{64}$/u);
    }
  });
});

function request(
  runtime: ReturnType<typeof workflowRuntime>,
  attachmentIds: string[],
  nodeId = 'agent-1',
) {
  return {
    executionId: 'workflow-1',
    projectId: PROJECT_ID,
    nodeId,
    attempt: 1,
    attachmentIds,
    runtime,
  };
}

function workflowRuntime(nodes: CanvasNode[], edges: Canvas['edges'] = []) {
  const canvas = CanvasSchema.parse({
    schemaVersion: 1,
    id: 'canvas-1',
    projectId: PROJECT_ID,
    name: 'Context canvas',
    nodes,
    edges,
    groups: [],
    viewState: { viewport: { x: 0, y: 0, zoom: 1 } },
    revisionLoops: [],
    workflowLimits: {},
    createdAt: T0,
    updatedAt: T0,
  });
  return createWorkflowExecutionRuntime(canvas, {
    planId: 'plan-1',
    runId: 'workflow-1',
    scope: { kind: 'workflow' },
    occurredAt: T0,
  });
}

function agentNode(attachmentIds: string[]): CanvasNode {
  return CanvasNodeSchema.parse({
    ...nodeBase('agent-1', 'Agent'),
    type: 'agent',
    data: {
      adapterId: 'test-agent',
      permissionProfileId: 'plan-read-only',
      promptDraft: 'Inspect selected context.',
      contextAttachmentIds: attachmentIds,
    },
  });
}

function taskNode(assigneeId: string): CanvasNode {
  return CanvasNodeSchema.parse({
    ...nodeBase('task-1', 'Assigned task'),
    type: 'task',
    data: { description: 'Inspect selected context.', assigneeId },
  });
}

function fileNode(
  id: string,
  relativePath: string,
  kind: 'file' | 'directory' = 'file',
): CanvasNode {
  return CanvasNodeSchema.parse({
    ...nodeBase(id, 'Source file'),
    type: 'file',
    data: { file: { projectId: PROJECT_ID, relativePath, kind, missing: false } },
  });
}

function fileReference(attachmentId: string, relativePath: string) {
  return { attachmentId, fileNodeId: attachmentId, relativePath, readOnly: true };
}

function canvasContextNode(
  id: string,
  type: 'product-brief' | 'task' | 'diagram' | 'whiteboard-mockup' | 'note-image',
  data: Record<string, unknown>,
): CanvasNode {
  return CanvasNodeSchema.parse({ ...nodeBase(id, id), type, data });
}

function nodeBase(id: string, title: string) {
  return {
    id,
    title,
    color: '#445566',
    icon: id,
    position: { x: 0, y: 0 },
    size: { width: 320, height: 180 },
    status: 'ready',
    createdAt: T0,
    updatedAt: T0,
  };
}

function fixtureRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), 'forgeboard-workflow-context-'));
  directories.push(directory);
  return directory;
}

function project(path: string): Project {
  return {
    id: PROJECT_ID,
    name: 'Context project',
    path,
    openedAt: T0,
    missing: false,
    health: {
      isGitRepository: false,
      branch: null,
      dirty: false,
      remotes: [],
      packageManager: 'unknown',
      frameworks: [],
      scripts: {},
      hasSubmodules: false,
      sensitiveWarnings: [],
    },
  };
}
