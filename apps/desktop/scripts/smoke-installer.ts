import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { resolveInstallerArtifacts, type InstallerArtifacts } from './installer-smoke/artifacts.js';
import {
  expectedSourceCommit,
  type InstallerIntegrityOptions,
  verifyInstallerIntegrity,
} from './installer-smoke/integrity.js';
import { smokeLinuxArtifacts } from './installer-smoke/linux.js';
import { smokeMacDmg } from './installer-smoke/macos.js';
import { runWithCleanup } from './installer-smoke/process.js';
import { smokeWindowsNsis } from './installer-smoke/windows.js';

export { resolveInstallerArtifacts, type InstallerArtifacts };

export async function runInstallerSmoke(
  releaseRoot: string,
  integrity: InstallerIntegrityOptions = {},
): Promise<void> {
  const artifacts = await resolveInstallerArtifacts(releaseRoot);
  await verifyInstallerIntegrity(releaseRoot, artifacts, {
    ...integrity,
    expectedSourceCommit: integrity.expectedSourceCommit ?? expectedSourceCommit(),
  });
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'forgeboard-installer-smoke-'));
  await runWithCleanup(
    async () => {
      if (artifacts.platform === 'darwin') await smokeMacDmg(artifacts.dmg, temporaryRoot);
      else if (artifacts.platform === 'win32') {
        await smokeWindowsNsis(artifacts.nsis, temporaryRoot);
      } else await smokeLinuxArtifacts(artifacts, temporaryRoot);
    },
    async () => rm(temporaryRoot, { recursive: true, force: true }),
    'Installer smoke test and temporary cleanup both failed.',
  );
  process.stdout.write('Artemis installer artifact smoke test passed: FORGEBOARD_SMOKE_OK\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runInstallerSmoke(join(import.meta.dirname, '..', 'release'));
}
