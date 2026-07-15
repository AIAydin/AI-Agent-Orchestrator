// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FileDocument, FileSaveInput } from '../../../../shared/files/contracts.js';
import { FileEditorPanel } from './FileEditorPanel.js';
import type { MonacoLoader, MonacoModule } from './monaco-loader.js';
import type { FileEditorOperations } from './operations.js';
import { useFileEditor } from './useFileEditor.js';

const PROJECT_ID = 'b180a449-52e9-4f49-96d2-9887421605b2';
const PATH = 'src/index.ts';
const FIRST_HASH = 'a'.repeat(64);
const SECOND_HASH = 'b'.repeat(64);

afterEach(cleanup);

describe('FileEditorPanel', () => {
  it('edits with Monaco and performs a hash-bound save through injected operations', async () => {
    const monaco = fakeMonaco();
    const operations = operationsFor(textDocument('before\n', FIRST_HASH));
    vi.mocked(operations.save).mockImplementation((input: FileSaveInput) =>
      Promise.resolve(textDocument(input.content, SECOND_HASH)),
    );

    render(
      <FileEditorPanel
        projectId={PROJECT_ID}
        relativePath={PATH}
        operations={operations}
        monacoLoader={monaco.loader}
      />,
    );
    await waitFor(() => expect(monaco.created).toHaveBeenCalledOnce());
    expect(screen.getByText('Saved')).toBeTruthy();

    act(() => monaco.userEdit('after\n'));
    expect(screen.getByText('Unsaved')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(operations.save).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        relativePath: PATH,
        content: 'after\n',
        expectedSha256: FIRST_HASH,
      }),
    );
    expect(await screen.findByText('Saved to disk.')).toBeTruthy();
    expect(screen.getByText('Saved')).toBeTruthy();
  });

  it('keeps stale edits dirty and requires a real revert before a later save', async () => {
    const monaco = fakeMonaco();
    const operations = operationsFor(textDocument('disk one\n', FIRST_HASH));
    vi.mocked(operations.save).mockRejectedValue(
      Object.assign(new Error('The file changed on disk. Revert or reopen it before saving.'), {
        code: 'STALE_CONTENT',
      }),
    );
    vi.mocked(operations.revert).mockResolvedValue(textDocument('disk two\n', SECOND_HASH));
    render(
      <FileEditorPanel
        projectId={PROJECT_ID}
        relativePath={PATH}
        operations={operations}
        monacoLoader={monaco.loader}
      />,
    );
    await waitFor(() => expect(monaco.created).toHaveBeenCalledOnce());

    act(() => monaco.userEdit('my draft\n'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('The file changed on disk. Revert or reopen it before saving.'),
    ).toBeTruthy();
    expect(screen.getByText('Unsaved')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    await waitFor(() => expect(operations.revert).toHaveBeenCalledOnce());
    expect(await screen.findByText('Reloaded from disk.')).toBeTruthy();
    expect(screen.getByText('Saved')).toBeTruthy();

    const draftOption = screen.getByRole<HTMLOptionElement>('option', {
      name: /Unsaved before revert/,
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'File history' }), {
      target: { value: draftOption.value },
    });
    expect(screen.getByText('Unsaved')).toBeTruthy();
  });

  it('shows binary documents as read-only and executes the native reveal callback', async () => {
    const monaco = fakeMonaco();
    const operations = operationsFor(binaryDocument());
    render(
      <FileEditorPanel
        projectId={PROJECT_ID}
        relativePath="assets/logo.bin"
        operations={operations}
        monacoLoader={monaco.loader}
      />,
    );

    expect(await screen.findByText('Binary file')).toBeTruthy();
    expect(monaco.created).not.toHaveBeenCalled();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Reveal in file manager' }));
    await waitFor(() =>
      expect(operations.reveal).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        relativePath: 'assets/logo.bin',
      }),
    );
    expect(await screen.findByText('Revealed in the system file manager.')).toBeTruthy();
  });

  it('blocks Monaco edits and the save shortcut when the node is read-only', async () => {
    const monaco = fakeMonaco();
    const operations = operationsFor(textDocument('protected\n', FIRST_HASH));
    render(
      <FileEditorPanel
        projectId={PROJECT_ID}
        relativePath={PATH}
        operations={operations}
        monacoLoader={monaco.loader}
        readOnly
      />,
    );
    await waitFor(() => expect(monaco.created).toHaveBeenCalledOnce());

    act(() => monaco.userEdit('blocked edit\n'));
    act(() => monaco.saveShortcut());

    expect(screen.getByText('Read-only')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'File history' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
    expect(operations.save).not.toHaveBeenCalled();
  });

  it('guards the editor API from saving, editing, or restoring history after it becomes read-only', async () => {
    const operations = operationsFor(textDocument('disk\n', FIRST_HASH));
    const { result, rerender } = renderHook(
      ({ readOnly }: { readOnly: boolean }) =>
        useFileEditor(PROJECT_ID, PATH, operations, readOnly),
      { initialProps: { readOnly: false } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const openedHistoryId = result.current.history[0]?.id;
    expect(openedHistoryId).toBeDefined();
    act(() => result.current.setBuffer('draft\n'));
    expect(result.current.buffer).toBe('draft\n');

    rerender({ readOnly: true });
    act(() => result.current.setBuffer('blocked\n'));
    act(() => result.current.restoreHistory(openedHistoryId as string));
    await act(async () => await result.current.save());

    expect(result.current.buffer).toBe('draft\n');
    expect(result.current.dirty).toBe(true);
    expect(operations.save).not.toHaveBeenCalled();
  });

  it('renders an honest missing state and retries the read operation', async () => {
    const monaco = fakeMonaco();
    const operations = operationsFor(textDocument('restored\n', FIRST_HASH));
    vi.mocked(operations.read)
      .mockRejectedValueOnce(
        Object.assign(new Error('The selected project file no longer exists.'), {
          code: 'FILE_NOT_FOUND',
        }),
      )
      .mockResolvedValueOnce(textDocument('restored\n', FIRST_HASH));
    render(
      <FileEditorPanel
        projectId={PROJECT_ID}
        relativePath={PATH}
        operations={operations}
        monacoLoader={monaco.loader}
      />,
    );

    expect(await screen.findByText('File missing')).toBeTruthy();
    expect(screen.getByText('Missing')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(operations.read).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(monaco.created).toHaveBeenCalledOnce());
    expect(screen.getByText('Saved')).toBeTruthy();
  });
});

function operationsFor(document: FileDocument): FileEditorOperations {
  return {
    read: vi.fn().mockResolvedValue(document),
    save: vi.fn().mockResolvedValue(document),
    revert: vi.fn().mockResolvedValue(document),
    reveal: vi.fn().mockResolvedValue(undefined),
  };
}

function textDocument(content: string, sha256: string): FileDocument {
  return {
    projectId: PROJECT_ID,
    relativePath: PATH,
    contentKind: 'text',
    content,
    encoding: 'utf-8',
    sizeBytes: new TextEncoder().encode(content).byteLength,
    modifiedAt: '2026-07-15T16:00:00.000Z',
    sha256,
    readOnly: false,
    readOnlyReason: null,
  };
}

function binaryDocument(): FileDocument {
  return {
    projectId: PROJECT_ID,
    relativePath: 'assets/logo.bin',
    contentKind: 'binary',
    content: null,
    encoding: null,
    sizeBytes: 128,
    modifiedAt: '2026-07-15T16:00:00.000Z',
    sha256: FIRST_HASH,
    readOnly: true,
    readOnlyReason: 'Binary files cannot be shown or edited as text.',
  };
}

function fakeMonaco(): {
  readonly loader: MonacoLoader;
  readonly created: ReturnType<typeof vi.fn>;
  readonly userEdit: (value: string) => void;
  readonly saveShortcut: () => void;
} {
  let value = '';
  let saveShortcut: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const model = { dispose: vi.fn() };
  const editor = {
    getValue: () => value,
    setValue: (next: string) => {
      value = next;
      for (const listener of listeners) listener();
    },
    onDidChangeModelContent: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    addCommand: vi.fn((_keybinding: number, command: () => void) => {
      saveShortcut = command;
    }),
    updateOptions: vi.fn(),
    getModel: () => model,
    layout: vi.fn(),
    dispose: vi.fn(),
  };
  const created = vi.fn((_container: HTMLElement, options: { model?: unknown }) => {
    void options.model;
    return editor;
  });
  const module = {
    editor: {
      createModel: vi.fn((initialValue: string) => {
        value = initialValue;
        return model;
      }),
      create: created,
      setModelLanguage: vi.fn(),
    },
    KeyMod: { CtrlCmd: 1 },
    KeyCode: { KeyS: 2 },
  } as unknown as MonacoModule;
  return {
    loader: vi.fn().mockResolvedValue(module),
    created,
    userEdit: (next) => {
      value = next;
      for (const listener of listeners) listener();
    },
    saveShortcut: () => saveShortcut?.(),
  };
}
