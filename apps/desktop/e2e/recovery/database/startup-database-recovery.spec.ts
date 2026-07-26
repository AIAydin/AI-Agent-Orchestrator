import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';

import {
  closeElectronAfterTest,
  launchDesktop,
  renameCanvasNode,
  watchExternalRequests,
} from '../../support/electron.js';

test('startup restores a corrupt local database from the verified backup chosen by the user', async () => {
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'forgeboard-startup-recovery-e2e-'));
  const backupDirectory = join(userDataDirectory, 'backups');
  const databasePath = join(userDataDirectory, 'forgeboard.sqlite');
  const recoveryLogPath = join(userDataDirectory, 'startup-recovery.jsonl');
  const mainEntry = resolve(import.meta.dirname, '../../../dist/main/index.js');
  const recoveryEntry = resolve(import.meta.dirname, 'fixtures/startup-recovery-entry.mjs');
  const externalRequests: string[] = [];
  let electronApp: ElectronApplication | null = null;

  try {
    const first = await launchDesktop(userDataDirectory);
    electronApp = first.app;
    watchExternalRequests(first.page, externalRequests);
    await first.page.getByRole('button', { name: 'Use safe defaults' }).click();
    await first.page.getByRole('button', { name: /Explore the safe demo/i }).click();
    await first.page
      .locator('.template-section')
      .getByRole('button', { name: /Product brief/ })
      .click();
    await renameCanvasNode(
      first.page.getByRole('article', { name: /^Product brief: /u }),
      'Recovered from startup backup',
    );

    const settings = await openDataSettings(first.page);
    await settings.getByLabel('Backup folder').fill(backupDirectory);
    await settings.getByRole('button', { name: /Save settings/ }).click();
    await expect(settings).toBeHidden();
    const reopened = await openDataSettings(first.page);
    await reopened.getByRole('button', { name: 'Create backup now' }).click();
    await expect(reopened.getByText(/Backup created at/)).toBeVisible();

    await first.app.close();
    electronApp = null;
    const backupNames = (await readdir(backupDirectory)).filter((name) =>
      name.endsWith('.sqlite3'),
    );
    expect(backupNames.length).toBeGreaterThanOrEqual(1);
    backupNames.sort();
    const backupPath = join(backupDirectory, backupNames.at(-1) ?? 'missing.sqlite3');
    expect((await readFile(backupPath)).subarray(0, 16).toString('utf8')).toBe('SQLite format 3\0');

    await Promise.all([
      writeFile(databasePath, 'not a sqlite database', { mode: 0o600 }),
      rm(`${databasePath}-wal`, { force: true }),
      rm(`${databasePath}-shm`, { force: true }),
      writeFile(recoveryLogPath, '', 'utf8'),
    ]);

    const recovered = await launchDesktop(userDataDirectory, {
      entry: recoveryEntry,
      environment: {
        FORGEBOARD_E2E_MAIN_ENTRY: mainEntry,
        FORGEBOARD_E2E_RECOVERY_BACKUP: backupPath,
        FORGEBOARD_E2E_RECOVERY_LOG: recoveryLogPath,
      },
    });
    electronApp = recovered.app;
    watchExternalRequests(recovered.page, externalRequests);

    await expect(recovered.page.locator('.setup-shell')).toHaveCount(0);
    await expect(recovered.page.locator('.recent-list button')).toHaveCount(1);
    await recovered.page.locator('.recent-list button').click();
    await expect(
      recovered.page.getByRole('article', {
        name: 'Product brief: Recovered from startup backup',
      }),
    ).toBeVisible();
    expect((await readFile(databasePath)).subarray(0, 16).toString('utf8')).toBe(
      'SQLite format 3\0',
    );
    expect(await readRecoveryLog(recoveryLogPath)).toEqual([
      {
        kind: 'message',
        title: 'Local data needs recovery',
        buttons: ['Quit Forgeboard', 'Choose verified backup'],
        cancelId: 0,
        defaultId: 0,
      },
      {
        kind: 'open',
        title: 'Choose a verified Forgeboard backup',
        buttonLabel: 'Choose backup',
        properties: ['openFile'],
      },
    ]);
    expect(externalRequests).toEqual([]);
  } finally {
    await closeElectronAfterTest(electronApp);
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

async function openDataSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.locator('.settings-modal');
  await settings.getByRole('button', { name: 'Data & privacy' }).click();
  await expect(settings.getByRole('heading', { name: 'Canvas recovery' })).toBeVisible();
  return settings;
}

async function readRecoveryLog(path: string): Promise<unknown[]> {
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}
