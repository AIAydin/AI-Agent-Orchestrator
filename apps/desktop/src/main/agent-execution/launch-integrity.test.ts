import {
  chmod,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
  truncate,
  utimes,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertLaunchExecutableIdentity,
  assertLaunchFileIdentity,
  captureLaunchExecutableIdentity,
  captureLaunchFileIdentity,
} from './launch-integrity.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe('agent launch executable identity', () => {
  it('accepts an unchanged canonical executable and rejects content replacement', async () => {
    const executable = await fixtureExecutable();
    const identity = await captureLaunchExecutableIdentity(executable);
    await expect(assertLaunchExecutableIdentity(identity)).resolves.toBeUndefined();

    await writeFile(executable, '#!/bin/sh\nexit 7\n');
    await chmod(executable, 0o700);
    await expect(assertLaunchExecutableIdentity(identity)).rejects.toThrow(/changed/iu);
  });

  it('rejects an executable whose execute mode changed after approval', async () => {
    const executable = await fixtureExecutable();
    const identity = await captureLaunchExecutableIdentity(executable);
    await chmod(executable, 0o600);

    await expect(assertLaunchExecutableIdentity(identity)).rejects.toThrow(/changed/iu);
  });

  it('binds a readable script argument even when it is not executable', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-agent-script-'));
    temporaryDirectories.push(directory);
    const script = await realpath(await writeFixtureScript(directory));
    const identity = await captureLaunchFileIdentity(script);
    await expect(assertLaunchFileIdentity(identity)).resolves.toBeUndefined();

    await writeFile(script, 'process.exit(7);\n');
    await expect(assertLaunchFileIdentity(identity)).rejects.toThrow(/changed/iu);
  });

  it('rejects a same-size replacement even when its modified time is restored', async () => {
    const executable = await fixtureExecutable();
    const identity = await captureLaunchExecutableIdentity(executable);
    const before = await stat(executable);

    await writeFile(executable, '#!/bin/sh\nexit 9\n');
    await chmod(executable, 0o700);
    await utimes(executable, before.atime, before.mtime);

    await expect(assertLaunchExecutableIdentity(identity)).rejects.toThrow(/changed/iu);
  });

  it('rejects a configured oversized sparse file before reading any content', async () => {
    const executable = await fixtureExecutable();
    await truncate(executable, 1_025);
    const prototype = await fileHandlePrototype(executable);
    const read = vi.spyOn(prototype, 'read');

    try {
      await expect(
        captureLaunchExecutableIdentity(executable, { maximumBytes: 1_024 }),
      ).rejects.toThrow(/size limit/iu);
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it('rejects growth during hashing without chasing the new end of file', async () => {
    const executable = await fixtureExecutable();
    const reviewedBytes = 128 * 1_024;
    const maximumBytes = 256 * 1_024;
    await truncate(executable, reviewedBytes);
    const prototype = await fileHandlePrototype(executable);
    const originalRead = Reflect.get(prototype, 'read');
    const positionalRead = originalRead as PositionalRead;
    let mutated = false;
    let furthestRequestedByte = 0;

    prototype.read = async function (
      this: FileHandle,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) {
      furthestRequestedByte = Math.max(furthestRequestedByte, position + length);
      const result = await positionalRead.call(this, buffer, offset, length, position);
      if (!mutated) {
        mutated = true;
        await truncate(executable, maximumBytes + 1);
      }
      return result;
    } as FileHandle['read'];

    try {
      await expect(captureLaunchExecutableIdentity(executable, { maximumBytes })).rejects.toThrow(
        /changed/iu,
      );
    } finally {
      prototype.read = originalRead;
    }

    expect(mutated).toBe(true);
    expect(furthestRequestedByte).toBe(reviewedBytes + 1);
  });
});

type PositionalRead = (
  this: FileHandle,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
) => Promise<{ bytesRead: number; buffer: Buffer }>;

async function fileHandlePrototype(filePath: string): Promise<FileHandle> {
  const handle = await open(filePath, 'r');
  try {
    return Object.getPrototypeOf(handle) as FileHandle;
  } finally {
    await handle.close();
  }
}

async function writeFixtureScript(directory: string): Promise<string> {
  const script = path.join(directory, 'cli.js');
  await writeFile(script, 'process.exit(0);\n');
  await chmod(script, 0o600);
  return script;
}

async function fixtureExecutable(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-agent-executable-'));
  temporaryDirectories.push(directory);
  const executable = path.join(directory, 'agent');
  await writeFile(executable, '#!/bin/sh\nexit 0\n');
  await chmod(executable, 0o700);
  return await realpath(executable);
}
