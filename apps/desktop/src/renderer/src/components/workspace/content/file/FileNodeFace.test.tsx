// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../../file-editor/MonacoTextEditor.js', () => ({
  MonacoTextEditor: ({
    value,
    readOnly,
    ariaLabel,
    onChange,
  }: {
    value: string;
    readOnly: boolean;
    ariaLabel: string;
    onChange: (next: string) => void;
  }) => (
    <textarea
      data-testid="code-view"
      data-readonly={String(readOnly)}
      name="code-view"
      aria-label={ariaLabel}
      value={value}
      readOnly={readOnly}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import { FileNodeFace } from './FileNodeFace.js';

const read = vi.fn();
const save = vi.fn();
const revert = vi.fn();

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'forgeboard');
});
beforeEach(() => {
  read.mockReset();
  save.mockReset();
  revert.mockReset();
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: { files: { read, save, revert } },
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

function codeView(): HTMLTextAreaElement {
  const element = screen.getByTestId('code-view');
  if (!(element instanceof HTMLTextAreaElement)) throw new Error('code view is not a textarea');
  return element;
}

describe('FileNodeFace', () => {
  it('shows the file name and an editable code view with no idle chrome', async () => {
    read.mockResolvedValue(document());
    render(<FileNodeFace id="n1" data={nodeData({ file: fileReference })} />);

    expect(screen.getByText('app.ts')).toBeTruthy();
    const code = await screen.findByTestId('code-view');
    expect(code.getAttribute('data-readonly')).toBe('false');
    expect((code as HTMLTextAreaElement).value).toContain('export const answer = 42;');
    expect(read).toHaveBeenCalledWith({
      projectId: fileReference.projectId,
      relativePath: fileReference.relativePath,
    });
    // Minimal by design: Save appears only once there is something to save.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('marks edits as unsaved and writes them back through files.save', async () => {
    read.mockResolvedValue(document());
    save.mockResolvedValue(
      document({ content: 'export const answer = 43;\n', sha256: 'b'.repeat(64) }),
    );
    render(<FileNodeFace id="n1" data={nodeData({ file: fileReference })} />);
    await screen.findByTestId('code-view');

    fireEvent.change(codeView(), { target: { value: 'export const answer = 43;\n' } });
    expect(screen.getByText('Unsaved')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        projectId: fileReference.projectId,
        relativePath: fileReference.relativePath,
        content: 'export const answer = 43;\n',
        expectedSha256: 'a'.repeat(64),
      }),
    );
    await waitFor(() => expect(screen.queryByText('Unsaved')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('surfaces a failed save and offers to reload the saved file', async () => {
    read.mockResolvedValue(document());
    save.mockRejectedValue({
      code: 'STALE_CONTENT',
      message: 'The file changed on disk since it was opened.',
    });
    revert.mockResolvedValue(document({ content: 'fresh from disk\n' }));
    render(<FileNodeFace id="n1" data={nodeData({ file: fileReference })} />);
    await screen.findByTestId('code-view');

    fireEvent.change(codeView(), { target: { value: 'stale edit\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'The file changed on disk since it was opened.',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(codeView().value).toBe('fresh from disk\n'));
  });

  it('hints at the project tree when no file is linked and reads nothing', () => {
    render(<FileNodeFace id="n1" data={nodeData()} />);
    expect(screen.getByText('Click a file in the project tree to open it here.')).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('surfaces the read failure message for files the renderer cannot read', async () => {
    read.mockRejectedValue({
      code: 'IO_ERROR',
      message: 'The file changed while it was being read. Try again.',
    });
    render(<FileNodeFace id="n1" data={nodeData({ file: fileReference })} />);
    expect(
      await screen.findByText('The file changed while it was being read. Try again.'),
    ).toBeTruthy();
  });

  it('renders the code of a git-ignored file like any other file', async () => {
    const ignored = { ...fileReference, relativePath: '.gemini/settings.json' };
    read.mockResolvedValue(
      document({ relativePath: ignored.relativePath, content: '{ "theme": "dark" }\n' }),
    );
    render(<FileNodeFace id="n1" data={nodeData({ file: ignored })} />);

    expect(screen.getByText('settings.json')).toBeTruthy();
    const code = await screen.findByTestId('code-view');
    expect((code as HTMLTextAreaElement).value).toContain('{ "theme": "dark" }');
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
    render(<FileNodeFace id="n1" data={nodeData({ file: { ...fileReference, missing: true } })} />);
    expect(screen.getByText('This file is missing on disk.')).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
  });
});
