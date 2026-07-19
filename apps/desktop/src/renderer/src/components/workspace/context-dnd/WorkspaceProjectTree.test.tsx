// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FileTreeResult } from '../../../../../shared/files/contracts.js';
import { readWorkspaceContextDrag, WORKSPACE_CONTEXT_DRAG_MIME } from './contracts.js';
import { WorkspaceProjectTree } from './WorkspaceProjectTree.js';

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';

afterEach(cleanup);

describe('WorkspaceProjectTree', () => {
  it('drags only normal openable regular files with no absolute path or content', async () => {
    const tree = projectTreeOperation();
    render(
      <WorkspaceProjectTree
        projectId={PROJECT_ID}
        operations={{
          tree,
          search: vi.fn(),
          read: vi.fn(),
        }}
      />,
    );

    fireEvent.click(await screen.findByRole('treeitem', { name: 'Open folder src' }));
    const safe = await screen.findByRole('treeitem', {
      name: 'File src/index.ts',
    });
    expect(safe.getAttribute('draggable')).toBe('true');
    expect(safe.getAttribute('aria-describedby')).toBe(
      screen.getByRole('tooltip', {
        name: /Drag src\/index\.ts onto an agent/u,
      }).id,
    );

    const transfer = dataTransfer();
    fireEvent.dragStart(safe, { dataTransfer: transfer });
    expect(readWorkspaceContextDrag(transfer)).toEqual({
      schemaVersion: 1,
      kind: 'project-file',
      projectId: PROJECT_ID,
      relativePath: 'src/index.ts',
    });
    expect(transfer.getData(WORKSPACE_CONTEXT_DRAG_MIME)).not.toContain('/tmp/project');
    expect(transfer.getData(WORKSPACE_CONTEXT_DRAG_MIME)).not.toContain('file bytes');
    fireEvent.click(screen.getByRole('button', { name: 'Go to folder .' }));
    const protectedEntry = screen.getByRole('treeitem', {
      name: 'Protected file .env',
    });
    expect(protectedEntry.getAttribute('draggable')).toBe('false');
    expect(protectedEntry.getAttribute('aria-describedby')).toBe(
      screen.getByRole('tooltip', { name: 'Credential-like file.' }).id,
    );
  });

  it('supports bounded project-relative search and refresh', async () => {
    const tree = projectTreeOperation();
    render(
      <WorkspaceProjectTree
        projectId={PROJECT_ID}
        operations={{ tree, search: vi.fn(), read: vi.fn() }}
      />,
    );
    await waitFor(() => expect(tree).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search project files' }), {
      target: { value: 'index' },
    });
    expect(
      await screen.findByRole('treeitem', {
        name: 'File src/index.ts',
      }),
    ).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search project files' }), {
      target: { value: 'env' },
    });
    expect(screen.getByRole('treeitem', { name: 'Protected file .env' })).toBeTruthy();
    expect(
      screen.queryByRole('treeitem', {
        name: 'File src/index.ts',
      }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh project files' }));
    await waitFor(() => expect(tree).toHaveBeenCalledTimes(4));
  });
});

function projectTreeOperation() {
  return vi.fn((input: { readonly directory: string }) =>
    Promise.resolve(treeResult(input.directory)),
  );
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
              name: 'src',
              relativePath: 'src',
              kind: 'directory',
              sizeBytes: null,
              modifiedAt: '2026-07-15T12:00:00.000Z',
              policy: { status: 'normal', reason: null },
              canOpen: true,
            },
            {
              name: '.env',
              relativePath: '.env',
              kind: 'file',
              sizeBytes: 20,
              modifiedAt: '2026-07-15T12:00:00.000Z',
              policy: { status: 'sensitive', reason: 'Credential-like file.' },
              canOpen: false,
            },
          ]
        : [
            {
              name: 'index.ts',
              relativePath: 'src/index.ts',
              kind: 'file',
              sizeBytes: 10,
              modifiedAt: '2026-07-15T12:00:00.000Z',
              policy: { status: 'normal', reason: null },
              canOpen: true,
            },
          ],
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
    setData: (format: string, value: string) => {
      values.set(format, value);
    },
    setDragImage: () => undefined,
  };
  return Object.defineProperty(transfer, 'types', {
    get: () => [...values.keys()],
  }) as unknown as DataTransfer;
}
