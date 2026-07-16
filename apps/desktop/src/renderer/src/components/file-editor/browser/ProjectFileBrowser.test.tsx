// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  FileDocument,
  FileReadInput,
  FileTreeEntry,
  FileTreeInput,
  FileTreeResult,
} from '../../../../../shared/files/contracts.js';
import { ProjectFileBrowser } from './ProjectFileBrowser.js';
import type { ProjectFileBrowserOperations } from './useProjectFileBrowser.js';

const PROJECT_ID = '66cd302d-c25a-4768-94ca-6a3d6fefef04';

afterEach(cleanup);

describe('ProjectFileBrowser', () => {
  it('indexes normal directories, filters quick-open paths, and selects only project-relative files', async () => {
    const tree = vi.fn((input: FileTreeInput) =>
      Promise.resolve(
        input.directory === '.'
          ? result('.', [
              entry('src', 'directory'),
              entry('.env', 'file', 'sensitive', 'Environment files are sensitive.'),
              entry('ignored.log', 'file', 'ignored', 'Ignored by .gitignore.'),
              entry('linked', 'symlink', 'symlink', 'Symbolic links are blocked.'),
            ])
          : result('src', [entry('src/index.ts', 'file')]),
      ),
    );
    const read = vi.fn(() => Promise.resolve(textDocument('src/index.ts')));
    const onSelect = vi.fn();
    render(
      <ProjectFileBrowser projectId={PROJECT_ID} operations={{ tree, read }} onSelect={onSelect} />,
    );

    await waitFor(() =>
      expect(tree).toHaveBeenCalledWith({ projectId: PROJECT_ID, directory: 'src' }),
    );
    expect(screen.getByRole('button', { name: 'Inspect file .env' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText('Environment files are sensitive.')).toBeTruthy();
    expect(screen.getByText('Ignored by .gitignore.')).toBeTruthy();
    expect(screen.getByText('Symbolic links are blocked.')).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: 'Quick open project file' }), {
      target: { value: 'index ts' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Inspect file src/index.ts' }));

    await waitFor(() =>
      expect(read).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        relativePath: 'src/index.ts',
      }),
    );
    const details = screen.getByRole('region', { name: 'Selected file details' });
    expect(within(details).getByText('UTF-8 text')).toBeTruthy();
    expect(within(details).getByText('Editable')).toBeTruthy();
    fireEvent.click(within(details).getByRole('button', { name: 'Open in editor' }));
    expect(onSelect).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      relativePath: 'src/index.ts',
      document: textDocument('src/index.ts'),
    });
    expect(JSON.stringify(tree.mock.calls)).not.toContain('/tmp/');
    expect(JSON.stringify(read.mock.calls)).not.toContain('/tmp/');
  });

  it('shows bounded, binary, and oversized files as honest read-only references', async () => {
    const tree = vi.fn(() =>
      Promise.resolve(
        result('.', [entry('asset.bin', 'file'), entry('archive.txt', 'file')], true),
      ),
    );
    const read = vi.fn((input: FileReadInput) =>
      Promise.resolve(input.relativePath === 'asset.bin' ? binaryDocument() : oversizedDocument()),
    );
    render(
      <ProjectFileBrowser projectId={PROJECT_ID} operations={{ tree, read }} onSelect={vi.fn()} />,
    );

    await screen.findByText('Bounded results');
    fireEvent.click(screen.getByRole('button', { name: 'Inspect file asset.bin' }));
    let details = await screen.findByRole('region', { name: 'Selected file details' });
    await waitFor(() => expect(within(details).getByText('Binary file')).toBeTruthy());
    expect(within(details).getByText('Read-only')).toBeTruthy();
    expect(
      within(details).getByText('Binary files cannot be shown or edited as text.'),
    ).toBeTruthy();
    expect(within(details).getByRole('button', { name: 'Use read-only reference' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Inspect file archive.txt' }));
    details = screen.getByRole('region', { name: 'Selected file details' });
    await waitFor(() => expect(within(details).getByText('Oversized file')).toBeTruthy());
    expect(within(details).getByText('Files larger than 4 MiB are read-only.')).toBeTruthy();
  });

  it('reports a file that disappears between tree listing and inspection as missing', async () => {
    const missing = Object.assign(new Error('The selected project file no longer exists.'), {
      code: 'FILE_NOT_FOUND',
    });
    const operations: ProjectFileBrowserOperations = {
      tree: () => Promise.resolve(result('.', [entry('gone.ts', 'file')])),
      read: () => Promise.reject(missing),
    };
    render(
      <ProjectFileBrowser projectId={PROJECT_ID} operations={operations} onSelect={vi.fn()} />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Inspect file gone.ts' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Missing · The selected project file no longer exists.',
    );
  });
});

function result(directory: string, entries: FileTreeEntry[], truncated = false): FileTreeResult {
  return { projectId: PROJECT_ID, directory, entries, truncated };
}

function entry(
  relativePath: string,
  kind: FileTreeEntry['kind'],
  status: FileTreeEntry['policy']['status'] = 'normal',
  reason: string | null = status === 'normal' ? null : `${status} by policy.`,
): FileTreeEntry {
  return {
    name: relativePath.split('/').at(-1) ?? relativePath,
    relativePath,
    kind,
    sizeBytes: kind === 'file' ? 11 : null,
    modifiedAt: '2026-07-15T12:00:00.000Z',
    policy: { status, reason },
    canOpen: status === 'normal' && (kind === 'file' || kind === 'directory'),
  };
}

function textDocument(relativePath: string): FileDocument {
  return {
    projectId: PROJECT_ID,
    relativePath,
    contentKind: 'text',
    content: 'export {};\n',
    encoding: 'utf-8',
    sizeBytes: 11,
    modifiedAt: '2026-07-15T12:00:00.000Z',
    sha256: 'a'.repeat(64),
    readOnly: false,
    readOnlyReason: null,
  };
}

function binaryDocument(): FileDocument {
  return {
    projectId: PROJECT_ID,
    relativePath: 'asset.bin',
    contentKind: 'binary',
    content: null,
    encoding: null,
    sizeBytes: 11,
    modifiedAt: '2026-07-15T12:00:00.000Z',
    sha256: 'b'.repeat(64),
    readOnly: true,
    readOnlyReason: 'Binary files cannot be shown or edited as text.',
  };
}

function oversizedDocument(): FileDocument {
  return {
    projectId: PROJECT_ID,
    relativePath: 'archive.txt',
    contentKind: 'too-large',
    content: null,
    encoding: null,
    sizeBytes: 5 * 1024 * 1024,
    modifiedAt: '2026-07-15T12:00:00.000Z',
    sha256: null,
    readOnly: true,
    readOnlyReason: 'Files larger than 4 MiB are read-only.',
  };
}
