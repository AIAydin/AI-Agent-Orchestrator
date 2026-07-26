// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FileTreeResult } from '../../../../../shared/files/contracts.js';
import { readWorkspaceContextDrag, WORKSPACE_CONTEXT_DRAG_MIME } from './contracts.js';
import { WorkspaceProjectTree } from './WorkspaceProjectTree.js';

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';

afterEach(cleanup);

describe('WorkspaceProjectTree', () => {
  it('expands and collapses folders in place without leaving the tree', async () => {
    render(
      <WorkspaceProjectTree
        projectId={PROJECT_ID}
        operations={{
          tree: projectTreeOperation(),
          search: vi.fn(),
          read: vi.fn(),
        }}
      />,
    );

    const folder = await screen.findByRole('treeitem', {
      name: 'Expand folder src',
    });
    expect(folder.getAttribute('aria-expanded')).toBe('false');
    expect(folder.getAttribute('aria-level')).toBe('1');
    expect(screen.queryByRole('treeitem', { name: 'File src/index.ts' })).toBeNull();

    fireEvent.click(folder);
    const opened = screen.getByRole('treeitem', {
      name: 'Collapse folder src',
    });
    expect(opened.getAttribute('aria-expanded')).toBe('true');
    const child = screen.getByRole('treeitem', { name: 'File src/index.ts' });
    expect(child.getAttribute('aria-level')).toBe('2');

    fireEvent.keyDown(opened, { key: 'ArrowLeft' });
    expect(screen.queryByRole('treeitem', { name: 'File src/index.ts' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('treeitem', { name: 'Expand folder src' }), {
      key: 'ArrowRight',
    });
    expect(screen.getByRole('treeitem', { name: 'File src/index.ts' })).toBeTruthy();
  });

  it('drags only normal openable regular files with no absolute path or content', async () => {
    render(
      <WorkspaceProjectTree
        projectId={PROJECT_ID}
        operations={{
          tree: projectTreeOperation(),
          search: vi.fn(),
          read: vi.fn(),
        }}
      />,
    );

    fireEvent.click(await screen.findByRole('treeitem', { name: 'Expand folder src' }));
    const safe = screen.getByRole('treeitem', { name: 'File src/index.ts' });
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

    const sensitiveEntry = screen.getByRole('treeitem', {
      name: 'Sensitive file .env',
    });
    expect(sensitiveEntry.getAttribute('draggable')).toBe('false');
    expect(sensitiveEntry.getAttribute('aria-disabled')).toBe('false');
    expect(sensitiveEntry.getAttribute('aria-describedby')).toBe(
      screen.getByRole('tooltip', {
        name: 'May hold credentials — opens on the canvas, never shared with agents.',
      }).id,
    );
  });

  it('opens a sensitive file on click without making it draggable', async () => {
    const onOpenFile = vi.fn();
    render(
      <WorkspaceProjectTree
        projectId={PROJECT_ID}
        operations={{ tree: projectTreeOperation(), search: vi.fn(), read: vi.fn() }}
        onOpenFile={onOpenFile}
      />,
    );

    const sensitiveEntry = await screen.findByRole('treeitem', { name: 'Sensitive file .env' });
    fireEvent.click(sensitiveEntry);
    expect(onOpenFile).toHaveBeenCalledWith(
      expect.objectContaining({
        relativePath: '.env',
        policy: { status: 'sensitive', reason: 'Credential-like file.' },
      }),
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
    expect(await screen.findByRole('treeitem', { name: 'File src/index.ts' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search project files' }), {
      target: { value: 'env' },
    });
    expect(screen.getByRole('treeitem', { name: 'Sensitive file .env' })).toBeTruthy();
    expect(screen.queryByRole('treeitem', { name: 'File src/index.ts' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh project files' }));
    await waitFor(() => expect(tree).toHaveBeenCalledTimes(4));
  });

  it('shows ignored files with their shield and opens them on click without dragging', async () => {
    const onOpenFile = vi.fn();
    render(
      <WorkspaceProjectTree
        projectId={PROJECT_ID}
        operations={{ tree: projectTreeOperation(), search: vi.fn(), read: vi.fn() }}
        onOpenFile={onOpenFile}
      />,
    );

    const ignored = await screen.findByRole('treeitem', { name: 'Ignored file debug.log' });
    expect(ignored.getAttribute('draggable')).toBe('false');
    expect(ignored.getAttribute('aria-disabled')).toBe('false');
    fireEvent.click(ignored);
    expect(onOpenFile).toHaveBeenCalledWith(
      expect.objectContaining({
        relativePath: 'debug.log',
        policy: { status: 'ignored', reason: 'Ignored by .gitignore.' },
      }),
    );
  });

  it('expands ignored folders by listing them on demand, shield kept', async () => {
    const tree = projectTreeOperation();
    render(
      <WorkspaceProjectTree
        projectId={PROJECT_ID}
        operations={{ tree, search: vi.fn(), read: vi.fn() }}
      />,
    );

    const folder = await screen.findByRole('treeitem', { name: 'Expand folder dist' });
    fireEvent.click(folder);
    expect(
      await screen.findByRole('treeitem', { name: 'Ignored file dist/bundle.js' }),
    ).toBeTruthy();
    expect(tree).toHaveBeenCalledWith({ projectId: PROJECT_ID, directory: 'dist' });
  });

  it('opens a clicked project file on the canvas', async () => {
    const onOpenFile = vi.fn();
    render(
      <WorkspaceProjectTree
        projectId={PROJECT_ID}
        operations={{ tree: projectTreeOperation(), search: vi.fn(), read: vi.fn() }}
        onOpenFile={onOpenFile}
      />,
    );

    fireEvent.click(await screen.findByRole('treeitem', { name: 'Expand folder src' }));
    fireEvent.click(screen.getByRole('treeitem', { name: 'File src/index.ts' }));
    expect(onOpenFile).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'src/index.ts' }),
    );
  });

  it('reveals a folder from search results by expanding it in the tree', async () => {
    render(
      <WorkspaceProjectTree
        projectId={PROJECT_ID}
        operations={{
          tree: projectTreeOperation(),
          search: vi.fn(),
          read: vi.fn(),
        }}
      />,
    );
    await screen.findByRole('treeitem', { name: 'Expand folder src' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search project files' }), {
      target: { value: 'src' },
    });
    fireEvent.click(screen.getByRole('treeitem', { name: 'Expand folder src' }));
    expect(
      screen.getByRole<HTMLInputElement>('textbox', { name: 'Search project files' }).value,
    ).toBe('');
    expect(
      screen.getByRole('treeitem', { name: 'Collapse folder src' }).getAttribute('aria-expanded'),
    ).toBe('true');
    expect(screen.getByRole('treeitem', { name: 'File src/index.ts' })).toBeTruthy();
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
              name: 'dist',
              relativePath: 'dist',
              kind: 'directory',
              sizeBytes: null,
              modifiedAt: '2026-07-15T12:00:00.000Z',
              policy: { status: 'ignored', reason: 'Ignored by .gitignore.' },
              canOpen: true,
            },
            {
              name: 'debug.log',
              relativePath: 'debug.log',
              kind: 'file',
              sizeBytes: 40,
              modifiedAt: '2026-07-15T12:00:00.000Z',
              policy: { status: 'ignored', reason: 'Ignored by .gitignore.' },
              canOpen: true,
            },
            {
              name: '.env',
              relativePath: '.env',
              kind: 'file',
              sizeBytes: 20,
              modifiedAt: '2026-07-15T12:00:00.000Z',
              policy: { status: 'sensitive', reason: 'Credential-like file.' },
              canOpen: true,
            },
          ]
        : directory === 'dist'
          ? [
              {
                name: 'bundle.js',
                relativePath: 'dist/bundle.js',
                kind: 'file',
                sizeBytes: 900,
                modifiedAt: '2026-07-15T12:00:00.000Z',
                policy: { status: 'ignored', reason: 'Ignored by .gitignore.' },
                canOpen: true,
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
