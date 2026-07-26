import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectImageService } from './service.js';

const PROJECT_ID = '66cd302d-c25a-4768-94ca-6a3d6fefef04';
const PNG_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

describe('ProjectImageService', () => {
  let fixtureRoot: string;
  let projectRoot: string;
  let outsideRoot: string;
  const showOpenDialog = vi.fn();

  beforeEach(async () => {
    fixtureRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'forgeboard-images-')));
    projectRoot = path.join(fixtureRoot, 'project');
    outsideRoot = path.join(fixtureRoot, 'outside');
    await mkdir(projectRoot);
    await mkdir(outsideRoot);
    showOpenDialog.mockReset();
  });

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it('chooses only a canonical image inside the selected project', async () => {
    const imagePath = path.join(projectRoot, 'design.png');
    await writeFile(imagePath, PNG_BYTES);
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [imagePath] });
    const assertCurrent = vi.fn();

    const selected = await service().choose({ projectId: PROJECT_ID }, assertCurrent);
    expect(selected).toMatchObject({
      projectId: PROJECT_ID,
      relativePath: 'design.png',
      kind: 'image',
      missing: false,
    });
    expect(selected?.lastKnownHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: projectRoot,
        properties: ['openFile'],
      }),
    );
    expect(assertCurrent).toHaveBeenCalledTimes(3);
  });

  it('rejects an outside selection without returning its absolute path', async () => {
    const outsidePath = path.join(outsideRoot, 'outside.png');
    await writeFile(outsidePath, PNG_BYTES);
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [outsidePath] });

    await expect(service().choose({ projectId: PROJECT_ID }, vi.fn())).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_PROJECT',
    });
  });

  it('loads bounded signature-validated inline data and reports moved references recoverably', async () => {
    await writeFile(path.join(projectRoot, 'safe.png'), PNG_BYTES);
    const imageService = service();

    const loaded = await imageService.load({
      projectId: PROJECT_ID,
      relativePath: 'safe.png',
    });
    expect(loaded).toMatchObject({ status: 'available' });
    expect(loaded.status === 'available' ? loaded.dataUrl : '').toMatch(
      /^data:image\/png;base64,/u,
    );
    expect(JSON.stringify(loaded)).not.toContain(projectRoot);

    await expect(
      imageService.load({ projectId: PROJECT_ID, relativePath: 'moved.png' }),
    ).resolves.toEqual({
      status: 'missing',
      projectId: PROJECT_ID,
      relativePath: 'moved.png',
      message: 'This image is missing or moved. Choose its new location to reconnect it.',
    });
  });

  it('keeps disguised files inert but loads git-ignored images', async () => {
    await writeFile(path.join(projectRoot, 'fake.png'), '<svg onload="alert(1)"></svg>');
    await writeFile(path.join(projectRoot, '.gitignore'), 'ignored.png\n');
    await writeFile(path.join(projectRoot, 'ignored.png'), PNG_BYTES);

    const disguised = await service().load({ projectId: PROJECT_ID, relativePath: 'fake.png' });
    expect(disguised).toMatchObject({ status: 'unavailable' });
    expect(disguised.status === 'unavailable' ? disguised.message : '').toMatch(/signature/u);

    const ignored = await service().load({ projectId: PROJECT_ID, relativePath: 'ignored.png' });
    expect(ignored).toMatchObject({ status: 'available' });
    expect(ignored.status === 'available' ? ignored.dataUrl : '').toMatch(
      /^data:image\/png;base64,/u,
    );
  });

  it('refuses sensitive images even when they are readable on disk', async () => {
    await writeFile(path.join(projectRoot, 'service-account.json'), PNG_BYTES);

    await expect(
      service().load({ projectId: PROJECT_ID, relativePath: 'service-account.json' }),
    ).rejects.toMatchObject({ code: 'SENSITIVE_FILE' });
  });

  function service(): ProjectImageService {
    return new ProjectImageService(
      {
        getProject: (projectId) =>
          projectId === PROJECT_ID
            ? { id: PROJECT_ID, path: projectRoot, missing: false }
            : undefined,
      },
      { showOpenDialog },
    );
  }
});
