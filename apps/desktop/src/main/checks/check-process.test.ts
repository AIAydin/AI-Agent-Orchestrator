import { access, chmod, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { launchCheckProcess, resolveCheckExecutable, sameFileIdentities } from './check-process.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe('check executable identity', () => {
  it('fails before process creation when required launch authorization throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeboard-check-audit-'));
    roots.push(root);
    const marker = join(root, 'spawned.txt');

    expect(() =>
      launchCheckProcess(
        process.execPath,
        ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
        root,
        { PATH: process.env.PATH ?? '' },
        () => undefined,
        10,
        10,
        () => {
          throw new Error('required check launch audit unavailable');
        },
      ),
    ).toThrow('required check launch audit unavailable');
    await expect(access(marker)).rejects.toThrow();
  });

  it('binds the resolved executable to its SHA-256 content, mode, and change time', async () => {
    const resolved = await resolveCheckExecutable(process.execPath, [], process.cwd());
    const executable = resolved.identities[0];

    expect(executable).toMatchObject({ path: resolved.executable });
    expect(executable?.contentDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(executable?.mode).toBeGreaterThan(0);
    expect(executable?.changedAtMs).toBeGreaterThan(0);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects same-size executable replacement even when modification time is restored',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'forgeboard-check-identity-'));
      roots.push(root);
      const executablePath = join(root, 'check-tool');
      const timestamp = new Date('2026-07-15T12:00:00.000Z');
      const original = '#!/bin/sh\nexit 0\n'.padEnd(1_024, ' ');
      const replacement = '#!/bin/sh\nexit 7\n'.padEnd(1_024, ' ');
      await writeFile(executablePath, original, { mode: 0o700 });
      await chmod(executablePath, 0o700);
      await utimes(executablePath, timestamp, timestamp);

      const before = await resolveCheckExecutable(executablePath, [], root);
      await writeFile(executablePath, replacement, { mode: 0o700 });
      await chmod(executablePath, 0o700);
      await utimes(executablePath, timestamp, timestamp);
      const after = await resolveCheckExecutable(executablePath, [], root);

      expect(after.identities[0]?.size).toBe(before.identities[0]?.size);
      expect(after.identities[0]?.modifiedAtMs).toBe(before.identities[0]?.modifiedAtMs);
      expect(after.identities[0]?.contentDigest).not.toBe(before.identities[0]?.contentDigest);
      expect(sameFileIdentities(before.identities, after.identities)).toBe(false);
    },
  );
});
