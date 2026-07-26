import { describe, expect, it } from 'vitest';

import type { FileDocument } from '../../../../../shared/files/contracts.js';
import type { WorkshopNode } from '../canvas/CanvasNode.js';
import {
  linkProjectFileToAgent,
  MAX_AGENT_CONTEXT_ATTACHMENTS,
  removeProjectFileFromAgent,
} from './linking.js';
import type { WorkspaceContextDragPayload } from './contracts.js';

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_PROJECT_ID = '00000000-0000-4000-8000-000000000002';
const HASH = 'a'.repeat(64);

describe('Agent project-file context linking', () => {
  it('creates one configured File node and links its opaque node ID to the Agent', () => {
    const result = linkProjectFileToAgent({
      projectId: PROJECT_ID,
      targetNodeId: 'agent-1',
      payload: payload(),
      document: document(),
      nodes: [agentNode()],
      newNodeId: 'file-created',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.createdFileNode).toBe(true);
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0]?.data.contextAttachmentIds).toEqual(['file-created']);
    expect(result.nodes[1]).toMatchObject({
      id: 'file-created',
      width: 640,
      height: 520,
      data: {
        kind: 'file',
        title: 'index.ts',
        file: {
          projectId: PROJECT_ID,
          relativePath: 'src/index.ts',
          kind: 'file',
          missing: false,
          lastKnownHash: HASH,
        },
      },
    });
  });

  it('uses an exact existing File-node source, refreshes its hash, and deduplicates links', () => {
    const source = fileNode({ lastKnownHash: 'b'.repeat(64) });
    const first = linkProjectFileToAgent({
      projectId: PROJECT_ID,
      targetNodeId: 'agent-1',
      payload: payload({ sourceNodeId: source.id }),
      document: document(),
      nodes: [agentNode(), source],
      newNodeId: 'unused',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.createdFileNode).toBe(false);
    expect(first.nodes.find((node) => node.id === source.id)?.data.file?.lastKnownHash).toBe(HASH);

    const second = linkProjectFileToAgent({
      projectId: PROJECT_ID,
      targetNodeId: 'agent-1',
      payload: payload({ sourceNodeId: source.id }),
      document: document(),
      nodes: first.nodes,
      newNodeId: 'unused-again',
    });
    expect(second.ok && second.changed).toBe(false);
    expect(
      second.ok
        ? second.nodes.find((node) => node.id === 'agent-1')?.data.contextAttachmentIds
        : [],
    ).toEqual(['file-1']);
  });

  it('deduplicates two File node IDs that resolve to the same physical project path', () => {
    const first = fileNode();
    const duplicate = { ...fileNode(), id: 'file-duplicate' };
    const result = linkProjectFileToAgent({
      projectId: PROJECT_ID,
      targetNodeId: 'agent-1',
      payload: payload({ sourceNodeId: duplicate.id }),
      document: document(),
      nodes: [agentNode({ contextAttachmentIds: [first.id] }), first, duplicate],
      newNodeId: 'unused',
    });

    expect(result.ok && result.changed).toBe(false);
    expect(result.ok ? result.attachmentNodeId : null).toBe(first.id);
    expect(
      result.ok
        ? result.nodes.find((node) => node.id === 'agent-1')?.data.contextAttachmentIds
        : [],
    ).toEqual([first.id]);
  });

  it('repairs and reuses an unlocked missing reference after a fresh main-process read', () => {
    const missing = fileNode({ missing: true });
    const result = linkProjectFileToAgent({
      projectId: PROJECT_ID,
      targetNodeId: 'agent-1',
      payload: payload(),
      document: document(),
      nodes: [agentNode(), missing],
      newNodeId: 'unused',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.createdFileNode).toBe(false);
    expect(result.nodes.find((node) => node.id === missing.id)?.data.file).toMatchObject({
      missing: false,
      lastKnownHash: HASH,
    });
  });

  it.each([
    [
      'locked Agent',
      [agentNode({ locked: true }), fileNode()],
      payload({ sourceNodeId: 'file-1' }),
    ],
    ['locked File node', [agentNode(), fileNode({}, true)], payload({ sourceNodeId: 'file-1' })],
    [
      'missing File node',
      [agentNode(), fileNode({ missing: true })],
      payload({ sourceNodeId: 'file-1' }),
    ],
    [
      'directory node',
      [agentNode(), fileNode({ kind: 'directory' })],
      payload({ sourceNodeId: 'file-1' }),
    ],
    [
      'cross-project source',
      [agentNode(), fileNode({ projectId: OTHER_PROJECT_ID })],
      payload({ sourceNodeId: 'file-1' }),
    ],
  ] as const)('rejects a %s', (_label, nodes, dragPayload) => {
    const result = linkProjectFileToAgent({
      projectId: PROJECT_ID,
      targetNodeId: 'agent-1',
      payload: dragPayload,
      document: document(),
      nodes,
      newNodeId: 'unused',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects cross-project payloads and mismatched authoritative reads', () => {
    expect(
      linkProjectFileToAgent({
        projectId: PROJECT_ID,
        targetNodeId: 'agent-1',
        payload: payload({ projectId: OTHER_PROJECT_ID }),
        document: document(),
        nodes: [agentNode()],
        newNodeId: 'file-created',
      }).ok,
    ).toBe(false);
    expect(
      linkProjectFileToAgent({
        projectId: PROJECT_ID,
        targetNodeId: 'agent-1',
        payload: payload(),
        document: document({ relativePath: 'src/other.ts' }),
        nodes: [agentNode()],
        newNodeId: 'file-created',
      }).ok,
    ).toBe(false);
  });

  it('refuses to link a sensitive file even though it opens locally', () => {
    const result = linkProjectFileToAgent({
      projectId: PROJECT_ID,
      targetNodeId: 'agent-1',
      payload: payload({ relativePath: '.env.local' }),
      document: document({ relativePath: '.env.local', sensitive: true }),
      nodes: [agentNode()],
      newNodeId: 'file-created',
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain("can't be shared with agents");
  });

  it('enforces the executor attachment cap and supports explicit removal', () => {
    const full = agentNode({
      contextAttachmentIds: Array.from(
        { length: MAX_AGENT_CONTEXT_ATTACHMENTS },
        (_, index) => `file-${String(index)}`,
      ),
    });
    expect(
      linkProjectFileToAgent({
        projectId: PROJECT_ID,
        targetNodeId: full.id,
        payload: payload(),
        document: document(),
        nodes: [full],
        newNodeId: 'overflow',
      }).ok,
    ).toBe(false);

    const linked = agentNode({
      contextAttachmentIds: ['file-1', 'stale-file'],
    });
    const removed = removeProjectFileFromAgent({
      targetNodeId: linked.id,
      attachmentNodeId: 'stale-file',
      nodes: [linked, fileNode()],
    });
    expect(removed.ok).toBe(true);
    expect(removed.ok ? removed.nodes[0]?.data.contextAttachmentIds : []).toEqual(['file-1']);
  });
});

function payload(
  overrides: Partial<WorkspaceContextDragPayload> = {},
): WorkspaceContextDragPayload {
  return {
    schemaVersion: 1 as const,
    kind: 'project-file' as const,
    projectId: PROJECT_ID,
    relativePath: 'src/index.ts',
    ...overrides,
  };
}

function document(overrides: Partial<FileDocument> = {}): FileDocument {
  return {
    projectId: PROJECT_ID,
    relativePath: 'src/index.ts',
    contentKind: 'text',
    content: 'export {};\n',
    encoding: 'utf-8',
    sizeBytes: 11,
    modifiedAt: '2026-07-15T12:00:00.000Z',
    sha256: HASH,
    readOnly: false,
    readOnlyReason: null,
    ...overrides,
  };
}

function agentNode(data: Partial<WorkshopNode['data']> = {}): WorkshopNode {
  return {
    id: 'agent-1',
    type: 'workshop',
    position: { x: 400, y: 100 },
    data: {
      kind: 'agent',
      title: 'Agent',
      description: 'Agent',
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#445566',
      contextAttachmentIds: [],
      ...data,
    },
  };
}

function fileNode(
  reference: Partial<NonNullable<WorkshopNode['data']['file']>> = {},
  locked = false,
): WorkshopNode {
  return {
    id: 'file-1',
    type: 'workshop',
    position: { x: 0, y: 0 },
    data: {
      kind: 'file',
      title: 'index.ts',
      description: 'File',
      status: 'idle',
      locked,
      collapsed: false,
      color: '#667788',
      file: {
        projectId: PROJECT_ID,
        relativePath: 'src/index.ts',
        kind: 'file',
        missing: false,
        ...reference,
      },
    },
  };
}
