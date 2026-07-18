import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FILE_IPC_CHANNELS,
  FileDocumentSchema,
  type FileIpcResult,
} from '../../shared/files/contracts.js';
import { FileIpcService } from './ipc.js';
import { ProjectImageService } from './images/service.js';
import { ProjectFileService } from './service.js';
import { PROJECT_IMAGE_IPC_CHANNELS } from '../../shared/files/images/contracts.js';

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  return {
    handlers,
    handle: vi.fn(
      (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) =>
        handlers.set(channel, handler),
    ),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: electronMock.handle,
    removeHandler: electronMock.removeHandler,
  },
}));

const PROJECT_ID = '66cd302d-c25a-4768-94ca-6a3d6fefef04';

describe('FileIpcService', () => {
  let fixtureRoot: string;
  let projectRoot: string;
  let outsideRoot: string;
  let service: FileIpcService;
  let showItemInFolder: ReturnType<typeof vi.fn>;
  let openPath: ReturnType<typeof vi.fn>;
  let showOpenDialog: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    electronMock.handlers.clear();
    electronMock.handle.mockClear();
    electronMock.removeHandler.mockClear();
    fixtureRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'forgeboard-file-ipc-')));
    projectRoot = path.join(fixtureRoot, 'project');
    outsideRoot = path.join(fixtureRoot, 'outside');
    await mkdir(projectRoot);
    await mkdir(outsideRoot);
    showItemInFolder = vi.fn();
    openPath = vi.fn().mockResolvedValue('');
    showOpenDialog = vi.fn();
    const projectStore = {
      getProject: (projectId: string) =>
        projectId === PROJECT_ID
          ? { id: PROJECT_ID, path: projectRoot, missing: false }
          : undefined,
    };
    service = new FileIpcService(
      new ProjectFileService(projectStore),
      { showItemInFolder, openPath },
      undefined,
      new ProjectImageService(projectStore, { showOpenDialog }),
    );
    service.registerIpcHandlers();
  });

  afterEach(async () => {
    await service.dispose();
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it('rejects subframes and strict-input violations before touching project files', async () => {
    await writeFile(path.join(projectRoot, 'note.txt'), 'safe\n');
    const subframe = liveEvent();
    Object.defineProperty(subframe, 'senderFrame', {
      value: { detached: false },
      configurable: true,
    });

    expect(
      await invoke(FILE_IPC_CHANNELS.read, subframe, {
        projectId: PROJECT_ID,
        relativePath: 'note.txt',
      }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(
      await invoke(FILE_IPC_CHANNELS.read, liveEvent(), {
        projectId: PROJECT_ID,
        relativePath: '../outside/secret.txt',
      }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  });

  it('preserves sensitive-file, symlink-escape, and stale-save denials', async () => {
    const target = path.join(projectRoot, 'note.txt');
    await writeFile(target, 'before\n');
    await writeFile(path.join(projectRoot, '.env'), 'TOKEN=local-only\n');
    await writeFile(path.join(outsideRoot, 'secret.txt'), 'outside\n');
    await symlink(path.join(outsideRoot, 'secret.txt'), path.join(projectRoot, 'outside-link'));

    expect(
      await invoke(FILE_IPC_CHANNELS.read, liveEvent(), {
        projectId: PROJECT_ID,
        relativePath: '.env',
      }),
    ).toMatchObject({ ok: false, error: { code: 'SENSITIVE_FILE' } });
    expect(
      await invoke(FILE_IPC_CHANNELS.read, liveEvent(), {
        projectId: PROJECT_ID,
        relativePath: 'outside-link',
      }),
    ).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_PROJECT' } });

    const opened = await invoke(FILE_IPC_CHANNELS.read, liveEvent(), {
      projectId: PROJECT_ID,
      relativePath: 'note.txt',
    });
    if (!opened.ok) {
      throw new Error('Expected the file IPC read to return a document.');
    }
    const sha256 = FileDocumentSchema.parse(opened.value).sha256;
    if (sha256 === null) throw new Error('Expected a content hash.');
    await writeFile(target, 'external change\n');

    expect(
      await invoke(FILE_IPC_CHANNELS.save, liveEvent(), {
        projectId: PROJECT_ID,
        relativePath: 'note.txt',
        expectedSha256: sha256,
        content: 'must not win\n',
      }),
    ).toMatchObject({ ok: false, error: { code: 'STALE_CONTENT' } });
  });

  it('executes reveal natively and returns no absolute path to the renderer', async () => {
    const target = path.join(projectRoot, 'note.txt');
    await writeFile(target, 'safe\n');

    const result = await invoke(FILE_IPC_CHANNELS.reveal, liveEvent(), {
      projectId: PROJECT_ID,
      relativePath: 'note.txt',
    });

    expect(result).toEqual({ ok: true, value: null });
    expect(showItemInFolder).toHaveBeenCalledWith(target);
    expect(JSON.stringify(result)).not.toContain(projectRoot);
    expect(JSON.stringify(result)).not.toContain(target);
  });

  it('searches through the validated project service and opens externally without disclosing paths', async () => {
    const target = path.join(projectRoot, 'note.txt');
    await writeFile(target, 'find this needle safely\n');

    const searched = await invoke(FILE_IPC_CHANNELS.search, liveEvent(), {
      projectId: PROJECT_ID,
      query: 'needle',
    });
    expect(searched).toMatchObject({
      ok: true,
      value: {
        matches: [{ relativePath: 'note.txt', line: 1, column: 11 }],
      },
    });
    expect(JSON.stringify(searched)).not.toContain(projectRoot);

    const opened = await invoke(FILE_IPC_CHANNELS.openExternal, liveEvent(), {
      projectId: PROJECT_ID,
      relativePath: 'note.txt',
    });
    expect(opened).toEqual({ ok: true, value: null });
    expect(openPath).toHaveBeenCalledWith(target);
    expect(JSON.stringify(opened)).not.toContain(projectRoot);

    openPath.mockResolvedValueOnce(`No application owns ${target}`);
    expect(
      await invoke(FILE_IPC_CHANNELS.openExternal, liveEvent(), {
        projectId: PROJECT_ID,
        relativePath: 'note.txt',
      }),
    ).toEqual({
      ok: false,
      error: {
        code: 'IO_ERROR',
        message: 'The operating system could not open this file in its default application.',
      },
    });
  });

  it('selects and loads project images without disclosing renderer filesystem paths', async () => {
    const target = path.join(projectRoot, 'design.png');
    await writeFile(target, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]));
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [target] });

    const selected = await invoke(PROJECT_IMAGE_IPC_CHANNELS.choose, liveEvent(), {
      projectId: PROJECT_ID,
    });
    expect(selected).toMatchObject({
      ok: true,
      value: { relativePath: 'design.png', kind: 'image', missing: false },
    });
    expect(JSON.stringify(selected)).not.toContain(projectRoot);

    const loaded = await invoke(PROJECT_IMAGE_IPC_CHANNELS.load, liveEvent(), {
      projectId: PROJECT_ID,
      relativePath: 'design.png',
    });
    expect(loaded).toMatchObject({
      ok: true,
      value: { status: 'available' },
    });
    expect(JSON.stringify(loaded)).toMatch(/data:image\/png;base64,/u);
    expect(JSON.stringify(loaded)).not.toContain(projectRoot);
  });
});

async function invoke(
  channel: string,
  event: IpcMainInvokeEvent,
  ...args: unknown[]
): Promise<FileIpcResult<unknown>> {
  const handler = electronMock.handlers.get(channel);
  if (handler === undefined) throw new Error(`Missing IPC handler for ${channel}.`);
  return (await handler(event, ...args)) as FileIpcResult<unknown>;
}

function liveEvent(): IpcMainInvokeEvent {
  const mainFrame = { detached: false };
  const sender = {
    mainFrame,
    isDestroyed: () => false,
  };
  return { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
}
