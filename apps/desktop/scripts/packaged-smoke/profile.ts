import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

import {
  PACKAGED_SMOKE_PROFILE_FILE,
  PACKAGED_SMOKE_ROOT_ARGUMENT,
  PACKAGED_SMOKE_TOKEN_ARGUMENT,
} from '../../src/shared/packaged-smoke.js';

export interface IsolatedSmokeProfile {
  readonly root: string;
  readonly launchArguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
}

export async function createIsolatedSmokeProfile(root: string): Promise<IsolatedSmokeProfile> {
  await mkdir(root, { mode: 0o700 });
  const canonicalRoot = await realpath(root);
  const canonicalTemporaryDirectory = await realpath(tmpdir());
  const temporaryRelativePath = relative(canonicalTemporaryDirectory, canonicalRoot);
  if (
    temporaryRelativePath === '' ||
    temporaryRelativePath === '..' ||
    temporaryRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(temporaryRelativePath)
  ) {
    throw new Error('Packaged smoke profiles must be fresh children of the system temp directory.');
  }
  const directories = [
    'session',
    'documents',
    'downloads',
    'temp',
    'crash-dumps',
    'logs',
    'home',
    'home/config',
    'home/cache',
    'home/data',
    'home/AppData/Roaming',
    'home/AppData/Local',
    'runtime',
  ];
  await Promise.all(
    directories.map(
      async (directory) => await mkdir(join(canonicalRoot, directory), { recursive: true }),
    ),
  );
  const token = randomUUID();
  await writeFile(
    join(canonicalRoot, PACKAGED_SMOKE_PROFILE_FILE),
    `${JSON.stringify({ schemaVersion: 1, token })}\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
  const home = join(canonicalRoot, 'home');
  const temporary = join(canonicalRoot, 'temp');
  return {
    root: canonicalRoot,
    launchArguments: [
      '--smoke-test',
      `--user-data-dir=${canonicalRoot}`,
      `${PACKAGED_SMOKE_ROOT_ARGUMENT}${canonicalRoot}`,
      `${PACKAGED_SMOKE_TOKEN_ARGUMENT}${token}`,
    ],
    environment: {
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_CACHE_HOME: join(home, 'cache'),
      XDG_DATA_HOME: join(home, 'data'),
      XDG_RUNTIME_DIR: join(canonicalRoot, 'runtime'),
      GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      TMPDIR: temporary,
      TEMP: temporary,
      TMP: temporary,
      ELECTRON_ENABLE_LOGGING: '1',
    },
  };
}
