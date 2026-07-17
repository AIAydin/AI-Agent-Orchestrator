import { describe, expect, it, vi } from 'vitest';

import {
  GitConnectionsMutationCoordinator,
  type GitRemoteDeliveryMutationBoundary,
} from './mutation-coordinator.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

const fixture = () => {
  const pauseForDataMutation = vi.fn(() => Promise.resolve());
  const pauseForGitHubRuntimeMutation = vi.fn();
  const resumeAfterPrivacyReset = vi.fn();
  const delivery: GitRemoteDeliveryMutationBoundary = {
    pauseForDataMutation,
    pauseForGitHubRuntimeMutation,
    resumeAfterPrivacyReset,
  };
  return {
    coordinator: new GitConnectionsMutationCoordinator(delivery),
    pauseForDataMutation,
    pauseForGitHubRuntimeMutation,
    resumeAfterPrivacyReset,
  };
};

describe('GitConnectionsMutationCoordinator', () => {
  it('keeps a GitHub CLI change from overlapping a remote configuration change', async () => {
    const { coordinator, pauseForGitHubRuntimeMutation, resumeAfterPrivacyReset } = fixture();
    const hold = deferred();
    const remote = coordinator.withRemoteConfigurationMutation(async () => {
      await hold.promise;
      return 'remote-complete';
    });

    await expect(
      coordinator.withGitHubCliMutation(() => Promise.resolve('cli-complete')),
    ).rejects.toThrow('Another Git connection or GitHub CLI change is still finishing');
    expect(pauseForGitHubRuntimeMutation).not.toHaveBeenCalled();
    expect(resumeAfterPrivacyReset).not.toHaveBeenCalled();

    hold.resolve();
    await expect(remote).resolves.toBe('remote-complete');
    expect(resumeAfterPrivacyReset).toHaveBeenCalledTimes(1);
  });

  it('keeps a remote configuration change from overlapping a GitHub CLI change', async () => {
    const { coordinator, pauseForDataMutation, resumeAfterPrivacyReset } = fixture();
    const hold = deferred();
    const cli = coordinator.withGitHubCliMutation(async () => {
      await hold.promise;
      return 'cli-complete';
    });

    await expect(
      coordinator.withRemoteConfigurationMutation(() => Promise.resolve('remote-complete')),
    ).rejects.toThrow('Another Git connection or GitHub CLI change is still finishing');
    expect(pauseForDataMutation).not.toHaveBeenCalled();

    hold.resolve();
    await expect(cli).resolves.toBe('cli-complete');
    expect(resumeAfterPrivacyReset).toHaveBeenCalledTimes(1);
  });

  it('resumes after an operation failure and releases shared admission', async () => {
    const { coordinator, resumeAfterPrivacyReset } = fixture();

    await expect(
      coordinator.withGitHubCliMutation(() => Promise.reject(new Error('selection failed'))),
    ).rejects.toThrow('selection failed');
    expect(resumeAfterPrivacyReset).toHaveBeenCalledTimes(1);

    await expect(
      coordinator.withRemoteConfigurationMutation(() => Promise.resolve('retry-complete')),
    ).resolves.toBe('retry-complete');
    expect(resumeAfterPrivacyReset).toHaveBeenCalledTimes(2);
  });

  it('does not resume an unsuccessful pause and still releases shared admission', async () => {
    const { coordinator, pauseForDataMutation, resumeAfterPrivacyReset } = fixture();
    pauseForDataMutation.mockRejectedValueOnce(new Error('delivery busy'));

    await expect(
      coordinator.withRemoteConfigurationMutation(() => Promise.resolve('not-run')),
    ).rejects.toThrow('delivery busy');
    expect(resumeAfterPrivacyReset).not.toHaveBeenCalled();

    await expect(
      coordinator.withGitHubCliMutation(() => Promise.resolve('retry-complete')),
    ).resolves.toBe('retry-complete');
    expect(resumeAfterPrivacyReset).toHaveBeenCalledTimes(1);
  });
});
