import { CanvasNodeSchema, CanvasSchema, type Canvas } from '@forgeboard/core/domain';
import { describe, expect, it } from 'vitest';

import {
  CollaborationMetadataProjectionError,
  collaborationMetadataSnapshotFromCanvas,
  collaborationNodeMetadataFromCanvasNode,
  deserializeCollaborationMetadataSnapshot,
  serializeCollaborationMetadataSnapshot,
  type CollaborationCanvasProjectionOptions,
} from './canvas-metadata.js';
import { CollaborationMetadataSnapshotSchema } from './metadata-contracts.js';

const NOW = '2026-07-15T12:00:00.000Z';
const FILE_RESOURCE_ID = '56cf42a7-a889-4eab-8f0e-31b3d9da0f28';
const GIT_RUN_ID = '11111111-1111-4111-8111-111111111111';
const SENSITIVE_VALUES = [
  'PROMPT_DO_NOT_SHARE',
  '/Users/private/repository',
  'SOURCE_CONTENT_DO_NOT_SHARE',
  'TRANSCRIPT_DO_NOT_SHARE',
  'ENVIRONMENT_DO_NOT_SHARE',
  'SECRET_DO_NOT_SHARE',
  'private/credential.ts',
  'DIFF_DO_NOT_SHARE',
  'TERMINAL_DO_NOT_SHARE',
  'MARKDOWN_DO_NOT_SHARE',
  'EXCALIDRAW_DO_NOT_SHARE',
  'EXTENSION_DO_NOT_SHARE',
  'PRIVATE_REMOTE_DO_NOT_SHARE',
  'private/BRANCH_DO_NOT_SHARE',
  'PR_BODY_DO_NOT_SHARE',
  'https://github.example.invalid/private/REPO_DO_NOT_SHARE/pull/1',
] as const;

