import { chmod, mkdtemp, open, rm, truncate, writeFile, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GITHUB_CLI_MAX_EXECUTABLE_BYTES } from '../../storage/github-cli/contracts.js';
import { assertGitHubCliExecutableCurrent, captureGitHubCliExecutable } from './identity.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe('GitHub CLI executable identity size bounds', () => {
  it('rejects an oversized sparse selection before reading or disclosing its path', async () => {
    const executable = await fixtureExecutable();
    await truncate(executable, GITHUB_CLI_MAX_EXECUTABLE_BYTES + 1);
    const prototype = await fileHandlePrototype(executable);
    const read = vi.spyOn(prototype, 'read');

    try {
      const failure = await captureGitHubCliExecutable(executable).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/size limit/iu);
      expect((failure as Error).message).not.toContain(executable);
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it('rejects an oversized replacement before re-hashing it', async () => {
    const executable = await fixtureExecutable();
    const captured = await captureGitHubCliExecutable(executable);
    await truncate(executable, GITHUB_CLI_MAX_EXECUTABLE_BYTES + 1);
    const prototype = await fileHandlePrototype(executable);
    const read = vi.spyOn(prototype, 'read');

    try {
      await expect(assertGitHubCliExecutableCurrent(captured)).rejects.toThrow(
        'The selected GitHub CLI program changed on disk. Choose it again so Artemis can re-check it.',
      );
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });
});

async function fixtureExecutable(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-gh-size-bound-'));
  temporaryDirectories.push(directory);
  const executable = path.join(directory, 'gh-fixture');
  await writeFile(executable, '#!/bin/sh\nexit 0\n');
  await chmod(executable, 0o700);
  return executable;
}

async function fileHandlePrototype(filePath: string): Promise<FileHandle> {
  const handle = await open(filePath, 'r');
  try {
    return Object.getPrototypeOf(handle) as FileHandle;
  } finally {
    await handle.close();
  }
}
