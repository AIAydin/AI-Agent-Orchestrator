import { chmod, realpath } from 'node:fs/promises';

import type { InstallerArtifacts } from './artifacts.js';
import { isFile, runCommand, runWithCleanup, smokeExecutable } from './process.js';

const EXPECTED_PACKAGE_NAME = 'forgeboard';
const INSTALLED_EXECUTABLE = '/usr/bin/forgeboard';
const OWNED_EXECUTABLE = '/opt/Forgeboard/forgeboard';

type LinuxArtifacts = Extract<InstallerArtifacts, { platform: 'linux' }>;

export async function smokeLinuxArtifacts(
  artifacts: LinuxArtifacts,
  temporaryRoot: string,
): Promise<void> {
  await chmod(artifacts.appImage, 0o755);
  await smokeExecutable(
    artifacts.appImage,
    ['--appimage-extract-and-run', '--no-sandbox'],
    `${temporaryRoot}/user-data-appimage`,
    { cwd: temporaryRoot },
  );

  const packageName = (await runCommand('dpkg-deb', ['--field', artifacts.deb, 'Package'])).trim();
  if (packageName !== EXPECTED_PACKAGE_NAME) {
    throw new Error(
      `Expected the DEB package name ${EXPECTED_PACKAGE_NAME}, received ${packageName || '(empty)'}.`,
    );
  }
  const packageArchitecture = (
    await runCommand('dpkg-deb', ['--field', artifacts.deb, 'Architecture'])
  ).trim();
  const hostArchitecture = (await runCommand('dpkg', ['--print-architecture'])).trim();
  if (packageArchitecture !== hostArchitecture && packageArchitecture !== 'all') {
    throw new Error(
      `The DEB architecture ${packageArchitecture} does not match host ${hostArchitecture}.`,
    );
  }
  if (await isFile(INSTALLED_EXECUTABLE)) {
    throw new Error(`Refusing to overwrite a pre-existing executable: ${INSTALLED_EXECUTABLE}`);
  }

  let installAttempted = false;
  await runWithCleanup(
    async () => {
      installAttempted = true;
      await runCommand('sudo', ['-n', 'dpkg', '--install', artifacts.deb]);
      await verifyPackageOwnership();
      await smokeExecutable(
        INSTALLED_EXECUTABLE,
        ['--no-sandbox'],
        `${temporaryRoot}/user-data-deb`,
      );
    },
    async () => {
      if (installAttempted) {
        await runCommand('sudo', ['-n', 'dpkg', '--purge', EXPECTED_PACKAGE_NAME]);
      }
    },
    'DEB smoke test and cleanup both failed.',
  );
}

async function verifyPackageOwnership(): Promise<void> {
  const status = (
    await runCommand('dpkg-query', ['--show', '--showformat=${Status}', EXPECTED_PACKAGE_NAME])
  ).trim();
  if (status !== 'install ok installed') {
    throw new Error(`The ${EXPECTED_PACKAGE_NAME} package is not fully installed: ${status}`);
  }
  const executableTarget = await realpath(INSTALLED_EXECUTABLE);
  if (executableTarget !== OWNED_EXECUTABLE) {
    throw new Error(
      `${INSTALLED_EXECUTABLE} resolves outside the expected package: ${executableTarget}`,
    );
  }
  const installedFiles = (
    await runCommand('dpkg-query', ['--listfiles', EXPECTED_PACKAGE_NAME])
  ).split(/\r?\n/u);
  if (!installedFiles.includes(OWNED_EXECUTABLE)) {
    throw new Error(`${OWNED_EXECUTABLE} is not owned by the ${EXPECTED_PACKAGE_NAME} package.`);
  }
}
