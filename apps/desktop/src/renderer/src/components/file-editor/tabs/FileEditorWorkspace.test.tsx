// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  FileDocument,
  FileReadInput,
  FileSaveInput,
} from '../../../../../shared/files/contracts.js';
import type { MonacoLoader, MonacoModule } from '../monaco-loader.js';
import type { FileEditorOperations } from '../operations.js';
import { FileEditorWorkspace } from './FileEditorWorkspace.js';

const PROJECT_ID = '66cd302d-c25a-4768-94ca-6a3d6fefef04';

afterEach(cleanup);

describe('FileEditorWorkspace', () => {
  it('keeps multiple Monaco tabs alive, protects dirty tabs, and navigates search matches', async () => {
    const monaco = fakeMonacoLoader();
    const operations = operationsFor();
    const onBrowseFiles = vi.fn();
    const onRevealInTree = vi.fn();
    const view = render(
      <FileEditorWorkspace
        primary={{ projectId: PROJECT_ID, relativePath: 'src/first.ts' }}
        operations={operations}
        onBrowseFiles={onBrowseFiles}
        onRevealInTree={onRevealInTree}
        monacoLoader={monaco.loader}
      />,
    );
    await waitFor(() => expect(monaco.editors).toHaveLength(1));

    view.rerender(
      <FileEditorWorkspace
        primary={{ projectId: PROJECT_ID, relativePath: 'src/first.ts' }}
        requestedTab={{
          projectId: PROJECT_ID,
          relativePath: 'src/second.ts',
          requestId: 1,
          position: { line: 12, column: 5 },
        }}
        operations={operations}
        onBrowseFiles={onBrowseFiles}
        onRevealInTree={onRevealInTree}
        monacoLoader={monaco.loader}
      />,
    );
    await waitFor(() => expect(monaco.editors).toHaveLength(2));
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.getByRole('tab', { name: 'second.ts' })).toHaveProperty('ariaSelected', 'true');
    expect(monaco.editors[1]?.setPosition).toHaveBeenCalledWith({
      lineNumber: 12,
      column: 5,
    });

    act(() => monaco.editors[1]?.userEdit('unsaved second\n'));
    const closeSecond = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Close src/second.ts',
    });
    expect(closeSecond.disabled).toBe(true);
    expect(screen.getByLabelText('Unsaved changes')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(operations.save).toHaveBeenCalledOnce());
    await waitFor(() => expect(closeSecond.disabled).toBe(false));

    fireEvent.click(screen.getByRole('button', { name: 'Show in file list' }));
    expect(onRevealInTree).toHaveBeenCalledWith('src/second.ts');
    fireEvent.click(closeSecond);
    expect(screen.getAllByRole('tab')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Browse' }));
    expect(onBrowseFiles).toHaveBeenCalledOnce();
  });

  it('drags only a ready tab whose visible buffer matches its saved disk file', async () => {
    const monaco = fakeMonacoLoader();
    const onFileDragStart = vi.fn();
    render(
      <FileEditorWorkspace
        primary={{ projectId: PROJECT_ID, relativePath: 'src/first.ts' }}
        operations={operationsFor()}
        onBrowseFiles={vi.fn()}
        onRevealInTree={vi.fn()}
        onFileDragStart={onFileDragStart}
        monacoLoader={monaco.loader}
      />,
    );
    const tab = screen.getByRole('tab', { name: 'first.ts' });
    await waitFor(() => expect(tab.getAttribute('draggable')).toBe('true'));
    const transfer = {} as DataTransfer;
    fireEvent.dragStart(tab, { dataTransfer: transfer });
    expect(onFileDragStart).toHaveBeenCalledWith(transfer, {
      projectId: PROJECT_ID,
      relativePath: 'src/first.ts',
    });

    act(() => monaco.editors[0]?.userEdit('unsaved\n'));
    await waitFor(() => expect(tab.getAttribute('draggable')).toBe('false'));
    fireEvent.dragStart(tab, { dataTransfer: transfer });
    expect(onFileDragStart).toHaveBeenCalledOnce();
    const tooltipId = tab.getAttribute('aria-describedby');
    expect(tooltipId).not.toBeNull();
    expect(document.getElementById(tooltipId ?? '')?.textContent).toMatch(/Save or discard/u);
  });
});

function operationsFor(): FileEditorOperations {
  return {
    read: vi.fn((input: FileReadInput) =>
      Promise.resolve(documentFor(input.relativePath, `open ${input.relativePath}\n`)),
    ),
    save: vi.fn((input: FileSaveInput) =>
      Promise.resolve(documentFor(input.relativePath, input.content, 'b'.repeat(64))),
    ),
    revert: vi.fn((input: FileReadInput) =>
      Promise.resolve(documentFor(input.relativePath, 'reverted\n')),
    ),
    reveal: vi.fn().mockResolvedValue(undefined),
    openExternal: vi.fn().mockResolvedValue(undefined),
  };
}

function documentFor(relativePath: string, content: string, sha256 = 'a'.repeat(64)): FileDocument {
  return {
    projectId: PROJECT_ID,
    relativePath,
    contentKind: 'text',
    content,
    encoding: 'utf-8',
    sizeBytes: new TextEncoder().encode(content).byteLength,
    modifiedAt: '2026-07-15T12:00:00.000Z',
    sha256,
    readOnly: false,
    readOnlyReason: null,
  };
}

function fakeMonacoLoader(): {
  readonly loader: MonacoLoader;
  readonly editors: Array<{
    readonly setPosition: ReturnType<typeof vi.fn>;
    readonly userEdit: (value: string) => void;
  }>;
} {
  const editors: Array<{
    readonly setPosition: ReturnType<typeof vi.fn>;
    readonly userEdit: (value: string) => void;
  }> = [];
  const module = {
    editor: {
      createModel: vi.fn((value: string) => ({
        value,
        uri: { toString: () => `file:///model-${String(editors.length)}` },
        dispose: vi.fn(),
      })),
      create: vi.fn((_container: HTMLElement, options: { model: { value: string } }) => {
        const model = options.model;
        const listeners = new Set<() => void>();
        let saveCommand: (() => void) | undefined;
        const setPosition = vi.fn();
        const editor = {
          getValue: () => model.value,
          setValue: (value: string) => {
            model.value = value;
            for (const listener of listeners) listener();
          },
          onDidChangeModelContent: (listener: () => void) => {
            listeners.add(listener);
            return { dispose: () => listeners.delete(listener) };
          },
          addCommand: vi.fn((_keybinding: number, command: () => void) => {
            saveCommand = command;
          }),
          updateOptions: vi.fn(),
          getModel: () => model,
          setPosition,
          revealPositionInCenter: vi.fn(),
          focus: vi.fn(),
          layout: vi.fn(),
          dispose: vi.fn(),
        };
        editors.push({
          setPosition,
          userEdit: (value) => {
            model.value = value;
            for (const listener of listeners) listener();
          },
        });
        void saveCommand;
        return editor;
      }),
      setModelLanguage: vi.fn(),
    },
    KeyMod: { CtrlCmd: 1 },
    KeyCode: { KeyS: 2 },
  } as unknown as MonacoModule;
  return { loader: vi.fn().mockResolvedValue(module), editors };
}
