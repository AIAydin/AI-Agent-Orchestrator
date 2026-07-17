import path from 'node:path';

import type { GitHubCommandRunner } from '@forgeboard/git-engine';
import { describe, expect, it } from 'vitest';

import type { GitHubCliCommandRuntime } from '../github-cli/runtime.js';
import {
  assertGitHubRuntimeCurrent,
  bindGitHubRuntime,
  type GitHubRuntimeAuthority,
} from './github-runtime.js';

const NOW = '2026-07-17T14:00:00.000Z';
const EXECUTABLE = path.resolve('/tmp/forgeboard-automatic-gh');

describe('automatic GitHub runtime validation transitions', () => {
  it('discloses an exact detected executable as unavailable until its version is validated', async () => {
    const binding = await bindGitHubRuntime(authority(automaticRuntime('unverified')));

    expect(binding).toMatchObject({
      source: 'automatic',
      available: false,
      validationState: 'unverified',
      executable: EXECUTABLE,
      disclosure: {
        source: 'automatic',
        available: false,
        filename: 'forgeboard-automatic-gh',
        sha256: 'd'.repeat(64),
        executablePath: EXECUTABLE,
      },
    });
  });

  it('accepts only the same exact automatic executable transitioning from unverified to ready', async () => {
    const reviewed = await bindGitHubRuntime(authority(automaticRuntime('unverified')));

    await expect(
      assertGitHubRuntimeCurrent(authority(automaticRuntime('ready')), reviewed, false),
    ).resolves.toBeUndefined();
    await expect(
      assertGitHubRuntimeCurrent(
        authority(automaticRuntime('ready', 'e'.repeat(64))),
        reviewed,
        false,
      ),
    ).rejects.toThrow(/changed/iu);
  });

  it('rejects validation loss and still enforces readiness when no transition occurred', async () => {
    const ready = await bindGitHubRuntime(authority(automaticRuntime('ready')));
    const unverified = await bindGitHubRuntime(authority(automaticRuntime('unverified')));

    await expect(
      assertGitHubRuntimeCurrent(authority(automaticRuntime('unverified')), ready, false),
    ).rejects.toThrow(/changed/iu);
    await expect(
      assertGitHubRuntimeCurrent(authority(automaticRuntime('unverified')), unverified, true),
    ).rejects.toThrow(/unavailable/iu);
  });
});

function authority(runtime: GitHubCliCommandRuntime): GitHubRuntimeAuthority {
  return { resolveCommandRuntime: () => Promise.resolve(runtime) };
}

function automaticRuntime(
  state: 'unverified' | 'ready',
  sha256 = 'd'.repeat(64),
): GitHubCliCommandRuntime {
  const identity = {
    source: 'automatic' as const,
    filename: path.basename(EXECUTABLE),
    sizeBytes: 42,
    sha256,
    version: state === 'ready' ? '2.80.0' : null,
  };
  const runner: GitHubCommandRunner = {
    executable: EXECUTABLE,
    run: () => Promise.reject(new Error('The binding test runner must not execute.')),
  };
  return {
    source: 'automatic',
    available: state === 'ready',
    executable: EXECUTABLE,
    identityFingerprint: sha256,
    review: { source: 'automatic', executablePath: EXECUTABLE, identity },
    status: {
      source: 'automatic',
      state,
      identity,
      verifiedAt: state === 'ready' ? NOW : null,
      checkedAt: NOW,
    },
    runner,
  };
}
