import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectVideoService } from './service.js';

const PROJECT_ID = '76cd302d-c25a-4768-94ca-6a3d6fefef04';
const MP4_BYTES = Buffer.from([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

describe('ProjectVideoService', () => {
  let fixtureRoot: string;
  let projectRoot: string;
  const showOpenDialog = vi.fn();

  beforeEach(async () => {
    fixtureRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'forgeboard-videos-')));
    projectRoot = path.join(fixtureRoot, 'project');
    await mkdir(projectRoot);
    showOpenDialog.mockReset();
  });

  afterEach(async () => await rm(fixtureRoot, { recursive: true, force: true }));

  it('selects a signature-validated project video and issues no absolute renderer path', async () => {
    const videoPath = path.join(projectRoot, 'demo.mp4');
    await writeFile(videoPath, MP4_BYTES);
    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [videoPath],
    });
    const video = service();
    await expect(video.choose({ projectId: PROJECT_ID }, vi.fn())).resolves.toMatchObject({
      relativePath: 'demo.mp4',
      kind: 'file',
      missing: false,
    });
    const loaded = await video.load({
      projectId: PROJECT_ID,
      relativePath: 'demo.mp4',
    });
    expect(loaded).toMatchObject({
      status: 'available',
      mimeType: 'video/mp4',
      sizeBytes: 12,
    });
    expect(JSON.stringify(loaded)).not.toContain(projectRoot);
    if (loaded.status !== 'available') throw new Error('Expected playable video');
    await expect(video.fileUrlForProtocolRequest(loaded.playbackUrl)).resolves.toMatch(/^file:/u);
  });

  it('imports a selected external video into the project without overwriting existing media', async () => {
    const outsidePath = path.join(fixtureRoot, 'demo.mp4');
    await writeFile(outsidePath, MP4_BYTES);
    await mkdir(path.join(projectRoot, 'forgeboard-videos'));
    await writeFile(path.join(projectRoot, 'forgeboard-videos', 'demo.mp4'), MP4_BYTES);
    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [outsidePath],
    });

    await expect(service().choose({ projectId: PROJECT_ID }, vi.fn())).resolves.toMatchObject({
      projectId: PROJECT_ID,
      relativePath: 'forgeboard-videos/demo-1.mp4',
      kind: 'file',
      missing: false,
    });
    await expect(
      stat(path.join(projectRoot, 'forgeboard-videos', 'demo-1.mp4')),
    ).resolves.toMatchObject({ size: MP4_BYTES.length });
  });

  it('plays a git-ignored project video and still refuses sensitive paths', async () => {
    await writeFile(path.join(projectRoot, '.gitignore'), 'recordings/\n');
    await mkdir(path.join(projectRoot, 'recordings'));
    await writeFile(path.join(projectRoot, 'recordings', 'demo.mp4'), MP4_BYTES);
    await mkdir(path.join(projectRoot, '.ssh'));
    await writeFile(path.join(projectRoot, '.ssh', 'demo.mp4'), MP4_BYTES);
    const video = service();

    const loaded = await video.load({
      projectId: PROJECT_ID,
      relativePath: 'recordings/demo.mp4',
    });
    expect(loaded).toMatchObject({ status: 'available', mimeType: 'video/mp4' });
    if (loaded.status !== 'available') throw new Error('Expected playable video');
    await expect(video.fileUrlForProtocolRequest(loaded.playbackUrl)).resolves.toMatch(/^file:/u);

    await expect(
      video.load({ projectId: PROJECT_ID, relativePath: '.ssh/demo.mp4' }),
    ).rejects.toMatchObject({ code: 'SENSITIVE_FILE' });
  });

  it('rejects disguised content and invalid capability URLs', async () => {
    await writeFile(path.join(projectRoot, 'fake.mp4'), 'not a video');
    await expect(
      service().load({ projectId: PROJECT_ID, relativePath: 'fake.mp4' }),
    ).rejects.toMatchObject({ code: 'BINARY_FILE' });
    await expect(
      service().fileUrlForProtocolRequest('forgeboard-video://media/nope'),
    ).resolves.toBeNull();
  });

  function service(): ProjectVideoService {
    return new ProjectVideoService(
      {
        getProject: () => ({
          id: PROJECT_ID,
          path: projectRoot,
          missing: false,
        }),
      },
      { showOpenDialog },
    );
  }
});
