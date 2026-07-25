import { describe, expect, it, vi } from 'vitest';

import { replaceFileWithWindowsRetry } from './windows-replace.js';

describe('replaceFileWithWindowsRetry', () => {
  it('revalidates and retries bounded Windows sharing failures', async () => {
    const sharingFailure = Object.assign(new Error('busy'), { code: 'EPERM' });
    const renameFile = vi
      .fn<(source: string, destination: string) => Promise<void>>()
      .mockRejectedValueOnce(sharingFailure)
      .mockRejectedValueOnce(sharingFailure)
      .mockResolvedValue(undefined);
    const revalidate = vi.fn();
    const wait = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined);

    await replaceFileWithWindowsRetry('source', 'destination', revalidate, {
      platform: 'win32',
      renameFile,
      wait,
    });

    expect(renameFile).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[10], [25]]);
    expect(revalidate).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-Windows or non-sharing failures', async () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const renameFile = vi.fn().mockRejectedValue(missing);

    await expect(
      replaceFileWithWindowsRetry('source', 'destination', vi.fn(), {
        platform: 'win32',
        renameFile,
      }),
    ).rejects.toBe(missing);
    await expect(
      replaceFileWithWindowsRetry('source', 'destination', vi.fn(), {
        platform: 'linux',
        renameFile,
      }),
    ).rejects.toBe(missing);
    expect(renameFile).toHaveBeenCalledTimes(2);
  });

  it('stops when revalidation rejects the current file identities', async () => {
    const sharingFailure = Object.assign(new Error('busy'), { code: 'EACCES' });
    const renameFile = vi.fn().mockRejectedValue(sharingFailure);
    const changed = new Error('configuration changed');

    await expect(
      replaceFileWithWindowsRetry(
        'source',
        'destination',
        () => {
          throw changed;
        },
        {
          platform: 'win32',
          renameFile,
          wait: () => Promise.resolve(),
        },
      ),
    ).rejects.toBe(changed);
    expect(renameFile).toHaveBeenCalledOnce();
  });
});
