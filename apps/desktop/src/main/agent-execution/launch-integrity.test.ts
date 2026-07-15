import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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
});

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
