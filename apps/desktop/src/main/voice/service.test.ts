import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

import { VOICE_MODEL_ID, VOICE_MODEL_REVISION } from '../../shared/voice/contracts.js';
import { VoiceIpcService } from './service.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map(async (path) => await rm(path, { recursive: true })),
  );
});

describe('VoiceIpcService local model state', () => {
  it('requires an exact pinned marker and erases the model during privacy reset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeboard-voice-service-'));
    temporaryPaths.push(root);
    const service = new VoiceIpcService(
      { showMessageBox: vi.fn() },
      { appendAudit: vi.fn() },
      root,
    );

    expect((await service.status()).state).toBe('not-installed');
    const modelDirectory = join(root, 'voice-models');
    await mkdir(modelDirectory);
    await writeFile(
      join(modelDirectory, 'installed.json'),
      JSON.stringify({ modelId: VOICE_MODEL_ID, revision: 'wrong-revision' }),
    );
    expect((await service.status()).state).toBe('not-installed');
    await writeFile(
      join(modelDirectory, 'installed.json'),
      JSON.stringify({ modelId: VOICE_MODEL_ID, revision: VOICE_MODEL_REVISION }),
    );
    expect((await service.status()).state).toBe('ready');

    await service.resetForPrivacy();
    expect((await service.status()).state).toBe('not-installed');
  });
});
