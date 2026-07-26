// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FileDocument, FileTreeResult } from '../../../../../../shared/files/contracts.js';
import type { WorkshopNode } from '../../canvas/CanvasNode.js';
import { AgentContextDropZone } from '../AgentContextDropZone.js';
import type { WorkspaceContextDragPayload } from '../contracts.js';
import { linkProjectFileToAgent } from '../linking.js';
import { WorkspaceProjectTree } from '../WorkspaceProjectTree.js';

const PROJECT_ID = '70000000-0000-4000-8000-000000000001';

afterEach(cleanup);

describe('project-file to Agent context UI workflow', () => {
  it('drags a safe project-tree file into the selected Agent and shows the durable link', async () => {
    render(<TreeToSelectedAgentHarness />);
    fireEvent.click(await screen.findByRole('treeitem', { name: 'Expand folder docs' }));
    const source = await screen.findByRole('treeitem', {
      name: 'File docs/brief.md',
    });
    const target = screen.getByRole('region', { name: 'Files for this agent' });
    const transfer = dataTransfer();

    fireEvent.dragStart(source, { dataTransfer: transfer });
    fireEvent.dragOver(target, { dataTransfer: transfer });
    fireEvent.drop(target, { dataTransfer: transfer });

    expect(await screen.findByText('docs/brief.md')).toBeTruthy();
    expect(screen.getByText('1/256')).toBeTruthy();
  });
});

function TreeToSelectedAgentHarness() {
  const [nodes, setNodes] = useState<WorkshopNode[]>([agentNode()]);
  const agent = nodes.find((node) => node.id === 'agent-1')!;
  const onAttach = (targetNodeId: string, payload: WorkspaceContextDragPayload) => {
    setNodes(linkedNodes(nodes, payload, document(payload), targetNodeId));
    return Promise.resolve();
  };
  return (
    <>
      <WorkspaceProjectTree
        projectId={PROJECT_ID}
        operations={{
          tree: vi.fn((input: { readonly directory: string }) =>
            Promise.resolve(treeResult(input.directory)),
          ),
          search: vi.fn(),
          read: vi.fn(),
        }}
      />
      <AgentContextDropZone
        agent={agent}
        nodes={nodes}
        readOnly={false}
        onAttach={(payload) => onAttach(agent.id, payload)}
        onRemove={vi.fn()}
      />
    </>
  );
}

function linkedNodes(
  nodes: readonly WorkshopNode[],
  payload: WorkspaceContextDragPayload,
  verified: FileDocument,
  targetNodeId = 'agent-1',
): WorkshopNode[] {
  const result = linkProjectFileToAgent({
    projectId: PROJECT_ID,
    targetNodeId,
    payload,
    document: verified,
    nodes,
    newNodeId: 'file-created',
  });
  if (!result.ok) throw new Error(result.message);
  return result.nodes;
}

function treeResult(directory: string): FileTreeResult {
  return {
    projectId: PROJECT_ID,
    directory,
    truncated: false,
    entries:
      directory === '.'
        ? [
            {
              name: 'docs',
              relativePath: 'docs',
              kind: 'directory',
              sizeBytes: null,
              modifiedAt: '2026-07-15T12:00:00.000Z',
              policy: { status: 'normal', reason: null },
              canOpen: true,
            },
          ]
        : [
            {
              name: 'brief.md',
              relativePath: 'docs/brief.md',
              kind: 'file',
              sizeBytes: 10,
              modifiedAt: '2026-07-15T12:00:00.000Z',
              policy: { status: 'normal', reason: null },
              canOpen: true,
            },
          ],
  };
}

function document(payload: WorkspaceContextDragPayload): FileDocument {
  return {
    projectId: PROJECT_ID,
    relativePath: payload.relativePath,
    contentKind: 'text',
    content: 'verified\n',
    encoding: 'utf-8',
    sizeBytes: 9,
    modifiedAt: '2026-07-15T12:00:00.000Z',
    sha256: 'a'.repeat(64),
    readOnly: false,
    readOnlyReason: null,
  };
}

function agentNode(): WorkshopNode {
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
    },
  };
}

function dataTransfer(): DataTransfer {
  const values = new Map<string, string>();
  const transfer = {
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    clearData: (format?: string) => {
      if (format === undefined) values.clear();
      else values.delete(format);
    },
    getData: (format: string) => values.get(format) ?? '',
    setData: (format: string, value: string) => values.set(format, value),
    setDragImage: () => undefined,
  };
  return Object.defineProperty(transfer, 'types', {
    get: () => [...values.keys()],
  }) as unknown as DataTransfer;
}
