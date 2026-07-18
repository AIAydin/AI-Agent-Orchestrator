import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { launchDesktop, watchExternalRequests } from '../support/electron.js';
import { chooseSettingsExportPath, chooseSettingsImportPath } from './native-file-dialogs.js';

test('ordinary settings configure, persist, export, reset, import, and revalidate through the UI', async () => {
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'forgeboard-settings-e2e-'));
  const worktreeDirectoryInput = join(userDataDirectory, 'managed-worktrees');
  const exportPath = join(userDataDirectory, 'forgeboard-settings.json');
  const invalidImportPath = join(userDataDirectory, 'forgeboard-settings-invalid.json');
  const externalRequests: string[] = [];
  let electronApp: ElectronApplication | null = null;

  try {
    await mkdir(worktreeDirectoryInput, { recursive: true, mode: 0o700 });
    const worktreeDirectory = await realpath(worktreeDirectoryInput);
    let session = await launchDesktop(userDataDirectory);
    electronApp = session.app;
    watchExternalRequests(session.page, externalRequests);
    await useSafeDefaults(session.page);
    const terminalExecutable = await electronApp.evaluate(() => process.execPath);

    await test.step('representative controls from every ordinary settings category save together', async () => {
      const settings = await openSettings(session.page);
      await settings.getByRole('button', { name: 'dark' }).click();
      await settings.getByRole('button', { name: 'compact' }).click();
      await settings.getByLabel('Reduce motion').check();
      await settings.getByLabel('Canvas grid size').fill('24');
      await settings.getByLabel('Keyboard preset').selectOption('vscode');

      await settings.getByRole('button', { name: 'Agents & runtime' }).click();
      await settings.getByLabel('Default terminal executable').fill(terminalExecutable);
      await settings
        .getByLabel('Environment variable names allowed into processes')
        .fill('PATH, HOME');
      await settings.getByLabel('Docker executable').fill('docker');
      await settings.getByLabel('Container image').fill('example.invalid/forgeboard-agent:1');
      await settings.getByLabel('Agent executable inside image').fill('/usr/local/bin/agent');
      await settings.getByLabel('CPU limit').fill('1.5');
      await settings.getByLabel('Memory limit (MB)').fill('2048');

      await settings.getByRole('button', { name: 'Permissions' }).click();
      await expect(settings.getByLabel('Default permission profile')).toBeVisible();

      await settings.getByRole('button', { name: 'Git & previews' }).click();
      await settings.getByLabel('Branch prefix').fill('ui-proof/');
      await settings.getByLabel('Managed worktree location').fill(worktreeDirectory);
      await settings.getByLabel('Git identity name').fill('UI Proof');
      await settings.getByLabel('Git identity email').fill('ui-proof@example.invalid');
      await settings.getByLabel('Default remote').fill('upstream');
      await settings.getByLabel('Preview port start').fill('43000');
      await settings.getByLabel('Preview port end').fill('43100');
      await settings.getByLabel('Trusted preview hosts').fill('127.0.0.1, localhost');

      await settings.getByRole('button', { name: 'Checks', exact: true }).click();
      await expect(settings.getByRole('heading', { name: 'Project checks' })).toBeVisible();
      await settings.getByRole('button', { name: 'Extensions' }).click();
      await expect(settings.getByRole('heading', { name: 'Local extensions' })).toBeVisible();

      await settings.getByRole('button', { name: 'Connectivity' }).click();
      await settings.getByLabel('Collaboration server URL').fill('ws://127.0.0.1:1234');
      await settings.getByLabel('Collaboration management API URL').fill('http://127.0.0.1:1234');
      await settings.getByLabel('Collaboration display name').fill('UI Proof User');
      await settings.getByLabel('Collaboration room').fill('ui-proof-room');
      await settings.getByLabel('Collaborator ID').fill('ui-proof-user');
      await settings.getByLabel('Update channel').selectOption('disabled');

      await settings.getByRole('button', { name: 'Data & privacy' }).click();
      await settings.getByLabel('Days to keep transcripts').fill('45');
      await settings.getByLabel('Days to keep activity history').fill('400');
      await settings.getByLabel('Snapshots to keep').fill('125');
      await settings.getByLabel('Autosave every (milliseconds)').fill('1500');
      await settings.getByLabel('Local backups').uncheck();
      await settings.getByRole('button', { name: 'Save settings' }).click();
      await expect(settings).toBeHidden();
    });

    await electronApp.close();
    electronApp = null;
    session = await launchDesktop(userDataDirectory);
    electronApp = session.app;
    watchExternalRequests(session.page, externalRequests);

    await test.step('saved UI configuration survives a complete application restart', async () => {
      const settings = await openSettings(session.page);
      await expect(settings.getByRole('button', { name: 'dark' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(settings.getByLabel('Canvas grid size')).toHaveValue('24');
      await settings.getByRole('button', { name: 'Git & previews' }).click();
      await expect(settings.getByLabel('Branch prefix')).toHaveValue('ui-proof/');
      await expect(settings.getByLabel('Managed worktree location')).toHaveValue(worktreeDirectory);
      await settings.getByRole('button', { name: 'Connectivity' }).click();
      await expect(settings.getByLabel('Collaboration display name')).toHaveValue('UI Proof User');
      await expect(settings.getByLabel('Update channel')).toHaveValue('disabled');
      await settings.getByRole('button', { name: 'Close settings' }).click();
    });

    await test.step('export, persisted defaults, invalid import revalidation, and valid import use native UI', async () => {
      await chooseSettingsExportPath(electronApp, exportPath);
      let settings = await openDataSettings(session.page);
      await settings.getByRole('button', { name: 'Export settings' }).click();
      await expect(settings.getByText(`Settings exported to ${exportPath}`)).toBeVisible();
      await access(exportPath);
      const exported = JSON.parse(await readFile(exportPath, 'utf8')) as {
        settings: Record<string, unknown>;
      };
      const invalidWorktreePath = join(worktreeDirectory, 'not-a-directory');
      await writeFile(invalidWorktreePath, 'ordinary file', 'utf8');
      await writeFile(
        invalidImportPath,
        JSON.stringify({
          format: 'forgeboard-settings',
          version: 1,
          settings: { ...exported.settings, worktreeRoot: invalidWorktreePath },
        }),
        'utf8',
      );

      await settings.getByRole('button', { name: 'Restore defaults' }).click();
      await expect(settings.getByText(/Defaults loaded as a draft/u)).toBeVisible();
      await settings.getByRole('button', { name: 'Save settings' }).click();
      await expect(settings).toBeHidden();
      settings = await openSettings(session.page);
      await expect(settings.getByRole('button', { name: 'system' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await settings.getByRole('button', { name: 'Close settings' }).click();

      await chooseSettingsImportPath(electronApp, invalidImportPath);
      settings = await openDataSettings(session.page);
      await settings.getByRole('button', { name: 'Import settings' }).click();
      await expect(settings.getByText(/Settings loaded as a draft/u)).toBeVisible();
      const blockedSave = settings.getByRole('button', { name: 'Save settings' });
      await expect(blockedSave).toBeDisabled();
      await expect(blockedSave).toHaveAttribute(
        'title',
        /does not exist|not a directory|not an ordinary folder/u,
      );
      await settings.getByRole('button', { name: 'Close settings' }).click();

      await chooseSettingsImportPath(electronApp, exportPath);
      settings = await openDataSettings(session.page);
      await settings.getByRole('button', { name: 'Import settings' }).click();
      await settings.getByRole('button', { name: 'Save settings' }).click();
      await expect(settings).toBeHidden();
      settings = await openSettings(session.page);
      await expect(settings.getByRole('button', { name: 'dark' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await settings.getByRole('button', { name: 'Close settings' }).click();
    });

    expect(externalRequests).toEqual([]);
  } finally {
    await electronApp?.close().catch(() => undefined);
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

async function useSafeDefaults(page: Page): Promise<void> {
  await page
    .getByRole('dialog', { name: /Set up Forgeboard in a few quick steps/i })
    .getByRole('button', { name: 'Use safe defaults' })
    .click();
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.locator('.settings-modal');
  await expect(settings).toBeVisible();
  return settings;
}

async function openDataSettings(page: Page) {
  const settings = await openSettings(page);
  await settings.getByRole('button', { name: 'Data & privacy' }).click();
  await expect(settings.getByRole('heading', { name: 'Export and import' })).toBeVisible();
  return settings;
}
