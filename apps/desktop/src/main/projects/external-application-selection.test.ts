import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertExternalApplicationSelection,
  externalApplicationDialogOptions,
} from './external-application-selection.js';

describe('external application selection', () => {
  it('keeps the macOS package picker closed to ordinary directories', () => {
    expect(externalApplicationDialogOptions('darwin')).toMatchObject({
      title: 'Choose an application bundle or executable',
      properties: ['openFile'],
    });
    expect(externalApplicationDialogOptions('linux').properties).toEqual(['openFile']);
    expect(externalApplicationDialogOptions('win32').properties).toEqual(['openFile']);
  });

  it('accepts .app directories only on macOS and keeps exact files cross-platform', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeboard-external-picker-'));
    const application = join(root, 'Editor.app');
    const executable = join(root, 'editor');
    await mkdir(application);
    await writeFile(executable, 'editor');
    const applicationMetadata = await stat(application);
    const executableMetadata = await stat(executable);

    expect(() =>
      assertExternalApplicationSelection(application, applicationMetadata, 'darwin'),
    ).not.toThrow();
    expect(() =>
      assertExternalApplicationSelection(executable, executableMetadata, 'linux'),
    ).not.toThrow();
    expect(() =>
      assertExternalApplicationSelection(application, applicationMetadata, 'linux'),
    ).toThrow('exact executable');
  });

  it('rejects ordinary directories even when they happen to be selected on macOS', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeboard-external-picker-'));
    const metadata = await stat(root);
    expect(() => assertExternalApplicationSelection(root, metadata, 'darwin')).toThrow(
      '.app bundle',
    );
  });
});