function canvas(): Canvas {
  const baseNode = {
    title: 'Safe title',
    color: '#445566',
    icon: 'task',
    position: { x: 10, y: 20 },
    size: { width: 320, height: 180 },
    groupId: 'group-1',
    inspector: {
      repositoryPath: SENSITIVE_VALUES[1],
      fileContents: SENSITIVE_VALUES[2],
      transcript: SENSITIVE_VALUES[3],
      environment: SENSITIVE_VALUES[4],
      secret: SENSITIVE_VALUES[5],
    },
    createdAt: NOW,
    updatedAt: NOW,
  };

  return CanvasSchema.parse({
    schemaVersion: 1,
    id: 'canvas-1',
    projectId: 'project-1',
    name: 'Private implementation plan',
    nodes: [
      {
        ...baseNode,
        id: 'agent-1',
        type: 'agent',
        data: {
          promptDraft: SENSITIVE_VALUES[0],
          worktreeId: 'private-worktree',
          branch: 'private-branch',
        },
      },
      {
        ...baseNode,
        id: 'task-1',
        type: 'task',
        status: 'running',
        comments: [
          {
            id: 'comment-1',
            authorId: 'editor-1',
            scope: 'shared',
            body: 'Please verify the safe empty state.',
            createdAt: NOW,
          },
          {
            id: 'local:private-note',
            authorId: 'local-user',
            scope: 'local',
            body: 'PRIVATE_COMMENT_DO_NOT_SHARE',
            createdAt: NOW,
          },
        ],
        data: {
          description: 'SOURCE_CONTENT_DO_NOT_SHARE',
          priority: 'high',
          assigneeId: 'editor-1',
          dependencyTaskIds: [],
          acceptanceCriteria: [
            {
              id: 'criterion-1',
              description: 'MARKDOWN_DO_NOT_SHARE',
              evidence: 'DIFF_DO_NOT_SHARE',
              satisfied: true,
            },
          ],
          relatedFiles: [
            {
              projectId: 'project-1',
              relativePath: SENSITIVE_VALUES[6],
              kind: 'file',
            },
          ],
          taskStatus: 'in-progress',
        },
      },
      {
        ...baseNode,
        id: 'file-1',
        type: 'file',
        data: {
          file: {
            projectId: 'project-1',
            relativePath: SENSITIVE_VALUES[6],
            kind: 'file',
            lastKnownHash: 'deadbeef',
          },
          historyRefs: [SENSITIVE_VALUES[7]],
          recoverableWarning: SENSITIVE_VALUES[5],
        },
      },
      {
        ...baseNode,
        id: 'diff-1',
        type: 'diff-review',
        data: {
          files: [SENSITIVE_VALUES[6]],
          revisionRequest: SENSITIVE_VALUES[7],
          hunkDecisions: { [SENSITIVE_VALUES[7]]: 'accepted' },
        },
      },
      {
        ...baseNode,
        id: 'terminal-1',
        type: 'terminal',
        data: {
          cwdRelative: 'private',
          command: {
            executable: 'printenv',
            args: [SENSITIVE_VALUES[8]],
            environmentNames: ['ENVIRONMENT_DO_NOT_SHARE'],
          },
        },
      },
      {
        ...baseNode,
        id: 'diagram-1',
        type: 'diagram',
        data: { mermaidSource: SENSITIVE_VALUES[9] },
      },
      {
        ...baseNode,
        id: 'whiteboard-1',
        type: 'whiteboard-mockup',
        data: { excalidraw: { text: SENSITIVE_VALUES[10] } },
      },
      {
        ...baseNode,
        id: 'note-1',
        type: 'note-image',
        data: {
          markdown: SENSITIVE_VALUES[9],
          images: [
            {
              projectId: 'project-1',
              relativePath: SENSITIVE_VALUES[6],
              kind: 'image',
            },
          ],
        },
      },
      {
        ...baseNode,
        id: 'extension-1',
        type: 'extension',
        data: {
          extensionId: 'private.extension',
          extensionVersion: '1.0.0',
          nodeTypeId: 'private-node',
          definition: { content: SENSITIVE_VALUES[11] },
          values: { token: SENSITIVE_VALUES[5] },
        },
      },
      {
        ...baseNode,
        id: 'git-pr-1',
        type: 'git-pr',
        data: {
          deliveryTarget: {
            kind: 'agent-run',
            runId: GIT_RUN_ID,
          },
          remote: SENSITIVE_VALUES[12],
          destinationBranch: SENSITIVE_VALUES[13],
          baseBranch: 'main',
          pullRequestTitle: 'Safe title',
          pullRequestBody: SENSITIVE_VALUES[14],
          pullRequestDraft: false,
          pullRequestUrl: SENSITIVE_VALUES[15],
        },
      },
    ],
    edges: [
      {
        id: 'execute-1',
        sourceNodeId: 'agent-1',
        targetNodeId: 'task-1',
        type: 'execute',
        config: {},
        inspector: { diff: SENSITIVE_VALUES[7] },
        createdAt: NOW,
      },
      {
        id: 'extension-edge',
        sourceNodeId: 'extension-1',
        targetNodeId: 'task-1',
        type: 'context',
        config: { attachmentIds: ['private-attachment'] },
        createdAt: NOW,
      },
    ],
    groups: [
      {
        id: 'group-1',
        title: 'Implementation',
        nodeIds: [
          'agent-1',
          'task-1',
          'file-1',
          'diff-1',
          'terminal-1',
          'diagram-1',
          'whiteboard-1',
          'note-1',
          'extension-1',
          'git-pr-1',
        ],
        position: { x: 0, y: 0 },
        size: { width: 1_200, height: 800 },
        color: '#112233',
      },
    ],
    viewState: {
      viewport: { x: 4, y: 8, zoom: 1.5 },
      selectedNodeIds: ['file-1'],
      selectedEdgeIds: ['execute-1'],
    },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

describe('canonical Canvas collaboration metadata projection', () => {
  it('projects only explicit privacy-safe metadata and keeps file resources opaque', () => {
    const canonical = canvas();
    const snapshot = collaborationMetadataSnapshotFromCanvas(canonical, {
      fileResources: {
        'file-1': { localResourceId: FILE_RESOURCE_ID, availability: 'local' },
      },
    });
    const serialized = JSON.stringify(snapshot);

    for (const sensitiveValue of SENSITIVE_VALUES) expect(serialized).not.toContain(sensitiveValue);
    expect(serialized).not.toContain(GIT_RUN_ID);
    expect(snapshot.nodes['file-1']).toEqual({
      id: 'file-1',
      type: 'file',
      title: 'Safe title',
      position: { x: 10, y: 20 },
      size: { width: 320, height: 180 },
      color: '#445566',
      icon: 'task',
      status: 'idle',
      locked: false,
      collapsed: false,
      groupId: 'group-1',
      localResourceId: FILE_RESOURCE_ID,
      availability: 'local',
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(snapshot.nodes['extension-1']).toBeUndefined();
    expect(snapshot.edges['extension-edge']).toBeUndefined();
    expect(snapshot.nodes['whiteboard-1']?.type).toBe('whiteboard');
    expect(snapshot.nodes['git-pr-1']).toMatchObject({ id: 'git-pr-1', type: 'git-pr' });
    expect(snapshot.nodes['git-pr-1']).not.toHaveProperty('deliveryTarget');
    expect(snapshot.tasks['task-1']).toMatchObject({
      status: 'running',
      acceptanceState: 'passed',
    });
    expect(snapshot.comments['comment-1']?.body).toBe('Please verify the safe empty state.');
    expect(snapshot.comments['local:private-note']).toBeUndefined();
    expect(forbiddenKeys(snapshot)).toEqual([]);
  });

  it('uses metadata-only or unavailable file state without deriving an identifier from a path', () => {
    const canonical = canvas();
    const metadataOnly = collaborationMetadataSnapshotFromCanvas(canonical);
    expect(metadataOnly.nodes['file-1']).toMatchObject({
      availability: 'metadata-only',
    });
    expect(metadataOnly.nodes['file-1']).not.toHaveProperty('localResourceId');

    const missing = CanvasSchema.parse({
      ...canonical,
      nodes: canonical.nodes.map((node) =>
        node.type === 'file'
          ? {
              ...node,
              data: {
                ...node.data,
                file: { ...node.data.file, missing: true },
              },
            }
          : node,
      ),
    });
    expect(collaborationMetadataSnapshotFromCanvas(missing).nodes['file-1']).toMatchObject({
      availability: 'unavailable',
    });
  });

  it('round-trips the exact allowlisted snapshot through JSON without broadening its shape', () => {
    const snapshot = collaborationMetadataSnapshotFromCanvas(canvas());
    const roundTrip = deserializeCollaborationMetadataSnapshot(
      serializeCollaborationMetadataSnapshot(snapshot),
    );
    expect(roundTrip).toEqual(snapshot);
    expect(CollaborationMetadataSnapshotSchema.parse(roundTrip)).toEqual(snapshot);
  });

  it('shares group-frame behavior through explicit group fields and node ownership only', () => {
    const canonical = canvas();
    const group = canonical.groups[0];
    if (group === undefined) throw new Error('Missing group fixture.');
    const withFrame = CanvasSchema.parse({
      ...canonical,
      groups: canonical.groups.map((candidate) =>
        candidate.id === group.id
          ? {
              ...candidate,
              title: 'Stale group title',
              position: { x: 900, y: 900 },
              size: { width: 900, height: 700 },
              color: '#112233',
              locked: false,
            }
          : candidate,
      ),
      nodes: [
        ...canonical.nodes,
        CanvasNodeSchema.parse({
          id: group.id,
          type: 'group-frame',
          title: group.title,
          color: group.color,
          icon: 'group-frame',
          position: group.position,
          size: group.size,
          collapsed: true,
          locked: true,
          inspector: { privateNote: 'PRIVATE_GROUP_NOTE' },
          createdAt: NOW,
          updatedAt: NOW,
          data: {
            purpose: 'feature-area',
            childNodeIds: group.nodeIds,
            layout: 'grid',
            autoFit: true,
          },
        }),
      ],
    });

    const snapshot = collaborationMetadataSnapshotFromCanvas(withFrame);

    expect(snapshot.groups['group-1']).toMatchObject({
      id: 'group-1',
      title: group.title,
      position: group.position,
      size: group.size,
      color: group.color,
      locked: true,
      collapsed: true,
      purpose: 'feature-area',
      layout: 'grid',
      autoFit: true,
    });
    expect(snapshot.groups['group-1']).not.toHaveProperty('childNodeIds');
    expect(snapshot.nodes['group-1']).toMatchObject({
      id: 'group-1',
      type: 'group-frame',
      collapsed: true,
    });
    expect(snapshot.nodes['group-1']).not.toHaveProperty('data');
    expect(
      Object.values(snapshot.nodes)
        .filter((node) => node.groupId === 'group-1')
        .map((node) => node.id),
    ).toEqual([
      'agent-1',
      'task-1',
      'file-1',
      'diff-1',
      'terminal-1',
      'diagram-1',
      'whiteboard-1',
      'note-1',
      'git-pr-1',
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_GROUP_NOTE');
  });

  it.each([
    ['agent', { promptDraft: 'PRIVATE_PAYLOAD' }, 'agent'],
    ['product-brief', { markdown: 'PRIVATE_PAYLOAD' }, 'product-brief'],
    [
      'task',
      {
        description: 'PRIVATE_PAYLOAD',
        relatedFiles: [],
        taskStatus: 'backlog',
      },
      'task',
    ],
    ['file', { historyRefs: ['PRIVATE_PAYLOAD'] }, 'file'],
    ['diff-review', { revisionRequest: 'PRIVATE_PAYLOAD' }, 'diff-review'],
    ['terminal', { command: { executable: 'echo', args: ['PRIVATE_PAYLOAD'] } }, 'terminal'],
    ['web-preview', { url: 'https://private.example.test' }, 'web-preview'],
    ['mobile-preview', { url: 'https://private.example.test' }, 'mobile-preview'],
    ['test', { command: { executable: 'echo', args: ['PRIVATE_PAYLOAD'] } }, 'test'],
    ['review-gate', { reviewerAgentId: 'private-agent' }, 'review-gate'],
    ['git-pr', { branch: 'PRIVATE_PAYLOAD' }, 'git-pr'],
    ['diagram', { mermaidSource: 'PRIVATE_PAYLOAD' }, 'diagram'],
    ['whiteboard-mockup', { excalidraw: { private: 'PRIVATE_PAYLOAD' } }, 'whiteboard'],
    ['note-image', { markdown: 'PRIVATE_PAYLOAD' }, 'note-image'],
    ['group-frame', { purpose: 'custom', childNodeIds: ['private-node'] }, 'group-frame'],
    [
      'extension',
      {
        extensionId: 'private.extension',
        extensionVersion: '1.0.0',
        nodeTypeId: 'private-node',
        definition: { private: 'PRIVATE_PAYLOAD' },
      },
      undefined,
    ],
  ])('projects canonical %s nodes through the explicit allowlist', (type, data, expectedType) => {
    const node = CanvasNodeSchema.parse({
      id: `node-${type}`,
      type,
      title: 'Safe node',
      color: '#445566',
      icon: 'safe',
      position: { x: 10, y: 20 },
      size: { width: 320, height: 180 },
      inspector: { private: 'PRIVATE_PAYLOAD' },
      createdAt: NOW,
      updatedAt: NOW,
      data,
    });
    const metadata = collaborationNodeMetadataFromCanvasNode(node);
    expect(metadata?.type).toBe(expectedType);
    expect(JSON.stringify(metadata) ?? '').not.toContain('PRIVATE_PAYLOAD');
    if (metadata !== undefined) expect(forbiddenKeys(metadata)).toEqual([]);
  });

  it.each([
    ['repositoryFiles', { payload: 'private/credential.ts' }],
    ['fileContents', { payload: 'source' }],
    ['prompts', { payload: 'prompt' }],
    ['diffs', { payload: 'diff' }],
    ['transcripts', { payload: 'transcript' }],
    ['environment', { payload: 'TOKEN' }],
    ['secrets', { payload: 'secret' }],
  ])('rejects a forbidden snapshot root %s', (field, value) => {
    const snapshot = collaborationMetadataSnapshotFromCanvas(canvas());
    expect(
      CollaborationMetadataSnapshotSchema.safeParse({
        ...snapshot,
        [field]: value,
      }).success,
    ).toBe(false);
  });

  it('rejects forbidden nested metadata and adversarial non-canonical Canvas fields', () => {
    const snapshot = collaborationMetadataSnapshotFromCanvas(canvas());
    expect(
      CollaborationMetadataSnapshotSchema.safeParse({
        ...snapshot,
        nodes: {
          ...snapshot.nodes,
          'agent-1': { ...snapshot.nodes['agent-1'], prompt: 'do not share' },
        },
      }).success,
    ).toBe(false);

    const canonical = canvas();
    const adversarialRoot = {
      ...canonical,
      repositoryPath: '/private/repository',
    } as unknown as Canvas;
    expect(() => collaborationMetadataSnapshotFromCanvas(adversarialRoot)).toThrow();

    const adversarialNode = {
      ...canonical,
      nodes: canonical.nodes.map((node, index) =>
        index === 0 ? { ...node, fileContents: 'source' } : node,
      ),
    } as unknown as Canvas;
    expect(() => collaborationMetadataSnapshotFromCanvas(adversarialNode)).toThrow();
  });

  it('rejects path-bearing file bindings and duplicate shared identifiers', () => {
    const pathBearingOptions = {
      fileResources: {
        'file-1': {
          localResourceId: FILE_RESOURCE_ID,
          availability: 'local',
          relativePath: 'private/credential.ts',
        },
      },
    } as unknown as CollaborationCanvasProjectionOptions;
    expect(() => collaborationMetadataSnapshotFromCanvas(canvas(), pathBearingOptions)).toThrow();
    expect(() =>
      collaborationMetadataSnapshotFromCanvas(canvas(), {
        fileResources: {
          'agent-1': {
            localResourceId: FILE_RESOURCE_ID,
            availability: 'local',
          },
        },
      }),
    ).toThrow(CollaborationMetadataProjectionError);

    const canonical = canvas();
    const duplicateComment = CanvasSchema.parse({
      ...canonical,
      nodes: canonical.nodes.map((node) =>
        node.id === 'agent-1'
          ? {
              ...node,
              comments: [
                {
                  id: 'comment-1',
                  authorId: 'editor-1',
                  scope: 'shared',
                  body: 'A duplicate identifier',
                  createdAt: NOW,
                },
              ],
            }
          : node,
      ),
    });
    expect(() => collaborationMetadataSnapshotFromCanvas(duplicateComment)).toThrow(
      CollaborationMetadataProjectionError,
    );
  });

  it('fails closed instead of truncating user-authored metadata that exceeds wire limits', () => {
    const canonical = canvas();
    const oversizedComment = CanvasSchema.parse({
      ...canonical,
      nodes: canonical.nodes.map((node) =>
        node.id === 'task-1'
          ? {
              ...node,
              comments: [
                {
                  id: 'comment-oversized',
                  authorId: 'editor-1',
                  scope: 'shared',
                  body: 'x'.repeat(4_001),
                  createdAt: NOW,
                },
              ],
            }
          : node,
      ),
    });
    expect(() => collaborationMetadataSnapshotFromCanvas(oversizedComment)).toThrow(
      CollaborationMetadataProjectionError,
    );
  });

  it('rejects record-key identity swaps and dangling graph references', () => {
    const snapshot = collaborationMetadataSnapshotFromCanvas(canvas());
    expect(
      CollaborationMetadataSnapshotSchema.safeParse({
        ...snapshot,
        nodes: {
          ...snapshot.nodes,
          'agent-1': { ...snapshot.nodes['agent-1'], id: 'task-1' },
        },
      }).success,
    ).toBe(false);
    expect(
      CollaborationMetadataSnapshotSchema.safeParse({
        ...snapshot,
        edges: {
          ...snapshot.edges,
          'execute-1': {
            ...snapshot.edges['execute-1'],
            sourceId: 'missing-node',
          },
        },
      }).success,
    ).toBe(false);
    expect(
      CollaborationMetadataSnapshotSchema.safeParse({
        ...snapshot,
        reviews: {
          'review-1': {
            id: 'review-1',
            nodeId: 'missing-node',
            reviewerId: 'reviewer-1',
            status: 'pending',
            createdAt: NOW,
          },
        },
      }).success,
    ).toBe(false);
  });
});

const FORBIDDEN_FIELD_NAMES = new Set([
  'args',
  'canonicalPath',
  'command',
  'config',
  'data',
  'definition',
  'diff',
  'diffs',
  'environment',
  'environmentNames',
  'env',
  'excalidraw',
  'file',
  'fileContents',
  'inspector',
  'markdown',
  'path',
  'prompt',
  'promptDraft',
  'relativePath',
  'repository',
  'repositoryPath',
  'secret',
  'secrets',
  'transcript',
  'transcripts',
  'url',
  'values',
]);

function forbiddenKeys(value: unknown, matches: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) forbiddenKeys(item, matches);
    return matches;
  }
  if (typeof value !== 'object' || value === null) return matches;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_FIELD_NAMES.has(key)) matches.push(key);
    forbiddenKeys(nested, matches);
  }
  return matches;
}
