import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runWithCleanup, smokeExecutable } from './installer-smoke/process.js';

export interface PackagedLaunch {
  executable: string;
  args: string[];
}

export async function resolvePackagedLaunch(
  releaseRoot: string,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): Promise<PackagedLaunch> {
  const entries = (await readdir(releaseRoot, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const args: string[] = [];

  if (platform === 'darwin') {
    const directory = architecture === 'x64' ? 'mac' : `mac-${architecture}`;
    const executable = join(
      releaseRoot,
      directory,
      'Forgeboard.app',
      'Contents',
      'MacOS',
      'Forgeboard',
    );
    if (await isFile(executable)) return { executable, args };
  } else if (platform === 'win32') {
    const directory = architecture === 'x64' ? 'win-unpacked' : `win-${architecture}-unpacked`;
    const executable = join(releaseRoot, directory, 'Forgeboard.exe');
    if (await isFile(executable)) return { executable, args };
  } else {
    const normalizedArchitecture = architecture === 'arm' ? 'armv7l' : architecture;
    const directory =
      architecture === 'x64' ? 'linux-unpacked' : `linux-${normalizedArchitecture}-unpacked`;
    const executable = join(releaseRoot, directory, 'forgeboard');
    if (await isFile(executable)) return { executable, args };

    const appImages = entries.filter(
      (entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.appimage'),
    );
    const architectureMatches = appImages.filter((entry) =>
      entry.name.toLowerCase().includes(normalizedArchitecture.toLowerCase()),
    );
    const appImage =
      architectureMatches.length === 1
        ? architectureMatches[0]
        : appImages.length === 1
          ? appImages[0]
          : undefined;
    if (appImage) {
      const appImagePath = join(releaseRoot, appImage.name);
      if (await isFile(appImagePath)) {
        return { executable: appImagePath, args: ['--no-sandbox'] };
      }
    }
  }

  throw new Error(
    `No packaged Forgeboard executable for ${platform}-${architecture} found in ${releaseRoot}.`,
  );
}

export async function runPackagedSmoke(releaseRoot: string): Promise<void> {
  const launch = await resolvePackagedLaunch(releaseRoot);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'forgeboard-packaged-runtime-smoke-'));
  await runWithCleanup(
    async () =>
      await smokeExecutable(launch.executable, launch.args, join(temporaryRoot, 'user-data'), {
        cwd: temporaryRoot,
      }),
    async () => await rm(temporaryRoot, { recursive: true, force: true }),
    'Packaged runtime smoke test and temporary cleanup both failed.',
  );
  process.stdout.write('Packaged Forgeboard smoke test passed.\n');
}

async function isFile(path: string): Promise<boolean> {
  return await stat(path).then(
    (value) => value.isFile(),
    () => false,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runPackagedSmoke(join(import.meta.dirname, '..', 'release'));
}
