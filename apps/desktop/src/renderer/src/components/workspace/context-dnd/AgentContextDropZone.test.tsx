// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkshopNode } from '../canvas/CanvasNode.js';
import { WORKSPACE_CONTEXT_DRAG_MIME, writeWorkspaceContextDrag } from './contracts.js';
import { AgentContextDropZone } from './AgentContextDropZone.js';

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';

afterEach(cleanup);

describe('AgentContextDropZone', () => {
  it('shows exact linked File nodes, keeps stale IDs visible, and removes explicitly', () => {
    const onRemove = vi.fn();
    render(
      <AgentContextDropZone
        agent={agentNode(['file-1', 'stale-file'])}
        nodes={[agentNode(['file-1', 'stale-file']), fileNode()]}
        readOnly={false}
        onAttach={vi.fn()}
        onRemove={onRemove}
      />,
    );

    expect(screen.getByText('2/256')).toBeTruthy();
    expect(screen.getByText('src/index.ts')).toBeTruthy();
    expect(screen.getByText('File no longer available')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove stale-file from this agent' }));
    expect(onRemove).toHaveBeenCalledWith('stale-file');
  });

  it('accepts only the strict Forgeboard payload and reports verification progress', async () => {
    let finish: (() => void) | undefined;
    const onAttach = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <AgentContextDropZone
        agent={agentNode([])}
        nodes={[agentNode([])]}
        readOnly={false}
        onAttach={onAttach}
        onRemove={vi.fn()}
      />,
    );
    const zone = screen.getByRole('region', {
      name: 'Files for this agent',
    });
    const transfer = dataTransfer();
    writeWorkspaceContextDrag(transfer, {
      schemaVersion: 1,
      kind: 'project-file',
      projectId: PROJECT_ID,
      relativePath: 'src/index.ts',
      sourceNodeId: 'file-1',
    });

    fireEvent.dragOver(zone, { dataTransfer: transfer });
    fireEvent.drop(zone, { dataTransfer: transfer });
    expect(onAttach).toHaveBeenCalledWith({
      schemaVersion: 1,
      kind: 'project-file',
      projectId: PROJECT_ID,
      relativePath: 'src/index.ts',
      sourceNodeId: 'file-1',
    });
    expect(screen.getByRole('status').textContent).toMatch(/Checking/u);
    finish?.();
    await waitFor(() => expect(screen.queryByText(/Checking/u)).toBeNull());
  });

  it('rejects malformed payloads and disables linking for read-only context', () => {
    const onAttach = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <AgentContextDropZone
        agent={agentNode([])}
        nodes={[agentNode([])]}
        readOnly={false}
        onAttach={onAttach}
        onRemove={vi.fn()}
      />,
    );
    const invalid = dataTransfer('{"absolutePath":"/tmp/secret"}');
    fireEvent.drop(screen.getByRole('region', { name: 'Files for this agent' }), {
      dataTransfer: invalid,
    });
    expect(screen.getByRole('alert').textContent).toMatch(/project files list/u);
    expect(onAttach).not.toHaveBeenCalled();

    rerender(
      <AgentContextDropZone
        agent={agentNode([])}
        nodes={[agentNode([])]}
        readOnly
        onAttach={onAttach}
        onRemove={vi.fn()}
      />,
    );
    const valid = dataTransfer();
    writeWorkspaceContextDrag(valid, {
      schemaVersion: 1,
      kind: 'project-file',
      projectId: PROJECT_ID,
      relativePath: 'src/index.ts',
    });
    fireEvent.drop(screen.getByRole('region', { name: 'Files for this agent' }), {
      dataTransfer: valid,
    });
    expect(onAttach).not.toHaveBeenCalled();
  });
});

function agentNode(contextAttachmentIds: string[]): WorkshopNode {
  return {
    id: 'agent-1',
    type: 'workshop',
    position: { x: 0, y: 0 },
    data: {
      kind: 'agent',
      title: 'Agent',
      description: 'Agent',
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#445566',
      contextAttachmentIds,
    },
  };
}

function fileNode(): WorkshopNode {
  return {
    id: 'file-1',
    type: 'workshop',
    position: { x: 0, y: 0 },
    data: {
      kind: 'file',
      title: 'index.ts',
      description: 'File',
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#667788',
      file: {
        projectId: PROJECT_ID,
        relativePath: 'src/index.ts',
        kind: 'file',
        missing: false,
      },
    },
  };
}

function dataTransfer(initial = ''): DataTransfer {
  const values = new Map<string, string>();
  if (initial !== '') values.set(WORKSPACE_CONTEXT_DRAG_MIME, initial);
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
    setData: (format: string, value: string) => {
      values.set(format, value);
    },
    setDragImage: () => undefined,
  };
  return Object.defineProperty(transfer, 'types', {
    get: () => [...values.keys()],
  }) as unknown as DataTransfer;
}
