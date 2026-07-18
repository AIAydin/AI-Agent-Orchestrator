import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readInitializationMarker, writeInitializationMarker } from './initialization-marker.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

describe('database initialization marker', () => {
  it('durably creates a private marker and reads it idempotently', async () => {
    const root = await temporaryRoot();
    await expect(readInitializationMarker(root)).resolves.toBe('absent');
    await writeInitializationMarker(root);
    await writeInitializationMarker(root);
    await expect(readInitializationMarker(root)).resolves.toBe('initialized');
    expect((await lstat(join(root, '.forgeboard-initialized-v1'))).mode & 0o077).toBe(0);
    await expect(readFile(join(root, '.forgeboard-initialized-v1'), 'utf8')).resolves.toBe(
      'forgeboard-initialized-v1\n',
    );
  });

  it('rejects malformed, public, and linked markers', async () => {
    const malformedRoot = await temporaryRoot();
    await writeFile(join(malformedRoot, '.forgeboard-initialized-v1'), 'wrong', { mode: 0o600 });
    await expect(readInitializationMarker(malformedRoot)).rejects.toThrow('invalid');
    await expect(writeInitializationMarker(malformedRoot)).rejects.toThrow('invalid');

    const publicRoot = await temporaryRoot();
    await writeFile(join(publicRoot, '.forgeboard-initialized-v1'), 'forgeboard-initialized-v1\n');
    await chmod(join(publicRoot, '.forgeboard-initialized-v1'), 0o644);
    await expect(readInitializationMarker(publicRoot)).rejects.toThrow('not private');

    const linkedRoot = await temporaryRoot();
    const target = join(linkedRoot, 'target');
    await writeFile(target, 'forgeboard-initialized-v1\n', { mode: 0o600 });
    await symlink(target, join(linkedRoot, '.forgeboard-initialized-v1'));
    await expect(readInitializationMarker(linkedRoot)).rejects.toThrow('not an ordinary');
  });

  it('publishes a protected Windows marker through the injected write-through move', async () => {
    const root = await temporaryRoot();
    const protectedPaths: string[] = [];
    const options = {
      platform: 'win32' as const,
      windowsDurability: { moveFileWriteThrough: rename },
      windowsPrivacy: {
        protectPrivateFile: async (path: string) => {
          protectedPaths.push(path);
          await chmod(path, 0o600);
        },
        assertPrivateFile: async (path: string) => {
          expect((await lstat(path)).isFile()).toBe(true);
        },
      },
    };

    await writeInitializationMarker(root, options);
    await expect(readInitializationMarker(root, options)).resolves.toBe('initialized');
    expect(protectedPaths.some((path) => path.endsWith('.tmp'))).toBe(true);
    await expect(readFile(join(root, '.forgeboard-initialized-v1'), 'utf8')).resolves.toBe(
      'forgeboard-initialized-v1\n',
    );
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeboard-initialization-marker-')));
  roots.push(root);
  return root;
}
