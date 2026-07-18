import type { GitDelegatePlan } from '@forgeboard/git-engine';
import { describe, expect, it, vi } from 'vitest';

import { createNativeGitDelegateAuthorizer, delegateConfirmation } from './native-confirmation.js';

describe('native Git delegate confirmation', () => {
  it('is cancel-default and discloses exact commands, origins, paths, and fingerprint', () => {
    const confirmation = delegateConfirmation(plan());

    expect(confirmation).toMatchObject({
      type: 'warning',
      buttons: ['Cancel', 'Run filter commands'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    expect(confirmation.detail).toContain("node '/trusted/filter.cjs' --clean");
    expect(confirmation.detail).toContain('file:.git/config');
    expect(confirmation.detail).toContain('src/example.txt');
    expect(confirmation.detail).toContain('a'.repeat(64));
  });

  it('coalesces an exact plan and revalidates ownership around every decision', async () => {
    const assertCurrent = vi.fn();
    const show = vi.fn(() => Promise.resolve(1));
    const authorize = createNativeGitDelegateAuthorizer({ assertCurrent, show });

    const [first, second] = await Promise.all([authorize(plan()), authorize(plan())]);

    expect(first).toMatchObject({ approved: true, fingerprint: 'a'.repeat(64) });
    expect(second).toMatchObject({ approved: true, fingerprint: 'a'.repeat(64) });
    expect(show).toHaveBeenCalledTimes(1);
    expect(assertCurrent).toHaveBeenCalledTimes(4);
    first?.assertCurrent();
    expect(assertCurrent).toHaveBeenCalledTimes(5);
  });

  it('returns no authorization when the native dialog is cancelled', async () => {
    const authorize = createNativeGitDelegateAuthorizer({
      assertCurrent: () => undefined,
      show: () => Promise.resolve(0),
    });

    await expect(authorize(plan())).resolves.toBeNull();
  });
});

function plan(): GitDelegatePlan {
  return {
    schemaVersion: 1,
    fingerprint: 'a'.repeat(64),
    repositoryPath: '/workspace/repository',
    operation: 'stage-clean',
    filters: [
      {
        driver: 'trusted-clean',
        executableConfigured: true,
        pathCount: 1,
        pathDigest: 'b'.repeat(64),
        disclosedPaths: ['src/example.txt'],
        pathsTruncated: false,
        declarations: [
          {
            phase: 'clean',
            command: "node '/trusted/filter.cjs' --clean",
            origin: 'file:.git/config',
          },
        ],
      },
    ],
  };
}
