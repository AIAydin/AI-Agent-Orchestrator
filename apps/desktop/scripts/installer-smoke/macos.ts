import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { requireDirectory, runCommand, runWithCleanup, smokeExecutable } from './process.js';

export async function smokeMacDmg(dmg: string, temporaryRoot: string): Promise<void> {
  const mountPoint = join(temporaryRoot, 'mounted-dmg');
  const installedApplications = join(temporaryRoot, 'Applications');
  const installedBundle = join(installedApplications, 'Artemis.app');
  await mkdir(mountPoint);
  await mkdir(installedApplications);
  let mounted = false;

  await runWithCleanup(
    async () => {
      await runCommand('hdiutil', [
        'attach',
        '-readonly',
        '-nobrowse',
        '-mountpoint',
        mountPoint,
        dmg,
      ]);
      mounted = true;
      const sourceBundle = join(mountPoint, 'Artemis.app');
      await requireDirectory(sourceBundle, 'The DMG does not contain Artemis.app.');
      await runCommand('ditto', [sourceBundle, installedBundle]);
    },
    async () => {
      if (mounted) await detachDmg(mountPoint);
    },
    'DMG installation and detach both failed.',
  );

  await smokeExecutable(
    join(installedBundle, 'Contents', 'MacOS', 'Artemis'),
    [],
    join(temporaryRoot, 'user-data-dmg'),
  );
}

async function detachDmg(mountPoint: string): Promise<void> {
  try {
    await runCommand('hdiutil', ['detach', mountPoint]);
  } catch (detachError) {
    try {
      await runCommand('hdiutil', ['detach', '-force', mountPoint]);
    } catch (forceError) {
      throw new AggregateError([detachError, forceError], 'Normal and forced DMG detach failed.');
    }
  }
}
