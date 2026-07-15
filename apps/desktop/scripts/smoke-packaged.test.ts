import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolvePackagedLaunch } from './smoke-packaged.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRelease(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-packaged-smoke-'));
  roots.push(root);
  return root;
}

async function createExecutable(root: string, relativePath: string): Promise<string> {
  const path = join(root, relativePath);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, 'binary');
  return path;
}

describe('packaged smoke artifact discovery', () => {
  it('selects only the current platform and architecture unpacked app', async () => {
    const root = await temporaryRelease();
    await createExecutable(root, 'linux-unpacked/forgeboard');
    const windowsExecutable = await createExecutable(root, 'win-unpacked/Forgeboard.exe');
    await createExecutable(root, 'win-arm64-unpacked/Forgeboard.exe');

    await expect(resolvePackagedLaunch(root, 'win32', 'x64')).resolves.toEqual({
      executable: windowsExecutable,
      args: [],
    });
  });

  it('selects the architecture-specific macOS bundle', async () => {
    const root = await temporaryRelease();
    const executable = await createExecutable(
      root,
      'mac-arm64/Forgeboard.app/Contents/MacOS/Forgeboard',
    );
    await createExecutable(root, 'mac/Forgeboard.app/Contents/MacOS/Forgeboard');
    await createExecutable(root, 'Misleading.app/Contents/MacOS/Forgeboard');

    await expect(resolvePackagedLaunch(root, 'darwin', 'arm64')).resolves.toEqual({
      executable,
      args: [],
    });
  });

  it('uses a matching AppImage only when the unpacked Linux app is absent', async () => {
    const root = await temporaryRelease();
    const executable = await createExecutable(root, 'Forgeboard-0.1.0-arm64.AppImage');
    await createExecutable(root, 'Forgeboard-0.1.0-x64.AppImage');

    await expect(resolvePackagedLaunch(root, 'linux', 'arm64')).resolves.toEqual({
      executable,
      args: ['--no-sandbox'],
    });
  });

  it('fails closed when no current-platform artifact exists', async () => {
    const root = await temporaryRelease();
    await createExecutable(root, 'linux-unpacked/forgeboard');

    await expect(resolvePackagedLaunch(root, 'win32', 'x64')).rejects.toThrow(
      'No packaged Forgeboard executable for win32-x64',
    );
  });
});
