import { describe, expect, it, vi } from 'vitest';

import { FILE_IPC_CHANNELS, type FileDocument } from '../shared/files/contracts.js';
import { createFileApi } from './files.js';

const PROJECT_ID = '66cd302d-c25a-4768-94ca-6a3d6fefef04';

describe('createFileApi', () => {
  it('validates read inputs and document responses at the preload boundary', async () => {
    const document = textDocument();
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: document });
    const api = createFileApi(invoke);

    await expect(
      api.read({ projectId: PROJECT_ID, relativePath: 'src/index.ts' }),
    ).resolves.toEqual(document);
    expect(invoke).toHaveBeenCalledWith(FILE_IPC_CHANNELS.read, {
      projectId: PROJECT_ID,
      relativePath: 'src/index.ts',
    });

    invoke.mockClear();
    await expect(
      api.read({ projectId: PROJECT_ID, relativePath: '../outside.txt' }),
    ).rejects.toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();

    invoke.mockResolvedValue({ ok: true, value: { ...document, absolutePath: '/tmp/project' } });
    await expect(
      api.read({ projectId: PROJECT_ID, relativePath: 'src/index.ts' }),
    ).rejects.toBeTruthy();
  });

  it('throws typed domain failures for editor operations', async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        code: 'STALE_CONTENT',
        message: 'The file changed on disk. Reload it before saving again.',
      },
    });
    const api = createFileApi(invoke);

    await expect(
      api.save({
        projectId: PROJECT_ID,
        relativePath: 'src/index.ts',
        content: 'next\n',
        expectedSha256: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({
      code: 'STALE_CONTENT',
      message: 'The file changed on disk. Reload it before saving again.',
    });
  });

  it('returns void for native reveal and rejects any response carrying a path', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: null });
    const api = createFileApi(invoke);

    await expect(
      api.reveal({ projectId: PROJECT_ID, relativePath: 'src/index.ts' }),
    ).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith(FILE_IPC_CHANNELS.reveal, {
      projectId: PROJECT_ID,
      relativePath: 'src/index.ts',
    });

    invoke.mockResolvedValue({ ok: true, value: { absolutePath: '/tmp/project/src/index.ts' } });
    await expect(
      api.reveal({ projectId: PROJECT_ID, relativePath: 'src/index.ts' }),
    ).rejects.toBeTruthy();
  });

  it('validates bounded search results and keeps external-open responses content-free', async () => {
    const searchResult = {
      projectId: PROJECT_ID,
      query: 'needle',
      matches: [{ relativePath: 'src/index.ts', line: 2, column: 4, preview: 'a needle here' }],
      scannedFiles: 1,
      skippedFiles: 0,
      truncated: false,
    };
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: searchResult })
      .mockResolvedValueOnce({ ok: true, value: null });
    const api = createFileApi(invoke);

    await expect(api.search({ projectId: PROJECT_ID, query: 'needle' })).resolves.toEqual(
      searchResult,
    );
    await expect(
      api.openExternal({ projectId: PROJECT_ID, relativePath: 'src/index.ts' }),
    ).resolves.toBeUndefined();
    expect(invoke).toHaveBeenNthCalledWith(1, FILE_IPC_CHANNELS.search, {
      projectId: PROJECT_ID,
      query: 'needle',
    });
    expect(invoke).toHaveBeenNthCalledWith(2, FILE_IPC_CHANNELS.openExternal, {
      projectId: PROJECT_ID,
      relativePath: 'src/index.ts',
    });

    invoke.mockResolvedValueOnce({
      ok: true,
      value: { absolutePath: '/tmp/project/src/index.ts' },
    });
    await expect(
      api.openExternal({ projectId: PROJECT_ID, relativePath: 'src/index.ts' }),
    ).rejects.toBeTruthy();
  });

  it('validates project-image selection and inert preview responses', async () => {
    const reference = {
      projectId: PROJECT_ID,
      relativePath: 'design/safe.png',
      kind: 'image' as const,
      missing: false,
      lastKnownHash: 'c'.repeat(64),
    };
    const preview = {
      status: 'available' as const,
      projectId: PROJECT_ID,
      relativePath: reference.relativePath,
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAAA',
    };
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: reference })
      .mockResolvedValueOnce({ ok: true, value: preview });
    const api = createFileApi(invoke);

    await expect(api.chooseImage({ projectId: PROJECT_ID })).resolves.toEqual(reference);
    await expect(
      api.loadImage({ projectId: PROJECT_ID, relativePath: reference.relativePath }),
    ).resolves.toEqual(preview);

    invoke.mockResolvedValueOnce({
      ok: true,
      value: { ...preview, dataUrl: 'data:image/png;base64,R0lGODlhAAAA' },
    });
    await expect(
      api.loadImage({ projectId: PROJECT_ID, relativePath: reference.relativePath }),
    ).rejects.toBeTruthy();

    invoke.mockResolvedValueOnce({
      ok: true,
      value: { ...preview, relativePath: 'design/other.png' },
    });
    await expect(
      api.loadImage({ projectId: PROJECT_ID, relativePath: reference.relativePath }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});

function textDocument(): FileDocument {
  return {
    projectId: PROJECT_ID,
    relativePath: 'src/index.ts',
    contentKind: 'text',
    content: 'export {};\n',
    encoding: 'utf-8',
    sizeBytes: 11,
    modifiedAt: '2026-07-15T12:00:00.000Z',
    sha256: 'b'.repeat(64),
    readOnly: false,
    readOnlyReason: null,
  };
}
