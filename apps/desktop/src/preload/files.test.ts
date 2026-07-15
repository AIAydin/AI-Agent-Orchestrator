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
