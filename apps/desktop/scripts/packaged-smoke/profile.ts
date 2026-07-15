import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

import {
  PACKAGED_SMOKE_PROFILE_FILE,
  PACKAGED_SMOKE_ROOT_ARGUMENT,
  PACKAGED_SMOKE_TOKEN_ARGUMENT,
} from '../../src/shared/smoke/contracts.js';

export interface IsolatedSmokeProfile {
  readonly root: string;
  readonly launchArguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
}

export async function createIsolatedSmokeProfile(root: string): Promise<IsolatedSmokeProfile> {
  await mkdir(root, { mode: 0o700 });
  const canonicalRoot = await realpath(root);
  const canonicalTemporaryDirectory = await realpath(tmpdir());
  const canonicalParent = await realpath(dirname(canonicalRoot));
  const temporaryRelativePath = relative(canonicalTemporaryDirectory, canonicalParent);
  if (
    temporaryRelativePath === '' ||
    temporaryRelativePath === '..' ||
    temporaryRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(temporaryRelativePath) ||
    temporaryRelativePath.includes(sep)
  ) {
    throw new Error(
      'Packaged smoke launchers must use a direct mkdtemp child of the system temp directory.',
    );
  }
  const profileKind = launcherProfileKind(canonicalParent, canonicalRoot);
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
    `${JSON.stringify({
      schemaVersion: 2,
      token,
      profileRoot: canonicalRoot,
      profileParent: canonicalParent,
      systemTempRoot: canonicalTemporaryDirectory,
      profileKind,
    })}\n`,
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

function launcherProfileKind(
  profileParent: string,
  profileRoot: string,
): 'packaged-runtime' | 'installer' {
  const parentName = basename(profileParent);
  const rootName = basename(profileRoot);
  if (
    /^forgeboard-packaged-runtime-smoke-[A-Za-z0-9]{6}$/u.test(parentName) &&
    rootName === 'user-data'
  ) {
    return 'packaged-runtime';
  }
  if (
    /^forgeboard-installer-smoke-[A-Za-z0-9]{6}$/u.test(parentName) &&
    /^user-data-(?:appimage|deb|dmg|nsis)$/u.test(rootName)
  ) {
    return 'installer';
  }
  throw new Error('Packaged smoke profile path does not match a launcher-owned temporary layout.');
}
