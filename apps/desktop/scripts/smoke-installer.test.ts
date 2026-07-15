import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveInstallerArtifacts } from './smoke-installer.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function releaseWith(...files: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-installer-artifacts-'));
  roots.push(root);
  await Promise.all(files.map((name) => writeFile(join(root, name), 'artifact')));
  return root;
}

describe('installer artifact discovery', () => {
  it('requires exactly one macOS DMG', async () => {
    const root = await releaseWith(
      'Forgeboard-0.1.0-mac-arm64.dmg',
      'Forgeboard-0.1.0-mac-arm64.zip',
    );
    await expect(resolveInstallerArtifacts(root, 'darwin')).resolves.toEqual({
      platform: 'darwin',
      dmg: join(root, 'Forgeboard-0.1.0-mac-arm64.dmg'),
    });
  });

  it('prefers the named NSIS setup when a portable executable is also present', async () => {
    const root = await releaseWith(
      'Forgeboard-0.1.0-windows-x64-setup.exe',
      'Forgeboard-0.1.0-windows-x64-portable.exe',
    );
    await expect(resolveInstallerArtifacts(root, 'win32')).resolves.toEqual({
      platform: 'win32',
      nsis: join(root, 'Forgeboard-0.1.0-windows-x64-setup.exe'),
    });
  });

  it('rejects an executable that is not the expected NSIS setup artifact', async () => {
    const root = await releaseWith('Forgeboard Portable 0.1.0.exe');
    await expect(resolveInstallerArtifacts(root, 'win32')).rejects.toThrow(
      'Expected exactly one Windows NSIS installer, found 0',
    );
  });

  it('requires both Linux distribution artifacts', async () => {
    const root = await releaseWith(
      'Forgeboard-0.1.0-linux-x86_64.AppImage',
      'forgeboard_0.1.0_amd64.deb',
    );
    await expect(resolveInstallerArtifacts(root, 'linux')).resolves.toEqual({
      platform: 'linux',
      appImage: join(root, 'Forgeboard-0.1.0-linux-x86_64.AppImage'),
      deb: join(root, 'forgeboard_0.1.0_amd64.deb'),
    });
  });

  it('fails closed for missing or ambiguous platform artifacts', async () => {
    const root = await releaseWith('first.dmg', 'second.dmg');
    await expect(resolveInstallerArtifacts(root, 'darwin')).rejects.toThrow(
      'Expected exactly one macOS DMG, found 2',
    );
    await expect(resolveInstallerArtifacts(root, 'freebsd')).rejects.toThrow(
      'unsupported on freebsd',
    );
  });
});
