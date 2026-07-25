// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('../../../file-editor/MonacoTextEditor.js', () => ({
  MonacoTextEditor: ({ value, readOnly }: { value: string; readOnly: boolean }) => (
    <div data-testid="code-view" data-readonly={String(readOnly)}>
      {value}
    </div>
  ),
}));

import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import { FileNodeFace } from './FileNodeFace.js';

const read = vi.fn();

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'forgeboard');
});
beforeEach(() => {
  read.mockReset();
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: { files: { read } },
  });
});

function nodeData(overrides: Partial<WorkshopNodeData> = {}): WorkshopNodeData {
  return {
    kind: 'file',
    title: 'Atlas',
    description: 'app.ts',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#6d9ed0',
    ...overrides,
  } as WorkshopNodeData;
}

const fileReference = {
  projectId: '00000000-0000-4000-8000-000000000001',
  relativePath: 'src/app.ts',
  kind: 'file' as const,
  missing: false,
};

function document(overrides: Record<string, unknown> = {}) {
  return {
    projectId: fileReference.projectId,
    relativePath: fileReference.relativePath,
    contentKind: 'text',
    content: 'export const answer = 42;\n',
    encoding: 'utf-8',
    sizeBytes: 26,
    modifiedAt: '2026-07-15T12:00:00.000Z',
    sha256: 'a'.repeat(64),
    readOnly: false,
    readOnlyReason: null,
    ...overrides,
  };
}

describe('FileNodeFace', () => {
  it('shows the file name and a read-only code view — nothing else', async () => {
    read.mockResolvedValue(document());
    render(<FileNodeFace id="n1" data={nodeData({ file: fileReference })} />);

    expect(screen.getByText('app.ts')).toBeTruthy();
    const code = await screen.findByTestId('code-view');
    expect(code.getAttribute('data-readonly')).toBe('true');
    expect(code.textContent).toContain('export const answer = 42;');
    expect(read).toHaveBeenCalledWith({
      projectId: fileReference.projectId,
      relativePath: fileReference.relativePath,
    });
    // Minimal by design: no Choose, no Change, no Settings, no buttons at all.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('hints at the project tree when no file is linked and reads nothing', () => {
    render(<FileNodeFace id="n1" data={nodeData()} />);
    expect(screen.getByText('Click a file in the project tree to open it here.')).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('surfaces the read policy message for files the renderer cannot read', async () => {
    read.mockRejectedValue({
      code: 'IGNORED_FILE',
      message: 'Ignored files are not exposed to the embedded renderer.',
    });
    render(<FileNodeFace id="n1" data={nodeData({ file: fileReference })} />);
    expect(
      await screen.findByText('Ignored files are not exposed to the embedded renderer.'),
    ).toBeTruthy();
  });

  it('keeps binary files content-free with a terse reason', async () => {
    read.mockResolvedValue(
      document({
        contentKind: 'binary',
        content: null,
        encoding: null,
        sha256: null,
        readOnly: true,
        readOnlyReason: 'Not a text file.',
      }),
    );
    render(<FileNodeFace id="n1" data={nodeData({ file: fileReference })} />);
    expect(await screen.findByText('Not a text file.')).toBeTruthy();
    expect(screen.queryByTestId('code-view')).toBeNull();
  });

  it('marks a missing file instead of reading it', () => {
    render(
      <FileNodeFace id="n1" data={nodeData({ file: { ...fileReference, missing: true } })} />,
    );
    expect(screen.getByText('This file is missing on disk.')).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
  });
});
