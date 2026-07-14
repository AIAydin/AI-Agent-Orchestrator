import { join } from 'node:path';
import process from 'node:process';

import { isFile, runCommand, runWithCleanup, smokeExecutable } from './process.js';

interface WindowsInstallLocation {
  readonly executable: string;
  readonly uninstaller: string;
}

export async function smokeWindowsNsis(nsis: string, temporaryRoot: string): Promise<void> {
  const requested = installLocation(join(temporaryRoot, 'installed'));
  const fallback = process.env.LOCALAPPDATA
    ? installLocation(join(process.env.LOCALAPPDATA, 'Programs', 'Forgeboard'))
    : undefined;
  const locations = fallback ? [requested, fallback] : [requested];
  await rejectPreExistingInstall(locations);
  let installAttempted = false;

  await runWithCleanup(
    async () => {
      installAttempted = true;
      await runCommand(nsis, ['/S', `/D=${join(temporaryRoot, 'installed')}`], {
        windowsVerbatimArguments: true,
      });
      if (!(await isFile(requested.executable))) {
        throw new Error('The NSIS installer did not install Forgeboard.exe at the requested path.');
      }
      await smokeExecutable(requested.executable, [], join(temporaryRoot, 'user-data-nsis'));
    },
    async () => {
      if (installAttempted) await uninstallDiscoveredLocations(locations);
    },
    'NSIS smoke test and cleanup both failed.',
  );
}

function installLocation(root: string): WindowsInstallLocation {
  return {
    executable: join(root, 'Forgeboard.exe'),
    uninstaller: join(root, 'Uninstall Forgeboard.exe'),
  };
}

async function rejectPreExistingInstall(
  locations: readonly WindowsInstallLocation[],
): Promise<void> {
  for (const location of locations) {
    if ((await isFile(location.executable)) || (await isFile(location.uninstaller))) {
      throw new Error(
        `Refusing to overwrite a pre-existing Forgeboard install: ${location.executable}`,
      );
    }
  }
}

async function uninstallDiscoveredLocations(
  locations: readonly WindowsInstallLocation[],
): Promise<void> {
  for (const location of locations) {
    if (await isFile(location.uninstaller)) {
      await runCommand(location.uninstaller, ['/S']);
    } else if (await isFile(location.executable)) {
      throw new Error(`Forgeboard was installed without an uninstaller: ${location.executable}`);
    }
  }
}
