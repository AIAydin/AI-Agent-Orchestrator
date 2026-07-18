import { realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  assertLaunchExecutableIdentity,
  captureLaunchExecutableIdentity,
  type LaunchExecutableIdentity,
} from '../../agent-execution/launch-integrity.js';
import {
  GITHUB_CLI_MAX_EXECUTABLE_BYTES,
  GitHubCliExecutableIdentitySchema,
  type GitHubCliExecutableIdentity,
} from '../../storage/github-cli/contracts.js';

export interface CapturedGitHubCliExecutable {
  readonly executablePath: string;
  readonly executableFileName: string;
  readonly executableIdentity: GitHubCliExecutableIdentity;
}

/** Canonicalizes and hashes a selected executable without starting it. */
export async function captureGitHubCliExecutable(
  candidatePath: string,
): Promise<CapturedGitHubCliExecutable> {
  const canonicalPath = await realpath(path.resolve(candidatePath));
  const launchIdentity = await captureLaunchExecutableIdentity(canonicalPath, {
    maximumBytes: GITHUB_CLI_MAX_EXECUTABLE_BYTES,
  });
  return {
    executablePath: launchIdentity.path,
    executableFileName: path.basename(launchIdentity.path),
    executableIdentity: storedIdentity(launchIdentity),
  };
}

/** Re-opens and re-hashes the exact persisted executable. */
export async function assertGitHubCliExecutableCurrent(
  expected: CapturedGitHubCliExecutable,
): Promise<void> {
  try {
    await assertLaunchExecutableIdentity(launchIdentity(expected), {
      maximumBytes: GITHUB_CLI_MAX_EXECUTABLE_BYTES,
    });
  } catch {
    throw new Error(
      'The selected GitHub CLI program changed on disk. Choose it again so Forgeboard can re-check it.',
    );
  }
}

export function sameGitHubCliExecutable(
  left: CapturedGitHubCliExecutable,
  right: CapturedGitHubCliExecutable,
): boolean {
  return (
    pathsEqual(left.executablePath, right.executablePath) &&
    fileNamesEqual(left.executableFileName, right.executableFileName) &&
    left.executableIdentity.dev === right.executableIdentity.dev &&
    left.executableIdentity.ino === right.executableIdentity.ino &&
    left.executableIdentity.size === right.executableIdentity.size &&
    left.executableIdentity.mtimeMs === right.executableIdentity.mtimeMs &&
    left.executableIdentity.ctimeMs === right.executableIdentity.ctimeMs &&
    left.executableIdentity.mode === right.executableIdentity.mode &&
    left.executableIdentity.sha256 === right.executableIdentity.sha256
  );
}

function storedIdentity(identity: LaunchExecutableIdentity): GitHubCliExecutableIdentity {
  return GitHubCliExecutableIdentitySchema.parse({
    dev: identity.device,
    ino: identity.inode,
    size: identity.size,
    mtimeMs: identity.modifiedAtMs,
    ctimeMs: identity.changedAtMs,
    mode: identity.mode,
    sha256: identity.digest,
  });
}

function launchIdentity(executable: CapturedGitHubCliExecutable): LaunchExecutableIdentity {
  return {
    path: executable.executablePath,
    executable: true,
    device: executable.executableIdentity.dev,
    inode: executable.executableIdentity.ino,
    size: executable.executableIdentity.size,
    modifiedAtMs: executable.executableIdentity.mtimeMs,
    changedAtMs: executable.executableIdentity.ctimeMs,
    mode: executable.executableIdentity.mode,
    digest: executable.executableIdentity.sha256,
  };
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

function fileNamesEqual(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
