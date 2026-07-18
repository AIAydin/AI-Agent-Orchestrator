import path from 'node:path';

import type { GitHubCommandRunner } from '@forgeboard/git-engine';

import type { GitHubCliDisclosure } from '../../outbound/git/disclosures.js';
import type {
  GitHubCliCommandRuntime,
  GitHubCliPublicStatus,
  GitHubCliRuntimeService,
  GitHubCliSource,
} from '../github-cli/runtime.js';

export type GitHubRuntimeAuthority = Pick<GitHubCliRuntimeService, 'resolveCommandRuntime'>;

/** Immutable per-plan binding to one resolved, identity-guarded GitHub CLI runner. */
export interface GitHubRuntimeBinding {
  readonly source: GitHubCliSource;
  readonly available: boolean;
  readonly validationState: GitHubCliPublicStatus['state'];
  readonly executable: string;
  readonly identityFingerprint: string;
  readonly runner: GitHubCommandRunner;
  readonly disclosure: GitHubCliDisclosure;
}

export async function bindGitHubRuntime(
  authority: GitHubRuntimeAuthority,
): Promise<GitHubRuntimeBinding> {
  return bindingFromRuntime(await authority.resolveCommandRuntime());
}

/** Re-resolves current Settings/PATH state and rejects any change from the plan-time binding. */
export async function assertGitHubRuntimeCurrent(
  authority: GitHubRuntimeAuthority,
  binding: GitHubRuntimeBinding,
  requireAvailable: boolean,
): Promise<void> {
  let current: GitHubRuntimeBinding;
  try {
    current = await bindGitHubRuntime(authority);
  } catch (error) {
    throw new Error('The selected GitHub CLI changed or became unavailable. Check GitHub again.', {
      cause: error,
    });
  }
  if (
    current.identityFingerprint !== binding.identityFingerprint ||
    current.source !== binding.source ||
    !executablesEqual(current.executable, binding.executable) ||
    !sameOrValidatedTransition(binding, current)
  ) {
    throw new Error('The selected GitHub CLI changed. Check GitHub and prepare a new plan.');
  }
  if (requireAvailable && !current.available) {
    throw new Error('GitHub CLI is unavailable. Choose or install it, then check GitHub again.');
  }
}

function bindingFromRuntime(runtime: GitHubCliCommandRuntime): GitHubRuntimeBinding {
  if (!/^[a-f0-9]{64}$/u.test(runtime.identityFingerprint)) {
    throw new Error('Forgeboard could not verify the GitHub CLI identity.');
  }
  if (!executablesEqual(runtime.runner.executable, runtime.executable)) {
    throw new Error('The GitHub CLI runner does not match the program Forgeboard verified.');
  }
  if (runtime.status.source !== runtime.source || runtime.status.state === 'changed') {
    throw new Error('Forgeboard got an inconsistent GitHub CLI status. Check GitHub again.');
  }
  if (runtime.status.state === 'unavailable') {
    if (runtime.available || runtime.review !== null || runtime.source !== 'automatic') {
      throw new Error('Forgeboard got an inconsistent GitHub CLI status. Check GitHub again.');
    }
    return {
      source: runtime.source,
      available: false,
      validationState: 'unavailable',
      executable: runtime.executable,
      identityFingerprint: runtime.identityFingerprint,
      runner: runtime.runner,
      disclosure: {
        source: 'automatic',
        available: false,
        filename: null,
        sha256: null,
        executablePath: null,
      },
    };
  }
  const review = runtime.review;
  if (
    review === null ||
    review.source !== runtime.source ||
    review.identity.source !== runtime.source ||
    !executablesEqual(review.executablePath, runtime.executable)
  ) {
    throw new Error('Forgeboard got an inconsistent GitHub CLI status. Check GitHub again.');
  }
  const ready = runtime.status.state === 'ready';
  if (runtime.available !== ready || (!ready && runtime.status.state !== 'unverified')) {
    throw new Error('Forgeboard got an inconsistent GitHub CLI status. Check GitHub again.');
  }
  return {
    source: runtime.source,
    available: ready,
    validationState: runtime.status.state,
    executable: runtime.executable,
    identityFingerprint: runtime.identityFingerprint,
    runner: runtime.runner,
    disclosure: {
      source: runtime.source,
      available: ready,
      filename: review.identity.filename,
      sha256: review.identity.sha256,
      executablePath: review.executablePath,
    },
  };
}

function sameOrValidatedTransition(
  reviewed: GitHubRuntimeBinding,
  current: GitHubRuntimeBinding,
): boolean {
  if (
    reviewed.available === current.available &&
    reviewed.validationState === current.validationState
  ) {
    return true;
  }
  return (
    reviewed.source === 'automatic' &&
    reviewed.validationState === 'unverified' &&
    !reviewed.available &&
    current.validationState === 'ready' &&
    current.available
  );
}

function executablesEqual(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}
