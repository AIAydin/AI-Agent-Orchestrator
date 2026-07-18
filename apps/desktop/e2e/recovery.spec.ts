import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { launchDesktop, watchExternalRequests } from './support/electron.js';

test('canvas recovery, portable import, and automatic backups work entirely in the UI', async () => {
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'forgeboard-recovery-e2e-'));
  const backupDirectory = join(userDataDirectory, 'backups');
  const exportPath = join(userDataDirectory, 'forgeboard-local-data.json');
  const externalRequests: string[] = [];
  let electronApp: ElectronApplication | null = null;

  try {
    const session = await launchDesktop(userDataDirectory);
    const app = session.app;
    electronApp = app;
    const page = session.page;
    watchExternalRequests(page, externalRequests);

    await page
      .getByRole('dialog', { name: /Set up Forgeboard in a few quick steps/i })
      .getByRole('button', { name: 'Use safe defaults' })
      .click();
    await page.getByRole('button', { name: /Explore the safe demo/i }).click();
    await page
      .locator('.template-section')
      .getByRole('button', { name: /Product brief/ })
      .click();
    await page.getByRole('article', { name: 'Product brief: Product brief' }).click();
    await page.locator('.inspector').getByLabel('Title').fill('Recoverable brief');

    await test.step('automatic backup behavior and destination are configured in Settings', async () => {
      const settings = await openDataSettings(page);
      await settings.getByLabel('Backup folder').fill(backupDirectory);
      await settings.getByLabel('Back up automatically every (hours)').fill('1');
      await settings.getByLabel('Backups to keep').fill('2');
      await settings.getByRole('button', { name: 'Save settings' }).click();
      await expect(settings).toBeHidden();
    });

    await test.step('a manual canvas checkpoint is created without editing configuration', async () => {
      const settings = await openDataSettings(page);
      await settings.getByRole('button', { name: 'Create snapshot' }).click();
      await expect(settings.getByText('Snapshot created for Workshop.')).toBeVisible();
      await settings.getByRole('button', { name: 'Close settings' }).click();
    });

    await page.getByRole('article', { name: 'Product brief: Recoverable brief' }).click();
    await page.locator('.inspector').getByRole('button', { name: 'Delete' }).click();
    await expect(
      page.getByRole('article', { name: 'Product brief: Recoverable brief' }),
    ).toHaveCount(0);
    await closeProject(page);

    await approveNativeConfirmations(app);
    await test.step('snapshot restoration is disclosed, natively approved, and durable', async () => {
      const settings = await openDataSettings(page);
      const manualSnapshot = settings.locator('.recovery-snapshot-row').filter({
        hasText: 'manual',
      });
      await expect(manualSnapshot.first()).toBeVisible();
      await manualSnapshot.first().getByRole('button', { name: 'Review restore' }).click();
      const disclosure = settings.getByRole('region', { name: 'Confirm snapshot restore' });
      await expect(disclosure).toContainText('Restore this snapshot?');
      await disclosure.getByRole('button', { name: 'Continue to confirmation' }).click();
      await expect(settings).toBeHidden();

      await openOnlyRecentProject(page);
      await expect(
        page.getByRole('article', { name: 'Product brief: Recoverable brief' }),
      ).toBeVisible();
      await closeProject(page);
    });

    await test.step('portable data exports and replace-imports through native file selection', async () => {
      await chooseExportPath(app, exportPath);
      let settings = await openDataSettings(page);
      await settings.getByRole('button', { name: 'Export all local data' }).click();
      await expect(settings.getByText(`Local data exported to ${exportPath}`)).toBeVisible();
      await access(exportPath);
      await settings.getByRole('button', { name: 'Close settings' }).click();

      await openOnlyRecentProject(page);
      await page.getByRole('article', { name: 'Product brief: Recoverable brief' }).click();
      await page.locator('.inspector').getByRole('button', { name: 'Delete' }).click();
      await closeProject(page);

      await chooseImportPath(app, exportPath);
      settings = await openDataSettings(page);
      await settings.getByLabel('How to import').selectOption('replace');
      await settings.getByRole('button', { name: 'Choose export file' }).click();
      const disclosure = settings.getByRole('region', { name: 'Confirm local data import' });
      await expect(disclosure).toContainText('Replace all current data');
      await expect(disclosure).toContainText('forgeboard-local-data.json');
      await disclosure.getByRole('button', { name: 'Continue to confirmation' }).click();
      await expect(settings).toBeHidden();

      await openOnlyRecentProject(page);
      await expect(
        page.getByRole('article', { name: 'Product brief: Recoverable brief' }),
      ).toBeVisible();
    });

    await app.close();
    electronApp = null;
    await expect
      .poll(async () => await readdir(backupDirectory), {
        timeout: 15_000,
        message: 'shutdown should create a verified automatic backup in the UI-selected folder',
      })
      .toHaveLength(1);
    expect(externalRequests).toEqual([]);
  } finally {
    await electronApp?.close().catch(() => undefined);
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

async function closeProject(page: Page): Promise<void> {
  await page.locator('.project-switcher').click();
  await expect(
    page.getByRole('heading', { name: /Build software in a visual workshop/i }),
  ).toBeVisible();
}

async function openOnlyRecentProject(page: Page): Promise<void> {
  await expect(page.locator('.recent-list button')).toHaveCount(1);
  await page.locator('.recent-list button').click();
  await expect(page.locator('.project-switcher')).toContainText('forgeboard-demo');
}

async function approveNativeConfirmations(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ dialog }) => {
    Object.defineProperty(dialog, 'showMessageBox', {
      configurable: true,
      value: () => Promise.resolve({ response: 1, checkboxChecked: false }),
    });
  });
}

async function chooseExportPath(
  electronApp: ElectronApplication,
  exportPath: string,
): Promise<void> {
  await electronApp.evaluate(({ dialog }, selectedPath) => {
    Object.defineProperty(dialog, 'showSaveDialog', {
      configurable: true,
      value: () => Promise.resolve({ canceled: false, filePath: selectedPath }),
    });
  }, exportPath);
}

async function chooseImportPath(
  electronApp: ElectronApplication,
  importPath: string,
): Promise<void> {
  await electronApp.evaluate(({ dialog }, selectedPath) => {
    Object.defineProperty(dialog, 'showOpenDialog', {
      configurable: true,
      value: () => Promise.resolve({ canceled: false, filePaths: [selectedPath] }),
    });
  }, importPath);
}
