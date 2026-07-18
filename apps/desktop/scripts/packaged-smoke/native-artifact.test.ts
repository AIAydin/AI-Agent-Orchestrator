import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { assertWindowsDurableNativeArtifact } from './native-artifact.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

describe('packaged Windows durability artifact', () => {
  it('requires the native binary beneath the unpacked package directory', async () => {
    const root = await temporaryRoot();
    const packageDirectory = join(
      root,
      'win-unpacked',
      'resources',
      'app.asar.unpacked',
      'node_modules',
      '@forgeboard',
      'windows-durable-fs',
      'build',
      'Release',
    );
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, 'forgeboard_windows_durable_fs.node'), 'fixture');

    await expect(assertWindowsDurableNativeArtifact(root)).resolves.toBeUndefined();
  });

  it('rejects a binary that was not unpacked from ASAR', async () => {
    const root = await temporaryRoot();
    const packageDirectory = join(root, 'windows-durable-fs', 'build', 'Release');
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, 'forgeboard_windows_durable_fs.node'), 'fixture');

    await expect(assertWindowsDurableNativeArtifact(root)).rejects.toThrow('missing');
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-native-artifact-'));
  temporaryRoots.push(root);
  return root;
}
