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

    await test.step('representative controls from every ordinary settings category save together', async () => {
      const settings = await openSettings(session.page);
      await settings.getByRole('button', { name: 'dark' }).click();
      await settings.getByRole('button', { name: 'compact' }).click();
      await settings.getByLabel('Reduce motion').check();
      await settings.getByLabel('Canvas grid size').fill('24');
      await settings.getByLabel('Keyboard preset').selectOption('vscode');

      await settings.getByRole('button', { name: 'Agents & runtime' }).click();
      await settings.getByLabel('Docker executable').fill('docker');
      await settings.getByLabel('Container image').fill('example.invalid/forgeboard-agent:1');
      await settings.getByLabel('Agent executable inside image').fill('/usr/local/bin/agent');
      await settings.getByLabel('CPU limit').fill('1.5');
      await settings.getByLabel('Memory limit (MB)').fill('2048');

      await settings.getByRole('button', { name: 'Permissions' }).click();
      await expect(settings.getByLabel('Default permission profile')).toBeVisible();

      await settings.getByRole('button', { name: 'Git & previews' }).click();
      await settings.getByLabel('Managed worktree location').fill(worktreeDirectory);
      await settings.getByLabel('Preview port start').fill('43000');
      await settings.getByLabel('Preview port end').fill('43100');

      await expect(settings.getByRole('button', { name: 'Checks', exact: true })).toHaveCount(0);
      await expect(settings.getByRole('button', { name: 'Extensions' })).toHaveCount(0);

      await settings.getByRole('button', { name: 'Connectivity' }).click();
      await settings.getByText('Advanced', { exact: true }).click();
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
      await approveNextRetentionReduction(electronApp, async () => {
        await settings.getByRole('button', { name: 'Save settings' }).click();
      });
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
      const blockedSave = settings.getByRole('button', {
        name: 'Save settings',
      });
      await expect(blockedSave).toBeDisabled();
      await expect(blockedSave).toHaveAccessibleDescription(
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
    .getByRole('dialog', {
      name: 'Ready to build without wiring config files?',
    })
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

async function approveNextRetentionReduction(
  app: ElectronApplication,
  save: () => Promise<void>,
): Promise<void> {
  await app.evaluate(({ dialog }) => {
    interface RetentionDialogState {
      error?: string;
      originalDescriptor: PropertyDescriptor | undefined;
      status: 'armed' | 'approved' | 'rejected';
    }
    const state = globalThis as typeof globalThis & {
      __forgeboardSettingsRetentionDialog?: RetentionDialogState;
    };
    const originalDescriptor = Object.getOwnPropertyDescriptor(dialog, 'showMessageBox');
    const record: RetentionDialogState = {
      originalDescriptor,
      status: 'armed',
    };

    function restore(): void {
      if (Object.getOwnPropertyDescriptor(dialog, 'showMessageBox')?.value !== interceptor) return;
      if (originalDescriptor === undefined) Reflect.deleteProperty(dialog, 'showMessageBox');
      else Object.defineProperty(dialog, 'showMessageBox', originalDescriptor);
    }

    function interceptor(...arguments_: unknown[]) {
      restore();
      const options = arguments_.at(-1) as
        | {
            buttons?: unknown;
            cancelId?: unknown;
            defaultId?: unknown;
            detail?: unknown;
            message?: unknown;
            noLink?: unknown;
            title?: unknown;
            type?: unknown;
          }
        | undefined;
      const expectedDetail = [
        'Transcripts and completed run/check history: 45 to 30 days',
        'Activity history: 400 to 365 days',
        'Canvas snapshots per canvas: 125 to 100',
        '',
        'This applies immediately when Settings are saved and cannot be undone unless the data exists in a backup.',
      ].join('\n');
      const errors = [
        options?.type === 'warning' ? undefined : 'type must be warning',
        options?.title === 'Delete older local history?'
          ? undefined
          : 'title must identify deletion',
        options?.message === 'These retention changes can permanently delete older local history.'
          ? undefined
          : 'message must disclose permanent deletion',
        JSON.stringify(options?.buttons) ===
        JSON.stringify(['Cancel', 'Save and delete older data'])
          ? undefined
          : 'buttons must be Cancel then Save and delete older data',
        options?.defaultId === 0 ? undefined : 'Cancel must be the default action',
        options?.cancelId === 0 ? undefined : 'Cancel must be the escape action',
        options?.noLink === true ? undefined : 'native links must be disabled',
        options?.detail === expectedDetail ? undefined : 'detail must list the exact reductions',
      ].filter((error): error is string => error !== undefined);

      if (errors.length > 0) {
        record.error = errors.join('; ');
        record.status = 'rejected';
        return Promise.resolve({ response: 0, checkboxChecked: false });
      }
      record.status = 'approved';
      return Promise.resolve({ response: 1, checkboxChecked: false });
    }

    state.__forgeboardSettingsRetentionDialog = record;
    Object.defineProperty(dialog, 'showMessageBox', {
      configurable: true,
      value: interceptor,
    });
  });

  try {
    await save();
    await expect
      .poll(
        async () =>
          await app.evaluate(() => {
            const state = globalThis as typeof globalThis & {
              __forgeboardSettingsRetentionDialog?: { status: string };
            };
            return state.__forgeboardSettingsRetentionDialog?.status ?? 'missing';
          }),
      )
      .not.toBe('armed');
    const result = await app.evaluate(() => {
      const state = globalThis as typeof globalThis & {
        __forgeboardSettingsRetentionDialog?: {
          error?: string;
          status: string;
        };
      };
      return state.__forgeboardSettingsRetentionDialog;
    });
    expect(result?.status, result?.error).toBe('approved');
  } finally {
    await app.evaluate(({ dialog }) => {
      const state = globalThis as typeof globalThis & {
        __forgeboardSettingsRetentionDialog?: {
          originalDescriptor: PropertyDescriptor | undefined;
        };
      };
      const record = state.__forgeboardSettingsRetentionDialog;
      if (record !== undefined) {
        if (record.originalDescriptor === undefined)
          Reflect.deleteProperty(dialog, 'showMessageBox');
        else Object.defineProperty(dialog, 'showMessageBox', record.originalDescriptor);
      }
      delete state.__forgeboardSettingsRetentionDialog;
    });
  }
}
