import { describe, expect, it, vi } from 'vitest';

import { assertNoPreExistingLinuxInstall } from './linux.js';
import { CommandExitError, type runCommand } from './process.js';

describe('Linux installer smoke preflight', () => {
  it('allows an unregistered package only when neither installed path exists', async () => {
    const run = vi.fn<typeof runCommand>(() =>
      Promise.reject(new CommandExitError('dpkg-query', 1, 'no packages found')),
    );
    const exists = vi.fn(() => Promise.resolve(false));

    await expect(assertNoPreExistingLinuxInstall(run, exists)).resolves.toBeUndefined();
    expect(exists).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledWith('dpkg-query', [
      '--show',
      '--showformat=${db:Status-Abbrev}',
      'forgeboard',
    ]);
  });

  it('rejects an existing path before querying package state', async () => {
    const run = vi.fn<typeof runCommand>();
    const exists = vi.fn(() => Promise.resolve(true));

    await expect(assertNoPreExistingLinuxInstall(run, exists)).rejects.toThrow(
      'pre-existing Artemis path',
    );
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects a registered package and fails closed on unexpected query errors', async () => {
    const exists = vi.fn(() => Promise.resolve(false));
    await expect(
      assertNoPreExistingLinuxInstall(
        vi.fn<typeof runCommand>(() => Promise.resolve('ii ')),
        exists,
      ),
    ).rejects.toThrow('registered forgeboard package');
    await expect(
      assertNoPreExistingLinuxInstall(
        vi.fn<typeof runCommand>(() =>
          Promise.reject(new CommandExitError('dpkg-query', 2, 'database error')),
        ),
        exists,
      ),
    ).rejects.toMatchObject({ exitCode: 2 });
  });
});
