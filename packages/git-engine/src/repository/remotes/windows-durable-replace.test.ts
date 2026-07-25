import { describe, expect, it, vi } from 'vitest';

import { replaceFileAtomically } from './windows-durable-replace.js';

describe('atomic Windows durable replacement', () => {
  it('uses the native replace-existing authority and revalidates before a bounded retry', async () => {
    const sharingViolation = new Error('bounded native move failure');
    const moveWindows = vi
      .fn()
      .mockRejectedValueOnce(sharingViolation)
      .mockResolvedValueOnce(undefined);
    const revalidate = vi.fn();
    const wait = vi.fn().mockResolvedValue(undefined);

    await replaceFileAtomically('C:\\repo\\staging', 'C:\\repo\\config', revalidate, {
      platform: 'win32',
      moveWindows,
      wait,
    });

    expect(moveWindows).toHaveBeenCalledTimes(2);
    expect(moveWindows).toHaveBeenCalledWith('C:\\repo\\staging', 'C:\\repo\\config', true);
    expect(wait).toHaveBeenCalledWith(25);
    expect(revalidate).toHaveBeenCalledOnce();
  });

  it('stops retrying when authoritative file identity revalidation fails', async () => {
    const moveFailure = new Error('bounded native move failure');
    const stale = new Error('configuration changed');
    const moveWindows = vi.fn().mockRejectedValue(moveFailure);

    await expect(
      replaceFileAtomically(
        'C:\\repo\\staging',
        'C:\\repo\\config',
        () => {
          throw stale;
        },
        {
          platform: 'win32',
          moveWindows,
          wait: () => Promise.resolve(),
        },
      ),
    ).rejects.toBe(stale);
    expect(moveWindows).toHaveBeenCalledOnce();
  });

  it('uses the ordinary atomic rename directly on non-Windows hosts', async () => {
    const renameFile = vi.fn();
    const moveWindows = vi.fn();

    await replaceFileAtomically('/repo/staging', '/repo/config', vi.fn(), {
      platform: 'darwin',
      moveWindows,
      renameFile,
    });

    expect(renameFile).toHaveBeenCalledWith('/repo/staging', '/repo/config');
    expect(moveWindows).not.toHaveBeenCalled();
  });
});
